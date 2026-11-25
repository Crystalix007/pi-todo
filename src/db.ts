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
 *
 * Namespaces (see ./namespace.ts): every list row carries a `namespace` label.
 * "" is the shared/legacy global namespace, so list paths and task ids look the
 * same as before; named namespaces are additional, fully separate roots of the
 * same tree. Any DB API that scopes by namespace takes it as a TRAILING
 * argument defaulting to global, so existing callers stay global.
 */

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { GLOBAL_NAMESPACE } from "./namespace.ts";

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
	/** Isolation label; "" is the shared global namespace (see ./namespace.ts). */
	namespace: string;
	scope: string;
	name: string;
	title: string | null;
	/** Project directory this list's work belongs to (set by the agent). Empty = unset. */
	project_path: string;
	/** The list's overall goal — echoed in reads so scoped subagents keep context. Empty = unset. */
	description: string;
	path: string;
	created_at: number;
	updated_at: number;
}

/** List-level metadata fields (title, project path, goal description). */
export interface ListMetaInput {
	title?: string | null;
	project_path?: string | null;
	description?: string | null;
}

export interface ListSummary extends ListRow {
	counts: Counts;
}

/** Destination of `TodoDb.copyList`: a new list row plus explicit metadata overrides. */
export interface ListCopySpec {
	scope: string;
	name: string;
	/** Destination namespace; "" (the default) is the shared global namespace. */
	namespace?: string;
	/**
	 * Applied after the source metadata is copied: undefined keeps the copied
	 * value, null or "" clears it, anything else replaces it.
	 */
	meta?: ListMetaInput;
}

export interface ListCopyResult {
	/** The newly created destination list. */
	list: ListRow;
	/** Tasks written into the destination. */
	copied: number;
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
  namespace TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL,
  name TEXT NOT NULL,
  title TEXT,
  project_path TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(namespace, scope, name)
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
SELECT t.*, l.namespace, l.scope, l.name,
  CASE t.priority
    WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1
  END AS prio_num
FROM tasks t JOIN lists l ON t.list_id = l.id
WHERE t.status = ? AND l.namespace = ?
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
	try {
		// busy_timeout FIRST: taking the migration lock must wait for a concurrent
		// first open instead of failing with SQLITE_BUSY.
		conn.exec("PRAGMA busy_timeout = 5000;");
		await enableWal(conn);
		migrateSchema(conn, dbPath);
		return new TodoDb(conn);
	} catch (err) {
		try {
			conn.close();
		} catch {
			/* already closed */
		}
		throw err;
	}
}

/** How often to retry the WAL switch, and how long to wait between attempts. */
const WAL_ATTEMPTS = 10;
const WAL_RETRY_MS = 25;

/** The journal mode actually in force for this connection. */
function currentJournalMode(conn: AnyDb): string {
	const row = conn.prepare("PRAGMA journal_mode").get() as
		| { journal_mode?: unknown }
		| undefined;
	return String(row?.journal_mode ?? "").toLowerCase();
}

/**
 * Switch the file to WAL, tolerating a concurrent first open.
 *
 * `PRAGMA journal_mode` does NOT consult busy_timeout: while another connection
 * is converting the same file, it fails with SQLITE_BUSY even though that other
 * connection is about to leave the file in WAL mode. Journal mode is a
 * file-level property and never a correctness requirement here, so retry
 * briefly, accept the mode another opener established, and otherwise proceed in
 * whatever mode is in force rather than refusing to open the todo DB at all.
 * Genuine failures (read-only file, disk error) are rethrown immediately.
 */
async function enableWal(conn: AnyDb): Promise<void> {
	for (let attempt = 0; attempt < WAL_ATTEMPTS; attempt++) {
		try {
			conn.exec("PRAGMA journal_mode = WAL;");
			return;
		} catch (err) {
			if (currentJournalMode(conn) === "wal") return;
			const message = err instanceof Error ? err.message : String(err);
			if (!/locked|busy/i.test(message)) throw err;
			if (attempt < WAL_ATTEMPTS - 1) await sleep(WAL_RETRY_MS);
		}
	}
}

interface TableColumn {
	name: string;
	notnull: number;
}

/** The parts of an existing `lists` table shape that migration must inspect. */
interface ListsTableShape {
	/** Some UNIQUE index covers exactly (namespace, scope, name). */
	hasNamespaceUniqueIndex: boolean;
	projectPathNotNull: boolean;
	descriptionNotNull: boolean;
}

/**
 * Add the columns older releases lack. ALTER TABLE ADD COLUMN is constant SQL
 * and works for both nullable and NOT NULL DEFAULT '' columns; NOT NULL on the
 * lists metadata is enforced by the rebuild below. A column that already
 * exists makes SQLite throw, which is the "already migrated" case.
 */
function ensureSchemaColumns(conn: AnyDb): void {
	const additions = [
		"ALTER TABLE tasks ADD COLUMN tags TEXT",
		"ALTER TABLE tasks ADD COLUMN description TEXT",
		"ALTER TABLE lists ADD COLUMN namespace TEXT NOT NULL DEFAULT ''",
		"ALTER TABLE lists ADD COLUMN project_path TEXT",
		"ALTER TABLE lists ADD COLUMN description TEXT",
	];
	for (const sql of additions) {
		try {
			conn.exec(sql);
		} catch {
			/* column already exists */
		}
	}
}

function inspectListsTable(conn: AnyDb): ListsTableShape {
	const columns = conn
		.prepare("SELECT * FROM pragma_table_info(?)")
		.all("lists") as TableColumn[];
	const notNull = (name: string): boolean =>
		columns.find((c) => c.name === name)?.notnull === 1;
	let hasNamespaceUniqueIndex = false;
	const indexes = conn
		.prepare("SELECT * FROM pragma_index_list(?)")
		.all("lists") as { name: string; unique: number }[];
	for (const index of indexes) {
		if (index.unique !== 1) continue;
		const indexColumns = conn
			.prepare("SELECT * FROM pragma_index_info(?)")
			.all(index.name) as { name: string }[];
		const names = indexColumns.map((c) => c.name);
		if (
			names.length === 3 &&
			names[0] === "namespace" &&
			names[1] === "scope" &&
			names[2] === "name"
		) {
			hasNamespaceUniqueIndex = true;
		}
	}
	return {
		hasNamespaceUniqueIndex,
		projectPathNotNull: notNull("project_path"),
		descriptionNotNull: notNull("description"),
	};
}

/**
 * Rebuild the `lists` table in place, inside the caller's transaction.
 *
 * Three historical shapes exist: the pre-metadata table (no project_path /
 * description), the previous release's nullable metadata columns, and the
 * metadata-era table whose uniqueness is still (scope, name). Every upgrade
 * needs a table rebuild (SQLite cannot alter a UNIQUE constraint), so one
 * rebuild covers all of them. Rows keep their ids, so `tasks.list_id` — and its
 * ON DELETE CASCADE — keeps working without touching the tasks table.
 */
function rebuildListsTable(conn: AnyDb): void {
	// Four separate statements in the caller's transaction: the steps stay
	// readable, and a failure anywhere (or a crash) rolls back all of them.
	conn.exec(`CREATE TABLE lists_migration (
  id INTEGER PRIMARY KEY,
  namespace TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL,
  name TEXT NOT NULL,
  title TEXT,
  project_path TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(namespace, scope, name)
)`);
	conn.exec(`INSERT INTO lists_migration (id, namespace, scope, name, title, project_path, description, created_at, updated_at)
  SELECT id, COALESCE(namespace, ''), scope, name, title, COALESCE(project_path, ''), COALESCE(description, ''), created_at, updated_at FROM lists`);
	conn.exec("DROP TABLE lists");
	conn.exec("ALTER TABLE lists_migration RENAME TO lists");
}

/**
 * Bring a database file to the current schema, atomically.
 *
 * Everything that changes the file — schema creation, the column additions and
 * the `lists` table rebuild — runs inside ONE `BEGIN IMMEDIATE` transaction, so
 * an interrupted or failed migration rolls back to the original tables instead
 * of leaving a half-rebuilt file (a plain autocommit DDL batch would expose a
 * window where `lists` is dropped but the replacement is not yet renamed, and
 * the next open would then silently see an empty table).
 *
 * `BEGIN IMMEDIATE` takes the write lock up front, so concurrent first opens
 * serialize: the second connection waits (busy_timeout), then inspects the
 * already-migrated schema and does nothing. That is why the shape inspection
 * happens AFTER the lock is acquired — inspecting first would race with another
 * process's migration.
 *
 * `PRAGMA foreign_keys` is per-connection and is a no-op inside a transaction,
 * so it is disabled around the transaction and restored in `finally`. With it
 * enabled, `DROP TABLE lists` would run the ON DELETE CASCADE and delete every
 * task, so the rebuild requires it off; `PRAGMA foreign_key_check` runs before
 * COMMIT to prove the copied rows did not break any reference.
 *
 * Exported for the migration regression tests, which pass a wrapped connection
 * to force a failure at a chosen statement and assert the rollback.
 */
export function migrateSchema(conn: AnyDb, dbPath: string): void {
	conn.exec("PRAGMA foreign_keys = OFF;");
	try {
		conn.exec("BEGIN IMMEDIATE");
		try {
			assertNoInterruptedMigration(conn, dbPath);
			conn.exec(SCHEMA_SQL);
			ensureSchemaColumns(conn);
			const shape = inspectListsTable(conn);
			const needsRebuild =
				!shape.hasNamespaceUniqueIndex ||
				!shape.projectPathNotNull ||
				!shape.descriptionNotNull;
			if (needsRebuild) rebuildListsTable(conn);
			const violations = conn.prepare("PRAGMA foreign_key_check").all();
			if (violations.length > 0) {
				throw new Error(
					`lists migration would leave ${violations.length} foreign-key violation(s); rolling back.`,
				);
			}
			conn.exec("COMMIT");
		} catch (err) {
			try {
				conn.exec("ROLLBACK");
			} catch {
				/* no transaction left to roll back */
			}
			throw err;
		}
	} finally {
		conn.exec("PRAGMA foreign_keys = ON;");
	}
}

/** True when a table of that name already exists in the main schema. */
function tableExists(conn: AnyDb, table: string): boolean {
	return (
		conn
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
			)
			.get(table) !== undefined
	);
}

/**
 * Refuse to build over a leftover `lists_migration` table.
 *
 * The transactional migration never leaves one behind: a failure rolls back to
 * the original `lists` table. A leftover can therefore only come from an
 * earlier pre-release build that ran the old autocommit DDL, or from manual
 * surgery — and in that state the scratch table may hold the only copy of the
 * user's rows. Dropping it would destroy data, and merging it automatically
 * cannot tell which of the two tables is authoritative, so this fails closed
 * with concrete recovery steps.
 */
function assertNoInterruptedMigration(conn: AnyDb, dbPath: string): void {
	if (!tableExists(conn, "lists_migration")) return;
	throw new Error(
		`Found a leftover 'lists_migration' table in ${dbPath}. The migration is transactional and never leaves one behind, so this file was written by an interrupted pre-release build (or edited by hand). Refusing to continue instead of risking data loss. Recover manually: if 'lists' still holds your rows, discard the scratch table with: sqlite3 "${dbPath}" 'DROP TABLE lists_migration'; if 'lists' is empty and the rows are in lists_migration, restore them with: sqlite3 "${dbPath}" 'DROP TABLE lists; ALTER TABLE lists_migration RENAME TO lists;'`,
	);
}

// ---------------------------------------------------------------------------
// TodoDb — synchronous operations
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyDb = any;
type Stmt = any;

/** Attach the canonical path (`scope/name`, or just `name` at root). */
function withPath(row: Omit<ListRow, "path">): ListRow {
	return { ...row, path: row.scope ? `${row.scope}/${row.name}` : row.name };
}

export class TodoDb {
	private conn: AnyDb;
	private stmts: Record<string, Stmt>;

	constructor(conn: AnyDb) {
		this.conn = conn;
		this.stmts = {
			listsAll: conn.prepare(
				"SELECT id, namespace, scope, name, title, project_path, description, created_at, updated_at FROM lists WHERE namespace = ? ORDER BY scope, name",
			),
			listsAllNamespaces: conn.prepare(
				"SELECT id, namespace, scope, name, title, project_path, description, created_at, updated_at FROM lists ORDER BY namespace, scope, name",
			),
			getList: conn.prepare(
				"SELECT id, namespace, scope, name, title, project_path, description, created_at, updated_at FROM lists WHERE namespace = ? AND scope = ? AND name = ?",
			),
			getListById: conn.prepare(
				"SELECT id, namespace, scope, name, title, project_path, description, created_at, updated_at FROM lists WHERE id = ?",
			),
			insertList: conn.prepare(
				"INSERT OR IGNORE INTO lists (namespace, scope, name, title, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)",
			),
			insertFullList: conn.prepare(
				"INSERT INTO lists (namespace, scope, name, title, project_path, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			),
			setListTitle: conn.prepare(
				"UPDATE lists SET title = ?, updated_at = ? WHERE id = ?",
			),
			setListProjectPath: conn.prepare(
				"UPDATE lists SET project_path = ?, updated_at = ? WHERE id = ?",
			),
			setListDescription: conn.prepare(
				"UPDATE lists SET description = ?, updated_at = ? WHERE id = ?",
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

	/** Resolve one list inside `namespace` (default: the global namespace). */
	getList(
		scope: string,
		name: string,
		namespace: string = GLOBAL_NAMESPACE,
	): ListRow | undefined {
		const row = this.stmts.getList.get(namespace, scope, name) as
			| Omit<ListRow, "path">
			| undefined;
		return row ? withPath(row) : undefined;
	}

	/** Lists in `namespace` (default: global), optionally filtered by scope prefix. */
	getLists(
		scopePrefix?: string,
		namespace: string = GLOBAL_NAMESPACE,
	): ListSummary[] {
		return this.summaries(
			this.stmts.listsAll.all(namespace) as Omit<ListRow, "path">[],
			scopePrefix,
		);
	}

	/** Every list across all namespaces — the parent-only `lists` wildcard. */
	getListsAllNamespaces(scopePrefix?: string): ListSummary[] {
		return this.summaries(
			this.stmts.listsAllNamespaces.all() as Omit<ListRow, "path">[],
			scopePrefix,
		);
	}

	private summaries(
		rows: Omit<ListRow, "path">[],
		scopePrefix?: string,
	): ListSummary[] {
		const prefix = scopePrefix?.trim() || undefined;
		// Segment-boundary match: "feature" matches scope "feature" and "feature/...",
		// but NOT "feature-auth". Done in JS to avoid LIKE wildcard leaking.
		const matched = prefix
			? rows.filter(
					(r) => r.scope === prefix || r.scope.startsWith(`${prefix}/`),
				)
			: rows;
		return matched.map((r) => ({
			...withPath(r),
			counts: this.countsFor(r.id),
		}));
	}

	ensureList(
		scope: string,
		name: string,
		meta?: ListMetaInput,
		namespace: string = GLOBAL_NAMESPACE,
	): ListRow {
		const now = Date.now();
		this.stmts.insertList.run(namespace, scope, name, now, now);
		const row = this.getList(scope, name, namespace);
		if (!row) throw new Error(`Failed to create list '${scope}/${name}'.`);
		// Create-time metadata is lenient: only non-empty values are applied, so
		// re-ensuring an existing list never clobbers its metadata with blanks.
		// Use setListMeta directly for explicit set/clear semantics.
		const toApply: ListMetaInput = {};
		if (meta?.title) toApply.title = meta.title;
		if (meta?.project_path) toApply.project_path = meta.project_path;
		if (meta?.description) toApply.description = meta.description;
		if (Object.keys(toApply).length > 0) {
			this.setListMeta(row.id, toApply);
			return this.getList(scope, name, namespace) ?? row;
		}
		return row;
	}

	setListTitle(id: number, title: string | null): void {
		this.stmts.setListTitle.run(title, Date.now(), id);
	}

	/**
	 * Explicitly set/clear list metadata.
	 * undefined = leave unchanged; null or "" = clear; non-empty string = set.
	 * project_path/description are NOT NULL — "cleared" is stored as ''.
	 */
	setListMeta(id: number, meta: ListMetaInput): void {
		const now = Date.now();
		const cleared = (v: string | null | undefined): string | null =>
			v == null || v === "" ? null : v;
		if (meta.title !== undefined) {
			this.stmts.setListTitle.run(cleared(meta.title), now, id);
		}
		if (meta.project_path !== undefined) {
			const v = cleared(meta.project_path);
			this.stmts.setListProjectPath.run(v === null ? "" : v, now, id);
		}
		if (meta.description !== undefined) {
			const v = cleared(meta.description);
			this.stmts.setListDescription.run(v === null ? "" : v, now, id);
		}
		this.touchList(id);
	}

	deleteList(id: number): void {
		this.stmts.deleteList.run(id);
	}

	/**
	 * Deep-copy one list — its metadata and every task — into a NEW list at
	 * `spec.scope`/`spec.name` in `spec.namespace`.
	 *
	 * Callers run this inside the same transaction that checks namespace rights
	 * and destination availability, so a copy can never resurrect a list that
	 * disappeared in between. The copy is independent: fresh list/task ids, fresh
	 * timestamps, remapped parent links, sibling order and every task field
	 * (status, priority, note, tags, description) preserved, source untouched.
	 */
	copyList(sourceListId: number, spec: ListCopySpec): ListCopyResult {
		const namespace = spec.namespace ?? GLOBAL_NAMESPACE;
		const source = this.stmts.getListById.get(sourceListId) as
			| Omit<ListRow, "path">
			| undefined;
		if (!source) {
			throw new Error(`Source list #${sourceListId} no longer exists.`);
		}
		const targetPath = spec.scope ? `${spec.scope}/${spec.name}` : spec.name;
		if (this.stmts.getList.get(namespace, spec.scope, spec.name)) {
			throw new Error(
				`List '${targetPath}' already exists; a copy needs a new destination list.`,
			);
		}
		const now = Date.now();
		this.stmts.insertFullList.run(
			namespace,
			spec.scope,
			spec.name,
			source.title,
			source.project_path,
			source.description,
			now,
			now,
		);
		let list = this.getList(spec.scope, spec.name, namespace);
		if (!list) throw new Error(`Failed to create list '${targetPath}'.`);

		// The tree query orders by materialized path, so a parent always precedes
		// its children; appending each copied task under its remapped parent
		// reproduces the source's sibling order exactly.
		const rows = this.stmts.tree.all(sourceListId) as TreeRow[];
		const idMap = new Map<number, number>();
		for (const row of rows) {
			let parentId: number | null = null;
			if (row.parent_id != null) {
				const mapped = idMap.get(row.parent_id);
				if (mapped === undefined) {
					throw new Error(
						`Cannot copy task #${row.id}: its parent #${row.parent_id} was not copied first.`,
					);
				}
				parentId = mapped;
			}
			const newId = this.insertTask(list.id, {
				text: row.text,
				status: row.status,
				priority: row.priority,
				note: row.note,
				tags: row.tags ? row.tags.split(",").filter(Boolean) : null,
				description: row.description,
				parentId,
			});
			idMap.set(row.id, newId);
		}
		if (spec.meta) this.setListMeta(list.id, spec.meta);
		list = this.getList(spec.scope, spec.name, namespace) ?? list;
		return { list, copied: rows.length };
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
		tags: string | null;
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
					tags: string | null;
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
				for (const did of ids) this.stmts.updateStatus.run(spec.status, now, did);
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
		namespace: string = GLOBAL_NAMESPACE,
	): (TreeRow & { namespace: string; scope: string; name: string }) | null {
		const row = this.stmts.nextAcross.get(status, namespace) as
			| (TreeRow & { namespace: string; scope: string; name: string })
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
