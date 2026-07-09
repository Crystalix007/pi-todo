/**
 * pi-todo — the `/todo` user command + TUI viewer.
 *
 * `/todo`            → viewer of all TODO lists (drill into one with Enter).
 * `/todo <path>`     → viewer of that list's task tree.
 *
 * Non-TUI modes (rpc/json/print) fall back to a `notify` summary; `ctx.ui.custom`
 * is only called when `ctx.mode === "tui"`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

import type { ListSummary, TodoDb } from "./db.ts";
import { parseListPath } from "./paths.ts";
import {
	renderLists,
	renderTree,
	themedTreeLines,
	sortTree,
} from "./render.ts";
import type { SortMode } from "./render.ts";
import { SORT_MODES, SORT_LABEL } from "./render.ts";

interface TodoCommandDeps {
	getDb: () => Promise<TodoDb>;
}

export function registerTodoCommand(
	pi: ExtensionAPI,
	deps: TodoCommandDeps,
): void {
	pi.registerCommand("todo", {
		description:
			"View TODO lists and tasks (no args: list all; with a path: show that list's tasks)",
		getArgumentCompletions: async (prefix: string) => {
			try {
				const db = await deps.getDb();
				const lists = db.txn(() => db.getLists());
				const items = lists
					.map((l) => ({ value: l.path, label: l.path }))
					.filter((i) => i.value.startsWith(prefix));
				return items.length > 0 ? items : null;
			} catch {
				return null;
			}
		},
		handler: async (args: string, ctx) => {
			const db = await deps.getDb();

			// Decide initial view from the argument.
			let initialPath: string | null = null;
			const trimmed = (args ?? "").trim();
			if (trimmed) {
				try {
					const ref = parseListPath(trimmed);
					initialPath = ref.path;
				} catch (err) {
					if (ctx.hasUI) ctx.ui.notify((err as Error).message, "error");
					return;
				}
			}

			// Non-TUI: notify a compact summary and return.
			if (ctx.mode !== "tui") {
				const summary = initialPath
					? buildListSummary(db, initialPath)
					: buildAllListsSummary(db);
				if (ctx.hasUI) ctx.ui.notify(summary, "info");
				return;
			}

			// TUI viewer.
			await ctx.ui.custom<void>(
				(tui: any, theme: any, _kb: any, done: () => void) => {
					const viewer = new TodoViewer(
						db,
						theme,
						() => tui?.rows ?? tui?.height ?? 40,
						done,
					);
					viewer.open(initialPath);
					return viewer;
				},
			);
		},
	});
}

function buildAllListsSummary(db: TodoDb): string {
	const lists = db.txn(() => db.getLists());
	return renderLists(lists);
}

function buildListSummary(db: TodoDb, path: string): string {
	const ref = parseListPath(path);
	return db.txn(() => {
		const list = db.getList(ref.scope, ref.name);
		if (!list) return `List '${path}' not found.`;
		const tree = db.fetchTree(list.id);
		const counts = db.countsFor(list.id);
		return renderTree({ tree, counts, path, title: list.title }).text;
	});
}

// ---------------------------------------------------------------------------
// TUI viewer component
// ---------------------------------------------------------------------------

interface ViewerContent {
	/** All display lines. */
	lines: string[];
	/** Line indices the cursor can land on. */
	selectable: number[];
	/** For each selectable line, the list path it represents (lists mode only). */
	listPaths: string[];
	/** Breadcrumb / title shown at top. */
	title: string;
}

class TodoViewer {
	private db: TodoDb;
	private theme: any;
	private heightFn: () => number;
	private done: () => void;

	private content: ViewerContent = {
		lines: [],
		selectable: [],
		listPaths: [],
		title: "",
	};
	private cursor = 0; // index into content.selectable
	private scroll = 0; // line scroll offset
	private stack: string[] = []; // list paths visited (for back navigation)
	private sortMode: SortMode = "creation";

	constructor(
		db: TodoDb,
		theme: any,
		heightFn: () => number,
		done: () => void,
	) {
		this.db = db;
		this.theme = theme;
		this.heightFn = heightFn;
		this.done = done;
	}

	/** Open a specific list path (tree view), or null for the lists view. */
	open(path: string | null): void {
		this.cursor = 0;
		this.scroll = 0;
		if (path) {
			this.content = this.buildTree(path);
		} else {
			this.content = this.buildLists();
		}
	}

	private buildLists(): ViewerContent {
		const lists: ListSummary[] = this.db.txn(() => this.db.getLists());
		const lines: string[] = [];
		const selectable: number[] = [];
		const listPaths: string[] = [];
		lines.push(this.bold(`TODO lists (${lists.length})`));
		if (lists.length === 0) {
			lines.push(
				this.dim(
					"(no lists yet — ask the agent to add tasks, or use /todo <list>)",
				),
			);
		}
		for (const l of lists) {
			selectable.push(lines.length);
			listPaths.push(l.path);
			const counts = this.muted(`· ${l.counts.done}/${l.counts.total} done`);
			const title = l.title ? this.dim(`  (${l.title})`) : "";
			lines.push(`  ${this.accent(l.path)} ${title} ${counts}`);
		}
		lines.push("");
		lines.push(this.dim("↑/↓ select · Enter open · Esc close"));
		return { lines, selectable, listPaths, title: "lists" };
	}

	private buildTree(path: string): ViewerContent {
		const ref = parseListPath(path);
		const data = this.db.txn(() => {
			const list = this.db.getList(ref.scope, ref.name);
			if (!list) return null;
			return {
				list,
				tree: this.db.fetchTree(list.id),
				counts: this.db.countsFor(list.id),
			};
		});
		if (!data) {
			return {
				lines: [
					this.bold(`List '${path}' not found.`),
					"",
					this.dim("Esc to go back"),
				],
				selectable: [],
				listPaths: [],
				title: path,
			};
		}
		sortTree(data.tree, this.sortMode);
		const body = themedTreeLines(
			{ tree: data.tree, counts: data.counts, path, title: data.list.title },
			this.theme,
		);
		const sortLabel = SORT_LABEL[this.sortMode];
		const lines = [
			...body,
			"",
			this.dim(`↑/↓ scroll · Backspace/Esc back · s sort: ${sortLabel}`),
		];
		return { lines, selectable: [], listPaths: [], title: path };
	}

	handleInput(data: string): void {
		const sel = this.content.selectable;
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			if (sel.length > 0) {
				this.cursor = (this.cursor - 1 + sel.length) % sel.length;
				this.clampScroll();
			} else {
				this.scroll = Math.max(0, this.scroll - 1);
			}
		} else if (matchesKey(data, "down") || matchesKey(data, "j")) {
			if (sel.length > 0) {
				this.cursor = (this.cursor + 1) % sel.length;
				this.clampScroll();
			} else {
				this.scroll += 1;
			}
		} else if (matchesKey(data, "pageUp")) {
			this.scroll = Math.max(
				0,
				this.scroll - Math.max(1, this.viewportHeight() - 2),
			);
		} else if (matchesKey(data, "pageDown")) {
			this.scroll += Math.max(1, this.viewportHeight() - 2);
		} else if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			if (sel.length > 0) {
				const targetPath = this.content.listPaths[this.cursor];
				if (targetPath) {
					this.stack.push(this.content.title);
					this.open(targetPath);
				}
			}
		} else if (matchesKey(data, "backspace")) {
			const prev = this.stack.pop();
			if (prev && prev !== "lists") this.open(prev);
			else this.open(null);
		} else if (matchesKey(data, "s")) {
			const cur = SORT_MODES.indexOf(this.sortMode);
			const next = SORT_MODES[(cur + 1) % SORT_MODES.length];
			this.sortMode = next ?? "creation";
			this.cursor = 0;
			this.scroll = 0;
			this.content =
				this.content.title === "lists"
					? this.buildLists()
					: this.buildTree(this.content.title);
		} else if (
			matchesKey(data, "escape") ||
			matchesKey(data, "ctrl+c") ||
			matchesKey(data, "q")
		) {
			this.done();
		}
	}

	render(width: number): string[] {
		const height = this.viewportHeight();
		const sel = this.content.selectable;
		// Keep the selected line within the viewport.
		if (sel.length > 0) this.clampScroll();
		const start = Math.max(
			0,
			Math.min(this.scroll, Math.max(0, this.content.lines.length - height)),
		);
		this.scroll = start;
		const view: string[] = [];
		for (
			let i = start;
			i < start + height && i < this.content.lines.length;
			i++
		) {
			let line = this.content.lines[i] ?? "";
			if (sel.length > 0 && sel[this.cursor] === i) {
				line = `${this.theme.fg("accent", "▸")} ${line.slice(1)}`; // replace leading "  " marker
			}
			view.push(truncateToWidth(line, width));
		}
		while (view.length < height) view.push("");
		return view;
	}

	invalidate(): void {
		/* stateless rendering */
	}

	private viewportHeight(): number {
		try {
			return Math.max(5, this.heightFn() - 2);
		} catch {
			return 30;
		}
	}

	private clampScroll(): void {
		const sel = this.content.selectable;
		if (sel.length === 0) return;
		const selectedLine = sel[this.cursor];
		if (selectedLine === undefined) return;
		const height = this.viewportHeight();
		if (selectedLine < this.scroll) this.scroll = selectedLine;
		else if (selectedLine >= this.scroll + height)
			this.scroll = selectedLine - height + 1;
	}

	// theme helpers
	private bold(s: string): string {
		return this.theme.bold ? this.theme.bold(s) : s;
	}
	private dim(s: string): string {
		return this.theme.fg("dim", s);
	}
	private muted(s: string): string {
		return this.theme.fg("muted", s);
	}
	private accent(s: string): string {
		return this.theme.fg("accent", s);
	}
}
