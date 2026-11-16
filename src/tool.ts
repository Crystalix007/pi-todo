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
import { Type, type TUnsafe } from "typebox";

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
import {
	ALL_NAMESPACES,
	GLOBAL_SELECTOR,
	UNBOUND_CALLER,
	assertCanCreateList,
	namespaceLabel,
	resolveNamespace,
	type NamespaceResolution,
	type TodoCaller,
} from "./namespace.ts";
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
	/** Namespace selector (see ./namespace.ts); omitted = the caller's default. */
	namespace?: string;
	list?: string;
	scope?: string;
	title?: string;
	project_path?: string;
	/** (create) Existing list to deep-copy into `list`; the whole list, no '#id'. */
	from?: string;
	/** (create) Namespace of `from`; omitted = the caller's default namespace. */
	from_namespace?: string;
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

/**
 * StringEnum emits pi-schema's `Schema<T>`, which TypeBox cannot recognize as a
 * schema: Optional() fields then lose their optionality and enums widen to
 * unknown in the inferred parameter type. Re-tag the SAME runtime value (a plain
 * `{ type: "string", enum }` JSON schema every provider accepts) as TypeBox's
 * TUnsafe so the schema-derived argument type matches TodoParamsInput.
 */
function stringEnum<const T extends readonly string[]>(
	values: T,
	description: string,
): TUnsafe<T[number]> {
	// SAFETY: StringEnum's pi-schema `Schema<T>` is structurally the plain JSON
	// schema `{ type: "string", enum }` (its `~unsafe` brand is compile-time
	// only), so re-tagging it changes the static type, not the runtime value.
	return StringEnum(values, { description }) as unknown as TUnsafe<T[number]>;
}

const StatusEnum = stringEnum(STATUSES, "Task status: pending, in_progress, done.");

const PriorityEnum = stringEnum(
	["critical", "high", "medium", "low"] as const,
	"Task priority: critical, high, medium (default), low.",
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
	action: stringEnum(
		ACTIONS,
		"Operation. lists=show all lists; show=view tasks; create=make/ensure a list; add=create task(s); update=edit/check a task; move=reparent/reorder; delete=remove a task; delete_list=remove a list; purge=remove fully-completed branches.",
	),
	namespace: Type.Optional(
		Type.String({
			description:
				"Optional namespace, separate from 'list' paths (never a path prefix). Omit it for the caller's default namespace (global, or the namespace this session is bound to). 'global' reaches the shared global lists; '*' lists every namespace (parent sessions only).",
		}),
	),
	list: Type.Optional(
		Type.String({
			description:
				"List path: '$scope/$name' (scoped) or '/$name' or '$name' (root). Required for every action except 'lists'; optional for 'next' (omitting searches all lists in the resolved namespace). Subtree ref: append '#<task-id>' to scope show/next to that task and its descendants. Only show/next honor the suffix — other actions ignore it.",
		}),
	),
	scope: Type.Optional(
		Type.String({
			description:
				"(lists) Filter by scope name or segment prefix, e.g. 'feature-auth' matches 'feature-auth' and 'feature-auth/tasks'.",
		}),
	),
	title: Type.Optional(
		Type.String({
			description:
				"(create) Human title for the list; (update without id) new title. Pass '' to clear.",
		}),
	),
	project_path: Type.Optional(
		Type.String({
			description:
				"(create|update without id) Project directory this list's work belongs to (e.g. the repo path). Echoed in every read of the list — including subtree views handed to subagents — so context survives scoping. Pass '' to clear.",
		}),
	),
	from: Type.Optional(
		Type.String({
			description:
				"(create) Copy this EXISTING source list into 'list': a new, independent list with fresh ids, the same task tree, order and fields. Name the whole list — a '#<task-id>' suffix is rejected. The source is left untouched and an existing destination list is refused, so a copy never merges.",
		}),
	),
	from_namespace: Type.Optional(
		Type.String({
			description:
				"(create with 'from') Namespace of the source list; omitted = your default namespace. Use 'global' to copy a shared list into your own namespace. Rejected without 'from'.",
		}),
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
		stringEnum(
			STATUSES,
			"(next) Status to search for; (update) New status: pending, in_progress, done.",
		),
	),
	priority: Type.Optional(
		stringEnum(
			["critical", "high", "medium", "low"] as const,
			"(update) New priority: critical, high, medium, low.",
		),
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
				"(create|update without id) The list's overall goal — echoed in every read (incl. subtree views). (update with id) Per-task multi-line description. (add: set per item in items[].description) Pass empty string '' to clear.",
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
		stringEnum(["tree", "flat"] as const, "(show) 'tree' (default) or 'flat'."),
	),
	status_filter: Type.Optional(
		stringEnum(STATUSES, "(show) Only show tasks with this status."),
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

/** A resolved namespace plus the caller it was resolved for. */
type CallScope = NamespaceResolution & { caller: TodoCaller };

/**
 * Dispatch a todo action against the DB. Exported for testing without pi.
 *
 * `caller` is the session's immutable namespace binding (see ./namespace.ts):
 * unbound sessions (legacy, parent) default to the global namespace and may
 * target any namespace; bound sessions default to their own namespace and may
 * otherwise only reach existing global lists. Every action resolves through
 * this one policy, so no handler can bypass it.
 */
export async function dispatchTodo(
	db: TodoDb,
	p: TodoParamsInput,
	caller: TodoCaller = UNBOUND_CALLER,
): Promise<ActionResult> {
	const ns: CallScope = { ...resolveNamespace(p.namespace, caller), caller };
	if (ns.allNamespaces && p.action !== "lists") {
		throw new Error(
			`The '${ALL_NAMESPACES}' namespace selector is only valid for action 'lists'. Omit 'namespace' or name a single namespace for '${p.action}'.`,
		);
	}
	switch (p.action) {
		case "lists":
			return doLists(db, p, ns);
		case "show":
			return doShow(db, p, ns);
		case "create":
			return doCreate(db, p, ns);
		case "add":
			return doAdd(db, p, ns);
		case "update":
			return doUpdate(db, p, ns);
		case "move":
			return doMove(db, p, ns);
		case "delete":
			return doDelete(db, p, ns);
		case "delete_list":
			return doDeleteList(db, p, ns);
		case "purge":
			return doPurge(db, p, ns);
		case "next":
			return doNext(db, p, ns);
		default:
			throw new Error(
				`Unknown action '${p.action}'. Valid: ${ACTIONS.join(", ")}.`,
			);
	}
}

/** Extra context for text-only outcomes; keep legacy global wording unchanged. */
function namespaceContext(namespace: string): string {
	return namespace ? ` in namespace '${namespace}'` : "";
}

function ok(
	details: Record<string, unknown>,
	content: RenderedText,
): ActionResult {
	return { content, details: { ...details, truncated: content.truncated } };
}

async function doLists(
	db: TodoDb,
	p: TodoParamsInput,
	ns: CallScope,
): Promise<ActionResult> {
	const lists = db.txn(() =>
		ns.allNamespaces
			? db.getListsAllNamespaces(p.scope?.trim() || undefined)
			: db.getLists(p.scope?.trim() || undefined, ns.namespace),
	);
	const text = renderLists(lists);
	const details: Record<string, unknown> = {
		action: "lists",
		namespace: ns.allNamespaces ? ALL_NAMESPACES : namespaceLabel(ns.namespace),
		lists: lists.map(listSummaryToDetails),
	};
	return ok(details, { text, truncated: false });
}

async function doShow(
	db: TodoDb,
	p: TodoParamsInput,
	ns: CallScope,
): Promise<ActionResult> {
	const ref = requireListPath(p);
	const { scope, name } = ref;
	const showPath =
		ref.rootTaskId == null ? ref.path : `${ref.path}#${ref.rootTaskId}`;
	const { list, tree, counts } = db.txn(() => {
		const l = db.getList(scope, name, ns.namespace);
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
		{
			tree,
			counts,
			path: showPath,
			namespace: ns.namespace,
			title: list.title,
			projectPath: list.project_path,
			description: list.description,
			rootTaskText: ref.rootTaskId == null ? undefined : tree[0]?.text,
		},
		{ format: p.format, statusFilter: p.status_filter },
	);
	return ok(
		{
			action: "show",
			namespace: namespaceLabel(ns.namespace),
			list: listRef(list),
			tree,
			counts,
		},
		content,
	);
}

async function doCreate(
	db: TodoDb,
	p: TodoParamsInput,
	ns: CallScope,
): Promise<ActionResult> {
	const { scope, name, path } = requireListPath(p);
	if (p.from === undefined) {
		if (p.from_namespace !== undefined) {
			throw new Error(
				"'from_namespace' only selects the namespace of a copied source list — pass 'from' with the source list path.",
			);
		}
		return doEnsureList(db, p, ns, { scope, name, path });
	}
	return doCopyList(db, p, ns, p.from, { scope, name, path });
}

async function doEnsureList(
	db: TodoDb,
	p: TodoParamsInput,
	ns: CallScope,
	target: { scope: string; name: string; path: string },
): Promise<ActionResult> {
	const { scope, name, path } = target;
	const { list, tree, counts, created } = db.txn(() => {
		const existing = db.getList(scope, name, ns.namespace);
		// Creation rights are checked inside the transaction so a concurrent
		// delete cannot slip a shared global list in between check and insert.
		if (!existing) assertCanCreateList(ns.caller, ns.namespace, path);
		const l = db.ensureList(
			scope,
			name,
			{
				title: p.title ?? null,
				project_path: p.project_path ?? null,
				description: p.description ?? null,
			},
			ns.namespace,
		);
		return {
			list: l,
			created: existing == null,
			tree: db.fetchTree(l.id),
			counts: db.countsFor(l.id),
		};
	});
	const content = renderTree({
		namespace: ns.namespace,
		tree,
		counts,
		path,
		title: list.title,
		projectPath: list.project_path,
		description: list.description,
	});
	return ok(
		{
			action: "create",
			namespace: namespaceLabel(ns.namespace),
			list: listRef(list),
			tree,
			counts,
			affected: { created_list: created },
		},
		content,
	);
}

/**
 * `create` with `from`: an independent deep copy of one whole existing list.
 *
 * Source and destination are authorized by the same policy as every other
 * action, and the destination's creation rights are checked in the same
 * transaction as the insert: a bound session may copy a global list into its
 * own namespace but cannot copy anything into the shared global namespace.
 */
async function doCopyList(
	db: TodoDb,
	p: TodoParamsInput,
	ns: CallScope,
	from: string,
	target: { scope: string; name: string; path: string },
): Promise<ActionResult> {
	const src = parseListPath(from);
	if (src.rootTaskId != null) {
		throw new Error(
			`'from' must name a whole list: '${from}' selects task #${src.rootTaskId}. Drop the '#${src.rootTaskId}' suffix — copying a subtree is not supported.`,
		);
	}
	const srcNs = resolveNamespace(p.from_namespace, ns.caller);
	if (srcNs.allNamespaces) {
		throw new Error(
			`'from_namespace' must name one namespace; '${ALL_NAMESPACES}' cannot be copied.`,
		);
	}
	const srcLabel = namespaceLabel(srcNs.namespace);

	const result = db.txn(() => {
		const source = db.getList(src.scope, src.name, srcNs.namespace);
		if (!source) {
			throw new Error(
				`Source list '${src.path}' not found in namespace '${srcLabel}'. Use action 'lists' with that namespace to see available lists.`,
			);
		}
		if (
			srcNs.namespace === ns.namespace &&
			src.scope === target.scope &&
			src.name === target.name
		) {
			throw new Error(
				`Source and destination are the same list ('${target.path}' in namespace '${namespaceLabel(ns.namespace)}'); a copy needs a different destination.`,
			);
		}
		if (db.getList(target.scope, target.name, ns.namespace)) {
			throw new Error(
				`List '${target.path}' already exists in namespace '${namespaceLabel(ns.namespace)}'. A copy needs a new destination — choose another list name or delete the destination first.`,
			);
		}
		assertCanCreateList(ns.caller, ns.namespace, target.path);
		const { list, copied } = db.copyList(source.id, {
			namespace: ns.namespace,
			scope: target.scope,
			name: target.name,
			meta: {
				title: p.title,
				project_path: p.project_path,
				description: p.description,
			},
		});
		return {
			list,
			copied,
			tree: db.fetchTree(list.id),
			counts: db.countsFor(list.id),
		};
	});
	const content = renderTree({
		namespace: ns.namespace,
		tree: result.tree,
		counts: result.counts,
		path: target.path,
		title: result.list.title,
		projectPath: result.list.project_path,
		description: result.list.description,
	});
	return ok(
		{
			action: "create",
			namespace: namespaceLabel(ns.namespace),
			list: listRef(result.list),
			source: {
				namespace: srcLabel,
				scope: src.scope,
				name: src.name,
				path: src.path,
			},
			tree: result.tree,
			counts: result.counts,
			affected: { created_list: true, copied: result.copied },
		},
		{
			text: `copied ${result.copied} task(s) from '${src.path}' (namespace '${srcLabel}')\n\n${content.text}`,
			truncated: content.truncated,
		},
	);
}

async function doAdd(
	db: TodoDb,
	p: TodoParamsInput,
	ns: CallScope,
): Promise<ActionResult> {
	const { scope, name, path } = requireListPath(p);
	if (!p.items || p.items.length === 0)
		throw new Error("'items' is required for action 'add'.");
	const underRoot = p.under ?? null;
	const ordered = resolveItemOrder(p.items);

	const result = db.txn(() => {
		const existing = db.getList(scope, name, ns.namespace);
		// Same atomic creation check as 'create': a bound session may add tasks to
		// an existing global list but must not bring a new one into being.
		if (!existing) assertCanCreateList(ns.caller, ns.namespace, path);
		const created = existing == null;
		const list = db.ensureList(scope, name, undefined, ns.namespace);
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
		namespace: ns.namespace,
		tree: result.tree,
		counts: result.counts,
		path,
		title: result.list.title,
		projectPath: result.list.project_path,
		description: result.list.description,
	});
	const addedLine =
		result.addedIds.length > 0
			? `added ${result.added} task(s): #${result.addedIds.join(", #")}`
			: null;
	return ok(
		{
			action: "add",
			namespace: namespaceLabel(ns.namespace),
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

async function doUpdate(
	db: TodoDb,
	p: TodoParamsInput,
	ns: CallScope,
): Promise<ActionResult> {
	const { scope, name, path } = requireListPath(p);

	// No id → list-level metadata update (title / project_path / description).
	if (p.id === undefined || p.id === null) {
		return doUpdateListMeta(db, p, ns, scope, name, path);
	}
	if (p.title !== undefined || p.project_path !== undefined) {
		throw new Error(
			"'title' and 'project_path' are list-level fields — omit 'id' to update the list's metadata (they cannot be combined with a task update).",
		);
	}
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
		const list = db.getList(scope, name, ns.namespace);
		if (!list)
			throw new Error(
				`List '${path}' not found. Use action 'lists' to see available lists.`,
			);
		db.updateTask(list.id, p.id as number, spec);
		return { list, tree: db.fetchTree(list.id), counts: db.countsFor(list.id) };
	});
	const content = renderTree({
		namespace: ns.namespace,
		tree: result.tree,
		counts: result.counts,
		path,
		title: result.list.title,
		projectPath: result.list.project_path,
		description: result.list.description,
	});
	return ok(
		{
			action: "update",
			namespace: namespaceLabel(ns.namespace),
			list: listRef(result.list),
			tree: result.tree,
			counts: result.counts,
			affected: { updated: 1 },
		},
		content,
	);
}

/** `update` without an id: set/clear list-level metadata (title, project_path, description). */
async function doUpdateListMeta(
	db: TodoDb,
	p: TodoParamsInput,
	ns: CallScope,
	scope: string,
	name: string,
	path: string,
): Promise<ActionResult> {
	if (
		p.title === undefined &&
		p.project_path === undefined &&
		p.description === undefined
	) {
		throw new Error(
			"Action 'update' needs a task 'id' to edit a task, or list metadata fields (title, project_path, description) to update the list itself.",
		);
	}
	const result = db.txn(() => {
		const list = db.getList(scope, name, ns.namespace);
		if (!list)
			throw new Error(
				`List '${path}' not found. Use action 'lists' to see available lists.`,
			);
		db.setListMeta(list.id, {
			title: p.title,
			project_path: p.project_path,
			description: p.description,
		});
		const updated = db.getList(scope, name, ns.namespace) ?? list;
		return {
			list: updated,
			tree: db.fetchTree(list.id),
			counts: db.countsFor(list.id),
		};
	});
	const content = renderTree({
		namespace: ns.namespace,
		tree: result.tree,
		counts: result.counts,
		path,
		title: result.list.title,
		projectPath: result.list.project_path,
		description: result.list.description,
	});
	return ok(
		{
			action: "update",
			namespace: namespaceLabel(ns.namespace),
			list: listRef(result.list),
			tree: result.tree,
			counts: result.counts,
			affected: { updated_list: true },
		},
		content,
	);
}

async function doMove(
	db: TodoDb,
	p: TodoParamsInput,
	ns: CallScope,
): Promise<ActionResult> {
	const { scope, name, path } = requireListPath(p);
	if (p.id === undefined || p.id === null)
		throw new Error("'id' is required for action 'move'.");
	const spec: MoveSpec = {};
	if (p.under !== undefined) spec.under = p.under;
	if (p.after !== undefined) spec.after = p.after;

	const result = db.txn(() => {
		const list = db.getList(scope, name, ns.namespace);
		if (!list)
			throw new Error(
				`List '${path}' not found. Use action 'lists' to see available lists.`,
			);
		db.moveTask(list.id, p.id as number, spec);
		return { list, tree: db.fetchTree(list.id), counts: db.countsFor(list.id) };
	});
	const content = renderTree({
		namespace: ns.namespace,
		tree: result.tree,
		counts: result.counts,
		path,
		title: result.list.title,
		projectPath: result.list.project_path,
		description: result.list.description,
	});
	return ok(
		{
			action: "move",
			namespace: namespaceLabel(ns.namespace),
			list: listRef(result.list),
			tree: result.tree,
			counts: result.counts,
			affected: { moved: true },
		},
		content,
	);
}

async function doDelete(
	db: TodoDb,
	p: TodoParamsInput,
	ns: CallScope,
): Promise<ActionResult> {
	const { scope, name, path } = requireListPath(p);
	if (p.id === undefined || p.id === null)
		throw new Error("'id' is required for action 'delete'.");
	const result = db.txn(() => {
		const list = db.getList(scope, name, ns.namespace);
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
		namespace: ns.namespace,
		tree: result.tree,
		counts: result.counts,
		path,
		title: result.list.title,
		projectPath: result.list.project_path,
		description: result.list.description,
	});
	return ok(
		{
			action: "delete",
			namespace: namespaceLabel(ns.namespace),
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
	ns: CallScope,
): Promise<ActionResult> {
	const { scope, name, path } = requireListPath(p);
	const deleted = db.txn(() => {
		const list = db.getList(scope, name, ns.namespace);
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
			namespace: namespaceLabel(ns.namespace),
			list: { namespace: namespaceLabel(ns.namespace), scope, name, path },
			affected: { deleted: deleted.total },
		},
		{
			text: `Deleted list '${path}'${namespaceContext(ns.namespace)} and ${deleted.total} task(s).`,
			truncated: false,
		},
	);
}

async function doPurge(
	db: TodoDb,
	p: TodoParamsInput,
	ns: CallScope,
): Promise<ActionResult> {
	const { scope, name, path } = requireListPath(p);
	const result = db.txn(() => {
		const list = db.getList(scope, name, ns.namespace);
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
		namespace: ns.namespace,
		tree: result.tree,
		counts: result.counts,
		path,
		title: result.list.title,
		projectPath: result.list.project_path,
		description: result.list.description,
	});
	return ok(
		{
			action: "purge",
			namespace: namespaceLabel(ns.namespace),
			list: listRef(result.list),
			tree: result.tree,
			counts: result.counts,
			affected: { deleted: result.removed },
		},
		content,
	);
}

async function doNext(
	db: TodoDb,
	p: TodoParamsInput,
	ns: CallScope,
): Promise<ActionResult> {
	const wantedStatus: Status = p.status ?? "pending";

	if (p.list) {
		const ref = requireListPath(p);
		const { scope, name } = ref;
		const result = db.txn(() => {
			const list = db.getList(scope, name, ns.namespace);
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
			namespace: ns.namespace,
			tree: result.tree,
			counts: result.counts,
			path: result.path,
			title: result.list.title,
			projectPath: result.list.project_path,
			description: result.list.description,
			rootTaskText:
				ref.rootTaskId == null ? undefined : result.tree[0]?.text,
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
				namespace: namespaceLabel(ns.namespace),
				list: listRef(result.list),
				tree: result.tree,
				counts: result.counts,
				next_task: result.task ? nextTaskDetails(result.task) : null,
			},
			content,
		);
	}

	// Search across the lists of the resolved namespace (never other namespaces).
	const result = db.txn(() => {
		const task = db.nextTaskAcross(wantedStatus, ns.namespace);
		if (!task) return { found: false as const };
		const scope = task.scope;
		const name = task.name;
		const list = db.getList(scope, name, task.namespace)!;
		const tree = db.fetchTree(list.id);
		const counts = db.countsFor(list.id);
		return { found: true as const, task, list, tree, counts };
	});
	if (!result.found) {
		return ok(
			{
				action: "next",
				namespace: namespaceLabel(ns.namespace),
				tree: [],
				counts: { total: 0, pending: 0, in_progress: 0, done: 0 },
				next_task: null,
			},
			{
				text: `No '${wantedStatus}' tasks found in any list${namespaceContext(ns.namespace)}. Try adding tasks first.`,
				truncated: false,
			},
		);
	}
	const path = result.list.scope
		? `${result.list.scope}/${result.list.name}`
		: result.list.name;
	const treeText = renderTree({
		namespace: ns.namespace,
		tree: result.tree,
		counts: result.counts,
		path,
		title: result.list.title,
		projectPath: result.list.project_path,
		description: result.list.description,
	});
	return ok(
		{
			action: "next",
			namespace: namespaceLabel(ns.namespace),
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

function listRef(l: {
	namespace?: string;
	scope: string;
	name: string;
	title: string | null;
	project_path?: string | null;
	description?: string | null;
}): {
	namespace: string;
	scope: string;
	name: string;
	path: string;
	title?: string;
	project_path?: string;
	description?: string;
} {
	const path = l.scope ? `${l.scope}/${l.name}` : l.name;
	return {
		namespace: namespaceLabel(l.namespace ?? ""),
		scope: l.scope,
		name: l.name,
		path,
		...(l.title ? { title: l.title } : {}),
		...(l.project_path ? { project_path: l.project_path } : {}),
		...(l.description ? { description: l.description } : {}),
	};
}

function listSummaryToDetails(l: ListSummary): {
	namespace: string;
	scope: string;
	name: string;
	path: string;
	title?: string;
	project_path?: string;
	description?: string;
	counts: Counts;
} {
	return {
		namespace: namespaceLabel(l.namespace),
		scope: l.scope,
		name: l.name,
		path: l.path,
		...(l.title ? { title: l.title } : {}),
		...(l.project_path ? { project_path: l.project_path } : {}),
		...(l.description ? { description: l.description } : {}),
		counts: l.counts,
	};
}

export interface TodoToolDeps {
	getDb: () => Promise<TodoDb>;
	/**
	 * This session's immutable namespace caller (see ./namespace.ts), captured
	 * once by the extension factory (./binding.ts). Omitted means the legacy
	 * unbound caller: global by default, may target any namespace. This module
	 * keeps no mutable module-level policy.
	 */
	caller?: TodoCaller;
}

/** Build the todo tool definition (call pi.registerTool with the result, or spread). */
export function buildTodoToolDef(deps: TodoToolDeps) {
	const caller = deps.caller ?? UNBOUND_CALLER;
	return {
		name: "todo",
		label: "Todo",
		description: buildDescription(caller),
		promptSnippet:
			"Plan and manage hierarchical, named TODO lists (persisted); check off and refine tasks.",
		promptGuidelines: buildGuidelines(caller),
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
			const result = await dispatchTodo(db, params, caller);
			return {
				content: [{ type: "text", text: result.content.text }],
				details: result.details,
			};
		},
	};
}

function buildGuidelines(caller: TodoCaller): string[] {
	const guidelines = [
		"Use the todo tool for planning tasks; create/update tasks via todo rather than writing plan files to disk.",
		"After mutating with todo, the returned tree shows the current state — no need to call todo show again.",
		"Author a whole nested plan in one todo add call using items[] with ref/underRef (e.g. [{ref:'p',text:'Parent'},{text:'Child',underRef:'p'}]).",
		"Pull the next task with the 'next' action, then mark it in_progress with update (next is read-only and returns next_task:null when the queue is empty).",
		"Scope a subagent's work with a subtree ref: list 'scope/name#id' limits show/next to that task's descendants. Set project_path and description (the goal) when creating a list — subtree views echo them so scoped subagents keep the project context.",
	];
	if (caller.kind === "bound") {
		guidelines.push(
			`This todo session is bound to namespace '${caller.namespace}': omit 'namespace' to work there; pass 'global' only for shared lists that already exist (new global lists are refused).`,
		);
	} else {
		guidelines.push(
			"Use namespace:'*' with the todo 'lists' action to discover lists in other namespaces (such as a child session's); omit 'namespace' for the global lists.",
		);
	}
	return guidelines;
}

function buildDescription(caller: TodoCaller): string {
	const namespaceParagraph =
		caller.kind === "bound"
			? `NAMESPACES: optional isolation labels, separate from list paths and scopes — a path or '#id' never carries one. This session is bound to namespace '${caller.namespace}': omit 'namespace' to stay in it. '${GLOBAL_SELECTOR}' reaches the shared global lists — read them and change EXISTING ones, but new global lists cannot be created. Sibling namespaces and '${ALL_NAMESPACES}' are unavailable. create's 'from' copies an existing list into a new list in your namespace. This isolates todo data per API; it is not an OS sandbox.`
			: `NAMESPACES: optional isolation labels, separate from list paths and scopes — a path or '#id' never carries one. Omit 'namespace' for the global namespace; '${ALL_NAMESPACES}' lists every namespace for discovery. create's 'from' copies one existing list into a new, independent list. This isolates todo data per API; it is not an OS sandbox.`;
	return [
		"Manage persistent, named TODO lists with nested tasks. Lists are named '$scope/$name' (scoped) or '/$name' or '$name' (root). State is persisted in SQLite.",
		"",
		"Subtree refs: append '#<task-id>' to a list path (e.g. 'feature/auth#7') to scope show/next to that task and its descendants — useful when handing a subagent a focused subset. Subtree reads still show the list's project path and overall goal, so scoped subagents keep the project context.",
		"",
		namespaceParagraph,
		"",
		"ACTIONS (the 'action' field selects one; relevant fields shown):",
		"- lists: list TODO lists in your default namespace. Optional 'scope' filters by scope name or segment prefix; optional 'namespace' selects another namespace ('global', a namespace the parent assigned, or '*' to see all of them).",
		"- show {list}: view a list's tasks as a tree. Optional 'format' (tree|flat), 'status_filter'.",
		"- create {list} [title] [project_path] [description]: create/ensure a list exists. title = human label; project_path = project directory the work belongs to; description = the overall goal. All three are echoed in every read of the list (including subtree views). With 'from' it instead COPIES that whole existing source list (add 'from_namespace' when the source lives in another namespace, e.g. 'global') into the new destination list: independent copy, fresh task ids, same tree order and task fields, source untouched, and an existing destination is refused. When copying, title/project_path/description override the copied values ('' clears one).",
		"- add {list, items[, under]}: add task(s). 'items' is an array; each may have 'priority' (critical|high|medium|low, default medium). Nest via ref/underRef. 'under'=existing task id in THIS list to attach top-level items under.",
		"- update {list, id, text|note|status|priority|tags|description[, cascade]}: edit a task. Pass '' to clear note/description, [] to clear tags. WITHOUT 'id': updates the list itself instead — title, project_path, description ('' clears a field).",
		"- move {list, id[, under][, after]}: reparent/reorder. Omitting 'under' moves the task to top level; 'after'=sibling id within the destination parent (a non-sibling id is appended).",
		"- delete {list, id}: remove a task and its whole subtree (reports how many tasks were removed).",
		"- delete_list {list}: remove an entire list and all its tasks.",
		"- purge {list}: remove completed work — deletes any task that is 'done' with no pending descendants (done leaves included). Pending tasks are never deleted.",
		"- next {list?}: get the highest-priority pending task. If 'list' is given, search within it; otherwise search the lists of the resolved namespace. Optional 'status' to look for e.g. 'in_progress' instead. 'next' is read-only: it does NOT mark the task in_progress — call update with status:'in_progress' when you start work. Returns next_task:null when nothing matches (not an error).",
		"",
		"STATUS is one of: pending, in_progress, done.",
		"Every write returns the affected list's current tree + counts, so you needn't call 'show' afterward. Task ids appear as '#<id>' in the tree.",
		"On errors the tool reports them; use 'show' or 'lists' to discover valid ids/paths.",
	].join("\n");
}

// re-export for index.ts
export { headerLine, DEFAULT_MAX_TREE_LINES };
export type { TaskNode, Status, Counts };
