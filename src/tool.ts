/**
 * pi-todo — the `todo` agent tool.
 *
 * Single tool with a discriminated `action`. Uses a FLAT-REF schema for one-call
 * nested authoring (recursion-free → provider-safe on Anthropic/Google/OpenAI):
 * each item may carry a `ref` and an `underRef` (the ref of a parent item in the
 * same batch). The tool resolves refs → real ids during insert.
 *
 * Errors are signaled by THROWING (sets isError:true) with actionable messages.
 * Every mutation returns the affected list's tree + counts so no follow-up
 * `show` is needed.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import type {
	Counts,
	InsertSpec,
	ListSummary,
	MoveSpec,
	Status,
	TaskNode,
	TodoDb,
	UpdateSpec,
} from "./db.ts";
import { parseListPath } from "./paths.ts";
import {
	DEFAULT_MAX_TREE_LINES,
	headerLine,
	renderLists,
	renderTree,
	type RenderedText,
} from "./render.ts";

export const STATUSES = ["pending", "in_progress", "done"] as const;
export const ACTIONS = [
	"lists",
	"show",
	"create",
	"add",
	"update",
	"move",
	"delete",
	"delete_list",
	"purge",
] as const;
export type Action = (typeof ACTIONS)[number];

interface TaskItemInput {
	ref?: string;
	text: string;
	status?: Status;
	note?: string;
	underRef?: string;
}

export interface TodoParamsInput {
	action: Action;
	list?: string;
	scope?: string;
	title?: string;
	items?: TaskItemInput[];
	under?: number;
	id?: number;
	text?: string;
	note?: string;
	status?: Status;
	cascade?: boolean;
	after?: number;
	format?: "tree" | "flat";
	status_filter?: Status;
}

const Status = StringEnum(STATUSES);

const TaskItem = Type.Object({
	ref: Type.Optional(
		Type.String({
			description:
				"Stable label unique within this add call (e.g. 'a','b1'). Required only if another item's underRef points here.",
		}),
	),
	text: Type.String({ description: "Task text." }),
	status: Type.Optional(Status),
	note: Type.Optional(
		Type.String({ description: "Optional detail/note for this task." }),
	),
	underRef: Type.Optional(
		Type.String({
			description:
				"ref of a PARENT item in THIS batch. Omit for a top-level task (or to attach under the top-level 'under' id).",
		}),
	),
});

export const TodoToolParams = Type.Object({
	action: StringEnum(ACTIONS, {
		description:
			"Operation. lists=show all lists; show=view tasks; create=make/ensure a list; add=create task(s); update=edit/check a task; move=reporder/reparent; delete=remove a task; delete_list=remove a list; purge=remove fully-completed branches.",
	}),
	list: Type.Optional(
		Type.String({
			description:
				"List path: '$scope/$name' (scoped) or '/$name' or '$name' (root). Required for every action except 'lists'.",
		}),
	),
	scope: Type.Optional(
		Type.String({
			description: "(lists) Filter by exact scope, e.g. 'feature-auth'.",
		}),
	),
	title: Type.Optional(
		Type.String({ description: "(create) Optional human title for the list." }),
	),
	items: Type.Optional(
		Type.Array(TaskItem, {
			description:
				"(add) One or more tasks. Nest via ref/underRef to author a whole plan in one call (e.g. [{ref:'p',text:'Parent'},{text:'Child',underRef:'p'}]).",
		}),
	),
	under: Type.Optional(
		Type.Number({
			description:
				"(add) Existing parent task id to append the whole batch under. (move) target parent id; omit for top-level.",
		}),
	),
	id: Type.Optional(
		Type.Number({ description: "(update|move|delete) Target task id." }),
	),
	text: Type.Optional(Type.String({ description: "(update) New task text." })),
	note: Type.Optional(
		Type.String({
			description: "(update) New note. Pass empty string '' to clear.",
		}),
	),
	status: Type.Optional(Status),
	cascade: Type.Optional(
		Type.Boolean({
			description:
				"(update) Apply status to all descendants too. Default false.",
		}),
	),
	after: Type.Optional(
		Type.Number({
			description:
				"(move) Place after this sibling id; omit to append to the end of the parent's children.",
		}),
	),
	format: Type.Optional(
		StringEnum(["tree", "flat"] as const, {
			description: "(show) 'tree' (default) or 'flat'.",
		}),
	),
	status_filter: Type.Optional(Status),
});

function requireListPath(p: TodoParamsInput): {
	scope: string;
	name: string;
	path: string;
} {
	if (!p.list)
		throw new Error(
			"Parameter 'list' is required for this action. Use '$scope/$name' or '/$name'.",
		);
	return parseListPath(p.list);
}

/** Topologically order items so parents precede children; validate refs. */
function resolveItemOrder(items: TaskItemInput[]): TaskItemInput[] {
	if (items.length === 0)
		throw new Error("'items' must contain at least one task.");
	for (const it of items) {
		if (!it.text || !it.text.trim()) {
			throw new Error("Each task 'text' must be non-empty.");
		}
	}

	const byRef = new Map<string, TaskItemInput>();
	for (const it of items) {
		if (it.ref !== undefined) {
			if (byRef.has(it.ref))
				throw new Error(
					`Duplicate ref '${it.ref}' in items. Each ref must be unique.`,
				);
			byRef.set(it.ref, it);
		}
	}
	for (const it of items) {
		if (it.underRef !== undefined && !byRef.has(it.underRef)) {
			throw new Error(
				`underRef '${it.underRef}' does not match any item's 'ref' in this batch.`,
			);
		}
	}

	const order: TaskItemInput[] = [];
	const state = new Map<TaskItemInput, 0 | 1 | 2>();
	const visit = (it: TaskItemInput): void => {
		const st = state.get(it) ?? 0;
		if (st === 2) return;
		if (st === 1) throw new Error("Cycle detected in items underRef chain.");
		state.set(it, 1);
		if (it.underRef !== undefined) {
			const parent = byRef.get(it.underRef);
			if (parent) visit(parent);
		}
		state.set(it, 2);
		order.push(it);
	};
	for (const it of items) visit(it);
	return order;
}

interface ActionResult {
	content: RenderedText;
	details: Record<string, unknown>;
}

/** Dispatch a todo action against the DB. Exported for testing without pi. */
export async function dispatchTodo(
	db: TodoDb,
	p: TodoParamsInput,
): Promise<ActionResult> {
	switch (p.action) {
		case "lists":
			return doLists(db, p);
		case "show":
			return doShow(db, p);
		case "create":
			return doCreate(db, p);
		case "add":
			return doAdd(db, p);
		case "update":
			return doUpdate(db, p);
		case "move":
			return doMove(db, p);
		case "delete":
			return doDelete(db, p);
		case "delete_list":
			return doDeleteList(db, p);
		case "purge":
			return doPurge(db, p);
		default:
			throw new Error(
				`Unknown action '${p.action}'. Valid: ${ACTIONS.join(", ")}.`,
			);
	}
}

function ok(
	details: Record<string, unknown>,
	content: RenderedText,
): ActionResult {
	return { content, details: { ...details, truncated: content.truncated } };
}

async function doLists(db: TodoDb, p: TodoParamsInput): Promise<ActionResult> {
	const lists = db.txn(() => db.getLists(p.scope?.trim() || undefined));
	const text = renderLists(lists);
	const details: Record<string, unknown> = {
		action: "lists",
		lists: lists.map(listSummaryToDetails),
	};
	return ok(details, { text, truncated: false });
}

async function doShow(db: TodoDb, p: TodoParamsInput): Promise<ActionResult> {
	const { scope, name, path } = requireListPath(p);
	const { list, tree, counts } = db.txn(() => {
		const l = db.getList(scope, name);
		if (!l)
			throw new Error(
				`List '${path}' not found. Use action 'lists' to see available lists.`,
			);
		return { list: l, tree: db.fetchTree(l.id), counts: db.countsFor(l.id) };
	});
	const content = renderTree(
		{ tree, counts, path, title: list.title },
		{ format: p.format, statusFilter: p.status_filter },
	);
	return ok({ action: "show", list: listRef(list), tree, counts }, content);
}

async function doCreate(db: TodoDb, p: TodoParamsInput): Promise<ActionResult> {
	const { scope, name, path } = requireListPath(p);
	const { list, tree, counts } = db.txn(() => {
		const l = db.ensureList(scope, name, p.title ?? null);
		return { list: l, tree: db.fetchTree(l.id), counts: db.countsFor(l.id) };
	});
	const content = renderTree({ tree, counts, path, title: list.title });
	return ok(
		{
			action: "create",
			list: listRef(list),
			tree,
			counts,
			affected: { created_list: true },
		},
		content,
	);
}

async function doAdd(db: TodoDb, p: TodoParamsInput): Promise<ActionResult> {
	const { scope, name, path } = requireListPath(p);
	if (!p.items || p.items.length === 0)
		throw new Error("'items' is required for action 'add'.");
	const underRoot = p.under ?? null;
	if (p.under !== undefined && p.under !== null && p.under <= 0) {
		throw new Error(
			"'under' must be a positive task id (task ids start at 1).",
		);
	}
	const ordered = resolveItemOrder(p.items);

	const result = db.txn(() => {
		const list = db.ensureList(scope, name, null);
		const refToId = new Map<string, number>();
		let added = 0;
		for (const it of ordered) {
			let parentId: number | null;
			if (it.underRef !== undefined) {
				const pid = refToId.get(it.underRef);
				if (pid === undefined) {
					throw new Error(
						`underRef '${it.underRef}' could not be resolved (insert order error).`,
					);
				}
				parentId = pid;
			} else {
				parentId = underRoot;
			}
			const spec: InsertSpec = {
				text: it.text,
				status: it.status ?? "pending",
				note: it.note ?? null,
				parentId,
			};
			const newId = db.insertTask(list.id, spec);
			if (it.ref !== undefined) refToId.set(it.ref, newId);
			added++;
		}
		return {
			list,
			added,
			tree: db.fetchTree(list.id),
			counts: db.countsFor(list.id),
		};
	});

	const content = renderTree({
		tree: result.tree,
		counts: result.counts,
		path,
		title: result.list.title,
	});
	return ok(
		{
			action: "add",
			list: listRef(result.list),
			tree: result.tree,
			counts: result.counts,
			affected: { added: result.added },
		},
		content,
	);
}

async function doUpdate(db: TodoDb, p: TodoParamsInput): Promise<ActionResult> {
	const { scope, name, path } = requireListPath(p);
	if (p.id === undefined || p.id === null)
		throw new Error("'id' is required for action 'update'.");
	if (p.text === undefined && p.note === undefined && p.status === undefined) {
		throw new Error(
			"Action 'update' needs at least one of: text, note, status.",
		);
	}
	const spec: UpdateSpec = {};
	if (p.text !== undefined) spec.text = p.text;
	if (p.text !== undefined && !p.text.trim()) {
		throw new Error("'text' must be non-empty.");
	}
	if (p.note !== undefined) spec.note = p.note;
	if (p.status !== undefined) spec.status = p.status;
	if (p.cascade !== undefined) spec.cascade = p.cascade;

	const result = db.txn(() => {
		const list = db.getList(scope, name);
		if (!list)
			throw new Error(
				`List '${path}' not found. Use action 'lists' to see available lists.`,
			);
		db.updateTask(list.id, p.id as number, spec);
		return { list, tree: db.fetchTree(list.id), counts: db.countsFor(list.id) };
	});
	const content = renderTree({
		tree: result.tree,
		counts: result.counts,
		path,
		title: result.list.title,
	});
	return ok(
		{
			action: "update",
			list: listRef(result.list),
			tree: result.tree,
			counts: result.counts,
			affected: { updated: 1 },
		},
		content,
	);
}

async function doMove(db: TodoDb, p: TodoParamsInput): Promise<ActionResult> {
	const { scope, name, path } = requireListPath(p);
	if (p.id === undefined || p.id === null)
		throw new Error("'id' is required for action 'move'.");
	const spec: MoveSpec = {};
	if (p.under !== undefined) spec.under = p.under;
	if (p.after !== undefined) spec.after = p.after;

	const result = db.txn(() => {
		const list = db.getList(scope, name);
		if (!list)
			throw new Error(
				`List '${path}' not found. Use action 'lists' to see available lists.`,
			);
		db.moveTask(list.id, p.id as number, spec);
		return { list, tree: db.fetchTree(list.id), counts: db.countsFor(list.id) };
	});
	const content = renderTree({
		tree: result.tree,
		counts: result.counts,
		path,
		title: result.list.title,
	});
	return ok(
		{
			action: "move",
			list: listRef(result.list),
			tree: result.tree,
			counts: result.counts,
			affected: { moved: true },
		},
		content,
	);
}

async function doDelete(db: TodoDb, p: TodoParamsInput): Promise<ActionResult> {
	const { scope, name, path } = requireListPath(p);
	if (p.id === undefined || p.id === null)
		throw new Error("'id' is required for action 'delete'.");
	const result = db.txn(() => {
		const list = db.getList(scope, name);
		if (!list)
			throw new Error(
				`List '${path}' not found. Use action 'lists' to see available lists.`,
			);
		db.deleteTask(list.id, p.id as number);
		return { list, tree: db.fetchTree(list.id), counts: db.countsFor(list.id) };
	});
	const content = renderTree({
		tree: result.tree,
		counts: result.counts,
		path,
		title: result.list.title,
	});
	return ok(
		{
			action: "delete",
			list: listRef(result.list),
			tree: result.tree,
			counts: result.counts,
			affected: { deleted: 1 },
		},
		content,
	);
}

async function doDeleteList(
	db: TodoDb,
	p: TodoParamsInput,
): Promise<ActionResult> {
	const { scope, name, path } = requireListPath(p);
	const deleted = db.txn(() => {
		const list = db.getList(scope, name);
		if (!list)
			throw new Error(
				`List '${path}' not found. Use action 'lists' to see available lists.`,
			);
		const counts = db.countsFor(list.id);
		db.deleteList(list.id);
		return counts;
	});
	return ok(
		{
			action: "delete_list",
			list: { scope, name, path },
			affected: { deleted: deleted.total },
		},
		{
			text: `Deleted list '${path}' and ${deleted.total} task(s).`,
			truncated: false,
		},
	);
}

async function doPurge(db: TodoDb, p: TodoParamsInput): Promise<ActionResult> {
	const { scope, name, path } = requireListPath(p);
	const result = db.txn(() => {
		const list = db.getList(scope, name);
		if (!list)
			throw new Error(
				`List '${path}' not found. Use action 'lists' to see available lists.`,
			);
		const removed = db.purgeDone(list.id);
		return {
			list,
			removed,
			tree: db.fetchTree(list.id),
			counts: db.countsFor(list.id),
		};
	});
	const content = renderTree({
		tree: result.tree,
		counts: result.counts,
		path,
		title: result.list.title,
	});
	return ok(
		{
			action: "purge",
			list: listRef(result.list),
			tree: result.tree,
			counts: result.counts,
			affected: { deleted: result.removed },
		},
		content,
	);
}

// ---- details helpers ----

function listRef(l: { scope: string; name: string; title: string | null }): {
	scope: string;
	name: string;
	path: string;
	title?: string;
} {
	const path = l.scope ? `${l.scope}/${l.name}` : l.name;
	return {
		scope: l.scope,
		name: l.name,
		path,
		...(l.title ? { title: l.title } : {}),
	};
}

function listSummaryToDetails(l: ListSummary): {
	scope: string;
	name: string;
	path: string;
	title?: string;
	counts: Counts;
} {
	return {
		scope: l.scope,
		name: l.name,
		path: l.path,
		...(l.title ? { title: l.title } : {}),
		counts: l.counts,
	};
}

export interface TodoToolDeps {
	getDb: () => Promise<TodoDb>;
}

/** Build the todo tool definition (call pi.registerTool with the result, or spread). */
export function buildTodoToolDef(deps: TodoToolDeps) {
	return {
		name: "todo",
		label: "Todo",
		description: buildDescription(),
		promptSnippet:
			"Plan and manage hierarchical, named TODO lists (persisted); check off and refine tasks.",
		promptGuidelines: [
			"Use the todo tool for planning tasks; create/update tasks via todo rather than writing plan files to disk.",
			"After mutating with todo, the returned tree shows the current state — no need to call todo show again.",
			"Author a whole nested plan in one todo add call using items[] with ref/underRef (e.g. [{ref:'p',text:'Parent'},{text:'Child',underRef:'p'}]).",
		],
		parameters: TodoToolParams,
		async execute(
			_toolCallId: string,
			params: TodoParamsInput,
			signal: AbortSignal | undefined,
		): Promise<{
			content: { type: "text"; text: string }[];
			details: Record<string, unknown>;
		}> {
			if (signal?.aborted)
				return { content: [{ type: "text", text: "Cancelled" }], details: {} };
			const db = await deps.getDb();
			const result = await dispatchTodo(db, params);
			return {
				content: [{ type: "text", text: result.content.text }],
				details: result.details,
			};
		},
	};
}

function buildDescription(): string {
	return [
		"Manage persistent, named TODO lists with nested tasks. Lists are named '$scope/$name' (scoped) or '/$name' or '$name' (root). State is persisted in SQLite.",
		"",
		"ACTIONS (the 'action' field selects one; relevant fields shown):",
		"- lists: list all TODO lists. Optional 'scope' filters by exact scope.",
		"- show {list}: view a list's tasks as a tree. Optional 'format' (tree|flat), 'status_filter'.",
		"- create {list} [title]: create/ensure a list exists (optionally set a title).",
		"- add {list, items[, under]}: add task(s). 'items' is an array; nest via ref/underRef. 'under'=existing task id to attach top-level items under.",
		"- update {list, id, text|note|status[, cascade]}: edit a task; 'note':'' clears it; cascade applies status to all descendants.",
		"- move {list, id[, under][, after]}: reparent/reorder. 'under' omits to top-level; 'after'=sibling id to place after.",
		"- delete {list, id}: remove a task and its subtree.",
		"- delete_list {list}: remove an entire list and all its tasks.",
		"- purge {list}: remove completed work — deletes any task that is 'done' with no pending descendants (done leaves included). Pending tasks are never deleted.",
		"",
		"STATUS is one of: pending, in_progress, done.",
		"Every write returns the affected list's current tree + counts, so you needn't call 'show' afterward.",
		"On errors the tool reports them; use 'show' or 'lists' to discover valid ids/paths.",
	].join("\n");
}

// re-export for index.ts
export { headerLine, DEFAULT_MAX_TREE_LINES };
export type { TaskNode, Status, Counts };
