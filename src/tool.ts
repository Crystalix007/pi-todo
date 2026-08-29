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
	Priority,
	Status,
	TaskNode,
	TodoDb,
	UpdateSpec,
} from "./db.ts";
import { parseListPath } from "./paths.ts";
import {
	DEFAULT_MAX_TREE_LINES,
	countsOfTree,
	headerLine,
	renderLists,
	renderTree,
	sanitize,
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
	"next",
] as const;
export type Action = (typeof ACTIONS)[number];

interface TaskItemInput {
	ref?: string;
	text: string;
	status?: Status;
	priority?: Priority;
	note?: string;
	tags?: string[];
	description?: string;
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
	tags?: string[];
	description?: string;
	status?: Status;
	priority?: Priority;
	cascade?: boolean;
	after?: number;
	format?: "tree" | "flat";
	status_filter?: Status;
}

const StatusEnum = StringEnum(STATUSES, {
	description: "Task status: pending, in_progress, done.",
});

const PriorityEnum = StringEnum(
	["critical", "high", "medium", "low"] as const,
	{
		description: "Task priority: critical, high, medium (default), low.",
	},
);

const TaskItem = Type.Object({
	ref: Type.Optional(
		Type.String({
			description:
				"Stable label unique within this add call (e.g. 'a','b1'). Required only if another item's underRef points here.",
		}),
	),
	text: Type.String({ description: "Task text." }),
	status: Type.Optional(StatusEnum),
	note: Type.Optional(
		Type.String({ description: "Optional detail/note for this task." }),
	),
	underRef: Type.Optional(
		Type.String({
			description:
				"ref of a PARENT item in THIS batch. Omit for a top-level task (or to attach under the top-level 'under' id).",
		}),
	),
	priority: Type.Optional(PriorityEnum),
	tags: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Optional tags (e.g. 'blocked', 'waiting-on-input'). Signal that a task cannot be completed yet.",
		}),
	),
	description: Type.Optional(
		Type.String({
			description:
				"Optional multi-line description with elaboration on what the task involves.",
		}),
	),
});

export const TodoToolParams = Type.Object({
	action: StringEnum(ACTIONS, {
		description:
			"Operation. lists=show all lists; show=view tasks; create=make/ensure a list; add=create task(s); update=edit/check a task; move=reparent/reorder; delete=remove a task; delete_list=remove a list; purge=remove fully-completed branches.",
	}),
	list: Type.Optional(
		Type.String({
			description:
				"List path: '$scope/$name' (scoped) or '/$name' or '$name' (root). Required for every action except 'lists'; optional for 'next' (omitting searches all lists). Subtree ref: append '#<task-id>' to scope show/next to that task and its descendants. Only show/next honor the suffix — other actions ignore it.",
		}),
	),
	scope: Type.Optional(
		Type.String({
			description:
				"(lists) Filter by scope name or segment prefix, e.g. 'feature-auth' matches 'feature-auth' and 'feature-auth/tasks'.",
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
				"(add) Existing parent task id in this list to append the whole batch under. (move) Target parent id; omit to move to top level (appended at the end of the top level).",
		}),
	),
	id: Type.Optional(
		Type.Number({
			description:
				"(update|move|delete) Target task id (a positive integer from this list's tree).",
		}),
	),
	text: Type.Optional(Type.String({ description: "(update) New task text." })),
	note: Type.Optional(
		Type.String({
			description: "(update) New note. Pass empty string '' to clear.",
		}),
	),
	status: Type.Optional(
		StringEnum(STATUSES, {
			description:
				"(next) Status to search for; (update) New status: pending, in_progress, done.",
		}),
	),
	priority: Type.Optional(
		StringEnum(["critical", "high", "medium", "low"] as const, {
			description: "(update) New priority: critical, high, medium, low.",
		}),
	),
	tags: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"(update) Optional tags for the task (e.g. 'blocked', 'waiting-on-input'). Pass empty array [] to clear. (add: set tags per item in items[].tags)",
		}),
	),
	description: Type.Optional(
		Type.String({
			description:
				"(update) Optional multi-line description. Pass empty string '' to clear. (add: set per item in items[].description)",
		}),
	),
	cascade: Type.Optional(
		Type.Boolean({
			description: "(update) Apply status to all descendants too. Default false.",
		}),
	),
	after: Type.Optional(
		Type.Number({
			description:
				"(move) Place after this sibling id (a task in the destination parent's children); omit to append to the end. A non-sibling id is appended silently.",
		}),
	),
	format: Type.Optional(
		StringEnum(["tree", "flat"] as const, {
			description: "(show) 'tree' (default) or 'flat'.",
		}),
	),
	status_filter: Type.Optional(
		StringEnum(STATUSES, {
			description: "(show) Only show tasks with this status.",
		}),
	),
});

function requireListPath(p: TodoParamsInput): ReturnType<typeof parseListPath> {
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
		case "next":
			return doNext(db, p);
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
	const ref = requireListPath(p);
	const { scope, name } = ref;
	const showPath =
		ref.rootTaskId == null ? ref.path : `${ref.path}#${ref.rootTaskId}`;
	const { list, tree, counts } = db.txn(() => {
		const l = db.getList(scope, name);
		if (!l)
			throw new Error(
				`List '${ref.path}' not found. Use action 'lists' to see available lists.`,
			);
		if (ref.rootTaskId != null) {
			const subtree = db.fetchSubtree(l.id, ref.rootTaskId);
			return {
				list: l,
				tree: subtree,
				counts: countsOfTree(subtree),
			};
		}
		return { list: l, tree: db.fetchTree(l.id), counts: db.countsFor(l.id) };
	});
	const content = renderTree(
		{ tree, counts, path: showPath, title: list.title },
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
	const ordered = resolveItemOrder(p.items);

	const result = db.txn(() => {
		const created = db.getList(scope, name) == null;
		const list = db.ensureList(scope, name, null);
		if (p.under !== undefined && p.under !== null) {
			if (p.under <= 0) {
				throw new Error(
					"'under' must be a positive task id (task ids start at 1).",
				);
			}
			// Validate the parent exists in THIS list: a nonexistent id would
			// surface as a raw SQLite FK error, and an id from another list
			// would silently orphan the new task (counted but invisible in the
			// tree, yet still returned by 'next').
			db.getTaskInList(list.id, p.under);
		}
		const refToId = new Map<string, number>();
		const addedIds: number[] = [];
		let added = 0;
		for (const it of ordered) {
			let parentId: number | null;
			if (it.underRef === undefined) {
				parentId = underRoot;
			} else {
				const pid = refToId.get(it.underRef);
				if (pid === undefined) {
					throw new Error(
						`underRef '${it.underRef}' could not be resolved (insert order error).`,
					);
				}
				parentId = pid;
			}
			const spec: InsertSpec = {
				text: it.text,
				status: it.status ?? "pending",
				priority: it.priority ?? "medium",
				note: it.note ?? null,
				tags: it.tags ?? null,
				description: it.description ?? null,
				parentId,
			};
			const newId = db.insertTask(list.id, spec);
			addedIds.push(newId);
			if (it.ref !== undefined) refToId.set(it.ref, newId);
			added++;
		}
		return {
			list,
			added,
			addedIds,
			created,
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
	const addedLine =
		result.addedIds.length > 0
			? `added ${result.added} task(s): #${result.addedIds.join(", #")}`
			: null;
	return ok(
		{
			action: "add",
			list: listRef(result.list),
			tree: result.tree,
			counts: result.counts,
			affected: { added: result.added, created_list: result.created },
			added_items: result.addedIds,
		},
		{
			text: addedLine ? `${addedLine}\n\n${content.text}` : content.text,
			truncated: content.truncated,
		},
	);
}

async function doUpdate(db: TodoDb, p: TodoParamsInput): Promise<ActionResult> {
	const { scope, name, path } = requireListPath(p);
	if (p.id === undefined || p.id === null)
		throw new Error("'id' is required for action 'update'.");
	if (
		p.text === undefined &&
		p.note === undefined &&
		p.status === undefined &&
		p.priority === undefined &&
		p.tags === undefined &&
		p.description === undefined
	) {
		throw new Error(
			"Action 'update' needs at least one of: text, note, status, priority, tags, description.",
		);
	}
	const spec: UpdateSpec = {};
	if (p.text !== undefined) spec.text = p.text;
	if (p.text !== undefined && !p.text.trim()) {
		throw new Error("'text' must be non-empty.");
	}
	if (p.note !== undefined) spec.note = p.note;
	if (p.status !== undefined) spec.status = p.status;
	if (p.priority !== undefined) spec.priority = p.priority;
	if (p.tags !== undefined) spec.tags = p.tags;
	if (p.description !== undefined) spec.description = p.description;
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
		const before = db.countsFor(list.id);
		db.deleteTask(list.id, p.id as number);
		return {
			list,
			before,
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
			action: "delete",
			list: listRef(result.list),
			tree: result.tree,
			counts: result.counts,
			affected: { deleted: result.before.total - result.counts.total },
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

async function doNext(db: TodoDb, p: TodoParamsInput): Promise<ActionResult> {
	const wantedStatus: Status = p.status ?? "pending";

	if (p.list) {
		const ref = requireListPath(p);
		const { scope, name } = ref;
		const result = db.txn(() => {
			const list = db.getList(scope, name);
			if (!list)
				throw new Error(
					`List '${ref.path}' not found. Use action 'lists' to see available lists.`,
				);
			if (ref.rootTaskId != null) {
				const tree = db.fetchSubtree(list.id, ref.rootTaskId);
				return {
					list,
					task: db.nextTaskInSubtree(list.id, ref.rootTaskId, wantedStatus),
					tree,
					counts: countsOfTree(tree),
					path: `${ref.path}#${ref.rootTaskId}`,
				};
			}
			return {
				list,
				task: db.nextTaskWithin(list.id, wantedStatus),
				tree: db.fetchTree(list.id),
				counts: db.countsFor(list.id),
				path: ref.path,
			};
		});
		const treeText = renderTree({
			tree: result.tree,
			counts: result.counts,
			path: result.path,
			title: result.list.title,
		});
		const content = result.task
			? {
					text: `next → #${result.task.id} ${sanitize(result.task.text)}\n\n${treeText.text}`,
					truncated: treeText.truncated,
				}
			: {
					text: `No '${wantedStatus}' tasks found in '${result.path}'. Try a different status or add tasks first.\n\n${treeText.text}`,
					truncated: treeText.truncated,
				};
		return ok(
			{
				action: "next",
				list: listRef(result.list),
				tree: result.tree,
				counts: result.counts,
				next_task: result.task ? nextTaskDetails(result.task) : null,
			},
			content,
		);
	}

	// Search across all lists.
	const result = db.txn(() => {
		const task = db.nextTaskAcross(wantedStatus);
		if (!task) return { found: false as const };
		const scope = task.scope;
		const name = task.name;
		const list = db.getList(scope, name)!;
		const tree = db.fetchTree(list.id);
		const counts = db.countsFor(list.id);
		return { found: true as const, task, list, tree, counts };
	});
	if (!result.found) {
		return ok(
			{
				action: "next",
				tree: [],
				counts: { total: 0, pending: 0, in_progress: 0, done: 0 },
				next_task: null,
			},
			{
				text: `No '${wantedStatus}' tasks found in any list. Try adding tasks first.`,
				truncated: false,
			},
		);
	}
	const path = result.list.scope
		? `${result.list.scope}/${result.list.name}`
		: result.list.name;
	const treeText = renderTree({
		tree: result.tree,
		counts: result.counts,
		path,
		title: result.list.title,
	});
	return ok(
		{
			action: "next",
			list: listRef(result.list),
			tree: result.tree,
			counts: result.counts,
			next_task: nextTaskDetails(result.task),
		},
		{
			text: `next → #${result.task.id} ${sanitize(result.task.text)}\n\n${treeText.text}`,
			truncated: treeText.truncated,
		},
	);
}

/** The single task `next` selected — also included as a `next → #id` line in content. */
function nextTaskDetails(task: {
	id: number;
	text: string;
	status: Status;
	priority: Priority;
	note: string | null;
	tags: string | null;
}): {
	id: number;
	text: string;
	status: Status;
	priority: Priority;
	note: string | null;
	tags: string[] | undefined;
} {
	return {
		id: task.id,
		text: task.text,
		status: task.status,
		priority: task.priority,
		note: task.note,
		tags: task.tags ? task.tags.split(",").filter(Boolean) : undefined,
	};
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
			"Pull the next task with the 'next' action, then mark it in_progress with update (next is read-only and returns next_task:null when the queue is empty).",
			"Scope a subagent's work with a subtree ref: list 'scope/name#id' limits show/next to that task's descendants.",
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
		"Subtree refs: append '#<task-id>' to a list path (e.g. 'feature/auth#7') to scope show/next to that task and its descendants — useful when handing a subagent a focused subset.",
		"",
		"ACTIONS (the 'action' field selects one; relevant fields shown):",
		"- lists: list all TODO lists. Optional 'scope' filters by scope name or segment prefix.",
		"- show {list}: view a list's tasks as a tree. Optional 'format' (tree|flat), 'status_filter'.",
		"- create {list} [title]: create/ensure a list exists (optionally set a title).",
		"- add {list, items[, under]}: add task(s). 'items' is an array; each may have 'priority' (critical|high|medium|low, default medium). Nest via ref/underRef. 'under'=existing task id in THIS list to attach top-level items under.",
		"- update {list, id, text|note|status|priority|tags|description[, cascade]}: edit a task. Pass '' to clear note/description, [] to clear tags.",
		"- move {list, id[, under][, after]}: reparent/reorder. Omitting 'under' moves the task to top level; 'after'=sibling id within the destination parent (a non-sibling id is appended).",
		"- delete {list, id}: remove a task and its whole subtree (reports how many tasks were removed).",
		"- delete_list {list}: remove an entire list and all its tasks.",
		"- purge {list}: remove completed work — deletes any task that is 'done' with no pending descendants (done leaves included). Pending tasks are never deleted.",
		"- next {list?}: get the highest-priority pending task. If 'list' is given, search within it; otherwise search all lists. Optional 'status' to look for e.g. 'in_progress' instead. 'next' is read-only: it does NOT mark the task in_progress — call update with status:'in_progress' when you start work. Returns next_task:null when nothing matches (not an error).",
		"",
		"STATUS is one of: pending, in_progress, done.",
		"Every write returns the affected list's current tree + counts, so you needn't call 'show' afterward. Task ids appear as '#<id>' in the tree.",
		"On errors the tool reports them; use 'show' or 'lists' to discover valid ids/paths.",
	].join("\n");
}

// re-export for index.ts
export { headerLine, DEFAULT_MAX_TREE_LINES };
export type { TaskNode, Status, Counts };
