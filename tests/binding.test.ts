/**
 * Per-session namespace binding capture (see src/binding.ts).
 *
 * Contract under test:
 *  - no payload / empty payload / only unrelated packages → legacy unbound
 *  - {"pi-todo/1":{"namespace":"..."}} → this session is bound to that name
 *  - unrelated keys are ignored; unknown fields cannot widen capability
 *  - malformed own payloads and unsupported versions fail closed (throw)
 *  - the extension factory captures the binding ONCE: it survives the parent
 *    restoring the environment, and two factories never share a caller
 *  - a retained-resume startup (same payload replayed) captures the same caller
 *
 * The DB is a throwaway file under the OS temp dir; ~/.pi/agent/todo.db is
 * never touched.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const dir = mkdtempSync(join(tmpdir(), "pi-todo-binding-test-"));
process.env.PI_TODO_DB = join(dir, "todo.db");
delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS;

const { getDb, closeTodoDb } = await import("../src/db.ts");
const { BINDING_ENV_VAR, captureExtensionCaller } = await import(
	"../src/binding.ts"
);
const { dispatchTodo } = await import("../src/tool.ts");
const { UNBOUND_CALLER } = await import("../src/namespace.ts");
const { default: todoExtension } = await import("../src/index.ts");

after(() => {
	delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
	closeTodoDb().then(() => rmSync(dir, { recursive: true, force: true }));
});

// ---- helpers ---------------------------------------------------------------

/** A payload as pi-subagents writes it: canonical JSON of all package bindings. */
function payload(value: unknown): Record<string, string | undefined> {
	return { [BINDING_ENV_VAR]: JSON.stringify(value) };
}

interface FakePi {
	pi: ExtensionAPI;
	tools: {
		execute: (
			id: string,
			params: unknown,
			signal?: AbortSignal,
		) => Promise<{ details: Record<string, unknown> }>;
	}[];
	commands: { name: string; options: Record<string, unknown> }[];
}

/** Just enough of ExtensionAPI to run the factory without pi. */
function createFakePi(): FakePi {
	const tools: FakePi["tools"] = [];
	const commands: FakePi["commands"] = [];
	const pi = {
		registerTool: (def: FakePi["tools"][number]) => tools.push(def),
		registerCommand: (name: string, options: Record<string, unknown>) =>
			commands.push({ name, options }),
		on: () => () => {},
	};
	return { pi: pi as unknown as ExtensionAPI, tools, commands };
}

/** `namespace:path` labels across every namespace (parent-only discovery). */
async function allListLabels(): Promise<string[]> {
	const r = await dispatchTodo(await getDb(), { action: "lists", namespace: "*" });
	return (r.details.lists as { namespace: string; path: string }[]).map(
		(l) => `${l.namespace}:${l.path}`,
	);
}

function namespaceOf(
	result: { details: Record<string, unknown> },
): string {
	return (result.details.list as { namespace: string }).namespace;
}

// ---- caller capture --------------------------------------------------------

test("no payload, an empty payload, or only unrelated packages leave the session unbound", () => {
	assert.equal(captureExtensionCaller({}), UNBOUND_CALLER);
	assert.equal(
		captureExtensionCaller({ [BINDING_ENV_VAR]: "" }),
		UNBOUND_CALLER,
	);
	assert.equal(
		captureExtensionCaller({ [BINDING_ENV_VAR]: "   " }),
		UNBOUND_CALLER,
	);
	assert.equal(
		captureExtensionCaller(payload({ "other-ext/1": { namespace: "x" } })),
		UNBOUND_CALLER,
		"another package's binding is not ours to interpret",
	);
});

test("pi-todo/1 binds the session to its namespace, immutably", () => {
	const caller = captureExtensionCaller(
		payload({ "pi-todo/1": { namespace: "job-worker-a" } }),
	);
	assert.deepEqual(caller, { kind: "bound", namespace: "job-worker-a" });
	assert.ok(Object.isFrozen(caller), "the captured caller is immutable");
	assert.throws(() => {
		(caller as { namespace: string }).namespace = "hijacked";
	}, TypeError);
});

test("unrelated packages are ignored while our own binding still applies", () => {
	const caller = captureExtensionCaller(
		payload({
			"other-ext/1": { namespace: "not-ours" },
			"pi-todo/1": { namespace: "job-worker-a" },
		}),
	);
	assert.deepEqual(caller, { kind: "bound", namespace: "job-worker-a" });
});

test("unknown fields inside our own binding cannot grant anything", () => {
	const caller = captureExtensionCaller(
		payload({
			"pi-todo/1": { namespace: "job-worker-a", canCreateGlobal: true },
		}),
	);
	// The flag is not part of the contract: only the namespace is honoured.
	assert.deepEqual(caller, { kind: "bound", namespace: "job-worker-a" });
});

test("malformed and unsupported own bindings fail closed", () => {
	const cases: { raw: string; expected: RegExp }[] = [
		{ raw: "not json", expected: /is not valid JSON/ },
		{ raw: "[]", expected: /must be a JSON object of per-package bindings/ },
		{ raw: "null", expected: /must be a JSON object of per-package bindings/ },
		{ raw: '"job-worker-a"', expected: /must be a JSON object of per-package/ },
		{
			raw: JSON.stringify({ "pi-todo/1": "job-worker-a" }),
			expected: /must be a JSON object like/,
		},
		{
			raw: JSON.stringify({ "pi-todo/1": {} }),
			expected: /must carry a string 'namespace'/,
		},
		{
			raw: JSON.stringify({ "pi-todo/1": { namespace: 42 } }),
			expected: /must carry a string 'namespace'/,
		},
		{
			raw: JSON.stringify({ "pi-todo/1": { namespace: "" } }),
			expected: /unusable namespace: Invalid namespace/,
		},
		{
			raw: JSON.stringify({ "pi-todo/1": { namespace: "global" } }),
			expected: /unusable namespace/,
			// A child must never be bound TO the shared namespace.
		},
		{
			raw: JSON.stringify({ "pi-todo/1": { namespace: "*" } }),
			expected: /unusable namespace/,
		},
		{
			raw: JSON.stringify({ "pi-todo/1": { namespace: "has space" } }),
			expected: /unusable namespace/,
		},
		{
			raw: JSON.stringify({ "pi-todo/2": { namespace: "job-worker-a" } }),
			expected: /'pi-todo\/2' is not supported/,
		},
		{
			raw: JSON.stringify({
				"pi-todo/1": { namespace: "job-worker-a" },
				"pi-todo/0": {},
			}),
			expected: /'pi-todo\/0' is not supported/,
		},
	];
	for (const { raw, expected } of cases) {
		assert.throws(
			() => captureExtensionCaller({ [BINDING_ENV_VAR]: raw }),
			expected,
			`payload ${raw} must fail closed`,
		);
	}
});

// ---- factory capture -------------------------------------------------------

test("the factory captures the binding once and keeps it after the env is restored", async () => {
	process.env.PI_SUBAGENT_EXTENSION_BINDINGS = JSON.stringify({
		"pi-todo/1": { namespace: "job-worker-a" },
	});
	const fake = createFakePi();
	todoExtension(fake.pi);
	// A foreground child has its parent's environment back once its session has
	// started: the captured policy must not depend on the variable any more.
	delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS;

	assert.equal(fake.tools.length, 1, "the todo tool was registered");
	assert.equal(fake.commands.length, 1, "the /todo command was registered");

	const result = await fake.tools[0]!.execute("call-1", {
		action: "add",
		list: "bind/from-factory",
		items: [{ text: "written by the child" }],
	});
	assert.equal(namespaceOf(result), "job-worker-a");
	assert.ok((await allListLabels()).includes("job-worker-a:bind/from-factory"));
	assert.ok(!(await allListLabels()).includes("global:bind/from-factory"));
});

test("two factories capture distinct callers from their own environments", async () => {
	process.env.PI_SUBAGENT_EXTENSION_BINDINGS = JSON.stringify({
		"pi-todo/1": { namespace: "job-worker-a" },
	});
	const childA = createFakePi();
	todoExtension(childA.pi);

	process.env.PI_SUBAGENT_EXTENSION_BINDINGS = JSON.stringify({
		"pi-todo/1": { namespace: "job-worker-b" },
	});
	const childB = createFakePi();
	todoExtension(childB.pi);

	delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
	const legacy = createFakePi();
	todoExtension(legacy.pi);

	const a = await childA.tools[0]!.execute("a", {
		action: "add",
		list: "bind/shared-path",
		items: [{ text: "from a" }],
	});
	const b = await childB.tools[0]!.execute("b", {
		action: "add",
		list: "bind/shared-path",
		items: [{ text: "from b" }],
	});
	const g = await legacy.tools[0]!.execute("g", {
		action: "add",
		list: "bind/shared-path",
		items: [{ text: "from unbound" }],
	});
	assert.equal(namespaceOf(a), "job-worker-a");
	assert.equal(namespaceOf(b), "job-worker-b");
	assert.equal(namespaceOf(g), "global", "no binding is never auto-isolation");

	// Each closure reads only its own copy of that path.
	const listsA = (a.details.tree as { text: string }[]).map((t) => t.text);
	const listsB = (b.details.tree as { text: string }[]).map((t) => t.text);
	assert.deepEqual(listsA, ["from a"]);
	assert.deepEqual(listsB, ["from b"]);
	const labels = await allListLabels();
	for (const ns of ["job-worker-a", "job-worker-b", "global"]) {
		assert.ok(labels.includes(`${ns}:bind/shared-path`), `${ns} has its copy`);
	}
});

test("a resumed child replays the same binding at factory startup", async () => {
	const replay = JSON.stringify({
		"pi-todo/1": { namespace: "job-worker-a" },
	});
	process.env.PI_SUBAGENT_EXTENSION_BINDINGS = replay;
	const first = captureExtensionCaller();
	const originalRun = createFakePi();
	todoExtension(originalRun.pi);

	// Retained resume relaunches the child with the ORIGINAL binding object.
	delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
	process.env.PI_SUBAGENT_EXTENSION_BINDINGS = replay;
	const resumed = captureExtensionCaller();
	const resumedRun = createFakePi();
	todoExtension(resumedRun.pi);
	delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS;

	assert.deepEqual(resumed, first);
	const result = await resumedRun.tools[0]!.execute("resume", {
		action: "lists",
	});
	assert.equal(result.details.namespace, "job-worker-a");
});

test("the factory fails closed instead of silently running unbound", () => {
	const fake = createFakePi();
	process.env.PI_SUBAGENT_EXTENSION_BINDINGS = JSON.stringify({
		"pi-todo/2": { namespace: "job-worker-a" },
	});
	try {
		assert.throws(() => todoExtension(fake.pi), /'pi-todo\/2' is not supported/);
	} finally {
		delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
	}
	assert.equal(fake.tools.length, 0, "no unbound tool was registered");
});
