/**
 * pi-todo — output formatters.
 *
 * Plain-ASCII text for the tool `content` (sent to the LLM; must be self-describing
 * since renderResult only runs in TUI). Themed lines for the /todo viewer.
 * Semantic truncation keeps output well under pi's 50KB/2000-line limit.
 */

import type { Counts, ListSummary, Priority, Status, TaskNode } from "./db.ts";
import { PRIORITY_ORDER } from "./db.ts";
import { GLOBAL_NAMESPACE } from "./namespace.ts";

export const DEFAULT_MAX_TREE_LINES = 300;

/** Cap a single rendered line so one giant task field can't dominate output. */
export const MAX_LINE_WIDTH = 500;
/** Byte backstop so a pathological list can't approach pi's 50KB tool limit. */
export const MAX_OUTPUT_BYTES = 24000;

// ---------------------------------------------------------------------------
// Brief (digest) mode — what a mutation returns by default.
//
// Rationale (measured over the operator's real DB, 70 lists / 730 tasks):
//  - 324 of the 343 tasks carrying a note/description are `done`, so collapsing
//    completed branches removes ~90% of the detail mass for free;
//  - the 19 open detail-bearing tasks hold 4.3 KB DB-wide, so inlining THEIR
//    detail costs almost nothing and keeps constraints visible to the agent
//    that is about to do the work (and to a subagent handed `list#id`);
//  - pi serializes each tool result truncated to 2000 chars when compacting, so
//    a digest under ~2 KB keeps the plan state legible in a summary.
// ---------------------------------------------------------------------------

/** Body-line budget for brief mode (header, receipt and trailer excluded). */
export const BRIEF_MAX_LINES = 60;
/** UTF-8 backstop for brief mode — a safety net, not the routine path (max real render: 3.4 KB). */
export const BRIEF_MAX_BYTES = 6144;
/** Brief headers shorten metadata (a goal is a decision log; full reads keep all of it). */
export const BRIEF_GOAL_CAP = 320;
export const BRIEF_PROJECT_CAP = 120;
/** Brief inline detail caps (full mode keeps the wider 3-line description cap). */
export const BRIEF_NOTE_CAP = 300;
export const BRIEF_DESC_LINES = 3;

const EMPTY_IDS: ReadonlySet<number> = new Set();

/** Collapse control chars (incl. newlines/tabs) so a task can't break the tree layout. */
export function sanitize(s: string): string {
	const collapsed = (s ?? "").replace(/[\x00-\x1f\x7f]+/g, " ").trim();
	return collapsed.length > MAX_LINE_WIDTH
		? `${collapsed.slice(0, MAX_LINE_WIDTH - 1)}…`
		: collapsed;
}

export const GLYPH: Record<Status, string> = {
	pending: "[ ]",
	in_progress: "[~]",
	done: "[x]",
};

/** One-char priority tags shown at end of task lines (medium is the default — omitted). */
export const PRIORITY_TAG: Record<Priority, string> = {
	critical: " [!]",
	high: " [↑]",
	medium: "",
	low: " [↓]",
};

export interface TreeView {
	tree: TaskNode[];
	counts: Counts;
	path: string;
	title?: string | null;
	/**
	 * One-line change receipt shown under the header (mutations only). It is
	 * derived from the real post-transaction state, so it never contradicts the
	 * tree below it.
	 */
	change?: string | null;
	/** Root task text shown in header for subtree views. */
	rootTaskText?: string;
	/** Project directory the list belongs to — echoed in every header. */
	projectPath?: string | null;
	/** The list's overall goal — echoed in every header (incl. subtree views). */
	description?: string | null;
	/**
	 * Storage namespace the list lives in. "" is the shared global namespace and
	 * renders nothing, so every legacy/global header stays byte-identical; a
	 * named namespace adds an explicit `namespace: <name>` part.
	 */
	namespace?: string;
}

export type SortMode = "creation" | "completion" | "priority";

export const SORT_MODES: SortMode[] = ["creation", "completion", "priority"];

export const SORT_LABEL: Record<SortMode, string> = {
	creation: "creation",
	completion: "completion",
	priority: "priority",
};

/**
 * `full` renders every task with its note and description (the explicit read).
 * `brief` is the mutation digest: open tasks keep their detail inline, completed
 * branches collapse to `(+N done)`, and a trailer names anything omitted.
 */
export type Detail = "brief" | "full";

export interface ShowOpts {
	format?: "tree" | "flat";
	statusFilter?: Status;
	maxLines?: number;
	sort?: SortMode;
	showDescriptions?: boolean;
	detail?: Detail;
	/** Task this render is focused on (`next`): marked, and never collapsed away. */
	focus?: number | null;
	/** Tasks this call touched: always rendered, never collapsed away. */
	touched?: ReadonlySet<number>;
}

export interface RenderedText {
	text: string;
	/**
	 * Task rows were deliberately left out to fit the budget (never routine
	 * collapsing). Named `elided`, not `truncated`: the text is complete as
	 * emitted, and the omission is always announced in its own trailer.
	 */
	elided: boolean;
}

const STATUS_ORDER: Record<Status, number> = {
	done: 3,
	in_progress: 2,
	pending: 1,
};

/** Recursively sort a task tree by the given mode. Mutates in place. */
export function sortTree(tree: TaskNode[], mode: SortMode): void {
	const cmp =
		mode === "completion"
			? (a: TaskNode, b: TaskNode): number => {
					const s = STATUS_ORDER[b.status] - STATUS_ORDER[a.status];
					if (s !== 0) return s;
					const p = PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority];
					if (p !== 0) return p;
					return a.id - b.id;
				}
			: mode === "priority"
				? (a: TaskNode, b: TaskNode): number => {
						const p = PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority];
						if (p !== 0) return p;
						const s = STATUS_ORDER[b.status] - STATUS_ORDER[a.status];
						if (s !== 0) return s;
						return a.id - b.id;
					}
				: () => 0; // creation: keep DB order
	tree.sort(cmp);
	for (const n of tree) sortTree(n.children, mode);
}

/** Compute whole-list counts by walking the tree. */
export function countsOfTree(tree: TaskNode[]): Counts {
	const c: Counts = { total: 0, pending: 0, in_progress: 0, done: 0 };
	const walk = (nodes: TaskNode[]): void => {
		for (const n of nodes) {
			c.total++;
			c[n.status]++;
			walk(n.children);
		}
	};
	walk(tree);
	return c;
}

/** Truncate at a word boundary at or below `max` chars, appending an ellipsis. */
export function capAtWord(s: string, max: number): string {
	if (s.length <= max) return s;
	const cut = s.slice(0, max);
	const space = cut.lastIndexOf(" ");
	const kept = space > max * 0.6 ? cut.slice(0, space) : cut;
	return `${kept.trimEnd()}…`;
}

export interface HeaderOpts {
	/**
	 * Brief headers word-cap `project`/`goal` so a decision-log goal cannot dominate
	 * a mutation response. Full reads and the TUI stay byte-identical.
	 */
	brief?: boolean;
}

export function headerLine(view: TreeView, opts: HeaderOpts = {}): string {
	const { counts, path, title, rootTaskText, projectPath, description } = view;
	let namePart = path;
	if (rootTaskText) namePart += ` "${rootTaskText}"`;
	if (title) namePart += `  (${title})`;
	const parts = [namePart];
	if (view.namespace && view.namespace !== GLOBAL_NAMESPACE)
		parts.push(`namespace: ${sanitize(view.namespace)}`);
	// Project context travels with every read — including subtree views — so a
	// subagent given `list#id` still knows the project and the overall goal.
	const cap = (s: string, max: number): string =>
		opts.brief ? capAtWord(s, max) : s;
	if (projectPath && projectPath.trim())
		parts.push(`project: ${cap(sanitize(projectPath), BRIEF_PROJECT_CAP)}`);
	if (description && description.trim())
		parts.push(`goal: ${cap(sanitize(description), BRIEF_GOAL_CAP)}`);
	parts.push(`${counts.done}/${counts.total} done`);
	if (counts.in_progress > 0) parts.push(`${counts.in_progress} in progress`);
	return parts.join("  ·  ");
}

interface Line {
	depth: number;
	glyph: string;
	id: number;
	text: string;
	priority: Priority;
	note?: string | null;
	tags?: string[] | null;
	description?: string | null;
}

/** Flatten the tree into display lines (depth-first, sibling order). */
export function flatten(tree: TaskNode[], opts: ShowOpts): Line[] {
	const out: Line[] = [];
	const filter = opts.statusFilter;
	const walk = (nodes: TaskNode[], depth: number): void => {
		for (const n of nodes) {
			if (!filter || n.status === filter) {
				out.push({
					depth,
					glyph: GLYPH[n.status],
					id: n.id,
					text: n.text,
					priority: n.priority,
					note: n.note,
					tags: n.tags,
					description: n.description,
				});
			}
			walk(n.children, filter ? depth : depth + 1);
		}
	};
	walk(tree, 0);
	return out;
}

function formatTagsPlain(tags: string[] | undefined | null): string {
	if (!tags || tags.length === 0) return "";
	return ` {${tags.join("} {")}}`;
}

function formatDescPlain(l: Line, indent: string): string[] {
	const desc = l.description;
	if (!desc || !desc.trim()) return [];
	const pad = `${indent}  ▸ `;
	const lines = desc.split("\n");
	const capped = lines.slice(0, 3);
	const out = capped.map((s) => `${pad}${sanitize(s)}`);
	if (lines.length > 3) out.push(`${pad}…`);
	return out;
}

function plainLine(l: Line, indented: boolean): string[] {
	const indent = indented ? "  ".repeat(l.depth) : "";
	const lines = [
		`${indent}${l.glyph} #${l.id} ${sanitize(l.text)}${PRIORITY_TAG[l.priority]}${formatTagsPlain(l.tags)}`,
	];
	if (l.note) lines.push(`${indent}  · ${sanitize(l.note)}`);
	for (const dl of formatDescPlain(l, indent)) lines.push(dl);
	return lines;
}

/** Does this subtree still contain work? A done branch with open descendants is NOT collapsible. */
export function hasOpenDescendant(n: TaskNode): boolean {
	return n.children.some(
		(c) => c.status !== "done" || hasOpenDescendant(c),
	);
}

/** Number of descendants (any status) below `n`. */
export function descendantCount(n: TaskNode): number {
	return n.children.reduce((sum, c) => sum + 1 + descendantCount(c), 0);
}

function hasDetail(n: TaskNode): boolean {
	return Boolean(
		(n.note && n.note.trim()) || (n.description && n.description.trim()),
	);
}

/** One rendered task block: its own line(s), so a hard cut can drop whole tasks. */
interface Block {
	id: number;
	lines: string[];
}

interface BriefStats {
	/** Descendants hidden inside collapsed done branches (routine, not truncation). */
	collapsedDone: number;
	/** Done task lines dropped for size (truncation). */
	omittedDone: number;
	/** Tasks whose note/description was shortened by the brief caps. */
	trimmedDetail: number;
}

/** Would collapsing this branch hide a task the current call just touched? */
function hidesTouched(n: TaskNode, touched: ReadonlySet<number>): boolean {
	return n.children.some((c) => touched.has(c.id) || hidesTouched(c, touched));
}

function briefBlock(
	n: TaskNode,
	depth: number,
	opts: {
		dropDone: boolean;
		focus?: number | null;
		detail?: boolean;
		touched?: ReadonlySet<number>;
	},
	stats: BriefStats,
): Block | null {
	const indent = "  ".repeat(depth);
	const isFocus = opts.focus === n.id;
	const head = `${indent}${GLYPH[n.status]} #${n.id} ${sanitize(n.text)}${PRIORITY_TAG[n.priority]}${formatTagsPlain(n.tags)}`;
	const touched = opts.touched ?? EMPTY_IDS;

	// A done branch with no open descendant is history: one line, with a count.
	// The exception is a branch that would hide a task this call just changed —
	// a receipt naming an id the digest cannot show is worse than the bytes.
	if (n.status === "done" && !hasOpenDescendant(n) && !hidesTouched(n, touched)) {
		const hidden = descendantCount(n);
		if (opts.dropDone) {
			stats.omittedDone += 1 + hidden;
			return null;
		}
		stats.collapsedDone += hidden;
		return { id: n.id, lines: [hidden > 0 ? `${head}  (+${hidden} done)` : head] };
	}

	const lines = [isFocus ? `${head}  ← next` : head];
	// Only OPEN work keeps its detail inline: that text is the constraint the
	// agent (or the subagent holding `list#id`) needs before touching the task.
	if (opts.detail !== false && n.status !== "done" && hasDetail(n)) {
		if (n.note && n.note.trim()) {
			const note = sanitize(n.note);
			if (note.length > BRIEF_NOTE_CAP) stats.trimmedDetail++;
			lines.push(`${indent}  · ${capAtWord(note, BRIEF_NOTE_CAP)}`);
		}
		if (n.description && n.description.trim()) {
			const all = n.description.split("\n").map(sanitize).filter(Boolean);
			if (all.length > BRIEF_DESC_LINES) stats.trimmedDetail++;
			for (const dl of all.slice(0, BRIEF_DESC_LINES))
				lines.push(`${indent}  ▸ ${dl}`);
			if (all.length > BRIEF_DESC_LINES) lines.push(`${indent}  ▸ …`);
		}
	}
	return { id: n.id, lines };
}

function briefBody(
	tree: TaskNode[],
	opts: {
		dropDone: boolean;
		focus?: number | null;
		touched?: ReadonlySet<number>;
	},
	stats: BriefStats,
): Block[] {
	const out: Block[] = [];
	const touched = opts.touched ?? EMPTY_IDS;
	const walk = (nodes: TaskNode[], depth: number): void => {
		for (const n of nodes) {
			const block = briefBlock(n, depth, opts, stats);
			if (block) out.push(block);
			// A collapsed or dropped branch is summarised on its own line: its
			// descendants are counted there, never rendered underneath.
			if (!block) continue;
			if (n.status === "done" && !hasOpenDescendant(n) && !hidesTouched(n, touched))
				continue;
			walk(n.children, depth + 1);
		}
	};
	walk(tree, 0);
	return out;
}

function briefTrailer(
	stats: BriefStats,
	view: TreeView,
	cutTasks: number,
): string[] {
	const parts: string[] = [];
	if (stats.collapsedDone > 0)
		parts.push(`${stats.collapsedDone} done task(s) collapsed`);
	if (stats.omittedDone > 0)
		parts.push(`${stats.omittedDone} done task(s) omitted for size`);
	if (stats.trimmedDetail > 0)
		parts.push(`${stats.trimmedDetail} note(s)/description(s) shortened`);
	if (cutTasks > 0)
		parts.push(`${cutTasks} open task(s) over the size budget`);
	if (parts.length === 0) return [];
	const hint =
		cutTasks > 0
			? `Narrow with show '${view.path}#<id>' or status_filter; show '${view.path}', detail:"full" for everything.`
			: `show '${view.path}', detail:"full" for everything.`;
	return [`… ${parts.join("; ")}. ${hint}`];
}

/** Render a list view to plain text (for the LLM / non-TUI modes). */
export function renderTree(view: TreeView, opts: ShowOpts = {}): RenderedText {
	return opts.detail === "brief"
		? renderBrief(view, opts)
		: renderFull(view, opts);
}

/**
 * Brief digest: the mutation default. Header, change receipt, structure with
 * open-task detail inline, completed branches collapsed, and a trailer that
 * names anything omitted. Never silently drops anything the caller asked for.
 */
export function renderBrief(view: TreeView, opts: ShowOpts = {}): RenderedText {
	const head = [headerLine(view, { brief: true })];
	if (opts.statusFilter) head.push("[x]=done  [ ]=pending  [~]=in progress");
	if (view.change) head.push(view.change);
	if (view.counts.total === 0) {
		head.push("(empty list — add tasks with action 'add')");
		return { text: head.join("\n"), elided: false };
	}

	// Collapse routinely. Only if the result is still too big do we drop done
	// rows — and that is reported as size elision, never as routine collapse.
	const stats: BriefStats = {
		collapsedDone: 0,
		omittedDone: 0,
		trimmedDetail: 0,
	};
	let blocks = briefBody(
		view.tree,
		{ dropDone: false, focus: opts.focus, touched: opts.touched },
		stats,
	);
	const tooBig =
		blocks.length > BRIEF_MAX_LINES ||
		Buffer.byteLength(
			[...head, ...blocks.flatMap((b) => b.lines)].join("\n"),
			"utf-8",
		) > BRIEF_MAX_BYTES;
	if (tooBig) {
		const droppedStats: BriefStats = {
			collapsedDone: stats.collapsedDone,
			omittedDone: 0,
			trimmedDetail: stats.trimmedDetail,
		};
		const dropped = briefBody(
			view.tree,
			{ dropDone: true, focus: opts.focus, touched: opts.touched },
			droppedStats,
		);
		// Only adopt the slimmer view if it actually helps; never claim rows were
		// omitted for size while still showing them.
		if (dropped.length < blocks.length) {
			blocks = dropped;
			stats.omittedDone = droppedStats.omittedDone;
		}
	}

	// Hard cut: drop whole task blocks from the end until both budgets hold.
	const countBlockLines = (bs: Block[]): number =>
		bs.reduce((sum, b) => sum + b.lines.length, 0);
	let cutTasks = 0;
	const overBudget = (): boolean => {
		const body = blocks
			.slice(0, blocks.length - cutTasks)
			.flatMap((b) => b.lines);
		const text = [...head, ...body, ""].join("\n");
		return (
			countBlockLines(blocks.slice(0, blocks.length - cutTasks)) >
				BRIEF_MAX_LINES || Buffer.byteLength(text, "utf-8") > BRIEF_MAX_BYTES
		);
	};
	while (blocks.length - cutTasks > 0 && overBudget()) cutTasks++;

	const kept = blocks.slice(0, blocks.length - cutTasks);
	const lines = [...head, ...kept.flatMap((b) => b.lines)];
	lines.push(...briefTrailer(stats, view, cutTasks));

	let text = lines.join("\n");
	// Absolute backstop: the trailer (which must never be elided) can itself be
	// large only in pathological cases; keep the promise honest if it happens.
	if (Buffer.byteLength(text, "utf-8") > BRIEF_MAX_BYTES) {
		text = `${text.slice(0, BRIEF_MAX_BYTES - 120)}\n… output cut at ~${BRIEF_MAX_BYTES} bytes; narrow with a subtree ref ('list#id').`;
	}
	return {
		text,
		elided: cutTasks > 0 || stats.omittedDone > 0,
	};
}

/** Full rendering: every task with its note and description (today's format). */
function renderFull(view: TreeView, opts: ShowOpts = {}): RenderedText {
	const maxLines = opts.maxLines ?? DEFAULT_MAX_TREE_LINES;
	const lines: string[] = [headerLine(view)];
	if (opts.statusFilter || view.counts.total === 0) {
		lines.push("[x]=done  [ ]=pending  [~]=in progress");
	}
	if (view.change) lines.push(view.change);
	if (view.counts.total === 0) {
		lines.push("(empty list — add tasks with action 'add')");
		return { text: lines.join("\n"), elided: false };
	}

	// A status filter always flattens (structure is lost when filtering).
	const flat = opts.format === "flat" || opts.statusFilter != null;
	const display = flatten(view.tree, opts);

	const budget = Math.max(5, maxLines - lines.length);
	let elided = false;
	let emitted = 0;
	let tasksEmitted = 0;
	for (const l of display) {
		const seg = plainLine(l, !flat); // tree mode indents; flat mode no indent
		let taskStarted = false;
		for (const s of seg) {
			if (emitted >= budget) {
				elided = true;
				break;
			}
			lines.push(s);
			emitted++;
			if (!taskStarted) {
				taskStarted = true;
				tasksEmitted++;
			}
		}
		if (elided) break;
	}

	if (elided) {
		// display.length counts TASKS; emitted counts rendered LINES (a task can
		// also render note + description lines), so the remaining-task count must
		// be tracked separately or it can go negative.
		const remaining = display.length - tasksEmitted;
		lines.push(
			`… ${remaining} more task(s) omitted. Narrow with status_filter ('pending'|'in_progress'|'done') or a subtree ref ('list#id').`,
		);
	}
	let text = lines.join("\n");
	// Byte backstop: a single oversized field (after line capping) still can't blow context.
	// Measured in UTF-8 bytes: the glyphs above are multi-byte, so length lies.
	if (Buffer.byteLength(text, "utf-8") > MAX_OUTPUT_BYTES) {
		text = `${text.slice(0, MAX_OUTPUT_BYTES - 120)}\n… output cut at ~${MAX_OUTPUT_BYTES} bytes; narrow with status_filter or a subtree ref ('list#id').`;
		elided = true;
	}
	return { text, elided };
}

/** Locate a task and its ancestor chain (root → task) within a fetched tree. */
export function findChain(
	tree: TaskNode[],
	id: number,
): TaskNode[] | null {
	for (const n of tree) {
		if (n.id === id) return [n];
		const below = findChain(n.children, id);
		if (below) return [n, ...below];
	}
	return null;
}

/** Body-line budget for the focus window (header/pick line excluded). */
export const FOCUS_MAX_LINES = 40;

/**
 * Long-form detail for the task a `next` call picked: this text is the
 * instruction set for the work about to start, so it is reproduced in full
 * (line-split, one sanitized line at a time) rather than word-capped.
 */
function focusDetail(n: TaskNode): string[] {
	const out: string[] = [];
	if (n.note && n.note.trim()) {
		const noteLines = n.note.split("\n").filter((s) => s.trim());
		for (const s of noteLines.slice(0, 6)) out.push(`  note: ${sanitize(s)}`.replace(/\s+/g, " "));
		if (noteLines.length > 6) out.push("  note: …");
	}
	if (n.description && n.description.trim()) {
		const dl = n.description.split("\n").filter((s) => s.trim());
		for (const s of dl.slice(0, 4)) out.push(`  ▸ ${sanitize(s)}`);
		if (dl.length > 4) out.push("  ▸ …");
	}
	return out;
}

/**
 * Focus window for `next`: the picked task (with its detail), its ancestor
 * chain, its siblings around it, and its own open children. Everything the
 * agent needs to start the task without a follow-up read, bounded in size.
 */
export function renderFocus(
	view: TreeView,
	focusId: number,
	opts: ShowOpts = {},
): RenderedText {
	const chain = findChain(view.tree, focusId);
	if (!chain || chain.length === 0) return renderBrief(view, opts);
	const node = chain[chain.length - 1];
	if (!node) return renderBrief(view, opts);

	// The pick, its detail and its ancestor chain always survive (they are the
	// answer); only the surrounding window is bounded below.
	const lines: string[] = [headerLine(view)]; // full header: a scoped agent's primary context read
	lines.push(
		`next → #${node.id} ${sanitize(node.text)}  ·  ${node.status}, ${node.priority}`,
	);
	lines.push(...focusDetail(node));

	const stats: BriefStats = {
		collapsedDone: 0,
		omittedDone: 0,
		trimmedDetail: 0,
	};
	const depth = chain.length - 1;
	const parent = depth > 0 ? chain[depth - 1] : undefined;
	const siblings = parent ? parent.children : view.tree;

	for (let i = 0; i < depth; i++) {
		const ancestor = chain[i];
		if (!ancestor) continue;
		// Ancestors are the scoping chain, one line each: their detail belongs in
		// `show`, not in a window the agent did not ask for.
		const block = briefBlock(ancestor, i, { dropDone: false, detail: false }, stats);
		if (block) lines.push(...block.lines);
	}

	// Window blocks: siblings around the pick, then the picked task's children.
	const window: Block[] = [];
	const siblingBlocks: Block[] = [];
	for (const s of siblings) {
		const block = briefBlock(
			s,
			depth,
			{ dropDone: false, focus: node.id },
			stats,
		);
		if (block) siblingBlocks.push(block);
	}
	const at = siblingBlocks.findIndex((b) => b.id === node.id);
	const SIBLING_WINDOW = 12;
	if (siblingBlocks.length > SIBLING_WINDOW && at >= 0) {
		const from = Math.max(0, at - 5);
		const to = Math.min(siblingBlocks.length, from + SIBLING_WINDOW);
		if (from > 0) window.push({ id: -1, lines: [`… ${from} earlier sibling(s)`] });
		window.push(...siblingBlocks.slice(from, to));
		if (to < siblingBlocks.length)
			window.push({
				id: -2,
				lines: [`… ${siblingBlocks.length - to} later sibling(s)`],
			});
	} else {
		window.push(...siblingBlocks);
	}
	for (const c of node.children) {
		const block = briefBlock(c, depth + 1, { dropDone: false }, stats);
		if (block) window.push(block);
	}

	// Bound the window by dropping whole trailing blocks (never mid-block).
	const lineCount = (bs: Block[]): number =>
		bs.reduce((sum, b) => sum + b.lines.length, 0);
	let cut = 0;
	while (
		window.length - cut > 0 &&
		lines.length + lineCount(window.slice(0, window.length - cut)) >
			FOCUS_MAX_LINES
	)
		cut++;
	const kept = window.slice(0, window.length - cut);
	lines.push(...kept.flatMap((b) => b.lines));
	const cutTasks = window.slice(window.length - cut).filter((b) => b.id > 0).length;
	if (cut > 0)
		lines.push(
			`… ${cutTasks > 0 ? `${cutTasks} more task(s)` : "more context"} elided; show '${view.path}#${node.id}' for the full subtree.`,
		);
	return { text: lines.join("\n"), elided: cut > 0 };
}

/** Render the list-of-lists to plain text. */
export function renderLists(lists: ListSummary[]): string {
	if (lists.length === 0) {
		return "No TODO lists yet. Create one with action 'create' or 'add' (lists auto-create on first add).";
	}
	const lines = [`TODO lists (${lists.length}):`];
	for (const l of lists) {
		const titlePart = l.title ? `  (${l.title})` : "";
		const projPart = l.project_path
			? `  ·  project: ${sanitize(l.project_path)}`
			: "";
		// Only namespaced lists are labelled; global output is unchanged.
		const nsPart =
			l.namespace && l.namespace !== GLOBAL_NAMESPACE
				? `  ·  namespace: ${sanitize(l.namespace)}`
				: "";
		lines.push(
			`  ${l.path}${titlePart}${projPart}${nsPart}  ·  ${l.counts.done}/${l.counts.total} done`,
		);
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Themed rendering for the /todo TUI viewer
// ---------------------------------------------------------------------------

export interface ThemeLike {
	fg(color: string, text: string): string;
	bold?(text: string): string;
}

const PRIORITY_COLOR: Record<Priority, string> = {
	critical: "error",
	high: "warning",
	medium: "muted",
	low: "dim",
};

const STATUS_COLOR: Record<Status, string> = {
	pending: "dim",
	in_progress: "warning",
	done: "success",
};

/** Theme-colored lines for the TUI viewer (no truncation cap — full screen). */
export function themedTreeLines(
	view: TreeView,
	theme: ThemeLike,
	opts: ShowOpts = {},
): string[] {
	const out: string[] = [
		theme.bold ? theme.bold(headerLine(view)) : headerLine(view),
	];
	if (view.counts.total === 0) {
		out.push(theme.fg("dim", "(empty list)"));
		return out;
	}
	const flat = opts.format === "flat" || opts.statusFilter != null;
	const showDesc = opts.showDescriptions === true;
	for (const l of flatten(view.tree, opts)) {
		const indent = flat ? "" : "  ".repeat(l.depth);
		const glyph = theme.fg(
			STATUS_COLOR[
				l.glyph === "[x]" ? "done" : l.glyph === "[~]" ? "in_progress" : "pending"
			],
			l.glyph,
		);
		const id = theme.fg("accent", `#${l.id}`);
		const rawText = sanitize(l.text);
		const text =
			l.glyph === "[x]" ? theme.fg("dim", rawText) : theme.fg("text", rawText);
		const prioTag = PRIORITY_TAG[l.priority];
		const prio = prioTag ? theme.fg(PRIORITY_COLOR[l.priority], prioTag) : "";
		const tagStr = formatTagsPlain(l.tags);
		const tags = tagStr ? theme.fg("info", tagStr) : "";
		const hasDesc = l.description != null && l.description.trim() !== "";
		const descIndicator = showDesc ? "" : hasDesc ? theme.fg("dim", " [⋯]") : "";
		out.push(`${indent}${glyph} ${id} ${text}${prio}${tags}${descIndicator}`);
		if (l.note)
			out.push(`${indent}  ${theme.fg("dim", `· ${sanitize(l.note)}`)}`);
		if (showDesc && hasDesc) {
			const pad = `${indent}  `;
			const descLines = l.description!.split("\n");
			const capped = descLines.slice(0, 5);
			for (const dl of capped)
				out.push(`${pad}${theme.fg("dim", `▸ ${sanitize(dl)}`)}`);
			if (descLines.length > 5) out.push(`${pad}${theme.fg("dim", "▸ …")}`);
		}
	}
	return out;
}

export function themedListsLines(
	lists: ListSummary[],
	theme: ThemeLike,
): string[] {
	if (lists.length === 0) return [theme.fg("dim", "No TODO lists yet.")];
	const out: string[] = [
		theme.bold
			? theme.bold(`TODO lists (${lists.length}):`)
			: `TODO lists (${lists.length}):`,
	];
	for (const l of lists) {
		const proj = l.project_path
			? `  ${theme.fg("muted", `· project: ${sanitize(l.project_path)}`)}`
			: "";
		const ns =
			l.namespace && l.namespace !== GLOBAL_NAMESPACE
				? `  ${theme.fg("muted", `· namespace: ${sanitize(l.namespace)}`)}`
				: "";
		out.push(
			`  ${theme.fg("accent", l.path)}  ${theme.fg("muted", `· ${l.counts.done}/${l.counts.total} done`)}${proj}${ns}`,
		);
	}
	return out;
}
