/**
 * pi-todo — optional list namespaces and the per-session policy for them.
 *
 * A namespace is an isolation label stored on each list row. Storage values:
 *  - ""            the shared GLOBAL namespace. Legacy rows and every list
 *                  written by an unbound session live here.
 *  - "<identifier>" a named namespace, owned by one session family.
 *
 * Namespaces are chosen by the parent session before it spawns children; they
 * are never derived from run/session ids, and a list `path` never carries one
 * (no magic path prefixes). The selector arrives as a separate `namespace`
 * tool parameter.
 *
 * This module is pure policy — no DB, no host dependencies — so the tool, the
 * tests, and (later) the viewer/command surface resolve permissions the same
 * way:
 *  - an UNBOUND caller (legacy session, parent) acts on the global namespace
 *    by default and may target any namespace explicitly;
 *  - a BOUND caller (child session) defaults to its own namespace and may
 *    otherwise only reach the shared global namespace, where it can read and
 *    mutate EXISTING lists but never create missing ones;
 *  - the wildcard "*" is parent-only and discovery-only.
 *
 * The guarantee is API isolation against pollution, not an OS sandbox.
 */

/** Storage value of the shared/legacy namespace. */
export const GLOBAL_NAMESPACE = "";
/** Selector spelling for the shared/legacy namespace. */
export const GLOBAL_SELECTOR = "global";
/** Parent-only discovery selector: every namespace at once. */
export const ALL_NAMESPACES = "*";

const NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_NAMESPACE_LENGTH = 64;

/**
 * Who is calling, for namespace purposes. Immutable per session: a session is
 * either unbound (legacy/parent) or bound to exactly one namespace (child).
 */
export type TodoCaller =
	| { readonly kind: "unbound" }
	| { readonly kind: "bound"; readonly namespace: string };

/** The legacy no-namespace caller: global by default, may target any namespace. */
export const UNBOUND_CALLER: TodoCaller = Object.freeze({ kind: "unbound" });

/** Build a caller bound to `namespace`; rejects reserved or malformed names. */
export function boundCaller(namespace: string): TodoCaller {
	assertNamespaceIdentifier(namespace);
	return Object.freeze({ kind: "bound", namespace });
}

export function isValidNamespaceIdentifier(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= MAX_NAMESPACE_LENGTH &&
		value !== GLOBAL_SELECTOR &&
		value !== ALL_NAMESPACES &&
		NAMESPACE_PATTERN.test(value)
	);
}

export function assertNamespaceIdentifier(value: string): void {
	if (isValidNamespaceIdentifier(value)) return;
	throw new Error(
		`Invalid namespace '${value}'. Use 1-${MAX_NAMESPACE_LENGTH} characters from A-Z, a-z, 0-9, '.', '_' or '-', starting with a letter or digit. '${GLOBAL_SELECTOR}' and '${ALL_NAMESPACES}' are reserved selectors.`,
	);
}

/** Human/agent-readable spelling of a storage namespace. */
export function namespaceLabel(namespace: string): string {
	return namespace === GLOBAL_NAMESPACE ? GLOBAL_SELECTOR : namespace;
}

export interface NamespaceResolution {
	/** Storage namespace this call reads/writes; "" is global. */
	namespace: string;
	/** The parent-only "*" selector was requested (discovery actions only). */
	allNamespaces: boolean;
}

/**
 * Resolve the `namespace` selector for one call against the caller.
 * Throws for malformed identifiers, sibling namespaces, and wildcard use by a
 * bound caller. Callers still have to reject `allNamespaces` outside discovery.
 */
export function resolveNamespace(
	selector: string | undefined | null,
	caller: TodoCaller,
): NamespaceResolution {
	const requested = (selector ?? "").trim();
	if (requested === ALL_NAMESPACES) {
		if (caller.kind === "bound") {
			throw new Error(
				`The '${ALL_NAMESPACES}' namespace selector is only available to the parent session; this session is bound to namespace '${caller.namespace}'.`,
			);
		}
		return { namespace: GLOBAL_NAMESPACE, allNamespaces: true };
	}
	if (requested === GLOBAL_SELECTOR) {
		return { namespace: GLOBAL_NAMESPACE, allNamespaces: false };
	}
	if (requested === "") {
		return {
			namespace:
				caller.kind === "bound" ? caller.namespace : GLOBAL_NAMESPACE,
			allNamespaces: false,
		};
	}
	assertNamespaceIdentifier(requested);
	if (caller.kind === "bound" && requested !== caller.namespace) {
		throw new Error(
			`Namespace '${requested}' is outside this session's namespace '${caller.namespace}'. Child sessions may use their own namespace and the shared '${GLOBAL_SELECTOR}' namespace.`,
		);
	}
	return { namespace: requested, allNamespaces: false };
}

/**
 * Whether this caller may create a list in `namespace`. A bound caller can do
 * everything to EXISTING global lists but must not add new ones to the shared
 * namespace; otherwise one child could pollute every other session's default
 * view. Enforce this atomically inside the write transaction.
 */
export function canCreateList(caller: TodoCaller, namespace: string): boolean {
	return !(caller.kind === "bound" && namespace === GLOBAL_NAMESPACE);
}

/** Throw with actionable guidance when creation is not permitted. */
export function assertCanCreateList(
	caller: TodoCaller,
	namespace: string,
	listPath: string,
): void {
	if (canCreateList(caller, namespace)) return;
	const own = caller.kind === "bound" ? caller.namespace : GLOBAL_SELECTOR;
	throw new Error(
		`List '${listPath}' does not exist in the global namespace, and a session bound to namespace '${own}' cannot create new global lists. Use an existing global list, or omit 'namespace' to create it in '${own}'.`,
	);
}
