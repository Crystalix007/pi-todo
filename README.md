# pi-todo

Agent-optimized TODO-list planning for [pi](https://pi.dev). Persistent, **hierarchical**, **named** task lists backed by SQLite3 — plus a `/todo` command to view them.

- **One `todo` tool** for agents: create lists, add tasks (nested, in a single call), check them off, refine, reorder, purge completed work.
- **Multiple named lists** with a `$scope/$name` (scoped) or `/$name` / `$name` (root) naming scheme.
- **SQLite3 persistence** — survives restarts; reachable from any project.
- **Nested / recursive refinement** — tasks have subtasks (arbitrary depth), via a recursion-free schema that works on every provider.
- **`/todo` command** — view all lists (drill in) or a single list's task tree.

## Install

This is a pi package. From this directory:

```bash
# local path
pi install ./pi-todo

# or git
pi install git:github.com/<you>/pi-todo
```

Or for development, symlink the source into your extensions dir (hot-reloadable with `/reload`):

```bash
ln -s "$PWD/src" ~/.pi/agent/extensions/pi-todo
```

Or just try it once:

```bash
pi -e ./src/index.ts
```

## Lists and names

A list is identified by a path:

| You type          | Scope          | Name   |
| ----------------- | -------------- | ------ |
| `/tasks`          | `""` (root)    | tasks  |
| `tasks`           | `""` (root)    | tasks  |
| `feature-auth/tasks` | `feature-auth` | tasks |
| `a/b/c`           | `a/b`          | c      |

`scope` is everything before the last `/`; the last segment is the list `name`. Root lists have an empty scope. Lists are **created automatically** the first time you `add` to them (or explicitly with `create`).

## The `todo` tool

Single tool with an `action` field. Every **write** returns the affected list's current tree + counts, so you usually don't need a follow-up `show`.

| Action        | Required fields                | Optional fields                    | What it does                                     |
| ------------- | ------------------------------ | ---------------------------------- | ------------------------------------------------ |
| `lists`       | —                              | `scope`                            | List all TODO lists (with counts).               |
| `show`        | `list`                         | `format` (`tree`\|`flat`), `status_filter` | View a list's tasks.                             |
| `create`      | `list`                         | `title`                            | Create/ensure a list exists (optionally set title). |
| `add`         | `list`, `items`                | `under`                            | Add task(s). Nest via `ref`/`underRef`.          |
| `update`      | `list`, `id`, (`text`\|`note`\|`status`) | `cascade`                | Edit a task. `note:""` clears it.                |
| `move`        | `list`, `id`                   | `under`, `after`                   | Reparent / reorder. Omit `under` for top-level.  |
| `delete`      | `list`, `id`                   | —                                  | Remove a task and its subtree.                   |
| `delete_list` | `list`                         | —                                  | Remove an entire list.                           |
| `purge`       | `list`                         | —                                  | Remove completed work (done tasks with no pending descendants). |

`status` is one of `pending`, `in_progress`, `done`.

### Authoring a whole nested plan in one call

`add` items support `ref` (a label unique within the call) and `underRef` (the `ref` of a parent item in the **same** call):

```jsonc
{
  "action": "add",
  "list": "feature-auth/tasks",
  "items": [
    { "ref": "p1", "text": "Build login form" },
    { "text": "HTML form",      "underRef": "p1" },
    { "text": "POST handler",   "underRef": "p1", "status": "in_progress" },
    { "ref": "p2", "text": "Set up DB schema", "status": "done" }
  ]
}
```

`under` (an existing task id) attaches the whole top-level batch under that task. This flat-reference schema is recursion-free, so it's accepted by Anthropic, Google, and OpenAI alike.

Example result (also returned to the agent, so it can act immediately):

```
feature-auth/tasks  ·  1/4 done  ·  1 in progress
[ ] #1 Build login form
  [ ] #2 HTML form
  [~] #3 POST handler
[x] #4 Set up DB schema
```

### Checking off and refining

```jsonc
// mark a task (and its subtree) done
{ "action": "update", "list": "feature-auth/tasks", "id": 1, "status": "done", "cascade": true }

// refine: add a subtask under an existing task
{ "action": "add", "list": "feature-auth/tasks", "under": 3, "items": [{ "text": "rate-limit login" }] }

// clean up completed branches
{ "action": "purge", "list": "feature-auth/tasks" }
```

## `/todo` command

- `/todo` — interactive viewer of all lists (↑/↓ to select, **Enter** to drill into a list, **Esc** to close).
- `/todo <list>` — viewer for that list's task tree (↑/↓ to scroll, **Backspace**/**Esc** to go back).

The viewer is read-only on purpose — mutations go through the `todo` tool, which is what agents (and you, via the agent) should use. In non-interactive modes (`-p`, `--mode json`) it prints a compact summary instead.

## Persistence

Tasks are stored in SQLite. Default location: `~/.pi/agent/todo.db`. Override with the `PI_TODO_DB` environment variable (e.g. `PI_TODO_DB=./.pi/todo.db` for per-project isolation). Uses WAL mode, per-connection foreign keys (cascading deletes), and serialized transactions, so concurrent tool calls are safe.

## Structure

```
src/
  index.ts    # extension factory: registers the todo tool + /todo command
  tool.ts     # todo tool: action dispatch, validation, content/details
  db.ts       # node:sqlite wrapper (schema, transactions, tree fetch)
  paths.ts    # $scope/$name path parsing
  render.ts   # tree/lists → text (truncation-aware) + themed variant
  command.ts  # /todo command + TUI viewer
```

## Status semantics

- `pending` → `in_progress` → `done`. "Check off" = `done`.
- `update` with `cascade: true` pushes a status to all descendants.
- Whole-list progress is always shown as `done/total` counts (a parent's counts reflect its subtree).
- `purge` deletes any task that is `done` with no pending descendants (including a lone done leaf); it never deletes pending work.
