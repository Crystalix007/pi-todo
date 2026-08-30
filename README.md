# pi-todo

Hierarchical TODO lists for pi agents, persisted in SQLite. Tasks nest to any depth; every read renders the current tree back to the agent, so a plan is also its own status report.

## Install

```bash
pi install git:github.com/Crystalix007/pi-todo
```

The `todo` tool and `/todo` command are available next session, or after `/reload`. Try it without installing:

```bash
pi -e git:github.com/Crystalix007/pi-todo
```

## Quick start

Ask the agent:

> Create a list `my-project/tasks` with a parent "Build login", children "HTML form" and "POST handler", and a separate "Write tests". Set the project path to this repo and the description to "Ship login in this sprint".

View it yourself:

```text
/todo my-project/tasks
```

Every write (`add`, `update`, `move`, `delete`, `purge`) returns the affected list's tree, so the agent never needs a follow-up `show`.

## How it works

**List paths.** A list lives at `$scope/$name` (`my-project/tasks`) or `$name` for root-level lists; scope is everything before the last `/`. Input is normalized, so `tasks`, `/tasks`, and `tasks/` all name the same list. Lists auto-create on first `add`, or explicitly via `create`.

**Tasks.** Nest arbitrarily deep. Each task has a `status` (`pending`, `in_progress`, `done`) and a `priority` (`critical`, `high`, `medium`, `low`), plus optional `note`, `tags`, and a multi-line `description`.

**List metadata.** A list can carry a `title`, a `project_path` (the directory the work belongs to), and a `description` (the overall goal). Set them in `create`, or later with `update` without an `id`. Every read prints them in the header, subtree views included, so a subagent scoped to `list#id` still knows the project and the goal:

```text
my-app/sprint  (Sprint 24)  ·  project: /Users/me/code/my-app  ·  goal: Ship v2 of the billing flow before the 15th  ·  0/3 done
```

**Subtree refs.** Append `#<task-id>` to a list path (`feature/auth#7`) to scope `show`/`next` to that task and its descendants. This is the standard way to hand a subagent a bounded slice of a plan.

**The `/todo` viewer is read-only.** It is for humans. All changes go through the `todo` tool; ask the agent to make them.

## Actions

| Action | Purpose | Key fields |
| ------ | ------- | ---------- |
| `lists` | List all lists | `scope` (prefix filter) |
| `show` | Print a list's task tree | `list`, `format` (`tree`\|`flat`), `status_filter` |
| `create` | Create a list | `list`, `title`, `project_path`, `description` |
| `add` | Add task(s) | `list`, `items[]`, `under` |
| `update` | Edit a task, or list metadata | `list` + `id`, or `list` only |
| `move` | Reparent / reorder a task | `list`, `id`, `under`, `after` |
| `delete` | Remove a task and its subtree | `list`, `id` |
| `delete_list` | Remove a whole list | `list` |
| `purge` | Remove fully-done branches | `list` |
| `next` | Highest-priority pending task | `list` (optional), `status` |

Field semantics:

- `update` with an `id` edits the task: `text`, `note`, `status`, `priority`, `tags`, `description`. `cascade` pushes a status change to all descendants. `''` clears `note`/`description`, `[]` clears `tags`.
- `update` without an `id` edits the list: `title`, `project_path`, `description`. `''` clears a field.
- `add` nests via `ref`/`underRef` (below) and attaches under an existing task with `under`.
- `next` is read-only. It returns `next_task: null` when nothing matches (not an error) and never changes a task's status; mark it `in_progress` after picking it up.
- `purge` deletes only `done` branches with no pending descendants.

## Nested authoring in one call

`add` accepts an `items[]` batch where each item may carry a `ref` label and an `underRef` pointing at another item's `ref`. No recursive JSON schema, works on every provider:

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

## Persistence

Data is stored in `~/.pi/agent/todo.db` (SQLite, WAL mode). Lists survive restarts and are shared across all projects; the scope prefix is the organizational scheme. Set `PI_TODO_DB=/path/to/todo.db` for per-project isolation. The schema migrates itself on open.

## `/todo` viewer

`/todo` lists all lists, `/todo <path>` opens one, `/todo <path>#<id>` opens a subtree.

| Key | Action |
| --- | ------ |
| ↑/↓ or j/k | Move selection |
| Enter | Open selected list |
| Backspace / Esc | Go back |
| `b` | Subtree view: back to the full list |
| `s` | Cycle sort (creation / completion / priority) |
| `d` | Toggle task descriptions |
| `q` / Ctrl+C | Close |

## Development

```text
src/
  index.ts    # extension entry: registers the todo tool + /todo command
  tool.ts     # action dispatch, validation, tool description
  db.ts       # node:sqlite wrapper: schema, migrations, tree fetch
  paths.ts    # $scope/$name path parsing
  render.ts   # tree → text (truncation-aware) + themed TUI output
  command.ts  # /todo command + TUI viewer
```

```bash
npm test
```
