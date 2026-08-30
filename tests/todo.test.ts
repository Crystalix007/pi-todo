/**
 * Regression tests for the agent-usability fixes (council pass).
 *
 * Behaviors under test:
 *  - `add` validates `under` (no raw FK error, no cross-list orphan)
 *  - `add` returns added ids + flags list auto-creation
 *  - `next` returns a success payload (next_task:null) when the queue is empty
 *  - `next` content marks the picked task (`next → #id`)
 *  - `delete` reports the true subtree-removed count
 *  - renderTree's truncation count never goes negative
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TodoDb } from "../src/db.ts";

// Point the DB at a throwaway file BEFORE the first getDb() call.
const dir = mkdtempSync(join(tmpdir(), "pi-todo-test-"));
process.env.PI_TODO_DB = join(dir, "todo.db");

const { getDb, closeTodoDb } = await import("../src/db.ts");
const { dispatchTodo } = await import("../src/tool.ts");
const { renderTree, countsOfTree } = await import("../src/render.ts");
const { parseListPath } = await import("../src/paths.ts");

let db: TodoDb;

before(async () => {
	db = await getDb();
});

after(() => {
	closeTodoDb().then(() => rmSync(dir, { recursive: true, force: true }));
});

test("next across all lists returns success with next_task:null when empty", async () => {
	const r = await dispatchTodo(db, { action: "next" });
	assert.equal(r.details.next_task, null);
	assert.equal(r.details.action, "next");
	assert.match(r.content.text, /No 'pending' tasks found in any list/);
});

test("add returns added ids, flags created_list, and prefixes content", async () => {
	const r = await dispatchTodo(db, {
		action: "add",
		list: "usability/t1",
		items: [
			{ ref: "p", text: "Parent" },
			{ text: "Child", underRef: "p" },
		],
	});
	assert.equal(r.details.affected.created_list, true);
	const ids = r.details.added_items as number[];
	assert.equal(ids.length, 2);
	assert.match(r.content.text, /^added 2 task\(s\): #\d+, #\d+/);
	// ids are referenced in the returned tree
	for (const id of ids) assert.match(r.content.text, new RegExp(`#${id} `));
});

test("add with a nonexistent under throws an actionable error", async () => {
	await assert.rejects(
		dispatchTodo(db, {
			action: "add",
			list: "usability/t2",
			items: [{ text: "x" }],
			under: 99999,
		}),
		/Task #99999 not found in this list/,
	);
});

test("add with an under id from another list is rejected (no orphan)", async () => {
	// parent in list A
	const a = await dispatchTodo(db, {
		action: "add",
		list: "usability/t3a",
		items: [{ text: "parent-in-a" }],
	});
	const parentId = (a.details.added_items as number[])[0];
	// child in list B referencing list A's id
	await assert.rejects(
		dispatchTodo(db, {
			action: "add",
			list: "usability/t3b",
			items: [{ text: "child" }],
			under: parentId,
		}),
		/Task #\d+ not found in this list/,
	);
	// nothing was inserted into B — the whole txn (incl. list auto-create) rolled back
	await assert.rejects(
		dispatchTodo(db, { action: "show", list: "usability/t3b" }),
		/List 'usability\/t3b' not found/,
	);
});

test("next within a list picks a task, marks it in content, and does not change status", async () => {
	await dispatchTodo(db, {
		action: "add",
		list: "usability/t4",
		items: [{ text: "low-prio" }, { text: "top-pick", priority: "critical" }],
	});
	const r = await dispatchTodo(db, { action: "next", list: "usability/t4" });
	const picked = r.details.next_task as { id: number; text: string };
	assert.equal(picked.text, "top-pick");
	assert.match(r.content.text, new RegExp(`^next → #${picked.id} top-pick`));
	// read-only: still pending afterwards
	const after1 = await dispatchTodo(db, {
		action: "show",
		list: "usability/t4",
	});
	assert.equal(after1.details.counts.pending, 2);
});

test("next within an exhausted list returns success with next_task:null", async () => {
	await dispatchTodo(db, {
		action: "add",
		list: "usability/t5",
		items: [{ text: "only", status: "done" }],
	});
	const r = await dispatchTodo(db, { action: "next", list: "usability/t5" });
	assert.equal(r.details.next_task, null);
	assert.match(r.content.text, /No 'pending' tasks found in 'usability\/t5'/);
});

test("delete reports the true removed count for a subtree", async () => {
	const r = await dispatchTodo(db, {
		action: "add",
		list: "usability/t6",
		items: [
			{ ref: "p", text: "root" },
			{ text: "c1", underRef: "p" },
			{ text: "c2", underRef: "p" },
		],
	});
	const rootId = (r.details.added_items as number[])[0];
	const del = await dispatchTodo(db, {
		action: "delete",
		list: "usability/t6",
		id: rootId,
	});
	assert.equal(del.details.affected.deleted, 3);
	assert.equal(del.details.counts.total, 0);
});

test("next respects the status filter (in_progress)", async () => {
	await dispatchTodo(db, {
		action: "add",
		list: "usability/t8",
		items: [{ text: "busy", status: "in_progress" }, { text: "not-yet" }],
	});
	const r = await dispatchTodo(db, {
		action: "next",
		list: "usability/t8",
		status: "in_progress",
	});
	assert.equal(r.details.next_task.text, "busy");
	// default status is pending — picks the pending task instead
	const r2 = await dispatchTodo(db, { action: "next", list: "usability/t8" });
	assert.equal(r2.details.next_task.text, "not-yet");
});

test("next within a subtree ref picks only descendants", async () => {
	await dispatchTodo(db, {
		action: "add",
		list: "usability/t9",
		items: [
			{ ref: "a", text: "branch A" },
			{ text: "a1", underRef: "a" },
			{ text: "a2", underRef: "a" },
			{ text: "sibling" },
		],
	});
	const show = await dispatchTodo(db, { action: "show", list: "usability/t9" });
	const m = show.content.text.match(/#(\d+) branch A/);
	const branchA = Number(m?.[1]);
	const next = await dispatchTodo(db, {
		action: "next",
		list: `usability/t9#${branchA}`,
	});
	// the pick is within the subtree (root or children), never the sibling
	assert.match(next.details.next_task.text, /^(branch A|a[12])$/);
	assert.notEqual(next.details.next_task.text, "sibling");
});

test("renderTree truncation count never goes negative", () => {
	const tree = Array.from({ length: 150 }, (_, i) => ({
		id: i + 1,
		text: `task ${i + 1}`,
		status: "pending" as const,
		priority: "medium" as const,
		description: "a description line making each task render 2 lines",
		children: [],
	}));
	const counts = countsOfTree(tree);
	const out = renderTree(
		{ tree, counts, path: "usability/t7", title: null },
		{ maxLines: 60 },
	);
	assert.equal(out.truncated, true);
	const m = out.text.match(/… (\d+) more task\(s\) truncated/);
	assert.ok(m, "truncation notice present");
	assert.ok(Number(m[1]) >= 0, `remaining count is not negative: ${m[1]}`);
});

test("parseListPath still parses subtree refs (no regression)", () => {
	const ref = parseListPath("feature/auth#7");
	assert.equal(ref.scope, "feature");
	assert.equal(ref.name, "auth");
	assert.equal(ref.rootTaskId, 7);
});

// ---------------------------------------------------------------------------
// List metadata: project_path + description (goal) exposed in every read
// ---------------------------------------------------------------------------

test("create stores project_path + description; reads echo them", async () => {
	const created = await dispatchTodo(db, {
		action: "create",
		list: "projctx/feat",
		title: "Feature work",
		project_path: "/tmp/my-app",
		description: "Ship the billing page",
	});
	assert.equal(created.details.list.project_path, "/tmp/my-app");
	assert.equal(created.details.list.description, "Ship the billing page");

	// Full-list show echoes both in the header.
	const show = await dispatchTodo(db, { action: "show", list: "projctx/feat" });
	assert.match(show.content.text, /project: \/tmp\/my-app/);
	assert.match(show.content.text, /goal: Ship the billing page/);

	// lists output carries the project path too.
	const lists = await dispatchTodo(db, { action: "lists", scope: "projctx" });
	assert.match(lists.content.text, /project: \/tmp\/my-app/);

	// Add tasks, then a SUBTREE read must still carry the project context +
	// overall goal (this is what a scoped subagent sees).
	const added = await dispatchTodo(db, {
		action: "add",
		list: "projctx/feat",
		items: [
			{ ref: "p", text: "root" },
			{ text: "leaf", underRef: "p" },
		],
	});
	const rootId = (added.details.added_items as number[])[0];
	const sub = await dispatchTodo(db, {
		action: "show",
		list: `projctx/feat#${rootId}`,
	});
	assert.match(sub.content.text, /project: \/tmp\/my-app/);
	assert.match(sub.content.text, /goal: Ship the billing page/);
	// The subtree header also names the root task.
	assert.match(sub.content.text, new RegExp(`#${rootId} "root"`));

	// Subtree next carries it too.
	const next = await dispatchTodo(db, {
		action: "next",
		list: `projctx/feat#${rootId}`,
	});
	assert.match(next.content.text, /project: \/tmp\/my-app/);
	assert.match(next.content.text, /goal: Ship the billing page/);
});

test("update without id edits list metadata; '' clears a field", async () => {
	await dispatchTodo(db, {
		action: "create",
		list: "projctx/meta",
		project_path: "/tmp/a",
	});

	const up = await dispatchTodo(db, {
		action: "update",
		list: "projctx/meta",
		project_path: "/tmp/b",
		description: "the new goal",
		title: "Retitled",
	});
	assert.equal(up.details.list.project_path, "/tmp/b");
	assert.equal(up.details.list.description, "the new goal");
	assert.equal(up.details.list.title, "Retitled");
	assert.equal(up.details.affected.updated_list, true);

	const cleared = await dispatchTodo(db, {
		action: "update",
		list: "projctx/meta",
		project_path: "",
	});
	assert.equal(cleared.details.list.project_path, undefined);
	// Others survive the partial clear.
	assert.equal(cleared.details.list.description, "the new goal");

	// Nothing given → still an actionable error.
	await assert.rejects(
		dispatchTodo(db, { action: "update", list: "projctx/meta" }),
		/needs a task 'id'|list metadata fields/,
	);
});

test("task update cannot silently mix in list-level fields", async () => {
	await dispatchTodo(db, {
		action: "create",
		list: "projctx/taskupd",
	});
	const added = await dispatchTodo(db, {
		action: "add",
		list: "projctx/taskupd",
		items: [{ text: "a task" }],
	});
	const taskId = (added.details.added_items as number[])[0];
	await assert.rejects(
		dispatchTodo(db, {
			action: "update",
			list: "projctx/taskupd",
			id: taskId,
			title: "oops",
		}),
		/list-level fields/,
	);
	// description with an id is still a per-task description.
	const ok = await dispatchTodo(db, {
		action: "update",
		list: "projctx/taskupd",
		id: taskId,
		description: "per-task note",
	});
	assert.equal(ok.details.list.description, undefined); // not list metadata
	assert.equal(ok.details.affected.updated, 1);
});
