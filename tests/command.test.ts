/**
 * `/todo` command: namespace argument parsing, completions, non-TUI summaries,
 * and the TUI viewer's namespace-scoped navigation.
 *
 * Contract under test (see src/command.ts and src/namespace.ts):
 *  - a LEGACY path argument is untouched; only a leading `--namespace` is a flag
 *  - the caller's default namespace decides what `/todo` shows: global for an
 *    unbound parent, its own namespace for a bound child (no sibling leaks)
 *  - `--namespace global` shows the shared lists only; `*` is parent-only
 *  - a child's arbitrary/wildcard namespace is rejected before any DB query
 *  - list -> tree -> subtree/back keeps the selected namespace
 *  - completions only offer lists of the namespace the caller may see
 *  - global viewer headers stay unchanged; named ones are labelled
 *
 * The DB is a throwaway file under the OS temp dir; ~/.pi/agent/todo.db is
 * never touched.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { TodoDb } from "../src/db.ts";
import type { TodoCaller } from "../src/namespace.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-todo-command-test-"));
process.env.PI_TODO_DB = join(dir, "todo.db");
delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS;

const { getDb, closeTodoDb } = await import("../src/db.ts");
const { dispatchTodo } = await import("../src/tool.ts");
const {
	registerTodoCommand,
	parseTodoCommandArgs,
} = await import("../src/command.ts");
const { boundCaller, UNBOUND_CALLER } = await import("../src/namespace.ts");
const { default: todoExtension } = await import("../src/index.ts");

const parent: TodoCaller = UNBOUND_CALLER;

let db: TodoDb;

before(async () => {
	db = await getDb();
});

after(() => {
	closeTodoDb().then(() => rmSync(dir, { recursive: true, force: true }));
});

// ---- harness ---------------------------------------------------------------

interface CompletionItem {
	value: string;
	label?: string;
	description?: string;
}

interface CommandDef {
	description?: string;
	handler: (args: string, ctx: any) => Promise<void>;
	getArgumentCompletions?: (
		prefix: string,
	) => Promise<CompletionItem[] | null> | CompletionItem[] | null;
}

function commandFor(deps: {
	getDb: () => Promise<TodoDb>;
	caller: TodoCaller;
}): CommandDef {
	let def: CommandDef | undefined;
	const pi = {
		registerCommand: (_name: string, options: CommandDef) => {
			def = options;
		},
	};
	registerTodoCommand(pi as unknown as ExtensionAPI, deps);
	assert.ok(def, "the /todo command was registered");
	return def;
}

interface FakeCtx {
	mode: "rpc" | "tui";
	hasUI: boolean;
	ui: {
		notify: (message: string, level: string) => void;
		custom: (factory: any) => Promise<void>;
	};
}

interface Harness {
	ctx: FakeCtx;
	notices: { message: string; level: string }[];
	component: () => any;
}

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function createHarness(mode: "rpc" | "tui"): Harness {
	const notices: Harness["notices"] = [];
	let component: any = null;
	const ctx: FakeCtx = {
		mode,
		hasUI: true,
		ui: {
			notify: (message, level) => notices.push({ message, level }),
			custom: async (factory) => {
				component = factory({ rows: 40 }, theme, {}, () => {});
			},
		},
	};
	return { ctx, notices, component: () => component };
}

async function seed(
	caller: TodoCaller,
	list: string,
	items: { text: string; ref?: string; underRef?: string }[],
	namespace?: string,
): Promise<{ addedItems: number[] }> {
	const result = await dispatchTodo(
		db,
		{
			action: "add",
			list,
			items,
			...(namespace !== undefined ? { namespace } : {}),
		},
		caller,
	);
	return { addedItems: result.details.added_items as number[] };
}

function textOf(notices: Harness["notices"]): string {
	return notices.map((n) => n.message).join("\n");
}

function render(component: any): string {
	return component.render(120).join("\n");
}

function lineWith(rendered: string, needle: string): string {
	const line = rendered.split("\n").find((l) => l.includes(needle));
	assert.ok(line, `expected a line containing '${needle}' in:\n${rendered}`);
	return line;
}

/** Move the list-view cursor until the selected row contains `needle`. */
function selectRow(viewer: any, needle: string): void {
	for (let i = 0; i < 100; i++) {
		const selected = render(viewer)
			.split("\n")
			.find((line) => line.startsWith("▸"));
		assert.ok(selected, `no selected row while looking for '${needle}'`);
		if (selected.includes(needle)) return;
		viewer.handleInput("\x1b[B"); // down
	}
	assert.fail(`never reached the row containing '${needle}'`);
}

// ---- argument parsing ------------------------------------------------------

test("legacy path arguments are untouched by the namespace flag parser", () => {
	assert.deepEqual(parseTodoCommandArgs(""), { path: null });
	assert.deepEqual(parseTodoCommandArgs("   "), { path: null });
	assert.deepEqual(parseTodoCommandArgs("team/tasks"), {
		path: "team/tasks",
	});
	assert.deepEqual(parseTodoCommandArgs("team/tasks#7"), {
		path: "team/tasks#7",
	});
	assert.deepEqual(parseTodoCommandArgs("--namespaceish/tasks"), {
		path: "--namespaceish/tasks",
	});
	assert.deepEqual(parseTodoCommandArgs("team/--namespace"), {
		path: "team/--namespace",
	});
	assert.deepEqual(parseTodoCommandArgs("-x/tasks"), { path: "-x/tasks" });
});

test("a leading --namespace flag selects a namespace and keeps the path", () => {
	assert.deepEqual(parseTodoCommandArgs("--namespace job-worker-a"), {
		namespace: "job-worker-a",
		path: null,
	});
	assert.deepEqual(parseTodoCommandArgs("  --namespace   job-worker-a  "), {
		namespace: "job-worker-a",
		path: null,
	});
	assert.deepEqual(parseTodoCommandArgs("--namespace job-worker-a tasks#3"), {
		namespace: "job-worker-a",
		path: "tasks#3",
	});
	assert.deepEqual(parseTodoCommandArgs("--namespace=global team/tasks"), {
		namespace: "global",
		path: "team/tasks",
	});
	assert.deepEqual(parseTodoCommandArgs("--namespace=*"), {
		namespace: "*",
		path: null,
	});
});

test("a flag token without a value is still a legal legacy path", () => {
	assert.deepEqual(parseTodoCommandArgs("--namespace"), {
		path: "--namespace",
	});
	assert.deepEqual(parseTodoCommandArgs("--namespace\t"), {
		path: "--namespace",
	});
	assert.deepEqual(parseTodoCommandArgs("--namespace="), {
		path: "--namespace=",
	});
	assert.deepEqual(parseTodoCommandArgs("--namespace= child"), {
		path: "--namespace= child",
	});
});

// ---- non-TUI summaries -----------------------------------------------------

test("parent /todo stays global; an explicit namespace shows only that namespace", async () => {
	await seed(parent, "cmd-global/visible", [{ text: "global-task" }]);
	await seed(parent, "cmd-child-visible", [{ text: "child-task" }], "job-cmd-a");

	const def = commandFor({ getDb: async () => db, caller: parent });

	const globalRun = createHarness("rpc");
	await def.handler("", globalRun.ctx);
	const globalText = textOf(globalRun.notices);
	assert.match(globalText, /cmd-global\/visible/);
	assert.doesNotMatch(globalText, /cmd-child-visible/);
	assert.doesNotMatch(globalText, /namespace: job-cmd-a/);

	const childRun = createHarness("rpc");
	await def.handler("--namespace job-cmd-a", childRun.ctx);
	const childText = textOf(childRun.notices);
	assert.match(childText, /cmd-child-visible/);
	assert.match(childText, /namespace: job-cmd-a/);
	assert.doesNotMatch(childText, /cmd-global\/visible/);
});

test("parent wildcard lists every namespace and labels only non-global lists", async () => {
	await seed(parent, "cmd-wild-global", [{ text: "g" }]);
	await seed(parent, "cmd-wild-child", [{ text: "c" }], "job-cmd-wild");

	const def = commandFor({ getDb: async () => db, caller: parent });
	const run = createHarness("rpc");
	await def.handler("--namespace *", run.ctx);
	const text = textOf(run.notices);

	assert.match(text, /cmd-wild-global/);
	assert.match(text, /cmd-wild-child/);
	assert.match(lineWith(text, "cmd-wild-child"), /namespace: job-cmd-wild/);
	assert.doesNotMatch(
		lineWith(text, "cmd-wild-global"),
		/namespace:/,
		"global list lines keep the legacy format",
	);
});

test("wildcard with a path is rejected in every mode", async () => {
	const def = commandFor({ getDb: async () => db, caller: parent });
	const run = createHarness("rpc");
	await def.handler("--namespace * some/list", run.ctx);
	assert.equal(run.notices.length, 1);
	assert.equal(run.notices[0]!.level, "error");
	assert.match(run.notices[0]!.message, /lists every namespace/);
});

test("not-found messages name the namespace only when it is not global", async () => {
	const def = commandFor({ getDb: async () => db, caller: parent });

	const globalRun = createHarness("rpc");
	await def.handler("cmd-does-not-exist", globalRun.ctx);
	assert.equal(globalRun.notices[0]!.message, "List 'cmd-does-not-exist' not found.");

	const namedRun = createHarness("rpc");
	await def.handler("--namespace job-cmd-missing cmd-does-not-exist", namedRun.ctx);
	assert.match(
		namedRun.notices[0]!.message,
		/List 'cmd-does-not-exist' not found in namespace 'job-cmd-missing'\./,
	);
});

// ---- bound-child isolation -------------------------------------------------

test("a bound child sees only its own namespace by default and only global explicitly", async () => {
	const child: TodoCaller = boundCaller("job-cmd-child");
	await seed(parent, "cmd-child-own/ok", [{ text: "own-task" }], "job-cmd-child");
	await seed(parent, "cmd-child-global/ok", [{ text: "global-task" }]);
	await seed(parent, "cmd-child-sibling/secret", [{ text: "secret-task" }], "job-cmd-sibling");

	const def = commandFor({ getDb: async () => db, caller: child });

	const ownRun = createHarness("rpc");
	await def.handler("", ownRun.ctx);
	const ownText = textOf(ownRun.notices);
	assert.match(ownText, /cmd-child-own\/ok/);
	assert.doesNotMatch(ownText, /cmd-child-global\/ok/);
	assert.doesNotMatch(ownText, /secret/);

	const globalRun = createHarness("rpc");
	await def.handler("--namespace global", globalRun.ctx);
	const globalText = textOf(globalRun.notices);
	assert.match(globalText, /cmd-child-global\/ok/);
	assert.doesNotMatch(globalText, /cmd-child-own\/ok/);
	assert.doesNotMatch(globalText, /secret/);

	const siblingRun = createHarness("rpc");
	await def.handler("--namespace job-cmd-sibling", siblingRun.ctx);
	assert.equal(siblingRun.notices.length, 1);
	assert.equal(siblingRun.notices[0]!.level, "error");
	assert.match(siblingRun.notices[0]!.message, /outside this session's namespace/);
	assert.doesNotMatch(textOf(siblingRun.notices), /secret/);

	const wildcardRun = createHarness("rpc");
	await def.handler("--namespace *", wildcardRun.ctx);
	assert.match(wildcardRun.notices[0]!.message, /parent session/);
});

test("a child's out-of-scope namespace is rejected before the DB is queried", async () => {
	const def = commandFor({
		getDb: async () => {
			throw new Error("the DB must not be queried");
		},
		caller: boundCaller("job-cmd-nodb"),
	});
	const run = createHarness("rpc");
	await def.handler("--namespace job-cmd-other x", run.ctx);
	assert.equal(run.notices.length, 1);
	assert.equal(run.notices[0]!.level, "error");
	assert.match(run.notices[0]!.message, /outside this session's namespace/);
});

// ---- completions -----------------------------------------------------------

test("completions stay inside the resolved namespace and preserve the flag", async () => {
	await seed(parent, "cmd-complete-global/one", [{ text: "g" }]);
	await seed(parent, "cmd-complete-own/two", [{ text: "c" }], "job-cmd-complete");

	const parentDef = commandFor({ getDb: async () => db, caller: parent });
	const legacy = await parentDef.getArgumentCompletions!("cmd-complete-global/");
	assert.deepEqual(
		legacy?.map((i) => i.value),
		["cmd-complete-global/one"],
		"legacy completion keeps returning bare paths",
	);

	const scoped = await parentDef.getArgumentCompletions!(
		"--namespace job-cmd-complete cmd-complete-own/",
	);
	assert.deepEqual(
		scoped?.map((i) => i.value),
		["--namespace job-cmd-complete cmd-complete-own/two"],
	);
	assert.deepEqual(scoped?.map((i) => i.label), ["cmd-complete-own/two"]);

	const namespaces = await parentDef.getArgumentCompletions!("--namespace ");
	const namespaceValues = namespaces?.map((i) => i.value) ?? [];
	assert.ok(namespaceValues.includes("--namespace global"));
	assert.ok(namespaceValues.includes("--namespace job-cmd-complete"));

	assert.equal(
		await parentDef.getArgumentCompletions!("--namespace * "),
		null,
		"the wildcard is listing-only",
	);

	const childDef = commandFor({
		getDb: async () => db,
		caller: boundCaller("job-cmd-complete"),
	});
	assert.equal(
		await childDef.getArgumentCompletions!("--namespace "),
		null,
		"a child cannot enumerate sibling namespaces",
	);
	assert.equal(
		await childDef.getArgumentCompletions!("--namespace job-cmd-other "),
		null,
	);
	const childPaths = await childDef.getArgumentCompletions!("");
	assert.deepEqual(
		childPaths?.map((i) => i.value),
		["cmd-complete-own/two"],
	);
});

// ---- TUI viewer ------------------------------------------------------------

test("parent wildcard viewer opens a child list and keeps its namespace on back", async () => {
	await seed(parent, "view-global/main", [{ text: "global-view-task" }]);
	await seed(parent, "view-a/main", [{ text: "a-view-task" }], "job-view-a");
	await seed(parent, "view-b/main", [{ text: "b-view-task" }], "job-view-b");

	const def = commandFor({ getDb: async () => db, caller: parent });
	const run = createHarness("tui");
	await def.handler("--namespace *", run.ctx);
	const viewer = run.component();
	assert.ok(viewer, "the viewer component was created");

	const listsView = render(viewer);
	assert.match(listsView, /TODO lists in all namespaces/);
	assert.match(lineWith(listsView, "view-a/main"), /namespace: job-view-a/);
	assert.doesNotMatch(
		lineWith(listsView, "view-global/main"),
		/namespace:/,
		"the global row keeps the legacy format",
	);

	// The wildcard view may also contain global lists from earlier tests, so
	// navigate to the child rows by name instead of assuming their index.
	selectRow(viewer, "view-a/main");
	viewer.handleInput("\r"); // enter
	const aTree = render(viewer);
	assert.match(aTree, /a-view-task/);
	assert.match(lineWith(aTree, "view-a/main"), /namespace: job-view-a/);
	assert.doesNotMatch(aTree, /b-view-task/);

	viewer.handleInput("\x1b"); // escape → back to the wildcard lists
	const backToList = render(viewer);
	assert.match(backToList, /TODO lists in all namespaces/);
	assert.doesNotMatch(backToList, /a-view-task/);

	selectRow(viewer, "view-b/main");
	viewer.handleInput("\r"); // enter
	const bTree = render(viewer);
	assert.match(bTree, /b-view-task/);
	assert.match(lineOfHeader(bTree), /namespace: job-view-b/);

	viewer.handleInput("s"); // sort toggle rebuilds without losing the namespace
	assert.match(lineOfHeader(render(viewer)), /namespace: job-view-b/);
});

test("a bound child's viewer never lists sibling or global lists", async () => {
	await seed(parent, "view-child/own", [{ text: "own-task" }], "job-view-child");
	await seed(parent, "view-child/global", [{ text: "global-task" }]);
	await seed(parent, "view-child/sibling", [{ text: "secret-task" }], "job-view-sibling");

	const def = commandFor({
		getDb: async () => db,
		caller: boundCaller("job-view-child"),
	});
	const run = createHarness("tui");
	await def.handler("", run.ctx);
	const rendered = render(run.component());

	assert.match(rendered, /TODO lists in namespace 'job-view-child'/);
	assert.match(rendered, /view-child\/own/);
	assert.match(rendered, /namespace: job-view-child/);
	assert.doesNotMatch(rendered, /view-child\/global/);
	assert.doesNotMatch(rendered, /view-child\/sibling/);
	assert.doesNotMatch(rendered, /secret-task/);
});

test("a subtree opens and returns to its full list inside the selected namespace", async () => {
	const seeded = await seed(
		parent,
		"deep",
		[
			{ ref: "p", text: "deep-parent" },
			{ text: "deep-child", underRef: "p" },
		],
		"job-view-deep",
	);
	const parentTaskId = seeded.addedItems[0]!;

	const def = commandFor({ getDb: async () => db, caller: parent });
	const run = createHarness("tui");
	await def.handler(`--namespace job-view-deep deep#${parentTaskId}`, run.ctx);
	const viewer = run.component();

	const subtree = render(viewer);
	assert.match(lineOfHeader(subtree), /namespace: job-view-deep/);
	assert.match(lineOfHeader(subtree), new RegExp(`deep#${parentTaskId}`));
	assert.match(subtree, /deep-parent/);
	assert.match(subtree, /deep-child/);

	viewer.handleInput("b"); // back to the full list
	const fullList = render(viewer);
	assert.match(lineOfHeader(fullList), /^deep {2}· {2}namespace: job-view-deep/);
	assert.doesNotMatch(lineOfHeader(fullList), new RegExp(`#${parentTaskId}`));
	assert.match(fullList, /deep-child/);
});

/** The first rendered line is the tree/list header. */
function lineOfHeader(rendered: string): string {
	return rendered.split("\n")[0] ?? "";
}

// ---- agent-facing discovery ------------------------------------------------

test("todo lists with the wildcard labels non-global namespaces for the parent", async () => {
	await seed(parent, "text-global/main", [{ text: "g" }]);
	await seed(parent, "text-child/main", [{ text: "c" }], "job-text-a");

	const result = await dispatchTodo(db, { action: "lists", namespace: "*" }, parent);
	assert.match(result.content.text, /text-child\/main/);
	assert.match(
		lineWith(result.content.text, "text-child/main"),
		/namespace: job-text-a/,
	);
	assert.doesNotMatch(
		lineWith(result.content.text, "text-global/main"),
		/namespace:/,
	);
});

// ---- factory integration ---------------------------------------------------

test("the extension factory passes the captured binding to /todo", async () => {
	await seed(parent, "wired-own/main", [{ text: "own-wired-task" }], "job-wired");
	await seed(parent, "wired-global/main", [{ text: "global-wired-task" }]);
	await seed(
		parent,
		"wired-sibling/main",
		[{ text: "secret-wired-task" }],
		"job-wired-sibling",
	);

	process.env.PI_SUBAGENT_EXTENSION_BINDINGS = JSON.stringify({
		"pi-todo/1": { namespace: "job-wired" },
	});
	let registered: CommandDef | undefined;
	try {
		const pi = {
			registerTool: () => {},
			registerCommand: (_name: string, options: CommandDef) => {
				registered = options;
			},
			on: () => () => {},
		};
		todoExtension(pi as unknown as ExtensionAPI);
	} finally {
		delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
	}
	assert.ok(registered, "the factory registered /todo");

	// A foreground child's environment is restored after startup; the captured
	// caller must still scope every view.
	const run = createHarness("rpc");
	await registered.handler("", run.ctx);
	const text = textOf(run.notices);
	assert.match(text, /wired-own\/main/);
	assert.doesNotMatch(text, /wired-global\/main/);
	assert.doesNotMatch(text, /secret-wired-task/);
});
