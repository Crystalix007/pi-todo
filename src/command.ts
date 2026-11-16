/**
 * pi-todo — the `/todo` user command + TUI viewer.
 *
 * `/todo`                              → lists of the caller's default namespace
 * `/todo <path>[#id]`                  → viewer of that list/subtree
 * `/todo --namespace <ns>`             → lists in <ns> (global, a child namespace,
 *                                        or `*` for the parent-only discovery view)
 * `/todo --namespace <ns> <path>[#id]` → that list/subtree in <ns>
 *
 * The namespace policy is resolved ONCE per command invocation by the shared
 * resolver in ./namespace.ts — the viewer never re-implements authorization.
 * A bound child defaults to its own namespace and may only step out to
 * `global`; the parent keeps the global default and is the only caller that may
 * use `*`. Every query below is scoped to the resolved namespace, so no view can
 * leak sibling lists.
 *
 * Only a LEADING `--namespace` token is a flag; everything else is a legacy list
 * path, unchanged. A list literally named `--namespace` is still reachable as
 * `/todo /--namespace`.
 *
 * Non-TUI modes (rpc/json/print) fall back to a `notify` summary; `ctx.ui.custom`
 * is only called when `ctx.mode === "tui"`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

import type { ListSummary, TaskNode, TodoDb } from "./db.ts";
import {
	ALL_NAMESPACES,
	GLOBAL_NAMESPACE,
	namespaceLabel,
	resolveNamespace,
	type NamespaceResolution,
	type TodoCaller,
} from "./namespace.ts";
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

export interface TodoCommandDeps {
	getDb: () => Promise<TodoDb>;
	/**
	 * The session's immutable namespace caller, captured once by the extension
	 * factory and shared with the todo tool. The viewer resolves every command
	 * invocation through it, so a child can never browse a sibling namespace.
	 */
	caller: TodoCaller;
}

const NAMESPACE_FLAG = "--namespace";

export interface TodoCommandArgs {
	/** Raw namespace selector; undefined means the caller's default namespace. */
	namespace?: string;
	/** List path or `path#id` subtree reference; null shows the lists view. */
	path: string | null;
}

/**
 * Split `/todo` arguments into an optional leading `--namespace` flag and the
 * legacy path argument. `--namespace <value>` and `--namespace=<value>` are the
 * only flag spellings. A leading `--namespace` with no value is still a legal
 * list path, so legacy paths are never reinterpreted; any other position also
 * keeps the text as a path.
 */
export function parseTodoCommandArgs(input: string): TodoCommandArgs {
	const raw = (input ?? "").trim();
	if (!raw) return { path: null };

	const equalsPrefix = `${NAMESPACE_FLAG}=`;
	if (raw.startsWith(equalsPrefix)) {
		const rest = raw.slice(equalsPrefix.length);
		// No value (or only whitespace) → this is the legal list path itself.
		if (!rest || /^\s/.test(rest)) return { path: raw };
		const split = rest.search(/\s/);
		const value = split < 0 ? rest : rest.slice(0, split);
		const path = split < 0 ? "" : rest.slice(split + 1).trim();
		return { namespace: value, path: path || null };
	}

	const split = raw.search(/\s/);
	const first = split < 0 ? raw : raw.slice(0, split);
	if (first !== NAMESPACE_FLAG) return { path: raw };
	// `/todo --namespace` alone names a list; the flag needs a second token.
	if (split < 0) return { path: raw };

	const rest = raw.slice(split + 1).trimStart();
	const valueEnd = rest.search(/\s/);
	const value = valueEnd < 0 ? rest : rest.slice(0, valueEnd);
	if (!value) return { path: raw };
	const path = valueEnd < 0 ? "" : rest.slice(valueEnd + 1).trim();
	return { namespace: value, path: path || null };
}

type CompletionArgs =
	| { kind: "namespace"; valuePrefix: string }
	| { kind: "path"; namespace?: string; argPrefix: string; pathPrefix: string };

/**
 * Interpret the text typed after `/todo` for argument completion. Completion is
 * lenient: a half-typed namespace value suggests namespace names, a trailing
 * space after the value starts path completion, and everything else keeps the
 * legacy path completion.
 */
function parseCompletionArgs(input: string): CompletionArgs {
	const text = input ?? "";
	const equalsPrefix = `${NAMESPACE_FLAG}=`;
	if (text.startsWith(equalsPrefix)) {
		const rest = text.slice(equalsPrefix.length);
		const split = rest.search(/\s/);
		if (split < 0) return { kind: "namespace", valuePrefix: rest };
		return {
			kind: "path",
			namespace: rest.slice(0, split),
			argPrefix: text.slice(0, equalsPrefix.length + split + 1),
			pathPrefix: rest.slice(split + 1),
		};
	}

	const isSpaceFlag =
		text === NAMESPACE_FLAG ||
		text.startsWith(`${NAMESPACE_FLAG} `) ||
		text.startsWith(`${NAMESPACE_FLAG}\t`);
	if (isSpaceFlag) {
		const body = text.slice(NAMESPACE_FLAG.length).trimStart();
		const split = body.search(/\s/);
		if (split < 0) return { kind: "namespace", valuePrefix: body };
		const pathPrefix = body.slice(split + 1);
		return {
			kind: "path",
			namespace: body.slice(0, split),
			argPrefix: text.slice(0, text.length - pathPrefix.length),
			pathPrefix,
		};
	}
	return { kind: "path", argPrefix: "", pathPrefix: text };
}

export function registerTodoCommand(
	pi: ExtensionAPI,
	deps: TodoCommandDeps,
): void {
	pi.registerCommand("todo", {
		description:
			"View TODO lists and tasks (no args: list all; with a path: show that list's tasks; --namespace <name|global|*> selects a namespace)",
		getArgumentCompletions: async (prefix: string) => {
			try {
				const completion = parseCompletionArgs(prefix ?? "");

				if (completion.kind === "namespace") {
					// Only the parent discovers namespaces; a bound child already knows
					// its own name (plus 'global') and must not enumerate siblings.
					if (deps.caller.kind !== "unbound") return null;
					const db = await deps.getDb();
					const namespaces = db.txn(() =>
						db.getListsAllNamespaces().map((l) => l.namespace),
					);
					const labels = [...new Set(namespaces.map(namespaceLabel))].sort();
					const items = labels
						.filter((label) => label.startsWith(completion.valuePrefix))
						.map((label) => ({
							value: `${NAMESPACE_FLAG} ${label}`,
							label,
							description: "namespace",
						}));
					return items.length > 0 ? items : null;
				}

				// Authorize before opening/querying the DB, exactly like the handler.
				const resolved = resolveNamespace(completion.namespace, deps.caller);
				if (resolved.allNamespaces) return null;
				const db = await deps.getDb();
				const lists = db.txn(() => db.getLists(undefined, resolved.namespace));
				const items = lists
					.filter((l) => l.path.startsWith(completion.pathPrefix))
					.map((l) => ({
						value: `${completion.argPrefix}${l.path}`,
						label: l.path,
					}));
				return items.length > 0 ? items : null;
			} catch {
				return null;
			}
		},
		handler: async (args: string, ctx) => {
			const notifyError = (message: string): void => {
				if (ctx.hasUI) ctx.ui.notify(message, "error");
			};

			let parsed: TodoCommandArgs;
			try {
				parsed = parseTodoCommandArgs(args);
			} catch (err) {
				notifyError((err as Error).message);
				return;
			}

			// Resolve before touching the DB: a child asking for a sibling namespace
			// or '*' is rejected without a single query.
			let resolution: NamespaceResolution;
			try {
				resolution = resolveNamespace(parsed.namespace, deps.caller);
			} catch (err) {
				notifyError((err as Error).message);
				return;
			}

			let initialPath: string | null = null;
			if (parsed.path) {
				try {
					initialPath = parsed.path;
					parseListPath(initialPath);
				} catch (err) {
					notifyError((err as Error).message);
					return;
				}
			}

			if (resolution.allNamespaces && initialPath !== null) {
				notifyError(
					`The '${ALL_NAMESPACES}' namespace selector lists every namespace; open one list by selecting it in the viewer, or name its namespace (/todo ${NAMESPACE_FLAG} <name> ${initialPath}).`,
				);
				return;
			}

			const db = await deps.getDb();

			// Non-TUI: notify a compact summary and return.
			if (ctx.mode !== "tui") {
				const summary =
					initialPath !== null
						? buildListSummary(db, initialPath, resolution.namespace)
						: buildListsSummary(db, resolution);
				if (ctx.hasUI) ctx.ui.notify(summary, "info");
				return;
			}

			// TUI viewer.
			await ctx.ui.custom<void>(
				(tui: any, theme: any, _kb: any, done: () => void) => {
					const viewer = new TodoViewer(
						db,
						resolution,
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

function buildListsSummary(db: TodoDb, resolution: NamespaceResolution): string {
	const lists = db.txn(() =>
		resolution.allNamespaces
			? db.getListsAllNamespaces()
			: db.getLists(undefined, resolution.namespace),
	);
	return renderLists(lists);
}

function buildListSummary(
	db: TodoDb,
	path: string,
	namespace: string,
): string {
	const ref = parseListPath(path);
	return db.txn(() => {
		const list = db.getList(ref.scope, ref.name, namespace);
		if (!list) return listNotFoundMessage(ref.path, namespace);
		if (ref.rootTaskId != null) {
			let tree: TaskNode[];
			try {
				tree = db.fetchSubtree(list.id, ref.rootTaskId);
			} catch {
				return subtreeNotFoundMessage(
					ref.rootTaskId,
					ref.path,
					namespace,
				);
			}
			const counts = countsOfTree(tree);
			const showPath = `${ref.path}#${ref.rootTaskId}`;
			const rootText = tree.length > 0 ? tree[0]!.text : undefined;
			return renderTree({
				tree,
				counts,
				path: showPath,
				title: list.title,
				projectPath: list.project_path,
				description: list.description,
				rootTaskText: rootText,
				namespace,
			}).text;
		}
		const tree = db.fetchTree(list.id);
		const counts = db.countsFor(list.id);
		return renderTree({
			tree,
			counts,
			path: ref.path,
			title: list.title,
			projectPath: list.project_path,
			description: list.description,
			namespace,
		}).text;
	});
}

/** Keep the legacy global wording; name the namespace only when there is one. */
function listNotFoundMessage(path: string, namespace: string): string {
	return namespace === GLOBAL_NAMESPACE
		? `List '${path}' not found.`
		: `List '${path}' not found in namespace '${namespaceLabel(namespace)}'.`;
}

function subtreeNotFoundMessage(
	rootTaskId: number,
	path: string,
	namespace: string,
): string {
	const suffix =
		namespace === GLOBAL_NAMESPACE
			? ""
			: ` in namespace '${namespaceLabel(namespace)}'`;
	return `Task #${rootTaskId} not found in '${path}'${suffix}.`;
}

// ---------------------------------------------------------------------------
// TUI viewer component
// ---------------------------------------------------------------------------

interface ViewScope {
	/** Storage namespace; "" is the shared global namespace. */
	namespace: string;
	/** Parent-only discovery view: lists every namespace. */
	allNamespaces: boolean;
}

interface ListEntry {
	path: string;
	/** Namespace the list lives in, so the wildcard view can open it. */
	namespace: string;
}

interface ViewerContent {
	/** All display lines. */
	lines: string[];
	/** Line indices the cursor can land on. */
	selectable: number[];
	/** For each selectable line, the list it represents (lists mode only). */
	listEntries: ListEntry[];
	/** Breadcrumb / title shown at top; "lists" marks the lists view. */
	title: string;
}

interface NavStep {
	path: string | null;
	scope: ViewScope;
}

class TodoViewer {
	private db: TodoDb;
	private theme: any;
	private heightFn: () => number;
	private done: () => void;

	private scope: ViewScope;
	private content: ViewerContent = {
		lines: [],
		selectable: [],
		listEntries: [],
		title: "",
	};
	private cursor = 0; // index into content.selectable
	private scroll = 0; // line scroll offset
	private stack: NavStep[] = []; // previous views (for back navigation)
	private sortMode: SortMode = "creation";
	private showDescriptions = false;
	private subtreeRootId: number | null = null;
	private fullListPath: string | null = null;

	constructor(
		db: TodoDb,
		resolution: NamespaceResolution,
		theme: any,
		heightFn: () => number,
		done: () => void,
	) {
		this.db = db;
		this.theme = theme;
		this.heightFn = heightFn;
		this.done = done;
		this.scope = {
			namespace: resolution.namespace,
			allNamespaces: resolution.allNamespaces,
		};
	}

	/**
	 * Open a specific list path (tree view), or null for the lists view, in
	 * `scope` (default: the current one). Navigation keeps the namespace with
	 * the view, so list → tree → subtree/back never falls back to global.
	 */
	open(path: string | null, scope: ViewScope = this.scope): void {
		this.cursor = 0;
		this.scroll = 0;
		this.subtreeRootId = null;
		this.fullListPath = null;
		this.scope = scope;
		if (!path) {
			this.content = this.buildLists();
			return;
		}
		// Detect subtree reference via #id suffix.
		const ref = parseListPath(path);
		if (ref.rootTaskId != null) {
			this.openSubtree(ref.path, ref.rootTaskId);
		} else {
			this.content = this.buildTree(ref.path);
		}
	}

	/** Open a subtree view rooted at a specific task within a list. */
	openSubtree(fullPath: string, rootTaskId: number): void {
		this.subtreeRootId = rootTaskId;
		this.fullListPath = fullPath;
		this.content = this.buildSubtree(fullPath, rootTaskId);
	}

	private listsForScope(): ListSummary[] {
		return this.db.txn(() =>
			this.scope.allNamespaces
				? this.db.getListsAllNamespaces()
				: this.db.getLists(undefined, this.scope.namespace),
		);
	}

	private buildLists(): ViewerContent {
		const lists = this.listsForScope();
		const lines: string[] = [];
		const selectable: number[] = [];
		const listEntries: ListEntry[] = [];
		lines.push(this.listsHeader(lists.length));
		if (lists.length === 0) {
			lines.push(
				this.dim(
					"(no lists yet — ask the agent to add tasks, or use /todo <list>)",
				),
			);
		}
		for (const l of lists) {
			selectable.push(lines.length);
			listEntries.push({ path: l.path, namespace: l.namespace });
			const counts = this.muted(`· ${l.counts.done}/${l.counts.total} done`);
			const title = l.title ? this.dim(`  (${l.title})`) : "";
			const proj = l.project_path
				? this.dim(`  · project: ${l.project_path}`)
				: "";
			const ns =
				l.namespace === GLOBAL_NAMESPACE
					? ""
					: this.dim(`  · namespace: ${l.namespace}`);
			lines.push(`  ${this.accent(l.path)}${title}${proj}${ns} ${counts}`);
		}
		lines.push("");
		lines.push(this.dim("↑/↓ select · Enter open · Esc close"));
		return { lines, selectable, listEntries, title: "lists" };
	}

	/** Global (legacy) header text is unchanged; only other scopes are labelled. */
	private listsHeader(count: number): string {
		if (this.scope.allNamespaces)
			return this.bold(`TODO lists in all namespaces (${count})`);
		if (this.scope.namespace !== GLOBAL_NAMESPACE)
			return this.bold(
				`TODO lists in namespace '${this.scope.namespace}' (${count})`,
			);
		return this.bold(`TODO lists (${count})`);
	}

	private buildSubtree(fullPath: string, rootTaskId: number): ViewerContent {
		const ref = parseListPath(fullPath);
		const data = this.db.txn(() => {
			const list = this.db.getList(ref.scope, ref.name, this.scope.namespace);
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
					this.bold(
						subtreeNotFoundMessage(
							rootTaskId,
							fullPath,
							this.scope.namespace,
						),
					),
					"",
					this.dim("b back · Esc close"),
				],
				selectable: [],
				listEntries: [],
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
				projectPath: data.list.project_path,
				description: data.list.description,
				namespace: this.scope.namespace,
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
			listEntries: [],
			title: `${fullPath}#${rootTaskId}`,
		};
	}

	private buildTree(path: string): ViewerContent {
		const ref = parseListPath(path);
		const data = this.db.txn(() => {
			const list = this.db.getList(ref.scope, ref.name, this.scope.namespace);
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
					this.bold(listNotFoundMessage(ref.path, this.scope.namespace)),
					"",
					this.dim("Esc to go back"),
				],
				selectable: [],
				listEntries: [],
				title: ref.path,
			};
		}
		sortTree(data.tree, this.sortMode);
		const opts: ShowOpts = { showDescriptions: this.showDescriptions };
		const body = themedTreeLines(
			{
				tree: data.tree,
				counts: data.counts,
				path: ref.path,
				title: data.list.title,
				projectPath: data.list.project_path,
				description: data.list.description,
				namespace: this.scope.namespace,
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
				`↑/↓ select · Backspace/Esc back · s sort: ${sortLabel} · d desc: ${descStatus}`,
			),
		];
		return { lines, selectable, listEntries: [], title: ref.path };
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
				const entry = this.content.listEntries[this.cursor];
				if (entry) {
					this.stack.push({ path: null, scope: this.scope });
					// A wildcard listing can hold the same path in several namespaces:
					// open THIS row's list, in its own namespace.
					this.open(entry.path, {
						namespace: entry.namespace,
						allNamespaces: false,
					});
				}
			}
		} else if (matchesKey(data, "backspace")) {
			this.navigateBack();
		} else if (matchesKey(data, "s")) {
			const cur = SORT_MODES.indexOf(this.sortMode);
			const next = SORT_MODES[(cur + 1) % SORT_MODES.length];
			this.sortMode = next ?? "creation";
			this.rebuildCurrent();
			this.clampCursor();
		} else if (matchesKey(data, "d")) {
			if (this.content.title !== "lists") {
				this.showDescriptions = !this.showDescriptions;
				this.rebuildCurrent();
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
			if (this.stack.length > 0) {
				this.navigateBack();
			} else {
				this.done();
			}
		}
	}

	/** Re-render the current view in the current scope (sort/description toggles). */
	private rebuildCurrent(): void {
		if (this.subtreeRootId != null && this.fullListPath != null) {
			this.openSubtree(this.fullListPath, this.subtreeRootId);
			return;
		}
		if (this.content.title === "lists") {
			this.content = this.buildLists();
			return;
		}
		this.content = this.buildTree(this.content.title);
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
				if (this.content.listEntries.length > 0) {
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

	private navigateBack(): void {
		const prev = this.stack.pop();
		if (prev) this.open(prev.path, prev.scope);
		else this.open(null);
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
