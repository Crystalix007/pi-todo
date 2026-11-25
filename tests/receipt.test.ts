/**
 * Change receipts — the one line that lets an agent verify a write without
 * re-reading the list.
 *
 * Contract under test:
 *  - the prefix distinguishes a real change from a no-op (`changed:` / `no change:`);
 *  - a destructive clear names what was destroyed, because brief output may never
 *    have shown the old value;
 *  - a cascade reports only descendants whose status actually moved;
 *  - a move reports where the task really landed, not what was requested;
 *  - receipts never echo long values, so they stay one line.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	addReceipt,
	copyReceipt,
	createReceipt,
	deleteReceipt,
	deleteListReceipt,
	idList,
	moveReceipt,
	purgeReceipt,
	updateListReceipt,
	updateTaskReceipt,
	type TaskSnapshot,
} from "../src/receipt.ts";

const snap = (over: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
	id: 12,
	parent_id: null,
	status: "pending",
	priority: "medium",
	text: "task",
	note: null,
	tags: null,
	description: null,
	...over,
});

test("add names the parent when there is one, and flags a new list", () => {
	assert.equal(
		addReceipt({ added: [{ id: 13, parentId: null }], createdList: false }),
		"changed: added 1 task: #13 at top level",
	);
	assert.equal(
		addReceipt({
			added: [
				{ id: 13, parentId: 7 },
				{ id: 14, parentId: 7 },
			],
			createdList: true,
		}),
		"changed: added 2 tasks: #13, #14 under #7; new list",
	);
	// A nested batch has several parents: the digest below shows the placement,
	// so the receipt must not imply a single `under`.
	assert.equal(
		addReceipt({
			added: [
				{ id: 3, parentId: null },
				{ id: 1, parentId: 2 },
				{ id: 4, parentId: 2 },
			],
			createdList: false,
		}),
		"changed: added 3 tasks: #1, #3, #4",
	);
});

test("idList caps a huge batch in sorted order", () => {
	assert.equal(idList([9, 3, 5]), "#3, #5, #9");
	assert.equal(idList(Array.from({ length: 15 }, (_, i) => i + 1)), "#1, #2, #3, #4, #5, #6, #7, #8, #9, #10, #11, #12 (+3 more)");
});

test("a no-op update says 'no change', never 'changed'", () => {
	const r = updateTaskReceipt({
		requested: ["status"],
		before: snap({ status: "done" }),
		after: snap({ status: "done" }),
	});
	assert.equal(r, "no change: #12 status already done");
	assert.ok(!r.startsWith("changed"));
});

test("status and priority report the transition", () => {
	assert.equal(
		updateTaskReceipt({
			requested: ["status"],
			before: snap(),
			after: snap({ status: "done" }),
		}),
		"changed: #12 status pending → done",
	);
	assert.equal(
		updateTaskReceipt({
			requested: ["priority"],
			before: snap(),
			after: snap({ priority: "high" }),
		}),
		"changed: #12 priority medium → high",
	);
});

test("clearing a field names what was destroyed", () => {
	assert.equal(
		updateTaskReceipt({
			requested: ["note"],
			before: snap({ note: "x".repeat(142) }),
			after: snap({ note: null }),
		}),
		"changed: #12 note cleared (was 142 chars)",
	);
	assert.equal(
		updateTaskReceipt({
			requested: ["tags"],
			before: snap({ tags: "blocked,waiting-on-input" }),
			after: snap({ tags: null }),
		}),
		"changed: #12 tags cleared (was 2)",
	);
});

test("setting detail summarises instead of echoing it", () => {
	assert.equal(
		updateTaskReceipt({
			requested: ["note"],
			before: snap(),
			after: snap({ note: "y".repeat(80) }),
		}),
		"changed: #12 note set (80 chars)",
	);
	assert.equal(
		updateTaskReceipt({
			requested: ["description"],
			before: snap(),
			after: snap({ description: "a\nb\nc" }),
		}),
		"changed: #12 description set (3 lines)",
	);
	assert.equal(
		updateTaskReceipt({
			requested: ["tags"],
			before: snap(),
			after: snap({ tags: "blocked" }),
		}),
		"changed: #12 tags set {blocked}",
	);
});

test("multiple fields read as clauses of one receipt", () => {
	assert.equal(
		updateTaskReceipt({
			requested: ["text", "priority", "tags"],
			before: snap(),
			after: snap({ text: "new text", priority: "critical", tags: "blocked" }),
		}),
		"changed: #12 text set; priority medium → critical; tags set {blocked}",
	);
});

test("cascade counts only the descendants that actually moved", () => {
	const r = updateTaskReceipt({
		requested: ["status"],
		before: snap(),
		after: snap({ status: "done" }),
		cascade: { changed: 2, already: 1, status: "done" },
	});
	assert.equal(r, "changed: #12 status pending → done; cascade 2 subtasks → done (1 already done)");
});

test("a cascade that moves nothing is reported as such, not as a change", () => {
	assert.equal(
		updateTaskReceipt({
			requested: [],
			before: snap({ status: "done" }),
			after: snap({ status: "done" }),
			cascade: { changed: 0, already: 2, status: "done" },
		}),
		"no change: #12 cascade: no descendant status changed (2 already done)",
	);
});

test("cascade without a status is called out as ignored", () => {
	assert.equal(
		updateTaskReceipt({
			requested: ["text"],
			before: snap(),
			after: snap({ text: "renamed" }),
			cascadeIgnored: true,
		}),
		"changed: #12 text set; cascade ignored (no status given)",
	);
});

test("list metadata receipts separate set / replaced / cleared / unchanged", () => {
	const empty = { title: null, project_path: null, description: null };
	assert.equal(
		updateListReceipt({
			requested: ["title", "description"],
			before: empty,
			after: { ...empty, title: "Sprint", description: "Ship it" },
		}),
		"changed: list title set (6 chars); goal set (7 chars)",
	);
	assert.equal(
		updateListReceipt({
			requested: ["title"],
			before: { ...empty, title: "Sprint" },
			after: { ...empty, title: "Sprint" },
		}),
		"no change: list title unchanged",
	);
	assert.equal(
		updateListReceipt({
			requested: ["description"],
			before: { ...empty, description: "x".repeat(320) },
			after: empty,
		}),
		"changed: list goal cleared (was 320 chars)",
	);
});

test("move reports the real placement", () => {
	assert.equal(
		moveReceipt({ id: 9, fromParent: null, toParent: 7, placedAfter: 5 }),
		"changed: #9 top level → #7; placed after #5",
	);
	assert.equal(
		moveReceipt({ id: 9, fromParent: 7, toParent: 7, placedAfter: 5 }),
		"changed: #9 reordered; placed after #5",
	);
	assert.equal(
		moveReceipt({ id: 9, fromParent: 7, toParent: null }),
		"changed: #9 #7 → top level; appended at the end",
	);
	// `after` cannot be honoured for a non-sibling: say so instead of lying.
	assert.equal(
		moveReceipt({
			id: 9,
			fromParent: 7,
			toParent: 3,
			requestedAfter: 99,
			placedAfter: 42,
			appendedInstead: true,
		}),
		"changed: #9 #7 → #3; appended (#99 is not a sibling)",
	);
});

test("delete reports removed subtasks and how many were still open", () => {
	assert.equal(
		deleteReceipt({ id: 9, removed: 5, openRemoved: 2 }),
		"changed: deleted #9 (+4 subtasks, 2 open)",
	);
	assert.equal(
		deleteReceipt({ id: 9, removed: 1, openRemoved: 0 }),
		"changed: deleted #9",
	);
});

test("purge says when there was nothing to purge", () => {
	assert.equal(purgeReceipt(0), "no change: nothing to purge (no fully-done branch)");
	assert.equal(purgeReceipt(6), "changed: purged 6 tasks");
	assert.equal(purgeReceipt(1), "changed: purged 1 task");
});

test("create on an existing list surfaces the metadata it silently applied", () => {
	const empty = { title: null, project_path: null, description: null };
	assert.equal(
		createReceipt({
			created: true,
			requested: ["title"],
			before: empty,
			after: { ...empty, title: "Demo" },
		}),
		"changed: list created; title set",
	);
	assert.equal(
		createReceipt({
			created: false,
			requested: ["title"],
			before: empty,
			after: { ...empty, title: "Demo v2" },
		}),
		"changed: list already existed; title set (7 chars)",
	);
	assert.equal(
		createReceipt({ created: false, requested: [], before: empty, after: empty }),
		"no change: list already existed",
	);
});

test("copy and delete_list keep their shape", () => {
	assert.equal(copyReceipt(12, "a/b"), "changed: copied 12 tasks from 'a/b'");
	assert.equal(deleteListReceipt("a/b", 3, ""), "Deleted list 'a/b' and 3 tasks.");
	assert.equal(
		deleteListReceipt("a/b", 1, "job-1"),
		"Deleted list 'a/b' in namespace 'job-1' and 1 task.",
	);
});
