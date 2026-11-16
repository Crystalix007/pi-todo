/**
 * pi-todo — extension entry point.
 *
 * Registers:
 *   - the `todo` agent tool (hierarchical, named, SQLite-persisted task lists)
 *   - the `/todo` user command (view lists / tasks)
 *
 * The SQLite DB is opened lazily on first use and closed on session shutdown.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { captureExtensionCaller } from "./binding.ts";
import { registerTodoCommand } from "./command.ts";
import { closeTodoDb, getDb, type Counts, type TaskNode } from "./db.ts";
import { themedTreeLines } from "./render.ts";
import { buildTodoToolDef } from "./tool.ts";

export default function (pi: ExtensionAPI): void {
	// Capture the launch-time binding ONCE per factory/session initialization.
	// Foreground children restore the parent's environment after startup;
	// background children retain theirs. Retained subagent resume relaunches
	// with the original payload.
	// The tool and the command surface therefore share this one immutable
	// caller instead of re-reading the environment per call.
	const deps = Object.freeze({ getDb, caller: captureExtensionCaller() });

	const toolDef = buildTodoToolDef(deps);

	pi.registerTool({
		...toolDef,
		renderCall(args: any, theme: any, _context: any): Text {
			let text =
				theme.fg("toolTitle", theme.bold("todo ")) +
				theme.fg("muted", String(args?.action ?? ""));
			if (args?.list) text += ` ${theme.fg("dim", String(args.list))}`;
			if (args?.id != null) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			if (typeof args?.namespace === "string" && args.namespace)
				text += ` ${theme.fg("muted", `namespace=${args.namespace}`)}`;
			if (args?.items) text += ` ${theme.fg("dim", `+${args.items.length}`)}`;
			return new Text(text, 0, 0);
		},
		renderResult(result: any, options: any, theme: any, _context: any): Text {
			const { expanded, isPartial } = options ?? {};
			if (isPartial) return new Text(theme.fg("warning", "Processing…"), 0, 0);

			const d = result?.details ?? {};
			const contentText = result?.content?.[0]?.text ?? "";

			// lists action → compact count (namespace shown only when non-global)
			if (Array.isArray(d.lists)) {
				return new Text(
					theme.fg(
						"muted",
						`${d.lists.length} list(s)${namespaceSuffix(d.namespace)}`,
					),
					0,
					0,
				);
			}

			// list-scoped result
			if (d.list && d.counts) {
				const counts = d.counts as Counts;
				if (expanded && Array.isArray(d.tree)) {
					const lines = themedTreeLines(
						{
							tree: d.tree as TaskNode[],
							counts,
							path: d.list.path,
							title: d.list.title,
							projectPath: d.list.project_path,
							description: d.list.description,
							// Details carry the label form; "global" must stay header-free.
							namespace:
								d.list.namespace === "global" ? "" : d.list.namespace,
						},
						theme,
					);
					return new Text(lines.join("\n"), 0, 0);
				}
				let t =
					theme.fg("success", "✓ ") +
					theme.fg("accent", d.list.path) +
					" " +
					theme.fg("muted", `${counts.done}/${counts.total} done`);
				const ns = namespaceSuffix(d.namespace);
				if (ns) t += theme.fg("dim", ns);
				const aff = formatAffected(d.affected);
				if (aff) t += ` ${theme.fg("dim", aff)}`;
				if (d.truncated) t += ` ${theme.fg("warning", "(truncated)")}`;
				return new Text(t, 0, 0);
			}

			// delete_list / fallback → echo the content text
			return new Text(theme.fg("muted", contentText), 0, 0);
		},
	});

	registerTodoCommand(pi, deps);

	pi.on("session_shutdown", () => {
		void closeTodoDb();
	});
}

/** ` · namespace: <label>` for named/wildcard scopes; empty for global lists. */
function namespaceSuffix(label: unknown): string {
	if (typeof label !== "string" || label === "" || label === "global")
		return "";
	return ` · namespace: ${label}`;
}

function formatAffected(affected: Record<string, unknown> | undefined): string {
	if (!affected) return "";
	const parts: string[] = [];
	if (typeof affected.added === "number") parts.push(`added ${affected.added}`);
	if (typeof affected.updated === "number") parts.push("updated");
	if (typeof affected.deleted === "number" && affected.deleted > 0)
		parts.push(`deleted ${affected.deleted}`);
	if (affected.moved) parts.push("moved");
	if (affected.created_list) parts.push("new list");
	if (affected.updated_list) parts.push("updated list");
	return parts.join(", ");
}
