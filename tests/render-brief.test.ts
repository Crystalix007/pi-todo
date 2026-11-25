/**
 * Brief (digest) rendering — the mutation default.
 *
 * Contract under test:
 *  - completed branches with no open descendant collapse to ONE line `(+N done)`
 *    and their children are never rendered underneath;
 *  - a done branch that still contains open work is NOT collapsed;
 *  - notes/descriptions of OPEN tasks are inline (the constraint the agent needs);
 *    detail of DONE tasks is not — it is reachable through `show detail:"full"`;
 *  - everything omitted is named in a trailer, and `elided` is only set when
 *    something was actually dropped, never for routine collapse;
 *  - brief headers word-cap a huge goal, full headers do not.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Counts, TaskNode } from "../src/db.ts";
import {
	BRIEF_GOAL_CAP,
	BRIEF_MAX_LINES,
	countsOfTree,
	renderBrief,
	renderFocus,
	renderTree,
	type TreeView,
} from "../src/render.ts";

const task = (
	id: number,
	over: Partial<TaskNode> & { children?: TaskNode[] } = {},
): TaskNode => ({
	id,
	text: `task ${id}`,
	status: "pending",
	priority: "medium",
	note: null,
	tags: null,
	description: null,
	children: [],
	...over,
});

function view(tree: TaskNode[], over: Partial<TreeView> = {}): TreeView {
	const counts: Counts = countsOfTree(tree);
	return { tree, counts, path: "team/tasks", ...over };
}

test("a completed branch collapses to one line and hides its children", () => {
	const tree = [
		task(1, {
			text: "done parent",
			status: "done",
			children: [
				task(2, { status: "done" }),
				task(3, { status: "done", children: [task(4, { status: "done" })] }),
			],
		}),
		task(5, { text: "open" }),
	];
	const text = renderBrief(view(tree)).text;
	assert.match(text, /^\[x\] #1 done parent  \(\+3 done\)$/m);
	// the collapsed children are counted, never rendered as their own lines
	assert.doesNotMatch(text, /#2 |#3 |#4 /);
	assert.match(text, /\[ \] #5 open/);
	assert.match(text, /… 3 done task\(s\) collapsed\./);
});

test("a collapsed branch expands when it would hide a task this call touched", () => {
	const tree = [
		task(1, {
			text: "done branch",
			status: "done",
			children: [task(2, { status: "done" }), task(3, { status: "done" })],
		}),
	];
	assert.doesNotMatch(renderBrief(view(tree)).text, /#2 /);

	const touched = renderBrief(view(tree), { touched: new Set([2]) }).text;
	assert.match(touched, /#2 task 2/, "the receipt's id must be visible");
	assert.match(touched, /#3 task 3/);

	// Touching the collapsed node itself changes nothing: its own line is shown
	// either way, so the branch still collapses.
	const self = renderBrief(view(tree), { touched: new Set([1]) }).text;
	assert.match(self, /\(\+2 done\)/);
});

test("a done branch that still contains open work is not collapsed", () => {
	const tree = [
		task(1, {
			text: "done but incomplete",
			status: "done",
			children: [
				task(2, { status: "done" }),
				task(3, { status: "pending", text: "still open child" }),
			],
		}),
	];
	const text = renderBrief(view(tree)).text;
	assert.match(text, /\[x\] #1 done but incomplete$/m);
	assert.match(text, /#2 task 2/);
	assert.match(text, /#3 still open child/);
});

test("open tasks keep their detail inline; done tasks do not", () => {
	const tree = [
		task(1, { text: "open with note", note: "constraint: keep it stable" }),
		task(2, {
			text: "done with note",
			status: "done",
			note: "commit abc123 did this",
		}),
		task(3, {
			text: "open with description",
			description: "line one\nline two",
		}),
	];
	const text = renderBrief(view(tree)).text;
	assert.match(text, /· constraint: keep it stable/);
	assert.doesNotMatch(text, /commit abc123/);
	assert.match(text, /▸ line one\n\s+▸ line two/);

	// full mode has both, and collapses nothing
	const full = renderTree(view(tree), { detail: "full" }).text;
	assert.match(full, /commit abc123 did this/);
	assert.match(full, /· constraint: keep it stable/);
});

test("an over-long note is capped and the trailer says so", () => {
	const tree = [task(1, { note: "x".repeat(900) })];
	const { text, elided } = renderBrief(view(tree));
	assert.match(text, /note\(s\)\/description\(s\) shortened/);
	assert.ok(text.split("\n").every((l) => l.length < 500), "no giant line");
	assert.equal(elided, false, "capping a note is not task loss");
});

test("over the line budget, done rows are dropped and the render is flagged elided", () => {
	// 40 done tasks + 40 open ones: only the open ones are essential.
	const tree = [
		...Array.from({ length: 40 }, (_, i) =>
			task(i + 1, { status: "done", text: `done ${i}` }),
		),
		...Array.from({ length: 40 }, (_, i) =>
			task(100 + i, { text: `open ${i}` }),
		),
	];
	const { text, elided } = renderBrief(view(tree));
	assert.equal(elided, true);
	assert.match(text, /done task\(s\) omitted for size/);
	// every open task survives: usable open work is never dropped
	for (let i = 0; i < 40; i++) assert.match(text, new RegExp(`#${100 + i} open ${i}`));
	assert.ok(
		text.split("\n").length <= BRIEF_MAX_LINES + 6,
		"stays near the line budget",
	);
});

test("a hard cut drops whole tasks and counts them", () => {
	// 200 open tasks cannot fit: the tail is cut, and the trailer admits it.
	const tree = Array.from({ length: 200 }, (_, i) =>
		task(i + 1, { text: `open ${i}` }),
	);
	const { text, elided } = renderBrief(view(tree));
	assert.equal(elided, true);
	assert.match(text, /open task\(s\) over the size budget/);
	assert.match(text, /Narrow with show 'team\/tasks#<id>'/);
	assert.match(text, /#1 open 0/);
	assert.doesNotMatch(text, /#200 open 199/);
});

test("the change receipt sits directly under the header", () => {
	const tree = [task(1)];
	const text = renderBrief(
		view(tree, { change: "changed: #1 status pending → done" }),
	).text;
	const lines = text.split("\n");
	assert.equal(lines[0], "team/tasks  ·  0/1 done");
	assert.equal(lines[1], "changed: #1 status pending → done");
	assert.equal(lines[2], "[ ] #1 task 1");
});

test("brief headers word-cap the goal; full headers and focus windows do not", () => {
	// Under sanitize()'s 500-char line cap but over the brief goal cap, so the
	// difference between brief and full is visible rather than both cutting.
	const goal = `${"word ".repeat(70)}tail-constraint`;
	const tree = [task(1)];
	const brief = renderBrief(view(tree, { description: goal })).text.split("\n")[0]!;
	assert.match(brief, /…/);
	assert.ok(brief.length < BRIEF_GOAL_CAP + 120, "goal is capped");
	assert.doesNotMatch(brief, /tail-constraint/);

	const full = renderTree(view(tree, { description: goal }), {
		detail: "full",
	}).text.split("\n")[0]!;
	assert.match(full, /tail-constraint/);
});

test("an all-done list still names its branches", () => {
	const tree = [
		task(1, { status: "done", text: "branch a", children: [task(2, { status: "done" })] }),
		task(3, { status: "done", text: "branch b" }),
	];
	const text = renderBrief(view(tree)).text;
	assert.match(text, /\[x\] #1 branch a  \(\+1 done\)/);
	assert.match(text, /\[x\] #3 branch b/);
	assert.match(text, /3\/3 done/);
});

// ---------------------------------------------------------------------------
// focus window (`next`)
// ---------------------------------------------------------------------------

const focusTree = [
	task(1, {
		text: "parent",
		status: "in_progress",
		note: "parent note",
		children: [
			task(2, { text: "sibling a", status: "done" }),
			task(3, {
				text: "the pick",
				priority: "critical",
				note: "do this before lunch",
				children: [
					task(4, { text: "child one" }),
					task(5, { text: "child two", status: "done" }),
				],
			}),
			task(6, { text: "sibling b" }),
		],
	}),
	task(7, { text: "unrelated branch" }),
];

test("next returns a focus window, not the whole tree", () => {
	const { text } = renderFocus(view(focusTree), 3);
	const lines = text.split("\n");
	assert.equal(lines[0], "team/tasks  ·  2/7 done  ·  1 in progress");
	assert.equal(lines[1], "next → #3 the pick  ·  pending, critical");
	assert.match(text, /note: do this before lunch/);
	// ancestor chain, siblings around the pick, and the pick's own children
	assert.match(text, /\[~\] #1 parent$/m);
	assert.match(text, /#2 sibling a/);
	assert.match(text, /#3 the pick \[!\]  ← next/);
	assert.match(text, /#6 sibling b/);
	assert.match(text, /#4 child one/);
	// an unrelated top-level branch is not included
	assert.doesNotMatch(text, /#7 unrelated branch/);
});

test("next keeps the full goal in its header (a scoped agent's context)", () => {
	const goal = `${"word ".repeat(70)}tail-constraint`;
	const { text } = renderFocus(view(focusTree, { description: goal }), 3);
	assert.match(text.split("\n")[0]!, /tail-constraint/);
});

test("a deep pick renders its whole ancestor chain", () => {
	const deep = [
		task(1, {
			text: "root",
			children: [
				task(2, {
					text: "mid",
					children: [task(3, { text: "leaf", children: [] })],
				}),
			],
		}),
	];
	const text = renderFocus(view(deep), 3).text;
	assert.match(text, /#1 root/);
	assert.match(text, /#2 mid/);
	assert.match(text, /#3 leaf/);
});
