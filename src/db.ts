/**
 * pi-todo — SQLite persistence layer (node:sqlite).
 *
 * Design notes (see SEQUENCED.md / PLAN.md):
 *  - node:sqlite DatabaseSync is SYNCHRONOUS, so all DB helpers below are sync.
 *    Transactions use BEGIN IMMEDIATE … COMMIT with a SYNCHRONOUS callback
 *    (no awaits inside) — two parallel tool calls cannot interleave within it.
 *  - One shared connection (singleton promise) to serialize access.
 *  - foreign_keys pragma is PER-CONNECTION → set on every open.
 *  - Tree fetch via recursive CTE ordered by a zero-padded materialized path.
 */

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Status = "pending" | "in_progress" | "done";

export const PRIORITIES = ["critical", "high", "medium", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];
/** Numeric weight for sorting: higher = more important. */
export const PRIORITY_ORDER: Record<Priority, number> = {
	critical: 4,
	high: 3,
	medium: 2,
	low: 1,
};

export interface TaskNode {
	id: number;
	text: string;
	status: Status;
	priority: Priority;
	note?: string | null;
	tags?: string[] | null;
	description?: string | null;
	children: TaskNode[];
}

export interface Counts {
	total: number;
	pending: number;
	in_progress: number;
	done: number;
}

export interface ListRow {
	id: number;
	scope: string;
	name: string;
	title: string | null;
	path: string;
	created_at: number;
	updated_at: number;
}

export interface ListSummary extends ListRow {
	counts: Counts;
}

/** A fully-resolved task to insert (parent already known). */
export interface InsertSpec {
	text: string;
	status: Status;
	priority?: Priority;
	note?: string | null;
	tags?: string[] | null;
	description?: string | null;
	parentId: number | null;
}

export interface UpdateSpec {
	text?: string;
	note?: string | null | undefined; // null/"" clears the note; undefined = leave as-is
	status?: Status;
	priority?: Priority;
	tags?: string[] | null;
	description?: string | null | undefined; // null/"" clears; undefined = leave as-is
	cascade?: boolean;
}

export interface MoveSpec {
	/** Target parent task id; null/undefined → top-level of the list. */
	under?: number | null;
	/** Place after this sibling id; omit to append to end of the parent's children. */
	after?: number | null;
}

interface TreeRow {
	id: number;
	parent_id: number | null;
	ord: number;
	text: string;
	status: Status;
	priority: Priority;
	note: string | null;
	tags: string | null;
	description: string | null;
	depth: number;
}

// ---------------------------------------------------------------------------
// node:sqlite experimental-warning suppression (narrow: only the SQLite message)
// ---------------------------------------------------------------------------

let sqliteWarnGuarded = false;
function guardSqliteExperimentalWarning(): void {
	if (sqliteWarnGuarded) return;
	sqliteWarnGuarded = true;
	const originalEmitWarning = process.emitWarning;
	// Narrow suppression: drop ONLY the node:sqlite experimental notice; forward everything else.
	const patched = ((warning: string | Error, ...rest: unknown[]): void => {
		try {
			const msg =
				typeof warning === "string"
					? warning
					: String((warning as Error)?.message ?? "");
			if (msg.includes("SQLite is an experimental feature")) return;
		} catch {
			/* fall through to original */
		}
		(originalEmitWarning as (w: string | Error, ...r: unknown[]) => void)(
			warning,
			...rest,
		);
	}) as typeof process.emitWarning;
	process.emitWarning = patched;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS lists (
  id INTEGER PRIMARY KEY,
  scope TEXT NOT NULL,
  name TEXT NOT NULL,
  title TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(scope, name)
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  note TEXT,
  tags TEXT,
  description TEXT,
  priority TEXT NOT NULL DEFAULT 'medium',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_list ON tasks(list_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
`;

const TREE_SQL = `
WITH RECURSIVE t(id, parent_id, ord, text, status, priority, note, tags, description, depth, path) AS (
  SELECT id, parent_id, ord, text, status, priority, note, tags, description, 0, printf('%012d', ord)
    FROM tasks WHERE list_id = ? AND parent_id IS NULL
  UNION ALL
  SELECT c.id, c.parent_id, c.ord, c.text, c.status, c.priority, c.note, c.tags, c.description, p.depth + 1,
         p.path || '/' || printf('%012d', c.ord)
    FROM tasks c JOIN t p ON c.parent_id = p.id
)
SELECT id, parent_id, ord, text, status, priority, note, tags, description, depth FROM t ORDER BY path
`;

const DESCENDANTS_SQL = `
WITH RECURSIVE d(id) AS (
  SELECT id FROM tasks WHERE parent_id = ? AND list_id = ?
  UNION ALL
  SELECT c.id FROM tasks c JOIN d ON c.parent_id = d.id
)
SELECT id FROM d
`;

const NEXT_WITHIN_SQL = `
SELECT t.*, CASE t.priority
  WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1
END AS prio_num
FROM tasks t WHERE t.list_id = ? AND t.status = ?
ORDER BY prio_num DESC, t.id ASC LIMIT 1
`;

const NEXT_ACROSS_SQL = `
SELECT t.*, l.scope, l.name,
  CASE t.priority
    WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1
  END AS prio_num
FROM tasks t JOIN lists l ON t.list_id = l.id
WHERE t.status = ?
ORDER BY prio_num DESC, t.id ASC LIMIT 1
`;

const SUBTREE_SQL = `
WITH RECURSIVE t(id, parent_id, ord, text, status, priority, note, tags, description, depth, path) AS (
  SELECT id, parent_id, ord, text, status, priority, note, tags, description, 0, printf('%012d', ord)
    FROM tasks WHERE id = ?
  UNION ALL
  SELECT c.id, c.parent_id, c.ord, c.text, c.status, c.priority, c.note, c.tags, c.description, p.depth + 1,
         p.path || '/' || printf('%012d', c.ord)
    FROM tasks c JOIN t p ON c.parent_id = p.id
)
SELECT id, parent_id, ord, text, status, priority, note, tags, description, depth FROM t ORDER BY path
`;

const NEXT_IN_SUBTREE_SQL = `
WITH RECURSIVE subtree(id) AS (
  SELECT id FROM tasks WHERE id = ?
  UNION ALL
  SELECT c.id FROM tasks c JOIN subtree s ON c.parent_id = s.id
)
SELECT t.*, CASE t.priority
  WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1
END AS prio_num
FROM tasks t WHERE t.list_id = ? AND t.status = ? AND t.id IN (SELECT id FROM subtree)
ORDER BY prio_num DESC, t.id ASC LIMIT 1
`;

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

let dbPromise: Promise<TodoDb> | null = null;

function resolveDbPath(): string {
	const override = process.env.PI_TODO_DB;
	if (override && override.trim()) return override;
	return join(homedir(), ".pi", "agent", "todo.db");
}

export function getDb(): Promise<TodoDb> {
	if (!dbPromise) dbPromise = initTodoDb();
	return dbPromise;
}

export async function closeTodoDb(): Promise<void> {
	const pending = dbPromise;
	dbPromise = null;
	if (pending) {
		try {
			const db = await pending;
			db.close();
		} catch {
			/* already closed or never opened */
		}
	}
}

async function initTodoDb(): Promise<TodoDb> {
	guardSqliteExperimentalWarning();
	const { DatabaseSync } = await import("node:sqlite");
	const dbPath = resolveDbPath();
	await mkdir(dirname(dbPath), { recursive: true });
	const conn = new DatabaseSync(dbPath);
	// Per-connection + database-level pragmas.
	conn.exec("PRAGMA journal_mode = WAL;");
	conn.exec("PRAGMA foreign_keys = ON;");
	conn.exec("PRAGMA busy_timeout = 5000;");
	conn.exec(SCHEMA_SQL);
	// Migration: add columns to existing databases.
	try {
		conn.exec("ALTER TABLE tasks ADD COLUMN tags TEXT");
	} catch {
		/* column exists */
	}
	try {
		conn.exec("ALTER TABLE tasks ADD COLUMN description TEXT");
	} catch {
		/* column exists */
	}
	return new TodoDb(conn);
}

// ---------------------------------------------------------------------------
// TodoDb — synchronous operations
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyDb = any;
type Stmt = any;

export class TodoDb {
	private conn: AnyDb;
	private stmts: Record<string, Stmt>;

	constructor(conn: AnyDb) {
		this.conn = conn;
		this.stmts = {
			listsAll: conn.prepare(
				"SELECT id, scope, name, title, created_at, updated_at FROM lists ORDER BY scope, name",
			),
			getList: conn.prepare(
				"SELECT id, scope, name, title, created_at, updated_at FROM lists WHERE scope = ? AND name = ?",
			),
			insertList: conn.prepare(
				"INSERT OR IGNORE INTO lists (scope, name, title, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)",
			),
			setListTitle: conn.prepare(
				"UPDATE lists SET title = ?, updated_at = ? WHERE id = ?",
			),
			touchList: conn.prepare("UPDATE lists SET updated_at = ? WHERE id = ?"),
			deleteList: conn.prepare("DELETE FROM lists WHERE id = ?"),

			insertTask: conn.prepare(
				"INSERT INTO tasks (list_id, parent_id, ord, text, status, note, tags, description, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			),
				getTask: conn.prepare(
						"SELECT id, list_id, parent_id, ord, text, status, priority, note, tags, description FROM tasks WHERE id = ?",
			),
			updateText: conn.prepare(
				"UPDATE tasks SET text = ?, updated_at = ? WHERE id = ?",
			),
			updateNote: conn.prepare(
				"UPDATE tasks SET note = ?, updated_at = ? WHERE id = ?",
			),
			updateStatus: conn.prepare(
				"UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?",
			),
			updatePriority: conn.prepare(
				"UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ?",
			),
			setTags: conn.prepare(
				"UPDATE tasks SET tags = ?, updated_at = ? WHERE id = ?",
			),
				setDescription: conn.prepare(
						"UPDATE tasks SET description = ?, updated_at = ? WHERE id = ?",
			),
				setParent: conn.prepare(
				"UPDATE tasks SET parent_id = ?, updated_at = ? WHERE id = ?",
			),
			setOrd: conn.prepare("UPDATE tasks SET ord = ? WHERE id = ?"),
			deleteTask: conn.prepare("DELETE FROM tasks WHERE id = ?"),
			maxOrdRoot: conn.prepare(
				"SELECT COALESCE(MAX(ord), 0) + 1 AS n FROM tasks WHERE list_id = ? AND parent_id IS NULL",
			),
			maxOrdChild: conn.prepare(
				"SELECT COALESCE(MAX(ord), 0) + 1 AS n FROM tasks WHERE parent_id = ?",
			),
			rootChildren: conn.prepare(
				"SELECT id FROM tasks WHERE list_id = ? AND parent_id IS NULL ORDER BY ord, id",
			),
			childrenOf: conn.prepare(
				"SELECT id FROM tasks WHERE parent_id = ? ORDER BY ord, id",
			),

			tree: conn.prepare(TREE_SQL),
			descendants: conn.prepare(DESCENDANTS_SQL),
			countByStatus: conn.prepare(
				"SELECT status, COUNT(*) AS c FROM tasks WHERE list_id = ? GROUP BY status",
			),

			nextWithin: conn.prepare(NEXT_WITHIN_SQL),
			nextAcross: conn.prepare(NEXT_ACROSS_SQL),
			subtree: conn.prepare(SUBTREE_SQL),
			nextInSubtree: conn.prepare(NEXT_IN_SUBTREE_SQL),
		};
	}

	close(): void {
		try {
			this.conn.close();
		} catch {
			/* ignore */
		}
	}

	/** Run fn inside BEGIN IMMEDIATE … COMMIT (synchronous fn, no awaits). */
	txn<T>(fn: () => T): T {
		this.conn.exec("BEGIN IMMEDIATE");
		try {
			const result = fn();
			this.conn.exec("COMMIT");
			return result;
		} catch (err) {
			try {
				this.conn.exec("ROLLBACK");
			} catch {
				/* ignore rollback errors */
			}
			throw err;
		}
	}

	// ---- lists ----

	getList(scope: string, name: string): ListRow | undefined {
		const row = this.stmts.getList.get(scope, name) as
			| Omit<ListRow, "path">
			| undefined;
		return row
			? { ...row, path: row.scope ? `${row.scope}/${row.name}` : row.name }
			: undefined;
	}

	getLists(scopePrefix?: string): ListSummary[] {
		const prefix = scopePrefix?.trim() || undefined;
		const all = this.stmts.listsAll.all() as Omit<ListRow, "path">[];
		// Segment-boundary match: "feature" matches scope "feature" and "feature/...",
		// but NOT "feature-auth". Done in JS to avoid LIKE wildcard leaking.
		const rows = prefix
			? all.filter(
					(r) => r.scope === prefix || r.scope.startsWith(`${prefix}/`),
				)
			: all;
		return rows.map((r) => {
			const path = r.scope ? `${r.scope}/${r.name}` : r.name;
			return { ...r, path, counts: this.countsFor(r.id) };
		});
	}

	ensureList(scope: string, name: string, title?: string | null): ListRow {
		const now = Date.now();
		this.stmts.insertList.run(scope, name, now, now);
		let row = this.getList(scope, name)!;
		if (title != null && title !== "") {
			this.stmts.setListTitle.run(title, Date.now(), row.id);
			row = this.getList(scope, name)!;
		}
		return row;
	}

	setListTitle(id: number, title: string | null): void {
		this.stmts.setListTitle.run(title, Date.now(), id);
	}

	deleteList(id: number): void {
		this.stmts.deleteList.run(id);
	}

	touchList(id: number): void {
		this.stmts.touchList.run(Date.now(), id);
	}

	// ---- tasks ----

	private nextOrd(listId: number, parentId: number | null): number {
		const row =
			parentId == null
				? (this.stmts.maxOrdRoot.get(listId) as { n: number })
				: (this.stmts.maxOrdChild.get(parentId) as { n: number });
		return row.n;
	}

	/** Insert a single resolved task; returns its new id. */
	insertTask(listId: number, spec: InsertSpec): number {
		const ord = this.nextOrd(listId, spec.parentId);
		const now = Date.now();
		const tagsStr =
			spec.tags && spec.tags.length > 0 ? spec.tags.join(",") : null;
		const res = this.stmts.insertTask.run(
			listId,
			spec.parentId,
			ord,
			spec.text,
			spec.status,
			spec.note ?? null,
			tagsStr,
			spec.description ?? null,
			spec.priority ?? "medium",
			now,
			now,
		);
		this.touchList(listId);
		return Number(res.lastInsertRowid);
	}

	/** Get a task, verifying it belongs to listId. */
	getTaskInList(
		listId: number,
		id: number,
	): {
		id: number;
		parent_id: number | null;
		ord: number;
		text: string;
		status: Status;
		priority: Priority;
		note: string | null;
		description: string | null;
	} {
		const row = this.stmts.getTask.get(id) as
			| {
					id: number;
					list_id: number;
					parent_id: number | null;
					ord: number;
					text: string;
					status: Status;
					priority: Priority;
					note: string | null;
					description: string | null;
			  }
			| undefined;
		if (!row || row.list_id !== listId) {
			throw new Error(
				`Task #${id} not found in this list. Run action 'show' to list valid ids.`,
			);
		}
		return row;
	}

	updateTask(listId: number, id: number, spec: UpdateSpec): void {
		this.getTaskInList(listId, id); // throws if missing / wrong list
		const now = Date.now();
		if (spec.text !== undefined) this.stmts.updateText.run(spec.text, now, id);
		if (spec.note !== undefined) {
			const noteVal = spec.note === "" ? null : spec.note;
			this.stmts.updateNote.run(noteVal, now, id);
		}
		if (spec.status !== undefined) {
			this.stmts.updateStatus.run(spec.status, now, id);
			if (spec.cascade) {
				const ids = this.descendantIds(listId, id);
				for (const did of ids)
					this.stmts.updateStatus.run(spec.status, now, did);
			}
		}
		if (spec.priority !== undefined) {
			this.stmts.updatePriority.run(spec.priority, now, id);
		}
		if (spec.tags !== undefined) {
			const tagsStr =
				spec.tags && spec.tags.length > 0 ? spec.tags.join(",") : null;
			this.stmts.setTags.run(tagsStr, now, id);
		}
		if (spec.description !== undefined) {
			const descVal = spec.description === "" ? null : spec.description;
			this.stmts.setDescription.run(descVal, now, id);
		}
		this.touchList(listId);
	}

	/** All descendant ids of `id` (not including `id`), within listId. */
	descendantIds(listId: number, id: number): number[] {
		const rows = this.stmts.descendants.all(id, listId) as { id: number }[];
		return rows.map((r) => r.id);
	}

	moveTask(listId: number, id: number, spec: MoveSpec): void {
		const task = this.getTaskInList(listId, id);
		const newParent = spec.under == null ? null : spec.under;

		// Validate target parent + cycle.
		if (newParent !== null) {
			if (newParent === id) {
				throw new Error(`Cannot move task #${id} under itself.`);
			}
			const target = this.stmts.getTask.get(newParent) as
				| { list_id: number }
				| undefined;
			if (!target || target.list_id !== listId) {
				throw new Error(`Target parent #${newParent} not found in this list.`);
			}
			const desc = new Set(this.descendantIds(listId, id));
			if (desc.has(newParent)) {
				throw new Error(
					`Cannot move task #${id} under #${newParent}: #${newParent} is a descendant of #${id}.`,
				);
			}
		}

		const oldParent = task.parent_id;
		// Detach to end of new parent first.
		this.stmts.setParent.run(newParent, Date.now(), id);
		// Build desired order for the destination group, placing after `after` if given.
		const siblingIds = (
			newParent == null
				? (this.stmts.rootChildren.all(listId) as { id: number }[])
				: (this.stmts.childrenOf.all(newParent) as { id: number }[])
		).map((r) => r.id);
		const reordered = siblingIds.filter((x) => x !== id);
		if (spec.after == null) {
			reordered.push(id);
		} else {
			const idx = reordered.indexOf(spec.after);
			if (idx >= 0) reordered.splice(idx + 1, 0, id);
			else reordered.push(id); // after-id not a sibling → append
		}
		this.renumber(reordered);
		// Cosmetically renumber the old group if it changed.
		if (oldParent !== newParent) {
			const oldIds = (
				oldParent == null
					? (this.stmts.rootChildren.all(listId) as { id: number }[])
					: (this.stmts.childrenOf.all(oldParent) as { id: number }[])
			).map((r) => r.id);
			this.renumber(oldIds);
		}
		this.touchList(listId);
	}

	private renumber(orderedIds: number[]): void {
		let i = 1;
		for (const tid of orderedIds) {
			this.stmts.setOrd.run(i, tid);
			i++;
		}
	}

	deleteTask(listId: number, id: number): void {
		this.getTaskInList(listId, id); // throws if missing / wrong list
		this.stmts.deleteTask.run(id); // FK cascade removes descendants
		this.touchList(listId);
	}

	/** Remove top-most fully-done subtrees. Returns total tasks removed. */
	purgeDone(listId: number): number {
		const before = this.countsFor(listId).total;
		const tree = this.fetchTree(listId);
		const isAllDone = (n: TaskNode): boolean =>
			n.status === "done" && n.children.every(isAllDone);
		const toDelete: number[] = [];
		const visit = (n: TaskNode): void => {
			if (isAllDone(n)) {
				toDelete.push(n.id); // top-most fully-done node; descendants removed by cascade
				return;
			}
			for (const c of n.children) visit(c);
		};
		for (const root of tree) visit(root);
		for (const id of toDelete) this.stmts.deleteTask.run(id);
		this.touchList(listId);
		const after = this.countsFor(listId).total;
		return before - after;
	}

	// ---- reads ----

	fetchTree(listId: number): TaskNode[] {
		const rows = this.stmts.tree.all(listId) as TreeRow[];
		const parseTags = (raw: string | null): string[] | undefined =>
			raw ? raw.split(",").filter(Boolean) : undefined;
		const nodes = new Map<number, TaskNode>();
		const roots: TaskNode[] = [];
		for (const r of rows) {
			nodes.set(r.id, {
				id: r.id,
				text: r.text,
				status: r.status,
				priority: r.priority,
				note: r.note ?? undefined,
				tags: parseTags(r.tags),
				description: r.description ?? undefined,
				children: [],
			});
		}
		for (const r of rows) {
			const node = nodes.get(r.id)!;
			if (r.parent_id == null) roots.push(node);
			else nodes.get(r.parent_id)?.children.push(node);
		}
		return roots;
	}

	countsFor(listId: number): Counts {
		const rows = this.stmts.countByStatus.all(listId) as {
			status: Status;
			c: number;
		}[];
		const counts: Counts = { total: 0, pending: 0, in_progress: 0, done: 0 };
		for (const r of rows) {
			counts[r.status] = r.c;
			counts.total += r.c;
		}
		return counts;
	}

	// ---- subtree ----

	/** Fetch a subtree rooted at a specific task id within a list. */
	fetchSubtree(listId: number, rootTaskId: number): TaskNode[] {
		this.getTaskInList(listId, rootTaskId); // throws if missing / wrong list
		const rows = this.stmts.subtree.all(rootTaskId) as TreeRow[];
		const parseTags = (raw: string | null): string[] | undefined =>
			raw ? raw.split(",").filter(Boolean) : undefined;
		const nodes = new Map<number, TaskNode>();
		let root: TaskNode | undefined;
		for (const r of rows) {
			const node: TaskNode = {
				id: r.id,
				text: r.text,
				status: r.status,
				priority: r.priority,
				note: r.note ?? undefined,
				tags: parseTags(r.tags),
				description: r.description ?? undefined,
				children: [],
			};
			nodes.set(r.id, node);
			if (r.id === rootTaskId) root = node;
		}
		for (const r of rows) {
			if (r.parent_id == null) continue;
			const parent = nodes.get(r.parent_id);
			const child = nodes.get(r.id);
			if (parent && child) parent.children.push(child);
		}
		return root ? [root] : [];
	}

	// ---- next-task ----

	nextTaskWithin(
		listId: number,
		status: Status,
	): (TreeRow & { list_id: number }) | null {
		const row = this.stmts.nextWithin.get(listId, status) as
			| (TreeRow & { list_id: number })
			| undefined;
		return row ?? null;
	}

	nextTaskAcross(
		status: Status,
	): (TreeRow & { scope: string; name: string }) | null {
		const row = this.stmts.nextAcross.get(status) as
			| (TreeRow & { scope: string; name: string })
			| undefined;
		return row ?? null;
	}

	nextTaskInSubtree(
		listId: number,
		rootTaskId: number,
		status: Status,
	): (TreeRow & { list_id: number }) | null {
		const row = this.stmts.nextInSubtree.get(rootTaskId, listId, status) as
			| (TreeRow & { list_id: number })
			| undefined;
		return row ?? null;
	}
}
