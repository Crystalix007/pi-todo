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

import type { ListSummary, TaskNode, TodoDb } from "./db.ts";
import { parseListPath } from "./paths.ts";
import {
	countsOfTree,
	flatten,
	renderLists,
	renderTree,
	themedTreeLines,
	sortTree,
} from "./render.ts";
import type { SortMode, ShowOpts } from "./render.ts";
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
			let initialRootId: number | undefined;
			const trimmed = (args ?? "").trim();
			if (trimmed) {
				try {
					const ref = parseListPath(trimmed);
					initialPath = ref.path;
					initialRootId = ref.rootTaskId;
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
					if (initialRootId != null) {
						viewer.openSubtree(initialPath!, initialRootId);
					} else {
						viewer.open(initialPath);
					}
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
		if (!list) return `List '${ref.path}' not found.`;
		if (ref.rootTaskId != null) {
			let tree: TaskNode[];
			try {
				tree = db.fetchSubtree(list.id, ref.rootTaskId);
			} catch {
				return `Task #${ref.rootTaskId} not found in '${ref.path}'.`;
			}
			const counts = countsOfTree(tree);
			const showPath = `${ref.path}#${ref.rootTaskId}`;
			const rootText = tree.length > 0 ? tree[0]!.text : undefined;
			return renderTree({
				tree,
				counts,
				path: showPath,
				title: list.title,
				rootTaskText: rootText,
			}).text;
		}
		const tree = db.fetchTree(list.id);
		const counts = db.countsFor(list.id);
		return renderTree({ tree, counts, path: ref.path, title: list.title }).text;
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
	private showDescriptions = false;
	private subtreeRootId: number | null = null;
	private fullListPath: string | null = null;

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
		this.subtreeRootId = null;
		this.fullListPath = null;
		if (!path) {
			this.content = this.buildLists();
			return;
		}
		// Detect subtree reference via #id suffix.
		const ref = parseListPath(path);
		if (ref.rootTaskId != null) {
			this.openSubtree(ref.path, ref.rootTaskId);
		} else {
			this.content = this.buildTree(path);
		}
	}

	/** Open a subtree view rooted at a specific task within a list. */
	openSubtree(fullPath: string, rootTaskId: number): void {
		this.subtreeRootId = rootTaskId;
		this.fullListPath = fullPath;
		this.content = this.buildSubtree(fullPath, rootTaskId);
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

	private buildSubtree(fullPath: string, rootTaskId: number): ViewerContent {
		const ref = parseListPath(fullPath);
		const data = this.db.txn(() => {
			const list = this.db.getList(ref.scope, ref.name);
			if (!list) return null;
			let tree: TaskNode[];
			try {
				tree = this.db.fetchSubtree(list.id, rootTaskId);
			} catch {
				return null;
			}
			return { list, tree, counts: countsOfTree(tree) };
		});
		if (!data) {
			return {
				lines: [
					this.bold(`Task #${rootTaskId} not found in '${fullPath}'.`),
					"",
					this.dim("b back · Esc close"),
				],
				selectable: [],
				listPaths: [],
				title: `${fullPath}#${rootTaskId}`,
			};
		}
		sortTree(data.tree, this.sortMode);
		const rootText = data.tree.length > 0 ? data.tree[0]!.text : undefined;
		const opts: ShowOpts = { showDescriptions: this.showDescriptions };
		const body = themedTreeLines(
			{
				tree: data.tree,
				counts: data.counts,
				path: `${fullPath}#${rootTaskId}`,
				title: data.list.title,
				rootTaskText: rootText,
			},
			this.theme,
			opts,
		);
		const selectable = this.computeTreeSelectable(data.tree, opts);
		const sortLabel = SORT_LABEL[this.sortMode];
		const descStatus = this.showDescriptions ? "on" : "off";
		const lines = [
			...body,
			"",
			this.dim(
				`↑/↓ select · b back to full list · s sort: ${sortLabel} · d desc: ${descStatus}`,
			),
		];
		return {
			lines,
			selectable,
			listPaths: [],
			title: `${fullPath}#${rootTaskId}`,
		};
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
		const opts: ShowOpts = { showDescriptions: this.showDescriptions };
		const body = themedTreeLines(
			{ tree: data.tree, counts: data.counts, path, title: data.list.title },
			this.theme,
			opts,
		);
		const selectable = this.computeTreeSelectable(data.tree, opts);
		const sortLabel = SORT_LABEL[this.sortMode];
		const descStatus = this.showDescriptions ? "on" : "off";
		const lines = [
			...body,
			"",
			this.dim(
				`↑/↓ select · Backspace/Esc back · s sort: ${sortLabel} · d desc: ${descStatus}`,
			),
		];
		return { lines, selectable, listPaths: [], title: path };
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
			if (this.subtreeRootId != null && this.fullListPath != null) {
				this.openSubtree(this.fullListPath, this.subtreeRootId);
			} else {
				this.content =
					this.content.title === "lists"
						? this.buildLists()
						: this.buildTree(this.content.title);
			}
			this.clampCursor();
		} else if (matchesKey(data, "d")) {
			if (this.content.title !== "lists") {
				this.showDescriptions = !this.showDescriptions;
				if (this.subtreeRootId != null && this.fullListPath != null) {
					this.openSubtree(this.fullListPath, this.subtreeRootId);
				} else {
					this.content = this.buildTree(this.content.title);
				}
				this.clampCursor();
			}
		} else if (matchesKey(data, "b")) {
			if (this.subtreeRootId != null && this.fullListPath != null) {
				this.open(this.fullListPath);
			}
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
				if (this.content.listPaths.length > 0) {
					// List view: replace leading "  " with colored "▸ "
					line = `${this.theme.fg("accent", "▸")} ${line.slice(1)}`;
				} else {
					// Tree view: prepend colored cursor marker
					line = `${this.theme.fg("accent", "▸")}${line}`;
				}
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

	private clampCursor(): void {
		const sel = this.content.selectable;
		if (sel.length === 0) {
			this.cursor = 0;
			return;
		}
		this.cursor = Math.min(this.cursor, sel.length - 1);
		this.clampScroll();
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

	// ---- selectable computation ----

	/** Compute which line indices in a themed tree body are task lines. */
	private computeTreeSelectable(tree: TaskNode[], opts: ShowOpts): number[] {
		const flat = flatten(tree, opts);
		const selectable: number[] = [];
		let idx = 1; // skip header line (index 0)
		const showDesc = opts.showDescriptions === true;
		for (const l of flat) {
			selectable.push(idx);
			idx += 1; // task line
			if (l.note) idx += 1; // note line
			if (showDesc && l.description?.trim()) {
				const lines = l.description.split("\n");
				const capped = Math.min(lines.length, 5);
				idx += capped;
				if (lines.length > 5) idx += 1; // ellipsis
			}
		}
		return selectable;
	}
}
