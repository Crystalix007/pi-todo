/**
 * Migration tests for the namespace schema (lists.namespace + UNIQUE(namespace, scope, name)).
 *
 * Historical shapes covered:
 *  - pre-metadata lists (no project_path / description, UNIQUE(scope, name))
 *  - metadata-era lists (NOT NULL metadata, still UNIQUE(scope, name))
 *
 * Both must migrate to namespace TEXT NOT NULL DEFAULT '' with a unique index
 * over (namespace, scope, name), preserving list ids, task rows, and the
 * tasks → lists foreign key. Re-opening the same file must be a no-op.
 *
 * Atomicity is covered separately: the migration must run as one transaction,
 * so a failure after CREATE or after DROP rolls back to the original tables
 * (no dropped data, no leftover scratch table), a leftover scratch table from
 * a pre-release build fails closed instead of being dropped, and concurrent
 * first opens serialize instead of racing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TASKS_SQL = `
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

const PRE_METADATA_SCHEMA = `
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
  priority TEXT NOT NULL DEFAULT 'medium',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

const METADATA_ERA_SCHEMA = `
CREATE TABLE lists (
  id INTEGER PRIMARY KEY,
  scope TEXT NOT NULL,
  name TEXT NOT NULL,
  title TEXT,
  project_path TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(scope, name)
);
${TASKS_SQL}
`;

async function closeTodoDbQuietly(): Promise<void> {
	try {
		const { closeTodoDb } = await import("../src/db.ts");
		await closeTodoDb();
	} catch {
		/* nothing open */
	}
}

async function withLegacyDb(
	schema: string,
	seed: (legacy: DatabaseSync) => void,
	fn: (dbPath: string) => Promise<void>,
): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "pi-todo-namespace-migrate-"));
	const dbPath = join(dir, "todo.db");
	const prev = process.env.PI_TODO_DB;
	try {
		const legacy = new DatabaseSync(dbPath);
		legacy.exec(schema);
		seed(legacy);
		legacy.close();
		process.env.PI_TODO_DB = dbPath;
		await fn(dbPath);
	} finally {
		// Close a DB a failed assertion left open, so the next test really opens
		// its own file instead of reusing a stale handle.
		await closeTodoDbQuietly();
		if (prev === undefined) delete process.env.PI_TODO_DB;
		else process.env.PI_TODO_DB = prev;
		rmSync(dir, { recursive: true, force: true });
	}
}

function seedTwoLists(legacy: DatabaseSync, withMetadata: boolean): void {
	if (withMetadata) {
		legacy.exec(
			"INSERT INTO lists (id, scope, name, title, project_path, description, created_at, updated_at) VALUES (1, 'old', 'list', 'legacy', '/tmp/p', 'goal', 1, 1), (2, 'old', 'other', NULL, '', '', 1, 1)",
		);
	} else {
		legacy.exec(
			"INSERT INTO lists (id, scope, name, title, created_at, updated_at) VALUES (1, 'old', 'list', 'legacy', 1, 1), (2, 'old', 'other', NULL, 1, 1)",
		);
	}
	legacy.exec(
		"INSERT INTO tasks (id, list_id, parent_id, ord, text, status, priority, created_at, updated_at) VALUES (1, 1, NULL, 1, 'legacy task', 'pending', 'medium', 1, 1)",
	);
	legacy.exec(
		"INSERT INTO tasks (id, list_id, parent_id, ord, text, status, priority, created_at, updated_at) VALUES (2, 1, 1, 1, 'legacy child', 'pending', 'medium', 1, 1)",
	);
}

/** Raw assertions on the migrated file: shape, index, FKs, and leftover tables. */
function assertMigratedShape(dbPath: string, expectedTasks: number): void {
	const chk = new DatabaseSync(dbPath, { readOnly: true });
	try {
		const columns = chk
			.prepare("SELECT * FROM pragma_table_info(?)")
			.all("lists") as { name: string; notnull: number }[];
		const namespace = columns.find((c) => c.name === "namespace");
		assert.ok(namespace, "namespace column exists");
		assert.equal(namespace.notnull, 1, "namespace is NOT NULL");

		const indexes = chk
			.prepare("SELECT * FROM pragma_index_list(?)")
			.all("lists") as { name: string; unique: number }[];
		const uniqueColumnSets = indexes
			.filter((i) => i.unique === 1)
			.map((i) =>
				(
					chk
						.prepare("SELECT * FROM pragma_index_info(?)")
						.all(i.name) as { name: string }[]
				).map((c) => c.name),
			);
		assert.ok(
			uniqueColumnSets.some(
				(cols) =>
					cols.length === 3 &&
					cols[0] === "namespace" &&
					cols[1] === "scope" &&
					cols[2] === "name",
			),
			`unique (namespace, scope, name) index present, got ${JSON.stringify(uniqueColumnSets)}`,
		);

		assert.equal(
			chk.prepare("PRAGMA foreign_key_check").all().length,
			0,
			"no FK violations after the rebuild",
		);
		const tasks = chk
			.prepare("SELECT COUNT(*) AS c FROM tasks WHERE list_id = 1")
			.get() as { c: number };
		assert.equal(
			tasks.c,
			expectedTasks,
			"tasks still reference the migrated list",
		);
		const leftovers = chk
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'lists_%'",
			)
			.all() as { name: string }[];
		assert.deepEqual(leftovers, [], "no migration scratch table left behind");
	} finally {
		chk.close();
	}
}

test("pre-metadata DB migrates to namespaced schema, keeping ids, tasks, and FKs", async () => {
	await withLegacyDb(
		PRE_METADATA_SCHEMA,
		(legacy) => seedTwoLists(legacy, false),
		async (dbPath) => {
			const { getDb, closeTodoDb } = await import("../src/db.ts");
			const db = await getDb();
			const row = db.getList("old", "list");
			assert.ok(row, "legacy list survived migration");
			assert.equal(row.id, 1, "list id preserved");
			assert.equal(row.namespace, "", "legacy lists are global");
			assert.equal(row.project_path, "", "missing project_path backfilled");
			assert.equal(row.description, "", "missing description backfilled");
			assert.equal(row.title, "legacy", "title preserved");
			assert.equal(db.fetchTree(row.id)[0]?.text, "legacy task");
			assert.equal(db.fetchTree(row.id)[0]?.children[0]?.text, "legacy child");
			assert.equal(db.getLists().length, 2, "both legacy lists are visible");

			// tasks.tags/description were added by an earlier migration; writes
			// that use them must still work on this upgraded file.
			db.insertTask(row.id, {
				text: "tagged",
				status: "pending",
				tags: ["blocked"],
				description: "backfilled columns",
				parentId: null,
			});
			const tagged = db.fetchTree(row.id).find((t) => t.text === "tagged");
			assert.deepEqual(tagged?.tags, ["blocked"]);
			assert.equal(tagged?.description, "backfilled columns");

			// A second namespace may now reuse the same scope/name pair.
			const team = db.ensureList("old", "list", undefined, "team");
			assert.notEqual(team.id, row.id);
			assert.equal(team.namespace, "team");
			assert.equal(db.getList("old", "list")?.id, 1, "global lookup unchanged");
			await closeTodoDb();

			assertMigratedShape(dbPath, 3);
		},
	);
});

test("metadata-era DB migrates to namespaced schema and re-opens idempotently", async () => {
	await withLegacyDb(
		METADATA_ERA_SCHEMA,
		(legacy) => seedTwoLists(legacy, true),
		async (dbPath) => {
			const { getDb, closeTodoDb } = await import("../src/db.ts");
			let db = await getDb();
			const row = db.getList("old", "list");
			assert.ok(row);
			assert.equal(row.project_path, "/tmp/p", "metadata preserved");
			assert.equal(row.description, "goal", "goal preserved");
			assert.equal(row.namespace, "");
			// Namespaced write before the reopen, to prove the migration is stable.
			db.ensureList("old", "list", { description: "team goal" }, "team");
			await closeTodoDb();

			db = await getDb();
			const globalRow = db.getList("old", "list");
			assert.equal(globalRow?.id, 1, "global row id stable across re-open");
			assert.equal(globalRow?.description, "goal", "global metadata untouched");
			const teamRow = db.getList("old", "list", "team");
			assert.equal(teamRow?.description, "team goal");
			assert.notEqual(teamRow?.id, globalRow?.id);
			await closeTodoDb();

			assertMigratedShape(dbPath, 2);
		},
	);
});

// ---------------------------------------------------------------------------
// Atomicity: the migration is one transaction, so a mid-way failure leaves the
// original file untouched. Faults are injected by wrapping the connection and
// throwing at one chosen statement, which is the same state a kill/crash at
// that point would leave (WAL/rollback-journal recovery applies the same
// rollback).
// ---------------------------------------------------------------------------

/** The current `lists` DDL, parameterized by table name (interrupted-state fixture). */
const NEW_LISTS_DDL = `CREATE TABLE %NAME% (
  id INTEGER PRIMARY KEY,
  namespace TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL,
  name TEXT NOT NULL,
  title TEXT,
  project_path TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(namespace, scope, name)
)`;

/**
 * Wrap a real connection so the migration fails when `trigger` matches the SQL
 * about to run. Everything else is delegated to the real connection, so the
 * transaction really is started and really is rolled back.
 */
function faultingConnection(
	real: DatabaseSync,
	label: string,
	trigger: (sql: string) => boolean,
): DatabaseSync {
	return new Proxy(real, {
		get(target, property, receiver) {
			if (property === "exec") {
				return (sql: string): void => {
					if (trigger(sql)) {
						throw new Error(`injected migration failure after ${label}`);
					}
					target.exec(sql);
				};
			}
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

function tableNames(conn: DatabaseSync): string[] {
	return (
		conn
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
			.all() as { name: string }[]
	).map((r) => r.name);
}

/** Assert the file is still the legacy shape with its rows and FKs intact. */
function assertRolledBack(dbPath: string, lists: number, tasks: number): void {
	const chk = new DatabaseSync(dbPath, { readOnly: true });
	try {
		const tables = tableNames(chk);
		assert.ok(tables.includes("lists"), "original lists table still present");
		assert.ok(
			!tables.includes("lists_migration"),
			`no scratch table after rollback, got ${tables.join(", ")}`,
		);
		const columns = chk
			.prepare("SELECT * FROM pragma_table_info(?)")
			.all("lists") as { name: string }[];
		assert.ok(
			!columns.some((c) => c.name === "namespace"),
			"column additions rolled back too",
		);
		const listRow = chk.prepare("SELECT COUNT(*) AS c FROM lists").get() as {
			c: number;
		};
		assert.equal(listRow.c, lists, "lists rows untouched");
		const taskRow = chk.prepare("SELECT COUNT(*) AS c FROM tasks").get() as {
			c: number;
		};
		assert.equal(taskRow.c, tasks, "tasks rows untouched");
		assert.equal(
			chk.prepare("PRAGMA foreign_key_check").all().length,
			0,
			"no FK violations after rollback",
		);
	} finally {
		chk.close();
	}
}

test("a failure after CREATE rolls back, then the file migrates cleanly", async () => {
	await withLegacyDb(
		METADATA_ERA_SCHEMA,
		(legacy) => seedTwoLists(legacy, true),
		async (dbPath) => {
			const { getDb, closeTodoDb, migrateSchema } = await import(
				"../src/db.ts"
			);
			const raw = new DatabaseSync(dbPath);
			raw.exec("PRAGMA busy_timeout = 5000;");
			const conn = faultingConnection(raw, "CREATE", (sql) => {
				if (!sql.startsWith("INSERT INTO lists_migration")) return false;
				// Prove the window: the scratch table exists and the original one is
				// still untouched, so the failure is between CREATE and the copy.
				const tables = tableNames(raw);
				assert.ok(tables.includes("lists"));
				assert.ok(tables.includes("lists_migration"));
				return true;
			});
			assert.throws(
				() => migrateSchema(conn, dbPath),
				/injected migration failure after CREATE/,
			);
			raw.close();

			assertRolledBack(dbPath, 2, 2);

			// Without the fault the very same file migrates and keeps its data.
			const db = await getDb();
			assert.equal(db.getList("old", "list")?.id, 1);
			assert.equal(db.getList("old", "list")?.project_path, "/tmp/p");
			assert.equal(db.fetchTree(1)[0]?.text, "legacy task");
			await closeTodoDb();
			assertMigratedShape(dbPath, 2);
		},
	);
});

test("a failure after DROP (before the rename) rolls back instead of losing lists", async () => {
	await withLegacyDb(
		METADATA_ERA_SCHEMA,
		(legacy) => seedTwoLists(legacy, true),
		async (dbPath) => {
			const { getDb, closeTodoDb, migrateSchema } = await import(
				"../src/db.ts"
			);
			const raw = new DatabaseSync(dbPath);
			raw.exec("PRAGMA busy_timeout = 5000;");
			const conn = faultingConnection(raw, "DROP", (sql) => {
				if (!sql.startsWith("ALTER TABLE lists_migration RENAME TO lists")) {
					return false;
				}
				// Prove the window: the DROP already ran inside the transaction, so
				// only the rollback can bring the user's lists back.
				const tables = tableNames(raw);
				assert.ok(!tables.includes("lists"), "lists already dropped here");
				assert.ok(tables.includes("lists_migration"));
				return true;
			});
			assert.throws(
				() => migrateSchema(conn, dbPath),
				/injected migration failure after DROP/,
			);
			raw.close();

			// This is the window the old autocommit batch could not survive.
			assertRolledBack(dbPath, 2, 2);

			const db = await getDb();
			assert.equal(db.getList("old", "list")?.title, "legacy");
			assert.equal(db.fetchTree(1)[0]?.children[0]?.text, "legacy child");
			await closeTodoDb();
			assertMigratedShape(dbPath, 2);
		},
	);
});

test("a leftover lists_migration table fails closed instead of dropping data", async () => {
	await withLegacyDb(
		METADATA_ERA_SCHEMA,
		(legacy) => seedTwoLists(legacy, true),
		async (dbPath) => {
			const { getDb, closeTodoDb } = await import("../src/db.ts");

			// Reproduce what an interrupted pre-release (autocommit) migration left:
			// the scratch table holds the user's rows while `lists` was recreated
			// empty by the next open's CREATE TABLE IF NOT EXISTS. node:sqlite turns
			// FK constraints on by default, which would make the DROP below cascade
			// into tasks; the old migration ran with them off, so mirror that.
			const raw = new DatabaseSync(dbPath);
			raw.exec("PRAGMA foreign_keys = OFF;");
			raw.exec(NEW_LISTS_DDL.replace("%NAME%", "lists_migration"));
			raw.exec(`INSERT INTO lists_migration (id, namespace, scope, name, title, project_path, description, created_at, updated_at)
  SELECT id, '', scope, name, title, COALESCE(project_path, ''), COALESCE(description, ''), created_at, updated_at FROM lists`);
			raw.exec("DROP TABLE lists");
			raw.exec(NEW_LISTS_DDL.replace("%NAME%", "lists"));
			raw.close();

			const failure = await getDb().then(
				() => null,
				(err: unknown) => err as Error,
			);
			assert.ok(failure instanceof Error, "open must fail closed");
			assert.match(failure.message, /leftover 'lists_migration' table/);
			assert.ok(failure.message.includes(dbPath), "names the file to repair");
			assert.match(failure.message, /DROP TABLE lists_migration/);
			assert.match(
				failure.message,
				/ALTER TABLE lists_migration RENAME TO lists/,
			);
			await closeTodoDb();

			// Nothing was dropped, moved, or replaced automatically.
			const chk = new DatabaseSync(dbPath, { readOnly: true });
			const listCount = chk
				.prepare("SELECT COUNT(*) AS c FROM lists")
				.get() as { c: number };
			const scratchCount = chk
				.prepare("SELECT COUNT(*) AS c FROM lists_migration")
				.get() as { c: number };
			const taskCount = chk
				.prepare("SELECT COUNT(*) AS c FROM tasks")
				.get() as { c: number };
			chk.close();
			assert.equal(listCount.c, 0, "recreated lists table left alone");
			assert.equal(scratchCount.c, 2, "user rows still in the scratch table");
			assert.equal(taskCount.c, 2, "tasks untouched");

			// The recovery steps from the message restore the rows.
			const fix = new DatabaseSync(dbPath);
			fix.exec("DROP TABLE lists");
			fix.exec("ALTER TABLE lists_migration RENAME TO lists");
			fix.close();

			const db = await getDb();
			assert.equal(db.getList("old", "list")?.id, 1);
			assert.equal(db.getList("old", "list")?.title, "legacy");
			assert.equal(db.fetchTree(1)[0]?.text, "legacy task");
			await closeTodoDb();
			assertMigratedShape(dbPath, 2);
		},
	);
});

/** Run a throwaway `node` process against `dbPath`, bounded by a kill timer. */
function runNode(
	script: string,
	dbPath: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			["--input-type=module", "-e", script],
			{
				env: { ...process.env, PI_TODO_DB: dbPath },
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
}

test("concurrent first opens serialize the migration exactly once", async () => {
	await withLegacyDb(
		METADATA_ERA_SCHEMA,
		(legacy) => seedTwoLists(legacy, true),
		async (dbPath) => {
			const dbModuleUrl = new URL("../src/db.ts", import.meta.url).href;
			const script = `
const { getDb, closeTodoDb } = await import(${JSON.stringify(dbModuleUrl)});
const db = await getDb();
const list = db.getList("old", "list");
if (!list) throw new Error("legacy list missing after concurrent open");
if (list.namespace !== "") throw new Error("unexpected namespace: " + list.namespace);
if (db.fetchTree(list.id)[0]?.text !== "legacy task") throw new Error("legacy task missing");
await closeTodoDb();
console.log("ok");
`;
			const results = await Promise.all(
				Array.from({ length: 3 }, () => runNode(script, dbPath)),
			);
			for (const [index, result] of results.entries()) {
				assert.equal(
					result.code,
					0,
					`child ${index} failed with code ${result.code}:\n${result.stderr}`,
				);
				assert.match(result.stdout, /ok/);
			}

			// One migration ran; the file opens in-process with data intact.
			const { getDb, closeTodoDb } = await import("../src/db.ts");
			const db = await getDb();
			assert.equal(db.getList("old", "list")?.id, 1);
			assert.equal(db.getLists().length, 2);
			await closeTodoDb();
			assertMigratedShape(dbPath, 2);
		},
	);
});
