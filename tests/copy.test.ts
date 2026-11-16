/**
 * `create` with `from` / `from_namespace`: the list copy API.
 *
 * Contract under test:
 *  - the copy is independent and complete: metadata, every task field, sibling
 *    order, nested structure — with fresh ids and unchanged source
 *  - explicit create fields override the copied metadata, including '' clears
 *  - a copy needs a NEW destination: an existing list is refused even when empty
 *  - same source/destination, '#id' subtree refs, and from_namespace without
 *    from are rejected
 *  - namespace policy applies to source AND destination: a bound session can
 *    copy a global list into its own namespace but cannot copy into global or a
 *    sibling namespace
 *  - the copy is one transaction: a failure part-way leaves nothing behind
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

const dir = mkdtempSync(join(tmpdir(), "pi-todo-copy-test-"));
process.env.PI_TODO_DB = join(dir, "todo.db");

const { getDb, closeTodoDb } = await import("../src/db.ts");
const { dispatchTodo } = await import("../src/tool.ts");
const { boundCaller, UNBOUND_CALLER } = await import("../src/namespace.ts");

const parent: TodoCaller = UNBOUND_CALLER;
const child: TodoCaller = boundCaller("job-worker-a");

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

/** The fields a copy must reproduce — ids excluded on purpose. */
interface Projection {
	text: string;
	status: string;
	priority: string;
	note?: string;
	tags?: string[];
	description?: string;
	children: Projection[];
}

function project(tree: TaskNode[]): Projection[] {
	return tree.map((n) => ({
		text: n.text,
		status: n.status,
		priority: n.priority,
		note: n.note,
		tags: n.tags,
		description: n.description,
		children: project(n.children),
	}));
}

function ids(tree: TaskNode[]): number[] {
	return tree.flatMap((n) => [n.id, ...ids(n.children)]);
}

async function show(
	list: string,
	namespace?: string,
	caller: TodoCaller = parent,
): Promise<{ list: ListDetails; tree: TaskNode[]; counts: Counts }> {
	const r = await dispatchTodo(db, { action: "show", list, namespace }, caller);
	return {
		list: r.details.list as ListDetails,
		tree: r.details.tree as TaskNode[],
		counts: r.details.counts as Counts,
	};
}

async function addItems(
	list: string,
	texts: string[],
	namespace?: string,
): Promise<number[]> {
	const r = await dispatchTodo(db, {
		action: "add",
		list,
		namespace,
		items: texts.map((text) => ({ text })),
	});
	return r.details.added_items as number[];
}

/** A source list with metadata, nested tasks, and every task field populated. */
async function seedSource(path: string, namespace?: string): Promise<void> {
	await dispatchTodo(db, {
		action: "create",
		list: path,
		namespace,
		title: "Source list",
		project_path: "/tmp/project",
		description: "the overall goal",
	});
	await dispatchTodo(db, {
		action: "add",
		list: path,
		namespace,
		items: [
			{
				ref: "a",
				text: "alpha",
				status: "in_progress",
				priority: "high",
				note: "alpha note",
				tags: ["blocked"],
				description: "alpha description",
			},
			{ text: "alpha-1", underRef: "a", priority: "critical" },
			{ text: "alpha-2", underRef: "a", status: "done", note: "done child" },
			{ text: "beta", priority: "low" },
			{ text: "gamma", tags: ["waiting-on-input", "external"] },
		],
	});
}

function copied(result: { details: Details }): number {
	return (result.details.affected as { copied: number }).copied;
}

// ---- the copy itself -------------------------------------------------------

test("create with from deep-copies metadata, tasks, and sibling order", async () => {
	await seedSource("copy/src");
	const source = await show("copy/src");
	const sourceIds = ids(source.tree);

	const r = await dispatchTodo(db, {
		action: "create",
		list: "copy/dest",
		from: "copy/src",
	});
	assert.equal(copied(r), 5);
	assert.equal((r.details.affected as { created_list: boolean }).created_list, true);
	const dest = r.details.list as ListDetails;
	assert.equal(dest.path, "copy/dest");
	assert.equal(dest.namespace, "global");
	assert.equal(dest.title, "Source list");
	assert.equal(dest.project_path, "/tmp/project");
	assert.equal(dest.description, "the overall goal");
	assert.deepEqual(r.details.source, {
		namespace: "global",
		scope: "copy",
		name: "src",
		path: "copy/src",
	});
	// The response already carries the destination's tree and counts.
	assert.deepEqual(project(r.details.tree as TaskNode[]), project(source.tree));
	assert.deepEqual(r.details.counts, source.counts);

	// Independent rows: fresh ids, identical content and order.
	const copy = await show("copy/dest");
	const copyIds = ids(copy.tree);
	assert.equal(copyIds.length, sourceIds.length);
	for (const id of copyIds) {
		assert.ok(!sourceIds.includes(id), `copied task #${id} is a new row`);
	}
	assert.deepEqual(project(copy.tree), project(source.tree));

	// The source is untouched.
	const sourceAfter = await show("copy/src");
	assert.deepEqual(project(sourceAfter.tree), project(source.tree));
	assert.deepEqual(ids(sourceAfter.tree), sourceIds);
	assert.deepEqual(sourceAfter.counts, source.counts);
	assert.equal(sourceAfter.list.title, "Source list");
});

test("explicit create fields override copied metadata and '' clears it", async () => {
	await seedSource("copy/override-src");
	const r = await dispatchTodo(db, {
		action: "create",
		list: "copy/override-dest",
		from: "copy/override-src",
		title: "Destination title",
		description: "",
	});
	const list = r.details.list as ListDetails;
	assert.equal(list.title, "Destination title");
	assert.equal(list.description, undefined, "'' cleared the copied description");
	assert.equal(list.project_path, "/tmp/project", "omitted keeps the copied value");
});

test("an empty source list copies metadata only", async () => {
	await dispatchTodo(db, {
		action: "create",
		list: "copy/empty-src",
		title: "Nothing to do yet",
		description: "empty goal",
	});
	const r = await dispatchTodo(db, {
		action: "create",
		list: "copy/empty-dest",
		from: "copy/empty-src",
	});
	assert.equal(copied(r), 0);
	assert.equal((r.details.list as ListDetails).title, "Nothing to do yet");
	assert.equal((r.details.list as ListDetails).description, "empty goal");
	assert.equal((r.details.counts as Counts).total, 0);
	assert.deepEqual(r.details.tree, []);
});

// ---- rejected copies -------------------------------------------------------

test("a copy needs a new destination, while plain create stays idempotent", async () => {
	await dispatchTodo(db, { action: "create", list: "copy/existing-dest" });
	await assert.rejects(
		dispatchTodo(db, {
			action: "create",
			list: "copy/existing-dest",
			from: "copy/src",
		}),
		/already exists in namespace 'global'. A copy needs a new destination/,
	);
	// Ordinary create (no 'from') on the same list is still a no-op ensure.
	const again = await dispatchTodo(db, { action: "create", list: "copy/existing-dest" });
	assert.equal((again.details.counts as Counts).total, 0);
	assert.equal((again.details.list as ListDetails).path, "copy/existing-dest");
});

test("same source and destination, subtree refs, and stray from_namespace are rejected", async () => {
	await assert.rejects(
		dispatchTodo(db, {
			action: "create",
			list: "copy/src",
			from: "copy/src",
		}),
		/Source and destination are the same list/,
	);
	await assert.rejects(
		dispatchTodo(db, {
			action: "create",
			list: "copy/subtree-dest",
			from: "copy/src#2",
		}),
		/'from' must name a whole list/,
	);
	await assert.rejects(
		dispatchTodo(db, {
			action: "create",
			list: "copy/nope",
			from_namespace: "global",
		}),
		/'from_namespace' only selects the namespace of a copied source list/,
	);
	await assert.rejects(
		dispatchTodo(db, {
			action: "create",
			list: "copy/missing-src-dest",
			from: "copy/does-not-exist",
		}),
		/Source list 'copy\/does-not-exist' not found in namespace 'global'/,
	);
	// '*' discovers namespaces, it never selects one to copy from.
	await assert.rejects(
		dispatchTodo(db, {
			action: "create",
			list: "copy/wildcard-dest",
			from: "copy/src",
			from_namespace: "*",
		}),
		/'from_namespace' must name one namespace/,
	);
});

// ---- namespaces ------------------------------------------------------------

test("a bound session copies a global list into its own namespace", async () => {
	const source = await show("copy/src");
	const r = await dispatchTodo(
		db,
		{ action: "create", list: "copy/child", from: "copy/src", from_namespace: "global" },
		child,
	);
	assert.equal((r.details.list as ListDetails).namespace, "job-worker-a");
	assert.equal(copied(r), 5);
	assert.deepEqual(project(r.details.tree as TaskNode[]), project(source.tree));

	// The shared source is untouched and the copy exists only in the child's view.
	const sourceAfter = await show("copy/src");
	assert.deepEqual(project(sourceAfter.tree), project(source.tree));
	await assert.rejects(
		dispatchTodo(db, { action: "show", list: "copy/child" }, parent),
		/List 'copy\/child' not found/,
	);
	assert.equal(
		(await show("copy/child", undefined, child)).list.namespace,
		"job-worker-a",
	);
});

test("the source namespace defaults to the caller's default namespace", async () => {
	await addItems("copy/own-src", ["child-owned"], "job-worker-a");
	const r = await dispatchTodo(
		db,
		{ action: "create", list: "copy/own-dest", from: "copy/own-src" },
		child,
	);
	assert.equal((r.details.source as ListDetails).namespace, "job-worker-a");
	assert.equal((r.details.list as ListDetails).namespace, "job-worker-a");
	assert.deepEqual(
		(r.details.tree as TaskNode[]).map((n) => n.text),
		["child-owned"],
	);
});

test("the parent copies across namespaces", async () => {
	await addItems("copy/peer-src", ["peer-owned"], "peer");
	const r = await dispatchTodo(db, {
		action: "create",
		list: "copy/from-peer",
		from: "copy/peer-src",
		from_namespace: "peer",
	});
	assert.equal((r.details.source as ListDetails).namespace, "peer");
	assert.equal((r.details.list as ListDetails).namespace, "global");
	assert.equal(copied(r), 1);
});

test("a bound session cannot copy into the shared global namespace", async () => {
	await addItems("copy/child-owned", ["mine"], "job-worker-a");
	await assert.rejects(
		dispatchTodo(
			db,
			{
				action: "create",
				list: "copy/into-global",
				namespace: "global",
				from: "copy/child-owned",
			},
			child,
		),
		/cannot create new global lists/,
	);
	await assert.rejects(
		dispatchTodo(db, { action: "show", list: "copy/into-global" }),
		/List 'copy\/into-global' not found/,
	);
});

test("a bound session cannot copy from or into a sibling namespace", async () => {
	await assert.rejects(
		dispatchTodo(
			db,
			{
				action: "create",
				list: "copy/sibling-src-dest",
				from: "copy/peer-src",
				from_namespace: "peer",
			},
			child,
		),
		/outside this session's namespace 'job-worker-a'/,
	);
	await assert.rejects(
		dispatchTodo(
			db,
			{
				action: "create",
				list: "copy/peer-dest",
				namespace: "peer",
				from: "copy/src",
				from_namespace: "global",
			},
			child,
		),
		/outside this session's namespace 'job-worker-a'/,
	);
});

// ---- atomicity -------------------------------------------------------------

test("a failure part-way through the copy rolls the destination back", async () => {
	await seedSource("copy/rollback-src");
	const before = await show("copy/rollback-src");

	const realInsert = db.insertTask.bind(db);
	let calls = 0;
	(db as unknown as { insertTask: typeof db.insertTask }).insertTask = (
		listId,
		spec,
	) => {
		calls += 1;
		if (calls === 3) throw new Error("copy fault");
		return realInsert(listId, spec);
	};
	try {
		await assert.rejects(
			dispatchTodo(db, {
				action: "create",
				list: "copy/rollback-dest",
				from: "copy/rollback-src",
			}),
			/copy fault/,
		);
	} finally {
		delete (db as unknown as { insertTask?: unknown }).insertTask;
	}

	// Neither the destination list nor any copied task survived, and the source
	// is unchanged.
	await assert.rejects(
		dispatchTodo(db, { action: "show", list: "copy/rollback-dest" }),
		/List 'copy\/rollback-dest' not found/,
	);
	const after = await show("copy/rollback-src");
	assert.deepEqual(after.counts, before.counts);
	assert.deepEqual(project(after.tree), project(before.tree));

	// The same copy succeeds once the fault is gone.
	const ok = await dispatchTodo(db, {
		action: "create",
		list: "copy/rollback-dest",
		from: "copy/rollback-src",
	});
	assert.equal(copied(ok), 5);
});

// ---- the DB primitive ------------------------------------------------------

test("TodoDb.copyList defaults to the global namespace and refuses an existing destination", () => {
	const source = db.getList("copy", "src");
	assert.ok(source);
	const result = db.copyList(source.id, {
		scope: "copy",
		name: "db-primitive-dest",
	});
	assert.equal(result.list.namespace, "", "default destination is global");
	assert.equal(result.list.title, "Source list");
	assert.equal(result.copied, 5);
	assert.throws(
		() =>
			db.copyList(source.id, { scope: "copy", name: "db-primitive-dest" }),
		/already exists; a copy needs a new destination list/,
	);
});
