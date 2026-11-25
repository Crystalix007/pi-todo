/**
 * End-to-end output shape through the dispatcher (not just the renderer).
 *
 * Contract under test:
 *  - a mutation returns a `changed:` receipt plus a BRIEF digest: completed
 *    branches collapsed, open-task detail inline, done-task notes hidden;
 *  - `show` (the explicit read) still returns full fidelity, and `detail`
 *    overrides in either direction;
 *  - `next` returns a focus window and `next detail:"full"` the whole tree;
 *  - `details.tree` keeps the whole tree regardless of the text shape, so the
 *    TUI and any programmatic consumer lose nothing;
 *  - routine collapsing never sets `elided`.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TodoDb } from "../src/db.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-todo-shape-"));
process.env.PI_TODO_DB = join(dir, "todo.db");

const { getDb, closeTodoDb } = await import("../src/db.ts");
const { dispatchTodo } = await import("../src/tool.ts");

let db: TodoDb;
const LIST = "shape/tasks";

before(async () => {
	db = await getDb();
	await dispatchTodo(db, {
		action: "add",
		list: LIST,
		items: [
			{ ref: "p", text: "Build login", status: "in_progress", note: "Reuse the shared form component." },
			{ text: "HTML form", underRef: "p", status: "done", note: "Commit abc123 did this; 12 files." },
			{ text: "POST handler", underRef: "p", note: "No new deps; keep the API stable." },
			{ ref: "d", text: "DB schema", status: "done", note: "Migration 0007 applied." },
			{ text: "Indexes", underRef: "d", status: "done", note: "Added in the same migration." },
			{ text: "Docs" },
		],
	} as never);
});

after(() => {
	closeTodoDb().then(() => rmSync(dir, { recursive: true, force: true }));
});

test("a mutation returns a receipt plus a brief digest, not the whole history", async () => {
	const r = await dispatchTodo(db, {
		action: "update",
		list: LIST,
		id: 3,
		status: "done",
	});
	const text = r.content.text;
	assert.match(text, /^changed: #3 status pending → done$/m);
	// open-task detail is inline ...
	assert.match(text, /Reuse the shared form component/);
	// ... completed-task notes are not
	assert.doesNotMatch(text, /Commit abc123/);
	assert.doesNotMatch(text, /Migration 0007/);
	// the completed branch is collapsed, with its size
	assert.match(text, /\[x\] #4 DB schema  \(\+1 done\)/);
	assert.doesNotMatch(text, /#5 Indexes/);
	// routine collapse is not elision
	assert.equal(r.content.elided, false);
	assert.equal(r.details.elided, false);
	// and the machine-readable payload still has everything
	const tree = r.details.tree as { id: number; children: unknown[] }[];
	assert.equal(tree.length, 3);
});

test("a task that just became done stays visible (touched, not collapsed away)", async () => {
	const r = await dispatchTodo(db, {
		action: "update",
		list: LIST,
		id: 4,
		text: "DB schema v2",
	});
	assert.match(r.content.text, /changed: #4 text set/);
	assert.match(r.content.text, /\[x\] #4 DB schema v2/);
});

test("show keeps full fidelity and detail overrides work both ways", async () => {
	const full = await dispatchTodo(db, { action: "show", list: LIST });
	assert.match(full.content.text, /Commit abc123 did this/);
	assert.match(full.content.text, /Migration 0007 applied/);
	// `show` does not collapse completed branches by default
	assert.match(full.content.text, /#5 Indexes/);

	const brief = await dispatchTodo(db, { action: "show", list: LIST, detail: "brief" });
	assert.doesNotMatch(brief.content.text, /Commit abc123/);
	assert.match(brief.content.text, /\(\+1 done\)/);

	const mutated = await dispatchTodo(db, {
		action: "update",
		list: LIST,
		id: 6,
		priority: "high",
		detail: "full",
	});
	assert.match(mutated.content.text, /Commit abc123 did this/, "detail:'full' on a write");
});

test("next returns a focus window; detail:'full' restores the whole tree", async () => {
	const r = await dispatchTodo(db, { action: "next", list: LIST });
	const picked = r.details.next_task as { id: number; text: string; note: string | null };
	assert.match(r.content.text, new RegExp(`^next → #${picked.id} ${picked.text}`, "m"));
	// the pick's own detail is reproduced — it is about to be worked on
	if (picked.note) {
		for (const line of picked.note.split("\n"))
			assert.ok(r.content.text.includes(line), `pick note line: ${line}`);
	}
	assert.match(r.content.text, /← next/);
	// the pick line and one window line, not the whole list
	assert.ok(r.content.text.split("\n").length < 10);
	// the header keeps the list's context for a scoped agent
	assert.match(r.content.text.split("\n")[0]!, /^shape\/tasks/);

	const wide = await dispatchTodo(db, { action: "next", list: LIST, detail: "full" });
	assert.match(wide.content.text, /Commit abc123 did this/);
	assert.match(wide.content.text, /#5 Indexes/);
});

test("next carries the picked task's description in details", async () => {
	await dispatchTodo(db, {
		action: "update",
		list: LIST,
		id: 6,
		description: "Write the operator guide.",
		priority: "critical",
	});
	const r = await dispatchTodo(db, { action: "next", list: LIST });
	const picked = r.details.next_task as { description?: string };
	assert.equal(picked.description, "Write the operator guide.");
	assert.match(r.content.text, /▸ Write the operator guide\./);
});

test("next on an exhausted list is still a success result", async () => {
	await dispatchTodo(db, { action: "update", list: LIST, id: 6, status: "done" });
	const r = await dispatchTodo(db, { action: "next", list: LIST });
	assert.equal(r.details.next_task, null);
	assert.match(r.content.text, /No 'pending' tasks found/);
});
