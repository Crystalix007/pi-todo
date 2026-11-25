/**
 * `create` on an existing list must not silently rewrite its metadata.
 *
 * `ensureList` applies any non-empty title/project_path/description it is given,
 * so a typo'd or stale `create` could quietly replace a list's title or goal —
 * and in a brief digest the only trace was one receipt clause. Such a call now
 * fails with an actionable error; repeating it with `force: true` confirms.
 * Setting a field that is currently EMPTY is not destructive and stays allowed.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TodoDb } from "../src/db.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-todo-guard-"));
process.env.PI_TODO_DB = join(dir, "todo.db");

const { getDb, closeTodoDb } = await import("../src/db.ts");
const { dispatchTodo } = await import("../src/tool.ts");

let db: TodoDb;
const LIST = "guard/tasks";

before(async () => {
	db = await getDb();
	await dispatchTodo(db, {
		action: "create",
		list: LIST,
		title: "Original",
		description: "Original goal",
	});
});

after(() => {
	closeTodoDb().then(() => rmSync(dir, { recursive: true, force: true }));
});

test("create refuses to replace existing metadata", async () => {
	await assert.rejects(
		dispatchTodo(db, {
			action: "create",
			list: LIST,
			title: "Clobbered",
		}),
		/already exists and 'create' would overwrite its title \(currently set\)[\s\S]*force:true/,
	);
	// Nothing changed.
	const view = await dispatchTodo(db, { action: "show", list: LIST });
	const list = view.details.list as { title?: string; description?: string };
	assert.equal(list.title, "Original");
	assert.equal(list.description, "Original goal");
});

test("the refusal names every field it would overwrite", async () => {
	await assert.rejects(
		dispatchTodo(db, {
			action: "create",
			list: LIST,
			title: "New",
			description: "New goal",
		}),
		/title \(currently set\), goal \(currently set\)/,
	);
});

test("force:true is the deliberate repeat that confirms the overwrite", async () => {
	const r = await dispatchTodo(db, {
		action: "create",
		list: LIST,
		title: "New",
		force: true,
	});
	assert.match(r.content.text, /^changed: list already existed; title replaced \(3 chars\)$/m);
	const view = await dispatchTodo(db, { action: "show", list: LIST });
	assert.equal((view.details.list as { title?: string }).title, "New");
});

test("re-sending identical metadata is not a conflict", async () => {
	const r = await dispatchTodo(db, {
		action: "create",
		list: LIST,
		title: "New",
	});
	assert.match(r.content.text, /^no change: list already existed$/m);
});

test("filling an empty field is allowed without force", async () => {
	const r = await dispatchTodo(db, {
		action: "create",
		list: LIST,
		project_path: "/repo",
	});
	assert.match(r.content.text, /changed: list already existed; project set/);
});

test("a bare create still just ensures the list exists", async () => {
	const r = await dispatchTodo(db, { action: "create", list: LIST });
	assert.match(r.content.text, /^no change: list already existed$/m);
	assert.equal(r.details.affected.created_list, false);
});

test("affected.updated counts the whole cascade, not just the target", async () => {
	const added = await dispatchTodo(db, {
		action: "add",
		list: "guard/cascade",
		items: [
			{ ref: "p", text: "parent" },
			{ text: "child a", underRef: "p" },
			{ text: "child b", underRef: "p", status: "done" },
		],
	});
	const [parent, childA, childB] = added.details.added_items as number[];

	// Two descendants exist; one is already done, so only one status moves.
	const r = await dispatchTodo(db, {
		action: "update",
		list: "guard/cascade",
		id: parent,
		status: "done",
		cascade: true,
	});
	assert.equal((r.details.affected as { updated: number }).updated, 2);
	assert.match(r.content.text, /cascade 1 subtask → done \(1 already done\)/);

	const single = await dispatchTodo(db, {
		action: "update",
		list: "guard/cascade",
		id: childA,
		text: "child a renamed",
	});
	assert.equal((single.details.affected as { updated: number }).updated, 1);
	void childB;
});
