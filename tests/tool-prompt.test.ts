/**
 * Caller-aware tool prompt surface.
 *
 * Ordinary (unbound) sessions keep the short planning guidelines with no
 * handoff ceremony; a bound child gets one extra line naming its namespace and
 * the shared-list rule. The descriptions differ only in the namespace
 * paragraph, and the tool schema itself is covered by tests/namespace.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildTodoToolDef } from "../src/tool.ts";
import { UNBOUND_CALLER, boundCaller } from "../src/namespace.ts";

function defFor(caller = UNBOUND_CALLER) {
	return buildTodoToolDef({
		getDb: async () => {
			throw new Error("the prompt surface must not need the DB");
		},
		caller,
	});
}

test("an unbound session keeps the ordinary planning guidelines", () => {
	const def = defFor();
	assert.equal(
		def.promptSnippet,
		"Plan and manage hierarchical, named TODO lists (persisted); check off and refine tasks.",
	);
	assert.doesNotMatch(def.description, /This session is bound to namespace/);
	assert.match(def.description, /'\*' lists every namespace for discovery/);
	assert.match(
		def.description,
		/global namespace/,
		"omitting namespace still means global",
	);

	const guidelines = def.promptGuidelines;
	assert.equal(guidelines.length, 6);
	assert.equal(
		guidelines[0],
		"Use the todo tool for planning tasks; create/update tasks via todo rather than writing plan files to disk.",
	);
	assert.ok(
		guidelines.every((line) => !line.includes("bound to namespace")),
		"no child-only guidance leaks into an unbound prompt",
	);
	assert.match(guidelines[5]!, /namespace:'\*'/);
});

test("a bound session gets one namespace guideline and a binding description", () => {
	const def = defFor(boundCaller("job-worker-a"));
	assert.match(def.description, /This session is bound to namespace 'job-worker-a'/);
	assert.match(def.description, /'global' reaches the shared global lists/);
	assert.doesNotMatch(def.description, /'\*' lists every namespace for discovery/);

	const guidelines = def.promptGuidelines;
	assert.equal(guidelines.length, 6);
	assert.equal(
		guidelines[5],
		"This todo session is bound to namespace 'job-worker-a': omit 'namespace' to work there; pass 'global' only for shared lists that already exist (new global lists are refused).",
	);

	// The five ordinary planning guidelines are identical in both sessions.
	assert.deepEqual(
		guidelines.slice(0, 5),
		defFor().promptGuidelines.slice(0, 5),
	);
});
