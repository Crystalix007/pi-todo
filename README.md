# pi-todo

Hierarchical TODO lists that agents can plan, check off, and refine — persisted in SQLite3, reachable from any project.

## Install

Copy-paste into pi:

```bash
pi install git:github.com/Crystalix007/pi-todo
```

That's it. The `todo` tool and `/todo` command will be available in your next session (or after `/reload`).

If you just want to try it without installing:

```bash
pi -e git:github.com/Crystalix007/pi-todo
```

## Quick start

Open pi and ask your agent:

> Add a few tasks to a list called `my-project/tasks`, nested: a parent "Build login" with children "HTML form" and "POST handler", plus a separate "Write tests".

The agent creates the list and tasks in one tool call. To see what's there yourself, type:

```
/todo my-project/tasks
```

Mark things done:

> Check off Build login as done (cascade to subtasks too).

## Key concepts

**Lists** live at a path — `$scope/$name` (e.g. `my-project/tasks`) or just `/tasks` for root. Scope is everything before the last slash. Don't worry about exact formatting — `tasks`, `/tasks`, and `tasks/` all mean the same thing. Lists auto-create the first time you add a task.

Each list carries optional metadata — a human `title`, a `project_path` (the directory the work belongs to), and a `description` (the overall goal). Set them when creating the list: `create {list, title, project_path, description}`. Every read of the list — including subtree views like `my-project/tasks#7` handed to a subagent — echoes the project path and goal, so a scoped subagent still knows what project it's working in and what the list is trying to achieve.

**Tasks** are nested. A task can have subtasks (and those can have subtasks, arbitrarily deep). Every task has a `status` (`pending`, `in_progress`, or `done`) and a `priority` (`critical`, `high`, `medium`, or `low`). Checking something off means setting its status to `done`.

**Pull the next task** with the `next` action — it finds the highest-priority pending task in a list (or across all lists). Mark things `in_progress` as you work on them and the `next` will skip past them.

**The agent does the work.** The `/todo` command shows lists and tasks in a keyboard-navigable viewer (↑/↓, Enter to drill in, Esc/Backspace to go back). But it's read-only — ask the agent to create, update, move, or delete. Every write returns the updated tree, so the agent doesn't need a follow-up read.

## Action reference

All operations go through the `todo` tool. The agent picks an `action` and fills in the fields it needs:

| Action | What it does | Required | Key options |
| ------ | ------------ | -------- | ----------- |
| `lists` | Show all TODO lists | — | `scope` to filter by scope |
| `show` | View a list's task tree | `list` | `format` (`tree`\|`flat`), `status_filter` |
| `add` | Create task(s) in one call | `list`, `items` | `under`, `priority` per item |
| `update` | Edit text, note, status, priority, or description | `list`, `id`, at least one change | `cascade` to push status to all descendants. Without `id`: updates the list itself (`title`, `project_path`, `description`; `''` clears) |
| `move` | Reparent or reorder | `list`, `id` | `under` (new parent), `after` (sibling to place after) |
| `next` | Pull the highest-priority pending task | `list` (optional; omit = all lists) | `status` (default `pending`) |
| `delete` | Remove a task and its subtree | `list`, `id` | — |
| `purge` | Clean up completed work | `list` | — |
| `create` | Explicitly create a list | `list` | `title`, `project_path`, `description` |
| `delete_list` | Remove a whole list | `list` | — |

`purge` only removes tasks that are `done` with no pending descendants — it never deletes work you still need.

## Nested plans in one call

The agent authors nested tasks using `ref` labels (unique within the call) and `underRef` (reference to a parent in the same batch). No recursive JSON schema needed — every provider accepts this:

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

After calling `add`, the tool returns the current tree so the agent can act on it immediately — no `show` needed.

## Persistence

Data is stored in `~/.pi/agent/todo.db` (SQLite3, WAL mode). Set `PI_TODO_DB=./.pi/todo.db` if you want per-project isolation. Lists survive restarts and are reachable from any project — the scope/name scheme is how you organize them.

## Structure

For the curious or those wanting to contribute:

```
src/
  index.ts    # extension factory: registers tool + command
  tool.ts     # action dispatch, validation, content/details
  db.ts       # node:sqlite wrapper (schema, transactions, tree fetch)
  paths.ts    # $scope/$name path parsing
  render.ts   # tree → text (truncation-aware) + themed TUI variant
  command.ts  # /todo command + TUI viewer
```
