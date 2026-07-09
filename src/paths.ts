/**
 * pi-todo — list-path normalization.
 *
 * Lists are named `$scope/$name` (scoped) or `/$name` / `name` (root / empty scope).
 * Parsing is deliberately lenient so agents can get the slash right inconsistently.
 */

export interface ListRef {
	/** Scope prefix; "" for root, else e.g. "feature-auth" or "a/b". */
	scope: string;
	/** List name (never empty, never contains "/"). */
	name: string;
	/** Canonical normalized path, e.g. "feature-auth/tasks" or "tasks" (no leading slash). */
	path: string;
	/** Optional root task id for subtree references, e.g. "feature/tasks#7". */
	rootTaskId?: number;
}

const FORBIDDEN = /[\x00-\x1f\x7f]/;

/**
 * Parse a list path into {scope, name, path, rootTaskId?}.
 *
 * Accepted forms (all normalize identically):
 *   "/tasks"      -> { scope: "",     name: "tasks" }
 *   "tasks"       -> { scope: "",     name: "tasks" }
 *   "tasks/"      -> { scope: "",     name: "tasks" }
 *   "feature-auth/tasks" -> { scope: "feature-auth", name: "tasks" }
 *   "a/b/c"       -> { scope: "a/b",  name: "c" }
 *   "feature/tasks#7"   -> { scope: "feature", name: "tasks", rootTaskId: 7 }
 *   "tasks#3"     -> { scope: "",     name: "tasks", rootTaskId: 3 }
 *
 * `name` is the segment after the last "/"; a trailing `#<number>` is
 * extracted as `rootTaskId`. Throws on empty / whitespace-only / control characters.
 */
export function parseListPath(input: string): ListRef {
	const raw = (input ?? "").trim();
	if (!raw) {
		throw new Error(
			"List path is empty. Use '$scope/$name' (scoped) or '/$name' or '$name' (root).",
		);
	}
	if (FORBIDDEN.test(raw)) {
		throw new Error(`List path '${raw}' contains control characters.`);
	}

	// Extract trailing #id suffix before normalizing slashes.
	let rootTaskId: number | undefined;
	let taskFree = raw;
	const hashIdx = raw.lastIndexOf("#");
	if (hashIdx > 0) {
		const idStr = raw.slice(hashIdx + 1);
		const parsed = parseInt(idStr, 10);
		if (!isNaN(parsed) && parsed > 0 && idStr === String(parsed)) {
			rootTaskId = parsed;
			taskFree = raw.slice(0, hashIdx);
		}
	}

	// Collapse duplicate slashes; drop a single leading slash and any trailing slash(es).
	let norm = taskFree.replace(/\/+/g, "/");
	if (norm.startsWith("/")) norm = norm.slice(1);
	norm = norm.replace(/\/+$/, "");
	if (!norm) {
		throw new Error("List path is empty after normalization.");
	}

	const idx = norm.lastIndexOf("/");
	if (idx < 0) {
		return { scope: "", name: norm, path: norm, rootTaskId };
	}
	const scope = norm.slice(0, idx);
	const name = norm.slice(idx + 1);
	if (!name) {
		throw new Error(`Invalid list path '${raw}': missing name after scope.`);
	}
	// Each segment must be non-empty (after collapsing this is guaranteed, but double-check).
	if (scope.split("/").some((s) => !s)) {
		throw new Error(`Invalid list path '${raw}': empty scope segment.`);
	}
	return { scope, name, path: norm, rootTaskId };
}

/** Render a list path, optionally including a subtree root id. */
export function formatListPath(ref: {
	scope: string;
	name: string;
	rootTaskId?: number;
}): string {
	const base = ref.scope ? `${ref.scope}/${ref.name}` : ref.name;
	return ref.rootTaskId != null ? `${base}#${ref.rootTaskId}` : base;
}
