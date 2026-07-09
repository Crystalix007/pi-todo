/**
 * pi-todo — output formatters.
 *
 * Plain-ASCII text for the tool `content` (sent to the LLM; must be self-describing
 * since renderResult only runs in TUI). Themed lines for the /todo viewer.
 * Semantic truncation keeps output well under pi's 50KB/2000-line limit.
 */

import type { Counts, ListSummary, Status, TaskNode } from "./db.ts";

export const DEFAULT_MAX_TREE_LINES = 300;

/** Cap a single rendered line so one giant task field can't dominate output. */
export const MAX_LINE_WIDTH = 500;
/** Byte backstop so a pathological list can't approach pi's 50KB tool limit. */
export const MAX_OUTPUT_BYTES = 24000;

/** Collapse control chars (incl. newlines/tabs) so a task can't break the tree layout. */
function sanitize(s: string): string {
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

export interface TreeView {
	tree: TaskNode[];
	counts: Counts;
	path: string;
	title?: string | null;
}

export interface ShowOpts {
	format?: "tree" | "flat";
	statusFilter?: Status;
	maxLines?: number;
}

export interface RenderedText {
	text: string;
	truncated: boolean;
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

export function headerLine(view: TreeView): string {
	const { counts, path, title } = view;
	const namePart = title ? `${path}  (${title})` : path;
	const parts = [namePart, `${counts.done}/${counts.total} done`];
	if (counts.in_progress > 0) parts.push(`${counts.in_progress} in progress`);
	return parts.join("  ·  ");
}

interface Line {
	depth: number;
	glyph: string;
	id: number;
	text: string;
	note?: string | null;
}

/** Flatten the tree into display lines (depth-first, sibling order). */
function flatten(tree: TaskNode[], opts: ShowOpts): Line[] {
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
					note: n.note,
				});
			}
			walk(n.children, filter ? depth : depth + 1);
		}
	};
	walk(tree, 0);
	return out;
}

function plainLine(l: Line, indented: boolean): string[] {
	const indent = indented ? "  ".repeat(l.depth) : "";
	const lines = [`${indent}${l.glyph} #${l.id} ${sanitize(l.text)}`];
	if (l.note) lines.push(`${indent}  · ${sanitize(l.note)}`);
	return lines;
}

/** Render a list view to plain text (for the LLM / non-TUI modes). */
export function renderTree(view: TreeView, opts: ShowOpts = {}): RenderedText {
	const maxLines = opts.maxLines ?? DEFAULT_MAX_TREE_LINES;
	const lines: string[] = [headerLine(view)];
	if (opts.statusFilter || view.counts.total === 0) {
		lines.push("[x]=done  [ ]=pending  [~]=in progress");
	}
	if (view.counts.total === 0) {
		lines.push("(empty list — add tasks with action 'add')");
		return { text: lines.join("\n"), truncated: false };
	}

	// A status filter always flattens (structure is lost when filtering).
	const flat = opts.format === "flat" || opts.statusFilter != null;
	const display = flatten(view.tree, opts);

	const budget = Math.max(5, maxLines - lines.length);
	let truncated = false;
	let emitted = 0;
	for (const l of display) {
		const seg = plainLine(l, !flat); // tree mode indents; flat mode no indent
		for (const s of seg) {
			if (emitted >= budget) {
				truncated = true;
				break;
			}
			lines.push(s);
			emitted++;
		}
		if (truncated) break;
	}

	if (truncated) {
		const remaining = display.length - emitted;
		lines.push(
			`… ${remaining} more task(s) truncated. Narrow with status_filter, or view via the /todo command.`,
		);
	}
	let text = lines.join("\n");
	// Byte backstop: a single oversized field (after line capping) still can't blow context.
	if (text.length > MAX_OUTPUT_BYTES) {
		text = `${text.slice(0, MAX_OUTPUT_BYTES - 120)}\n… output truncated at ~${MAX_OUTPUT_BYTES} bytes; narrow with status_filter or use /todo.`;
		truncated = true;
	}
	return { text, truncated };
}

/** Render the list-of-lists to plain text. */
export function renderLists(lists: ListSummary[]): string {
	if (lists.length === 0) {
		return "No TODO lists yet. Create one with action 'create' or 'add' (lists auto-create on first add).";
	}
	const lines = [`TODO lists (${lists.length}):`];
	for (const l of lists) {
		const titlePart = l.title ? `  (${l.title})` : "";
		lines.push(
			`  ${l.path}${titlePart}  ·  ${l.counts.done}/${l.counts.total} done`,
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
	for (const l of flatten(view.tree, opts)) {
		const indent = flat ? "" : "  ".repeat(l.depth);
		const glyph = theme.fg(
			STATUS_COLOR[
				l.glyph === "[x]"
					? "done"
					: l.glyph === "[~]"
						? "in_progress"
						: "pending"
			],
			l.glyph,
		);
		const id = theme.fg("accent", `#${l.id}`);
		const rawText = sanitize(l.text);
		const text =
			l.glyph === "[x]" ? theme.fg("dim", rawText) : theme.fg("text", rawText);
		out.push(`${indent}${glyph} ${id} ${text}`);
		if (l.note)
			out.push(`${indent}  ${theme.fg("dim", `· ${sanitize(l.note)}`)}`);
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
		out.push(
			`  ${theme.fg("accent", l.path)}  ${theme.fg("muted", `· ${l.counts.done}/${l.counts.total} done`)}`,
		);
	}
	return out;
}
