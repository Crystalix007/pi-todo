/**
 * pi-todo — change receipts.
 *
 * A mutation's `content` is a brief digest, not the whole tree, so the receipt
 * line is what lets an agent verify what it just did without a follow-up read.
 *
 * Rules this module enforces:
 *  - The receipt describes the REAL post-transaction outcome, computed from
 *    before/after snapshots — never from the request alone. A same-value write
 *    reports `no change`, a cascade reports only descendants that actually
 *    moved, and a move reports where the task really landed.
 *  - Destructive clears name what was destroyed (`note cleared (was 142 chars)`)
 *    because brief output may never have shown the old value.
 *  - Long values are summarised, never echoed: receipts stay ~1 line.
 *  - One prefix (`changed:` / `no change:`) so the line is greppable and
 *    unambiguous to a model reading a long transcript.
 */

export type ReceiptPrefix = "changed" | "no change";

/** Fields a task update can touch, in display order. */
const TASK_FIELDS = [
	"text",
	"status",
	"priority",
	"note",
	"tags",
	"description",
] as const;

export interface TaskSnapshot {
	id: number;
	parent_id: number | null;
	status: string;
	priority: string;
	text: string;
	note: string | null;
	tags: string | null;
	description: string | null;
}

export interface ListMetaSnapshot {
	title: string | null;
	project_path: string | null;
	description: string | null;
}

function chars(s: string | null | undefined): number {
	return s == null ? 0 : s.length;
}

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Compact `#13, #14, … #24` with a cap so a 200-task batch stays one clause. */
export function idList(ids: number[], max = 12): string {
	if (ids.length === 0) return "none";
	const sorted = [...ids].sort((a, b) => a - b);
	const shown = sorted.slice(0, max).map((id) => `#${id}`);
	const more = sorted.length - shown.length;
	return more > 0 ? `${shown.join(", ")} (+${more} more)` : shown.join(", ");
}

function prefix(hasChange: boolean): string {
	return hasChange ? "changed" : "no change";
}

function line(hasChange: boolean, clauses: string[]): string {
	return `${prefix(hasChange)}: ${clauses.join("; ")}`;
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

export interface AddedTask {
	id: number;
	parentId: number | null;
}

/**
 * Group added ids by their real parent so a nested batch never implies a single
 * `under`. Auto-created lists are named: a typo'd path silently creating a list
 * is otherwise invisible in a brief digest.
 */
export function addReceipt(args: {
	added: AddedTask[];
	createdList: boolean;
}): string {
	const groups = new Map<number | null, number[]>();
	for (const a of args.added) {
		const list = groups.get(a.parentId) ?? [];
		list.push(a.id);
		groups.set(a.parentId, list);
	}
	const clauses = [`added ${plural(args.added.length, "task")}: ${formatGroups(groups)}`];
	if (args.createdList) clauses.push("new list");
	return line(true, clauses);
}

function formatGroups(groups: Map<number | null, number[]>): string {
	const all = [...groups.values()].flat();
	// A single parent is worth naming; a mixed batch is not — the digest below
	// shows every added task in place, so a long grouping only adds noise.
	if (groups.size === 1) {
		const [parentId] = [...groups.keys()];
		const ids = idList(all);
		return parentId == null ? `${ids} at top level` : `${ids} under #${parentId}`;
	}
	return idList(all);
}

// ---------------------------------------------------------------------------
// update (task)
// ---------------------------------------------------------------------------

/** A status change that `cascade` also applied to descendants. */
export interface CascadeEffect {
	/** Descendants whose status actually changed (excludes the target). */
	changed: number;
	/** Descendants already at the target status. */
	already: number;
	status: string;
}

/**
 * `update` with an id. Every requested field reports set/cleared/unchanged from
 * the real snapshots, so a stray `''` that destroys a note is visible.
 */
export function updateTaskReceipt(args: {
	requested: readonly string[];
	before: TaskSnapshot;
	after: TaskSnapshot;
	cascade?: CascadeEffect | null;
	cascadeIgnored?: boolean;
}): string {
	const { requested, before, after } = args;
	const clauses: string[] = [];
	let changed = false;

	for (const field of TASK_FIELDS) {
		if (!requested.includes(field)) continue;
		const c = fieldClause(field, before, after);
		if (c.changed) changed = true;
		clauses.push(c.text);
	}

	if (args.cascadeIgnored) clauses.push("cascade ignored (no status given)");
	if (args.cascade) {
		const { changed: n, already, status } = args.cascade;
		if (n > 0) {
			changed = true;
			clauses.push(
				`cascade ${plural(n, "subtask")} → ${status}${already > 0 ? ` (${already} already ${status})` : ""}`,
			);
		} else {
			clauses.push(
				`cascade: no descendant status changed${already > 0 ? ` (${already} already ${status})` : ""}`,
			);
		}
	}

	if (clauses.length === 0) return line(false, [`#${before.id} nothing to update`]);
	return line(changed, [`#${before.id} ${clauses.join("; ")}`]);
}

function fieldClause(
	field: (typeof TASK_FIELDS)[number],
	before: TaskSnapshot,
	after: TaskSnapshot,
): { text: string; changed: boolean } {
	switch (field) {
		case "text":
			return before.text === after.text
				? { text: "text unchanged", changed: false }
				: { text: "text set", changed: true };
		case "status":
			return before.status === after.status
				? { text: `status already ${after.status}`, changed: false }
				: {
						text: `status ${before.status} → ${after.status}`,
						changed: true,
					};
		case "priority":
			return before.priority === after.priority
				? { text: `priority already ${after.priority}`, changed: false }
				: {
						text: `priority ${before.priority} → ${after.priority}`,
						changed: true,
					};
		case "note":
			if ((before.note ?? "") === (after.note ?? ""))
				return {
					text: after.note ? "note unchanged" : "note already empty",
					changed: false,
				};
			return after.note
				? { text: `note set (${chars(after.note)} chars)`, changed: true }
				: {
						text: `note cleared (was ${chars(before.note)} chars)`,
						changed: true,
					};
		case "tags":
			if ((before.tags ?? "") === (after.tags ?? ""))
				return {
					text: after.tags ? "tags unchanged" : "tags already empty",
					changed: false,
				};
			if (after.tags)
				return {
					text: `tags set {${after.tags.split(",").join("} {")}}`,
					changed: true,
				};
			return {
				text: `tags cleared (was ${before.tags ? before.tags.split(",").length : 0})`,
				changed: true,
			};
		case "description":
			if ((before.description ?? "") === (after.description ?? ""))
				return {
					text: after.description ? "description unchanged" : "description already empty",
					changed: false,
				};
			return after.description
				? {
						text: `description set (${plural(after.description.split("\n").length, "line")})`,
						changed: true,
					}
				: {
						text: `description cleared (was ${chars(before.description)} chars)`,
						changed: true,
					};
		default:
			// Unreachable: TASK_FIELDS is exhaustive. Kept so a future field cannot
			// silently vanish from the receipt.
			return { text: `${field} updated`, changed: true };
	}
}

// ---------------------------------------------------------------------------
// update (list metadata)
// ---------------------------------------------------------------------------

export function updateListReceipt(args: {
	requested: readonly ("title" | "project_path" | "description")[];
	before: ListMetaSnapshot;
	after: ListMetaSnapshot;
}): string {
	const clauses: string[] = [];
	let changed = false;
	const field = (
		label: string,
		b: string | null | undefined,
		a: string | null | undefined,
	): void => {
		if ((b ?? "") === (a ?? "")) {
			clauses.push(a ? `${label} unchanged` : `${label} already empty`);
			return;
		}
		changed = true;
		if (!a) clauses.push(`${label} cleared (was ${chars(b)} chars)`);
		else clauses.push(`${label} ${b ? "replaced" : "set"} (${chars(a)} chars)`);
	};
	if (args.requested.includes("title"))
		field("title", args.before.title, args.after.title);
	if (args.requested.includes("project_path"))
		field("project", args.before.project_path, args.after.project_path);
	if (args.requested.includes("description"))
		field("goal", args.before.description, args.after.description);
	return line(changed, [`list ${clauses.join("; ")}`]);
}

// ---------------------------------------------------------------------------
// move
// ---------------------------------------------------------------------------

/**
 * Move receipt. `under` omitted means top level; a non-sibling `after` is
 * silently appended by the DB, so the request alone cannot be trusted — the
 * caller passes the placement that actually happened.
 */
export function moveReceipt(args: {
	id: number;
	fromParent: number | null;
	toParent: number | null;
	/** Id the task is really placed after, if it was placed after one. */
	placedAfter?: number | null;
	/** True when `after` was requested but could not be honoured. */
	appendedInstead?: boolean;
	requestedAfter?: number | null;
}): string {
	const where = (p: number | null): string => (p == null ? "top level" : `#${p}`);
	const sameParent = args.fromParent === args.toParent;
	const clauses: string[] = [
		sameParent
			? `#${args.id} reordered`
			: `#${args.id} ${where(args.fromParent)} → ${where(args.toParent)}`,
	];
	if (args.appendedInstead && args.requestedAfter != null)
		clauses.push(`appended (#${args.requestedAfter} is not a sibling)`);
	else if (args.placedAfter != null) clauses.push(`placed after #${args.placedAfter}`);
	else clauses.push("appended at the end");
	return line(true, clauses);
}

// ---------------------------------------------------------------------------
// delete / purge / create / copy
// ---------------------------------------------------------------------------

export function deleteReceipt(args: {
	id: number;
	/** Total tasks removed, including the target. */
	removed: number;
	/** Removed tasks that were not done — the part brief output cannot show again. */
	openRemoved: number;
}): string {
	const subtasks = args.removed - 1;
	const clauses = [`deleted #${args.id}`];
	if (subtasks > 0) clauses.push(`(+${plural(subtasks, "subtask")}${args.openRemoved > 0 ? `, ${args.openRemoved} open` : ""})`);
	return line(true, [clauses.join(" ")]);
}

export function purgeReceipt(removed: number): string {
	return removed === 0
		? line(false, ["nothing to purge (no fully-done branch)"])
		: line(true, [`purged ${plural(removed, "task")}`]);
}

export function createReceipt(args: {
	created: boolean;
	requested: readonly ("title" | "project_path" | "description")[];
	before: ListMetaSnapshot;
	after: ListMetaSnapshot;
}): string {
	if (args.created) {
		const set = args.requested.filter((f) => {
			if (f === "title") return Boolean(args.after.title);
			if (f === "project_path") return Boolean(args.after.project_path);
			return Boolean(args.after.description);
		});
		const label: Record<string, string> = {
			title: "title",
			project_path: "project",
			description: "goal",
		};
		return line(
			true,
			[`list created${set.length > 0 ? `; ${set.map((f) => label[f]).join(", ")} set` : ""}`],
		);
	}
	// An existing list: `create` still applies the metadata it was given, which
	// brief output would otherwise hide entirely.
	const meta = updateListReceipt({
		requested: args.requested,
		before: args.before,
		after: args.after,
	});
	const changed = meta.startsWith("changed");
	return line(changed, [
		`list already existed${changed ? `; ${meta.replace(/^(no change|changed): list /, "")}` : ""}`,
	]);
}

export function copyReceipt(copied: number, from: string): string {
	return line(true, [`copied ${plural(copied, "task")} from '${from}'`]);
}

export function deleteListReceipt(path: string, removed: number, namespace: string): string {
	return `Deleted list '${path}'${namespace ? ` in namespace '${namespace}'` : ""} and ${plural(removed, "task")}.`;
}
