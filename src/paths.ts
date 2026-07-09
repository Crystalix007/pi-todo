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
}

const FORBIDDEN = /[\x00-\x1f\x7f]/;

/**
 * Parse a list path into {scope, name, path}.
 *
 * Accepted forms (all normalize identically):
 *   "/tasks"      -> { scope: "",     name: "tasks" }
 *   "tasks"       -> { scope: "",     name: "tasks" }
 *   "tasks/"      -> { scope: "",     name: "tasks" }
 *   "feature-auth/tasks" -> { scope: "feature-auth", name: "tasks" }
 *   "a/b/c"       -> { scope: "a/b",  name: "c" }
 *
 * `name` is the segment after the last "/"; everything before it is the scope.
 * Throws on empty / whitespace-only / control characters.
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

	// Collapse duplicate slashes; drop a single leading slash and any trailing slash(es).
	let norm = raw.replace(/\/+/g, "/");
	if (norm.startsWith("/")) norm = norm.slice(1);
	norm = norm.replace(/\/+$/, "");
	if (!norm) {
		throw new Error("List path is empty after normalization.");
	}

	const idx = norm.lastIndexOf("/");
	if (idx < 0) {
		return { scope: "", name: norm, path: norm };
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
	return { scope, name, path: norm };
}

/** Render a {scope, name} back to its canonical path string. */
export function formatListPath(ref: { scope: string; name: string }): string {
	return ref.scope ? `${ref.scope}/${ref.name}` : ref.name;
}
