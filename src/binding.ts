/**
 * pi-todo — capture of the per-session namespace binding.
 *
 * The PARENT session decides a child's namespace before it spawns that child
 * and hands it over through pi-subagents' child-only extension bindings: a
 * canonical-JSON environment variable keyed by package and payload version.
 *
 *   PI_SUBAGENT_EXTENSION_BINDINGS='{"pi-todo/1":{"namespace":"job-worker-a"}}'
 *
 * Read this launch-time input exactly ONCE, in the extension factory, and keep
 * it as an immutable value:
 *  - not at module scope, because a replaced or reloaded session re-runs the
 *    factory and a cached module would hand it the previous session's binding;
 *  - not per tool call, because in-process foreground launches restore the
 *    parent's environment after startup. A background child's environment
 *    remains set, but later changes must not alter its captured policy.
 *
 * A retained subagent resume replays the ORIGINAL binding object into the
 * child launch, so a resumed child captures the same namespace here without any
 * session entry, run-id, or identity derivation on our side.
 *
 * The payload carries no capability flags or handoff structure: the namespace
 * name is the whole contract, and every permission is derived from it by
 * ./namespace.ts. Unknown fields inside our own object are ignored — they can
 * never widen what the caller may do.
 *
 * Fail closed: a payload that names this package but cannot be understood
 * throws during extension load. Falling back to the unbound caller would hand a
 * child the parent's global namespace, which is exactly what a binding exists
 * to prevent.
 */

import {
	UNBOUND_CALLER,
	boundCaller,
	type TodoCaller,
} from "./namespace.ts";

/** Environment variable pi-subagents writes the child's bindings into. */
export const BINDING_ENV_VAR = "PI_SUBAGENT_EXTENSION_BINDINGS";
/** Payload version this extension implements. */
export const BINDING_VERSION = "1";
/** Key of this package's binding inside that payload. */
export const BINDING_KEY = `pi-todo/${BINDING_VERSION}`;

/**
 * Read the caller this session is bound to, once per extension factory run.
 *
 * No payload, an empty one, or a payload without a `pi-todo/1` entry all mean
 * the legacy unbound caller: global by default, may target any namespace. That
 * is never an automatic isolation — a session is isolated only when a parent
 * bound it explicitly.
 */
export function captureExtensionCaller(
	env: Record<string, string | undefined> = process.env,
): TodoCaller {
	const raw = env[BINDING_ENV_VAR];
	if (raw === undefined || raw.trim() === "") return UNBOUND_CALLER;

	let payload: unknown;
	try {
		payload = JSON.parse(raw);
	} catch (err) {
		throw new Error(
			`${BINDING_ENV_VAR} is not valid JSON (${(err as Error).message}).`,
		);
	}
	if (!isPlainObject(payload)) {
		throw new Error(
			`${BINDING_ENV_VAR} must be a JSON object of per-package bindings.`,
		);
	}

	// Any pi-todo entry under a version we do not implement is a binding we
	// cannot honour. Never guess what a newer payload means.
	for (const key of Object.keys(payload)) {
		if (key.startsWith("pi-todo/") && key !== BINDING_KEY) {
			throw new Error(
				`Extension binding '${key}' is not supported; pi-todo implements '${BINDING_KEY}'.`,
			);
		}
	}
	if (!Object.hasOwn(payload, BINDING_KEY)) return UNBOUND_CALLER;

	const own = payload[BINDING_KEY];
	if (!isPlainObject(own)) {
		throw new Error(
			`Extension binding '${BINDING_KEY}' must be a JSON object like {"namespace":"<name>"}.`,
		);
	}
	const namespace = own.namespace;
	if (typeof namespace !== "string") {
		throw new Error(
			`Extension binding '${BINDING_KEY}' must carry a string 'namespace'.`,
		);
	}
	try {
		return boundCaller(namespace);
	} catch (err) {
		throw new Error(
			`Extension binding '${BINDING_KEY}' has an unusable namespace: ${(err as Error).message}`,
		);
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}
