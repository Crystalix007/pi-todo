/**
 * Namespace labels in rendered output (plain text + themed TUI lines).
 *
 * Rule under test: only NON-GLOBAL lists carry a namespace label. Every legacy
 * global header/line stays byte-identical, so ordinary output is unchanged.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Counts, ListSummary, TaskNode } from "../src/db.ts";
import {
	headerLine,
	renderLists,
	renderTree,
	themedListsLines,
	themedTreeLines,
} from "../src/render.ts";

const counts: Counts = { total: 1, pending: 1, in_progress: 0, done: 0 };

const tree: TaskNode[] = [
	{ id: 1, text: "task", status: "pending", priority: "medium", children: [] },
];

const view = {
	tree,
	counts,
	path: "team/tasks",
	title: "Team",
	projectPath: "/repo",
	description: "Ship it",
};

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function summary(
	namespace: string,
	path: string,
): ListSummary {
	const slash = path.lastIndexOf("/");
	return {
		id: 1,
		namespace,
		scope: slash < 0 ? "" : path.slice(0, slash),
		name: slash < 0 ? path : path.slice(slash + 1),
		title: null,
		project_path: "",
		description: "",
		path,
		created_at: 0,
		updated_at: 0,
		counts,
	};
}

test("global tree headers are unchanged; named ones add a namespace label", () => {
	const legacy =
		"team/tasks  (Team)  ·  project: /repo  ·  goal: Ship it  ·  0/1 done";
	assert.equal(headerLine(view), legacy);
	assert.equal(
		headerLine({ ...view, namespace: "" }),
		legacy,
		"the storage value for global is empty",
	);
	assert.equal(
		headerLine({ ...view, namespace: "job-worker-a" }),
		"team/tasks  (Team)  ·  namespace: job-worker-a  ·  project: /repo  ·  goal: Ship it  ·  0/1 done",
	);

	assert.doesNotMatch(renderTree(view).text.split("\n")[0]!, /namespace:/);
	assert.match(
		renderTree({ ...view, namespace: "job-worker-a" }).text.split("\n")[0]!,
		/namespace: job-worker-a/,
	);
});

test("global list lines are unchanged; named lists are labelled", () => {
	assert.equal(
		renderLists([summary("", "team/tasks")]),
		"TODO lists (1):\n  team/tasks  ·  0/1 done",
	);
	const named = renderLists([summary("job-worker-a", "team/tasks")]);
	assert.match(named, /team\/tasks/);
	assert.match(named, /namespace: job-worker-a/);

	const mixed = renderLists([
		summary("", "global/tasks"),
		summary("job-worker-a", "child/tasks"),
	]);
	const globalLine = mixed
		.split("\n")
		.find((line) => line.includes("global/tasks"));
	assert.ok(globalLine);
	assert.doesNotMatch(globalLine, /namespace:/);
});

test("themed output labels namespaces without changing global headers", () => {
	const legacyHeader = headerLine(view);
	assert.equal(themedTreeLines(view, theme)[0], legacyHeader);
	assert.match(
		themedTreeLines({ ...view, namespace: "job-worker-a" }, theme)[0]!,
		/namespace: job-worker-a/,
	);

	const globalList = themedListsLines([summary("", "team/tasks")], theme);
	assert.doesNotMatch(globalList.join("\n"), /namespace:/);
	const namedList = themedListsLines(
		[summary("job-worker-a", "team/tasks")],
		theme,
	);
	assert.match(namedList.join("\n"), /namespace: job-worker-a/);
});
