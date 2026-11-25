/**
 * Tests for the `lists` `project` filter.
 *
 * Behaviors under test:
 *  - 'project' resolves '.'/relative values against the session cwd
 *  - a list matches when it is in the filter directory OR contains it (both ways)
 *  - matching respects path segments ('/repo' never matches '/repo-old')
 *  - project_path is canonicalized to an absolute path on write
 *  - loosely-stored legacy values (trailing slash, '.', '~/…') still match
 *  - lists with no project_path are counted and named, never hidden silently
 *  - 'project' is rejected outside 'lists', and a relative filter with no cwd
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type { TodoDb } from "../src/db.ts";

// Point the DB at a throwaway file BEFORE the first getDb() call.
const dir = mkdtempSync(join(tmpdir(), "pi-todo-project-"));
process.env.PI_TODO_DB = join(dir, "todo.db");

const { getDb, closeTodoDb } = await import("../src/db.ts");
const { dispatchTodo } = await import("../src/tool.ts");
const { renderLists } = await import("../src/render.ts");
const { absoluteProjectPath, canonicalProjectPath, projectMatches } =
	await import("../src/project.ts");

const REPO = "/repo";
const CWD = { cwd: REPO };

let db: TodoDb;

before(async () => {
	db = await getDb();
});

after(() => {
	closeTodoDb().then(() => rmSync(dir, { recursive: true, force: true }));
});

/** Paths of the lists a `lists` call returned. */
function listPaths(result: Awaited<ReturnType<typeof dispatchTodo>>): string[] {
	return (result.details.lists as { path: string }[]).map((l) => l.path);
}

// ---- pure path helpers -----------------------------------------------------

test("projectMatches is segment-bounded and bidirectional", () => {
	assert.equal(projectMatches("/repo", "/repo"), true);
	assert.equal(projectMatches("/repo/src", "/repo"), true, "child matches parent");
	assert.equal(projectMatches("/repo", "/repo/src"), true, "parent matches child");
	assert.equal(projectMatches("/repo-old", "/repo"), false, "no prefix bleed");
	assert.equal(projectMatches("/repo", "/repo-old"), false, "no prefix bleed (reverse)");
	assert.equal(projectMatches("/other", "/repo"), false);
	assert.equal(projectMatches("", "/repo"), false, "an unset project never matches");
	assert.equal(projectMatches("/repo/", "/repo"), true, "trailing slash is normalized");
	// A relative stored value is resolved against the reading session's cwd.
	assert.equal(projectMatches(".", "/repo", "/repo"), true);
	assert.equal(projectMatches("src", "/repo", "/repo"), true);
	assert.equal(projectMatches("src", "/repo"), false, "no cwd → nothing to resolve");
});

test("relative paths resolve against cwd; tilde expands", () => {
	assert.equal(absoluteProjectPath(".", REPO), REPO);
	assert.equal(absoluteProjectPath("./src", REPO), "/repo/src");
	assert.equal(absoluteProjectPath("src/", REPO), "/repo/src");
	assert.equal(absoluteProjectPath("/abs/path", REPO), "/abs/path");
	assert.equal(absoluteProjectPath("rel", undefined), null, "no cwd → null");
	assert.equal(absoluteProjectPath("~/work", REPO), join(homedir(), "work"));
});

test("canonicalProjectPath preserves the write-path conventions", () => {
	// undefined = leave alone (a copy keeps the source value), "" = clear/skip.
	assert.equal(canonicalProjectPath(undefined, REPO), undefined);
	assert.equal(canonicalProjectPath("", REPO), "");
	assert.equal(canonicalProjectPath("   ", REPO), "");
	assert.equal(canonicalProjectPath(".", REPO), REPO);
	// No cwd: a relative value is stored as typed (legacy lenient behavior).
	assert.equal(canonicalProjectPath("rel", undefined), "rel");
});

// ---- write-side canonicalization ------------------------------------------

test("create stores project_path as an absolute, normalized path", async () => {
	const abs = await dispatchTodo(
		db,
		{ action: "create", list: "proj/abs", project_path: "." },
		undefined,
		CWD,
	);
	assert.equal((abs.details.list as { project_path: string }).project_path, REPO);

	const rel = await dispatchTodo(
		db,
		{ action: "create", list: "proj/rel", project_path: "src/" },
		undefined,
		CWD,
	);
	assert.equal(
		(rel.details.list as { project_path: string }).project_path,
		"/repo/src",
	);

	// update without an id goes through the same canonicalization.
	const updated = await dispatchTodo(
		db,
		{ action: "update", list: "proj/rel", project_path: "." },
		undefined,
		CWD,
	);
	assert.equal(
		(updated.details.list as { project_path: string }).project_path,
		REPO,
	);
});

// ---- the filter -----------------------------------------------------------

test("lists project:'.' returns only this session's directory", async () => {
	await dispatchTodo(
		db,
		{ action: "create", list: "pfx/root", project_path: REPO },
		undefined,
		CWD,
	);
	await dispatchTodo(
		db,
		{ action: "create", list: "pfx/nested", project_path: "/repo/src" },
		undefined,
		CWD,
	);
	await dispatchTodo(
		db,
		{ action: "create", list: "pfx/elsewhere", project_path: "/other-repo" },
		undefined,
		CWD,
	);
	await dispatchTodo(
		db,
		{ action: "create", list: "pfx/lookalike", project_path: "/repo-old" },
		undefined,
		CWD,
	);

	const here = await dispatchTodo(
		db,
		{ action: "lists", project: ".", scope: "pfx" },
		undefined,
		CWD,
	);
	assert.deepEqual(listPaths(here).sort(), ["pfx/nested", "pfx/root"]);
	assert.equal(here.details.project, REPO);
	// The header names the directory and every line still carries its own path.
	assert.match(here.content.text, /^TODO lists in \/repo \(2\):/);
	// A child directory still finds the parent's list (both directions).
	const parentList = await dispatchTodo(
		db,
		{ action: "lists", project: "." },
		undefined,
		{ cwd: "/repo/src" },
	);
	assert.ok(listPaths(parentList).includes("pfx/root"));
	assert.match(parentList.content.text, /in \/repo\/src/);
	// A lookalike directory is not the same repo.
	const lookalike = await dispatchTodo(
		db,
		{ action: "lists", project: "/repo-old" },
		undefined,
		CWD,
	);
	assert.deepEqual(listPaths(lookalike), ["pfx/lookalike"]);
});

test("lists project composes with scope, and omitting it shows everything", async () => {
	const scoped = await dispatchTodo(
		db,
		{ action: "lists", project: REPO, scope: "pfx" },
		undefined,
		CWD,
	);
	assert.deepEqual(listPaths(scoped).sort(), ["pfx/nested", "pfx/root"]);

	const all = await dispatchTodo(db, { action: "lists", scope: "pfx" }, undefined, CWD);
	assert.deepEqual(listPaths(all).sort(), [
		"pfx/elsewhere",
		"pfx/lookalike",
		"pfx/nested",
		"pfx/root",
	]);
	// Unfiltered output is unchanged: no project header, no trailer.
	assert.match(all.content.text, /^TODO lists \(4\):/);
	assert.equal(all.details.project, undefined);
	assert.equal(all.details.without_project_path, undefined);
});

test("loosely-stored legacy project paths still match", async () => {
	const legacy = await dispatchTodo(
		db,
		{ action: "create", list: "legacy/raw", project_path: "/legacy/repo" },
		undefined,
		CWD,
	);
	const id = db.getList("legacy", "raw")!.id;
	assert.ok(legacy.details.list, "create returned the list");
	// Simulate a row written before canonicalization (trailing slash).
	db.setListMeta(id, { project_path: "/legacy/repo/" });
	assert.equal(db.getList("legacy", "raw")?.project_path, "/legacy/repo/");
	const found = await dispatchTodo(
		db,
		{ action: "lists", project: "/legacy/repo" },
		undefined,
		CWD,
	);
	assert.deepEqual(listPaths(found), ["legacy/raw"]);

	// A stored '.' is interpreted against the reading session's cwd.
	const dotted = await dispatchTodo(
		db,
		{ action: "create", list: "legacy/dotted", project_path: REPO },
		undefined,
		CWD,
	);
	assert.ok(dotted.details.list, "create returned the list");
	db.setListMeta(db.getList("legacy", "dotted")!.id, { project_path: "." });
	const fromCwd = await dispatchTodo(
		db,
		{ action: "lists", project: "." },
		undefined,
		CWD,
	);
	assert.ok(listPaths(fromCwd).includes("legacy/dotted"));
});

test("lists with no project_path are reported, not silently dropped", async () => {
	await dispatchTodo(
		db,
		{ action: "add", list: "unpinned/one", items: [{ text: "a" }] },
		undefined,
		CWD,
	);
	await dispatchTodo(
		db,
		{ action: "add", list: "unpinned/two", items: [{ text: "b" }] },
		undefined,
		CWD,
	);

	const r = await dispatchTodo(
		db,
		{ action: "lists", project: REPO, scope: "unpinned" },
		undefined,
		CWD,
	);
	assert.deepEqual(listPaths(r), []);
	assert.equal(r.details.without_project_path, 2);
	// Nothing matched, and the message says why + how to see them.
	assert.match(r.content.text, /^No TODO lists in \/repo\./);
	assert.match(r.content.text, /2 lists with no project_path are hidden/);
	assert.match(r.content.text, /without 'project'/);

	// Listed without the filter, the trailer disappears.
	const all = await dispatchTodo(db, { action: "lists", scope: "unpinned" }, undefined, CWD);
	assert.equal(all.details.without_project_path, undefined);
	assert.doesNotMatch(all.content.text, /hidden by this filter/);
});

test("lists project works across every namespace", async () => {
	await dispatchTodo(
		db,
		{ action: "create", list: "nsx/a", project_path: REPO, namespace: "team" },
		undefined,
		CWD,
	);
	const r = await dispatchTodo(
		db,
		{ action: "lists", project: REPO, scope: "nsx", namespace: "*" },
		undefined,
		CWD,
	);
	assert.deepEqual(listPaths(r), ["nsx/a"]);
	assert.equal(r.details.namespace, "*");
	assert.match(r.content.text, /namespace: team/);
});

// ---- error cases ----------------------------------------------------------

test("a relative project with no session cwd is an error, not a full listing", async () => {
	await assert.rejects(
		() => dispatchTodo(db, { action: "lists", project: "." }),
		/is relative and this call has no session working directory/,
	);
	// Absolute filters still need no cwd.
	const abs = await dispatchTodo(db, { action: "lists", project: REPO });
	assert.ok(listPaths(abs).length > 0);
});

test("an empty project filter is rejected", async () => {
	await assert.rejects(
		() => dispatchTodo(db, { action: "lists", project: "  " }, undefined, CWD),
		/'project' is empty/,
	);
});

test("project is rejected outside the lists action with a pointer to project_path", async () => {
	await assert.rejects(
		() =>
			dispatchTodo(
				db,
				{ action: "show", list: "pfx/root", project: REPO },
				undefined,
				CWD,
			),
		/'project' only filters action 'lists'.*project_path/,
	);
});

// ---- renderer -------------------------------------------------------------

test("renderLists names the filter and the hidden lists", () => {
	const text = renderLists(
		[
			{
				id: 1,
				namespace: "",
				scope: "s",
				name: "n",
				title: null,
				project_path: REPO,
				description: "",
				path: "s/n",
				created_at: 0,
				updated_at: 0,
				counts: { total: 2, pending: 1, in_progress: 0, done: 1 },
			},
		],
		{ project: REPO, unpinned: 1 },
	);
	const lines = text.split("\n");
	assert.equal(lines[0], "TODO lists in /repo (1):");
	assert.equal(lines[1], "  s/n  ·  project: /repo  ·  1/2 done");
	assert.match(lines[2] ?? "", /1 list with no project_path is hidden by this filter/);
});
