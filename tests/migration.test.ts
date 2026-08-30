/**
 * Migration regression tests for the lists NOT NULL rebuild.
 *
 * Two scenarios:
 *  - legacy DB: no project_path/description columns at all (pre-metadata release)
 *  - nullable DB: columns exist but were added as nullable TEXT (the previous
 *    release's migration) with some values already set
 *
 * Both must end with NOT NULL columns, NULLs backfilled to '', data preserved,
 * and the tasks → lists foreign key intact.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LEGACY_SCHEMA = `
CREATE TABLE lists (
  id INTEGER PRIMARY KEY,
  scope TEXT NOT NULL,
  name TEXT NOT NULL,
  title TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(scope, name)
);
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  note TEXT,
  tags TEXT,
  description TEXT,
  priority TEXT NOT NULL DEFAULT 'medium',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_list ON tasks(list_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
`;

async function withFreshDb(
	seed: (legacy: DatabaseSync) => void,
	fn: (dbPath: string) => Promise<void>,
): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "pi-todo-migrate-test-"));
	const dbPath = join(dir, "todo.db");
	const prev = process.env.PI_TODO_DB;
	try {
		const legacy = new DatabaseSync(dbPath);
		legacy.exec(LEGACY_SCHEMA);
		seed(legacy);
		legacy.close();
		process.env.PI_TODO_DB = dbPath;
		await fn(dbPath);
	} finally {
		if (prev === undefined) delete process.env.PI_TODO_DB;
		else process.env.PI_TODO_DB = prev;
		rmSync(dir, { recursive: true, force: true });
	}
}

test("legacy DB (no metadata columns) migrates: NOT NULL, NULLs backfilled, data + FKs intact", async () => {
	await withFreshDb(
		(legacy) => {
			legacy.exec(
				"INSERT INTO lists (scope, name, title, created_at, updated_at) VALUES ('old', 'list', 'legacy', 1, 1)",
			);
			legacy.exec(
				"INSERT INTO tasks (list_id, parent_id, ord, text, status, priority, created_at, updated_at) VALUES (1, NULL, 1, 'legacy task', 'pending', 'medium', 1, 1)",
			);
		},
		async (dbPath) => {
			const { getDb, closeTodoDb } = await import("../src/db.ts");
			const db = await getDb();
			const row = db.getList("old", "list");
			assert.ok(row, "list survived migration");
			assert.equal(row.project_path, "", "NULL backfilled to ''");
			assert.equal(row.description, "", "NULL backfilled to ''");
			assert.equal(row.title, "legacy", "title preserved");
			assert.equal(db.fetchTree(row.id)[0]?.text, "legacy task");

			// setListMeta must work against the rebuilt table (set + clear).
			db.setListMeta(row.id, { project_path: "/tmp/p", description: "g" });
			assert.equal(db.getList("old", "list")?.project_path, "/tmp/p");
			db.setListMeta(row.id, { project_path: "" });
			assert.equal(db.getList("old", "list")?.project_path, "");
			assert.equal(db.getList("old", "list")?.description, "g");

			await closeTodoDb();

			// Raw-level assertions on the migrated file.
			const chk = new DatabaseSync(dbPath, { readOnly: true });
			const cols = chk
				.prepare("PRAGMA table_info(lists)")
				.all()
				.map((c: any) => ({ name: c.name, notnull: c.notnull }));
			for (const name of ["project_path", "description"]) {
				const c = cols.find((x) => x.name === name);
				assert.ok(c, `${name} column exists`);
				assert.equal(c.notnull, 1, `${name} is NOT NULL`);
			}
			const nulls = chk
				.prepare(
					"SELECT COUNT(*) AS c FROM lists WHERE project_path IS NULL OR description IS NULL",
				)
				.get() as { c: number };
			assert.equal(nulls.c, 0, "no NULL metadata rows");
			const fk = chk.prepare("PRAGMA foreign_key_check").all();
			assert.equal(fk.length, 0, "no FK violations after rebuild");
			const count = chk
				.prepare("SELECT COUNT(*) AS c FROM tasks WHERE list_id = 1")
				.get() as { c: number };
			assert.equal(count.c, 1, "tasks still reference the rebuilt list");
			chk.close();
		},
	);
});

test("nullable-columns DB (previous release) rebuilds to NOT NULL, preserving set values", async () => {
	await withFreshDb(
		(legacy) => {
			legacy.exec("ALTER TABLE lists ADD COLUMN project_path TEXT");
			legacy.exec("ALTER TABLE lists ADD COLUMN description TEXT");
			legacy.exec(
				"INSERT INTO lists (scope, name, title, project_path, description, created_at, updated_at) VALUES ('old', 'list', NULL, '/tmp/already-set', NULL, 1, 1)",
			);
		},
		async (dbPath) => {
			const { getDb, closeTodoDb } = await import("../src/db.ts");
			const db = await getDb();
			const row = db.getList("old", "list");
			assert.ok(row);
			assert.equal(row.project_path, "/tmp/already-set", "set value preserved");
			assert.equal(row.description, "", "NULL backfilled to ''");
			await closeTodoDb();

			const chk = new DatabaseSync(dbPath, { readOnly: true });
			const cols = chk
				.prepare("PRAGMA table_info(lists)")
				.all()
				.map((c: any) => ({ name: c.name, notnull: c.notnull }));
			assert.equal(cols.find((c) => c.name === "project_path")?.notnull, 1);
			assert.equal(cols.find((c) => c.name === "description")?.notnull, 1);
			chk.close();
		},
	);
});
