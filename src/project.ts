/**
 * pi-todo — project-directory handling for TODO lists.
 *
 * A list may carry a `project_path`: the directory its work belongs to. The DB
 * is shared by every project (`~/.pi/agent/todo.db`), so that column is the only
 * per-repo marker in the schema — matching on it is how an agent asks "what am
 * I working on in THIS repo?" rather than "everything, everywhere".
 *
 * Values are stored as the agent typed them (`/repo`, `/repo/src`, `.`, `~/repo`,
 * `repo/`), and lists written before this module existed are just as loose. So
 * BOTH sides of a comparison are canonicalized here, in JS — never in SQL, where
 * a LIKE pattern would leak wildcards out of user input.
 *
 * Matching is deliberately case-sensitive and segment-bounded: `/repo` matches
 * `/repo` and `/repo/src`, but never `/repo-old`.
 */

import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

/** Collapse duplicate separators + trailing slashes, keeping a bare root "/". */
export function normalizeDirPath(input: string): string {
	let out = input.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
	if (out.length > 1) out = out.replace(/\/+$/, "");
	return out;
}

/** Expand a leading `~` or `~/…` to `home` (default: this process's home dir). */
export function expandTilde(input: string, home: string = homedir()): string {
	if (input === "~") return home;
	if (input.startsWith("~/")) return `${home}${input.slice(1)}`;
	return input;
}

/**
 * Absolute, normalized form of `input`, resolving relative paths (including ".")
 * against `cwd`. Returns null when the path is relative and no `cwd` is known —
 * the caller decides whether that is an error or a value to store verbatim.
 */
export function absoluteProjectPath(
	input: string,
	cwd?: string,
): string | null {
	const expanded = expandTilde(input.trim());
	if (!expanded) return null;
	if (isAbsolute(expanded)) return normalizeDirPath(expanded);
	if (!cwd) return null;
	return normalizeDirPath(resolve(expandTilde(cwd), expanded));
}

/**
 * Canonicalize a caller-supplied `project_path` for STORAGE.
 *
 * Preserves the write-path conventions the metadata APIs rely on:
 *   undefined → undefined (leave unchanged / keep a copied value)
 *   ""        → "" (clear the field; lenient `create` ignores blanks)
 *   absolute  → normalized absolute
 *   relative  → resolved against `cwd` when known, else stored as typed
 *
 * Storing absolute paths keeps a list pinned to one directory instead of one
 * that re-interprets a stored "." against whatever cwd reads it later.
 */
export function canonicalProjectPath(
	input: string | null | undefined,
	cwd?: string,
): string | null | undefined {
	if (input === undefined) return undefined;
	if (input === null) return null;
	const trimmed = input.trim();
	if (!trimmed) return "";
	return (
		absoluteProjectPath(trimmed, cwd) ?? normalizeDirPath(expandTilde(trimmed))
	);
}

/**
 * Does a list pinned at `listPath` belong to `filterPath`?
 *
 * True when the two directories are the same or one contains the other, so a
 * list pinned at `/repo` is still found while working in `/repo/src`, and a list
 * pinned at `/repo/src` is found when asking about `/repo`.
 *
 * `filterPath` is already absolute (resolved by the caller). `listPath` is
 * whatever was stored, so a relative legacy value (`.`, `src`) is resolved
 * against `cwd` — the reading session's — since that is the only interpretation
 * available. New writes store absolute paths (see canonicalProjectPath).
 */
export function projectMatches(
	listPath: string,
	filterPath: string,
	cwd?: string,
): boolean {
	const a = normalizeDirPath(
		absoluteProjectPath(listPath, cwd) ?? expandTilde(listPath),
	);
	const b = normalizeDirPath(expandTilde(filterPath));
	if (!a || !b) return false;
	return isWithin(a, b) || isWithin(b, a);
}

/** `child` is `parent` or sits under it, on a path-segment boundary. */
function isWithin(child: string, parent: string): boolean {
	if (child === parent) return true;
	// The root's prefix is already its own separator ("/"), not "//".
	const prefix = parent.endsWith("/") ? parent : `${parent}/`;
	return child.startsWith(prefix);
}
