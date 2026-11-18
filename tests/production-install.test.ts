/** Production extension installs must not pull in Pi's host-provided SDKs. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const hostPeers = [
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"typebox",
];

test("host APIs stay peer-only and pnpm automatic peer installation is disabled", () => {
	const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
	for (const name of hostPeers) {
		assert.equal(manifest.peerDependencies[name], "*");
		assert.equal(manifest.dependencies?.[name], undefined);
	}
	const config = readFileSync(new URL("pnpm-workspace.yaml", root), "utf8");
	assert.match(config, /^autoInstallPeers: false$/m);
});

test("Pi's pnpm production install succeeds offline without host SDKs or build approvals", (t) => {
	const version = spawnSync("pnpm", ["--version"], {
		encoding: "utf8",
		timeout: 10_000,
	});
	if (version.error && "code" in version.error && version.error.code === "ENOENT") {
		t.skip("pnpm is not installed; the package also supports npm");
		return;
	}
	assert.equal(version.status, 0, version.error?.message ?? version.stderr);

	const dir = mkdtempSync(join(tmpdir(), "pi-todo-production-install-"));
	try {
		for (const file of ["package.json", "package-lock.json", "pnpm-workspace.yaml"]) {
			copyFileSync(new URL(file, root), join(dir, file));
		}
		// Match Pi's managed git install, with offline mode to prove that no host
		// dependencies need fetching. Deliberately do NOT use --ignore-scripts:
		// an unexpected SDK install must expose the build-policy regression.
		const result = spawnSync("pnpm", [
			"install", "--prod",
			"--config.auto-install-peers=false",
			"--config.strict-peer-dependencies=false",
			"--config.strict-dep-builds=false",
			"--offline",
		], {
			cwd: dir,
			encoding: "utf8",
			env: { ...process.env, CI: "true" },
			timeout: 30_000,
		});
		assert.equal(result.status, 0,
			`${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`);
		const lock = readFileSync(join(dir, "pnpm-lock.yaml"), "utf8");
		assert.match(lock, /autoInstallPeers: false/);
		assert.doesNotMatch(lock, /@earendil-works|@google\/genai|protobufjs/);
		for (const name of hostPeers) {
			assert.equal(existsSync(join(dir, "node_modules", name)), false,
				`${name} must be provided by Pi, not installed by the extension`);
		}
		assert.doesNotMatch(readFileSync(join(dir, "pnpm-workspace.yaml"), "utf8"), /allowBuilds/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
