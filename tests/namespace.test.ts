/**
 * Namespace policy across every tool action.
 *
 * Contract under test (see src/namespace.ts):
 *  - unbound caller (legacy/parent): global by default, may target any namespace
 *  - bound caller (child): own namespace by default, existing globals only
 *  - bound caller can mutate EXISTING global lists but cannot create new ones
 *  - sibling namespaces and the '*' wildcard are closed to bound callers
 *  - lists/next default to the caller's default namespace only
 *  - '*' is parent-only and discovery-only
 *
 * The DB is a throwaway file under the OS temp dir; ~/.pi/agent/todo.db is
 * never touched.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Counts, TaskNode, TodoDb } from "../src/db.ts";
import type { TodoCaller } from "../src/namespace.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-todo-namespace-test-"));
process.env.PI_TODO_DB = join(dir, "todo.db");

const { getDb, closeTodoDb } = await import("../src/db.ts");
const { dispatchTodo, buildTodoToolDef, TodoToolParams } = await import(
	"../src/tool.ts"
);
const { boundCaller, UNBOUND_CALLER } = await import("../src/namespace.ts");

const parent: TodoCaller = UNBOUND_CALLER;
const team: TodoCaller = boundCaller("team");
const other: TodoCaller = boundCaller("other");

let db: TodoDb;

before(async () => {
	db = await getDb();
});

after(() => {
	closeTodoDb().then(() => rmSync(dir, { recursive: true, force: true }));
});

// ---- helpers ---------------------------------------------------------------

type Details = Record<string, unknown>;

interface ListDetails {
	namespace: string;
	scope: string;
	name: string;
	path: string;
	title?: string;
	project_path?: string;
	description?: string;
}

function detailsList(r: { details: Details }): ListDetails {
	return r.details.list as ListDetails;
}

function detailsLists(r: { details: Details }): ListDetails[] {
	return r.details.lists as ListDetails[];
}

function detailsCounts(r: { details: Details }): Counts {
	return r.details.counts as Counts;
}

function detailsTree(r: { details: Details }): TaskNode[] {
	return r.details.tree as TaskNode[];
}

function detailsAffected(r: { details: Details }): Record<string, unknown> {
	return r.details.affected as Record<string, unknown>;
}

async function addItems(
	list: string,
	texts: string[],
	opts: { caller?: TodoCaller; namespace?: string } = {},
): Promise<number[]> {
	const r = await dispatchTodo(
		db,
		{
			action: "add",
			list,
			namespace: opts.namespace,
			items: texts.map((text) => ({ text })),
		},
		opts.caller ?? parent,
	);
	return r.details.added_items as number[];
}

/** `namespace:path` labels of the lists action, for order-insensitive asserts. */
async function listLabels(
	caller: TodoCaller,
	namespace?: string,
): Promise<string[]> {
	const r = await dispatchTodo(db, { action: "lists", namespace }, caller);
	return detailsLists(r).map((l) => `${l.namespace}:${l.path}`);
}

// ---- isolation -------------------------------------------------------------

test("the same path in two namespaces is two independent lists", async () => {
	const globalIds = await addItems("iso/main", ["global-1"]);
	const teamIds = await addItems("iso/main", ["team-1"], { namespace: "team" });
	assert.equal(globalIds.length, 1);
	assert.equal(teamIds.length, 1);
	assert.notEqual(globalIds[0], teamIds[0], "distinct task rows");

	const globalShow = await dispatchTodo(db, { action: "show", list: "iso/main" });
	const teamShow = await dispatchTodo(db, {
		action: "show",
		list: "iso/main",
		namespace: "team",
	});
	assert.equal(detailsList(globalShow).namespace, "global");
	assert.equal(detailsList(teamShow).namespace, "team");
	assert.equal(detailsCounts(globalShow).total, 1);
	assert.equal(detailsCounts(teamShow).total, 1);
	assert.equal(detailsTree(globalShow)[0]?.text, "global-1");
	assert.equal(detailsTree(teamShow)[0]?.text, "team-1");
	// Paths and ids stay exactly as before: no namespace leaks into either.
	assert.equal(detailsList(globalShow).path, "iso/main");
	assert.equal(detailsList(teamShow).path, "iso/main");

	// lists: default = global only; explicit namespace = that namespace only.
	assert.ok((await listLabels(parent)).includes("global:iso/main"));
	assert.ok(!(await listLabels(parent)).includes("team:iso/main"));
	const teamOnly = await listLabels(parent, "team");
	assert.ok(teamOnly.includes("team:iso/main"));
	assert.ok(!teamOnly.includes("global:iso/main"));
	// '*' is the parent's discovery view across everything.
	const all = await listLabels(parent, "*");
	assert.ok(all.includes("global:iso/main"));
	assert.ok(all.includes("team:iso/main"));
});

test("a bound session defaults to its own namespace, with no implicit fallback", async () => {
	const globalBefore = detailsCounts(
		await dispatchTodo(db, { action: "show", list: "iso/main" }),
	).total;
	const teamBefore = detailsCounts(
		await dispatchTodo(db, { action: "show", list: "iso/main" }, team),
	).total;
	await addItems("iso/main", ["team-2"], { caller: team });

	const teamShow = await dispatchTodo(db, { action: "show", list: "iso/main" }, team);
	assert.equal(detailsList(teamShow).namespace, "team");
	assert.equal(
		detailsCounts(teamShow).total,
		teamBefore + 1,
		"child wrote its own copy",
	);
	assert.equal(detailsTree(teamShow)[0]?.text, "team-1");

	const globalShow = await dispatchTodo(db, { action: "show", list: "iso/main" });
	assert.equal(
		detailsCounts(globalShow).total,
		globalBefore,
		"global untouched",
	);

	const childLists = await listLabels(team);
	assert.ok(childLists.includes("team:iso/main"));
	assert.ok(!childLists.includes("global:iso/main"));
});

test("a path missing from the child's namespace is not found for reads", async () => {
	await addItems("iso/global-only", ["only-global"]);
	await assert.rejects(
		dispatchTodo(db, { action: "show", list: "iso/global-only" }, team),
		/List 'iso\/global-only' not found/,
	);
});

// ---- existing globals ------------------------------------------------------

test("a bound session can mutate existing global lists", async () => {
	const ids = await addItems("iso/global-ops", ["g-root", "g-leaf"]);
	const rootId = ids[0] as number;

	// task update
	const updated = await dispatchTodo(
		db,
		{
			action: "update",
			list: "iso/global-ops",
			namespace: "global",
			id: rootId,
			status: "in_progress",
		},
		team,
	);
	assert.equal(detailsCounts(updated).in_progress, 1);

	// move (reorder within the list)
	const moved = await dispatchTodo(
		db,
		{ action: "move", list: "iso/global-ops", namespace: "global", id: rootId },
		team,
	);
	assert.equal(detailsAffected(moved).moved, true);
	assert.equal(detailsCounts(moved).total, 2, "moved the task, added nothing");

	// list metadata update
	const meta = await dispatchTodo(
		db,
		{
			action: "update",
			list: "iso/global-ops",
			namespace: "global",
			title: "Shared",
			description: "set by a child",
		},
		team,
	);
	assert.equal(detailsList(meta).namespace, "global");
	assert.equal(detailsList(meta).title, "Shared");
	assert.equal(detailsAffected(meta).updated_list, true);

	// create on an existing global list stays idempotent and reports that it
	// did not create anything
	const created = await dispatchTodo(
		db,
		{ action: "create", list: "iso/global-ops", namespace: "global" },
		team,
	);
	assert.equal(detailsAffected(created).created_list, false);
	assert.equal(detailsList(created).title, "Shared", "same list, not a new one");
	assert.equal(detailsCounts(created).total, 2);

	// add to an existing global list
	const added = await dispatchTodo(
		db,
		{
			action: "add",
			list: "iso/global-ops",
			namespace: "global",
			items: [{ text: "g-done", status: "done" }],
		},
		team,
	);
	assert.equal(detailsAffected(added).added, 1);
	assert.equal(detailsCounts(added).total, 3);

	// purge completed work
	const purged = await dispatchTodo(
		db,
		{ action: "purge", list: "iso/global-ops", namespace: "global" },
		team,
	);
	assert.equal(detailsAffected(purged).deleted, 1, "purged the done leaf");
	assert.equal(detailsCounts(purged).total, 2);

	// delete one task
	const deleted = await dispatchTodo(
		db,
		{ action: "delete", list: "iso/global-ops", namespace: "global", id: rootId },
		team,
	);
	assert.equal(detailsAffected(deleted).deleted, 1);
	assert.equal(detailsCounts(deleted).total, 1, "the pending task survives");
});

test("a bound session can delete an existing global list", async () => {
	await addItems("iso/global-delete", ["doomed"]);
	const deleted = await dispatchTodo(
		db,
		{ action: "delete_list", list: "iso/global-delete", namespace: "global" },
		team,
	);
	assert.match(deleted.content.text, /Deleted list 'iso\/global-delete'/);
	assert.ok(!(await listLabels(parent, "*")).includes("global:iso/global-delete"));
});

// ---- creation restriction --------------------------------------------------

test("a bound session cannot create missing global lists, via create or add", async () => {
	await assert.rejects(
		dispatchTodo(
			db,
			{ action: "create", list: "iso/missing", namespace: "global" },
			team,
		),
		/cannot create new global lists/,
	);
	await assert.rejects(
		addItems("iso/missing", ["nope"], { caller: team, namespace: "global" }),
		/cannot create new global lists/,
	);
	assert.ok(!(await listLabels(parent, "*")).includes("global:iso/missing"));
});

test("delete-then-add on a global list fails instead of recreating it", async () => {
	await addItems("iso/gone", ["about-to-go"]);
	await dispatchTodo(
		db,
		{ action: "delete_list", list: "iso/gone", namespace: "global" },
		team,
	);
	await assert.rejects(
		addItems("iso/gone", ["resurrected"], {
			caller: team,
			namespace: "global",
		}),
		/cannot create new global lists/,
	);
	assert.ok(
		!(await listLabels(parent, "*")).includes("global:iso/gone"),
		"the rejected add did not recreate the shared list",
	);
});

test("a failing add on an existing global list rolls back without creating anything", async () => {
	await addItems("iso/rollback", ["kept"]);
	await assert.rejects(
		dispatchTodo(
			db,
			{
				action: "add",
				list: "iso/rollback",
				namespace: "global",
				items: [{ text: "never" }],
				under: 999999,
			},
			team,
		),
		/Task #999999 not found in this list/,
	);
	const show = await dispatchTodo(db, {
		action: "show",
		list: "iso/rollback",
		namespace: "global",
	});
	assert.equal(detailsCounts(show).total, 1);
	assert.equal(detailsTree(show)[0]?.text, "kept");
});

test("a bound session can read the global namespace (root and scoped lists)", async () => {
	await addItems("ns-root", ["root-task"]);
	const childGlobal = await listLabels(team, "global");
	assert.ok(childGlobal.includes("global:ns-root"), "root list visible");
	assert.ok(childGlobal.includes("global:iso/main"), "scoped list visible");
	assert.ok(!childGlobal.includes("team:iso/main"), "own namespace not mixed in");

	const scoped = await dispatchTodo(
		db,
		{ action: "lists", namespace: "global", scope: "iso" },
		team,
	);
	const scopedPaths = detailsLists(scoped).map((l) => l.path);
	assert.ok(scopedPaths.includes("iso/main"));
	assert.ok(!scopedPaths.includes("ns-root"), "scope filter still applies");

	const show = await dispatchTodo(
		db,
		{ action: "show", list: "ns-root", namespace: "global" },
		team,
	);
	assert.equal(detailsList(show).namespace, "global");
	assert.equal(detailsTree(show)[0]?.text, "root-task");
});

test("the parent may target arbitrary namespaces, including delete_list", async () => {
	await addItems("iso/parent-owned", ["x"], { namespace: "scratch" });
	const deleted = await dispatchTodo(db, {
		action: "delete_list",
		list: "iso/parent-owned",
		namespace: "scratch",
	});
	assert.equal(detailsList(deleted).namespace, "scratch");
	assert.ok(
		!(await listLabels(parent, "*")).includes("scratch:iso/parent-owned"),
	);
});

// ---- create signals --------------------------------------------------------

test("create reports created_list only for a genuinely new list", async () => {
	const first = await dispatchTodo(db, {
		action: "create",
		list: "iso/create-flag",
		title: "First",
	});
	assert.equal(detailsAffected(first).created_list, true, "new list");

	const second = await dispatchTodo(db, {
		action: "create",
		list: "iso/create-flag",
		namespace: "global",
	});
	assert.equal(
		detailsAffected(second).created_list,
		false,
		"ensuring an existing list is not a creation",
	);
	assert.equal(detailsList(second).title, "First", "same list, untouched");
	assert.equal(detailsList(second).path, "iso/create-flag");
});

// ---- sibling / wildcard restrictions ---------------------------------------

test("sibling namespaces are closed to a bound session", async () => {
	await addItems("iso/sibling", ["other-owned"], { caller: other });
	await assert.rejects(
		dispatchTodo(db, { action: "show", list: "iso/sibling", namespace: "other" }, team),
		/outside this session's namespace 'team'/,
	);
	await assert.rejects(
		addItems("iso/sibling", ["x"], { caller: team, namespace: "other" }),
		/outside this session's namespace 'team'/,
	);
	await assert.rejects(
		dispatchTodo(db, { action: "lists", namespace: "other" }, team),
		/outside this session's namespace 'team'/,
	);
	await assert.rejects(
		dispatchTodo(db, { action: "lists", namespace: "*" }, team),
		/only available to the parent session/,
	);
});

test("the wildcard is parent-only and discovery-only", async () => {
	await assert.rejects(
		dispatchTodo(db, { action: "show", list: "iso/main", namespace: "*" }, parent),
		/only valid for action 'lists'/,
	);
	await assert.rejects(
		dispatchTodo(
			db,
			{ action: "add", list: "iso/main", namespace: "*", items: [{ text: "x" }] },
			parent,
		),
		/only valid for action 'lists'/,
	);
	const all = await dispatchTodo(db, { action: "lists", namespace: "*" }, parent);
	assert.equal(all.details.namespace, "*");
});

test("malformed and reserved namespace identifiers are rejected", async () => {
	for (const bad of ["has space", "a/b", "-leading", "\u0000bad"]) {
		await assert.rejects(
			dispatchTodo(
				db,
				{ action: "lists", namespace: bad },
				boundCaller("team"),
			),
			/Invalid namespace|only available to the parent|outside this session/,
			`selector '${bad}' must not resolve`,
		);
	}
	assert.throws(() => boundCaller("global"), /Invalid namespace/);
	assert.throws(() => boundCaller("*"), /Invalid namespace/);
	assert.throws(() => boundCaller("has space"), /Invalid namespace/);
});

test("an empty namespace selector means the caller's default", async () => {
	const childShow = await dispatchTodo(
		db,
		{ action: "show", list: "iso/main", namespace: "" },
		team,
	);
	assert.equal(detailsList(childShow).namespace, "team");
	const parentShow = await dispatchTodo(db, {
		action: "show",
		list: "iso/main",
		namespace: "",
	});
	assert.equal(detailsList(parentShow).namespace, "global");
});

test("add details name the resolved namespace", async () => {
	const teamAdd = await dispatchTodo(
		db,
		{
			action: "add",
			list: "iso/details-team",
			items: [{ text: "team-detail" }],
		},
		team,
	);
	assert.equal(teamAdd.details.namespace, "team");

	const globalAdd = await dispatchTodo(db, {
		action: "add",
		list: "iso/details-global",
		items: [{ text: "global-detail" }],
	});
	assert.equal(globalAdd.details.namespace, "global");
});

// ---- next ------------------------------------------------------------------

test("lists and next default to the caller's own namespace only", async () => {
	await addItems("iso/next-global", ["parent-next"]);
	await addItems("iso/next-team", ["child-next"], { caller: team });

	const parentNext = await dispatchTodo(db, { action: "next" }, parent);
	assert.equal(detailsList(parentNext).namespace, "global");

	const childNext = await dispatchTodo(db, { action: "next" }, team);
	assert.equal(detailsList(childNext).namespace, "team");
	assert.equal(childNext.details.next_task === null, false);

	const childGlobalNext = await dispatchTodo(
		db,
		{ action: "next", namespace: "global" },
		team,
	);
	assert.equal(detailsList(childGlobalNext).namespace, "global");

	// Within one list: the child reads its own copy, not the global one.
	const within = await dispatchTodo(db, { action: "next", list: "iso/main" }, team);
	assert.equal(detailsList(within).namespace, "team");
});

test("tool text identifies the namespace for every list action", async () => {
	const caller = boundCaller("output-check");
	const list = "output/tasks";
	const labelled = async (params: Parameters<typeof dispatchTodo>[1]) => {
		const result = await dispatchTodo(db, params, caller);
		assert.match(result.content.text, /namespace[: ]+['"]?output-check/);
		return result;
	};

	await labelled({ action: "create", list });
	const added = await labelled({
		action: "add", list,
		items: [
			{ ref: "root", text: "root" },
			{ text: "child", underRef: "root", status: "done" },
			{ text: "sibling" },
		],
	});
	const [root, child, sibling] = added.details.added_items as number[];
	await labelled({ action: "show", list });
	await labelled({ action: "show", list: `${list}#${root}`, format: "flat" });
	await labelled({ action: "update", list, id: root, note: "changed" });
	await labelled({ action: "update", list, title: "Changed title" });
	await labelled({ action: "move", list, id: sibling, under: root });
	await labelled({ action: "delete", list, id: child });
	await labelled({ action: "purge", list });
	await labelled({ action: "next", list });
	await labelled({ action: "next", list: `${list}#${root}` });
	await labelled({ action: "next" });
	await labelled({ action: "create", list: "output/copy", from: list });
	await labelled({ action: "delete_list", list: "output/copy" });

	const empty = await dispatchTodo(db, { action: "next" }, boundCaller("output-empty"));
	assert.equal(empty.details.next_task, null);
	assert.match(empty.content.text, /namespace 'output-empty'/);
	const global = await dispatchTodo(db, { action: "create", list: "output/global" });
	assert.doesNotMatch(global.content.text, /namespace/);
});

// ---- back-compatible DB surface -------------------------------------------

test("DB list APIs keep defaulting to the global namespace", () => {
	assert.ok(db.getLists().every((l) => l.namespace === ""));
	assert.equal(db.getList("iso", "main")?.namespace, "");
	assert.equal(db.getList("iso", "main", "team")?.namespace, "team");
	assert.equal(db.ensureList("iso", "db-default").namespace, "");
	assert.equal(
		db.nextTaskAcross("pending")?.namespace,
		"",
		"nextTaskAcross defaults to global",
	);
	assert.ok(
		db.getListsAllNamespaces().some((l) => l.namespace === "team"),
		"all-namespace discovery includes named namespaces",
	);
});

// ---- deps / tool-def handoff ----------------------------------------------

test("buildTodoToolDef injects the session caller into dispatch", async () => {
	const def = buildTodoToolDef({
		getDb: async () => db,
		caller: team,
	});
	const result = await def.execute(
		"call-1",
		{ action: "add", list: "iso/def", items: [{ text: "from-def" }] },
		undefined,
	);
	assert.equal((result.details.list as ListDetails).namespace, "team");
	assert.ok(!(await listLabels(parent, "*")).includes("global:iso/def"));
});

test("tool parameters keep plain string enums for providers", () => {
	const schema = JSON.stringify(TodoToolParams);
	assert.match(
		schema,
		/"action":\{"type":"string","enum":\["lists","show","create","add","update","move","delete","delete_list","purge","next"\]/,
	);
	assert.doesNotMatch(schema, /"action":\{[^}]*"anyOf"/);
	assert.match(schema, /"namespace":\{"type":"string"/);
});
