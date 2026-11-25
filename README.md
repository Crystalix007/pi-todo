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

Every write returns a **change receipt** plus a **brief digest** of the list, so the agent never needs a follow-up `show` to know where it stands. The digest keeps the whole structure (every task's id and line) and inlines the notes and descriptions of *open* tasks, but collapses completed branches to `(+N done)` and never re-echoes the detail of work already finished:

## How it works

**List paths.** A list lives at `$scope/$name` (`my-project/tasks`) or `$name` for root-level lists; scope is everything before the last `/`. Input is normalized, so `tasks`, `/tasks`, and `tasks/` all name the same list. Lists auto-create on first `add`, or explicitly via `create`.

**Tasks.** Nest arbitrarily deep. Each task has a `status` (`pending`, `in_progress`, `done`) and a `priority` (`critical`, `high`, `medium`, `low`), plus optional `note`, `tags`, and a multi-line `description`.

**List metadata.** A list can carry a `title`, a `project_path` (the directory the work belongs to), and a `description` (the overall goal). Set them in `create`, or later with `update` without an `id`. Every read prints them in the header, subtree views included, so a subagent scoped to `list#id` still knows the project and the goal:

```text
feature/auth  (Auth)  ·  project: /repo  ·  goal: Ship login by Friday  ·  4/7 done  ·  1 in progress
changed: #4 status pending → done; cascade 2 subtasks → done
[~] #1 Build login  [!]
  · Constraint: reuse the shared form component, no new deps.
  [x] #2 HTML form
  [ ] #3 POST handler
[x] #4 DB schema  (+2 done)
[ ] #5 Docs
… 2 done task(s) collapsed. show 'feature/auth', detail:"full" for everything.
```

Receipts describe the real post-transaction outcome, not the request: a same-value write reports `no change`, a `cascade` counts only descendants whose status actually moved, a `move` reports where the task really landed, and a clear names what was destroyed (`note cleared (was 142 chars)`). Measured over the operator's real database, this keeps a typical write at a few hundred bytes instead of 9–18 KB, and the digest fits inside the 2 000-character window pi keeps per tool result when it compacts a session.

`show` is the explicit read and returns full fidelity by default: every task with its whole note and description. Pass `detail: "brief"` for the digest instead.

**Subtree refs.** Append `#<task-id>` to a list path (`feature/auth#7`) to scope `show`/`next` to that task and its descendants. This is the standard way to hand a subagent a bounded slice of a plan.

## Namespaces and subagents

Namespaces are opt-in isolation labels on lists. **Ordinary use is unchanged:** a session with no binding reads and writes the global namespace exactly as before, `/todo` still shows global lists, and nothing is isolated automatically.

The parent chooses a unique namespace before launch, such as `job-42-worker-a`. Names are case-sensitive: 1–64 letters, digits, `.`, `_`, or `-`, starting with a letter or digit; `global` and `*` are reserved selectors. The namespace is separate from the list path.

Precreate a child's plan with ordinary `todo` calls:

```jsonc
{ "action": "create", "list": "tasks", "namespace": "job-42-worker-a",
  "title": "Worker A", "project_path": "/repo", "description": "Refactor auth" }
{ "action": "add", "list": "tasks", "namespace": "job-42-worker-a",
  "items": [{ "text": "Refactor the auth flow" }] }
```

**Alternatively**, copy an existing global plan into a **new** destination (do not precreate it):

```json
{ "action": "create", "list": "tasks", "namespace": "job-42-worker-a",
  "from": "feature-auth/tasks", "from_namespace": "global" }
```

Configure a pi-subagents profile that admits `todo`, for example `.pi/agents/todo-worker.md`:

```markdown
---
name: todo-worker
description: Worker with TODO access
tools: todo, read, bash, edit, write
---
Use your local TODO plan to complete the assigned work.
```

Launch using that profile and the existing pi-subagents extension:

```js
subagent({
  agent: "todo-worker",
  task: "Work through your local TODO list 'tasks'.",
  async: true,
  options: {
    extensionBindings: { "pi-todo/1": { namespace: "job-42-worker-a" } }
  }
});
```

pi-subagents supplies the binding as `PI_SUBAGENT_EXTENSION_BINDINGS`. Native background children can load an installed pi-todo through ambient extensions; when ambient loading is disabled, configure its extension path explicitly (for example, `subagentOnlyExtensions`). A restrictive tool allowlist must include `todo`. Retained **subagent** resume replays the original binding; do not supply a new binding on resume.

Inside a bound session, `show {list: "tasks"}` addresses its local plan. `namespace: "global"` explicitly reaches ordinary shared lists, including scoped paths such as `feature-auth/tasks`. All mutations of existing globals are allowed, including metadata changes, `purge`, and `delete_list`; creating missing global lists is refused. Sibling namespaces and `*` are refused before any query.

The parent stays global by default: its `lists`/`next` never include child lists. To inspect child work, ask explicitly — `{"action":"lists","namespace":"*"}` discovers every persisted namespace, `/todo --namespace job-42-worker-a` browses a chosen one, and `/todo --namespace *` lists all of them. This does not change the default global queue.

Copies are atomic, one-shot snapshots: fresh ids, source untouched, no sync-back, and no namespace registry or GC. Parents read a child's plan with `show {list: "tasks", namespace: "job-42-worker-a"}`. Keep `PI_TODO_DB` shared; do not select a separate database per child.

Isolation is enforced at the todo API, not as an OS sandbox. pi-subagents does not implicitly pass bindings to nested subagent launches: give each isolated grandchild an explicit binding. Arbitrary shell-spawned processes can still inherit the environment. V1 targets native background children and retained subagent resume; external CLI adapters, standalone session resume, and foreground reload are not supported.

**The `/todo` viewer is read-only.** It is for humans. All changes go through the `todo` tool; ask the agent to make them.

## Actions

| Action | Purpose | Key fields |
| ------ | ------- | ---------- |
| `lists` | List all lists | `scope` (prefix filter), `namespace` (`global`\|`*`\|name) |
| `show` | Print a list's task tree | `list`, `format` (`tree`\|`flat`), `status_filter`, `detail` |
| `create` | Create a list (or copy one) | `list`, `title`, `project_path`, `description`, `from`, `from_namespace` |
| `add` | Add task(s) | `list`, `items[]`, `under` |
| `update` | Edit a task, or list metadata | `list` + `id`, or `list` only |
| `move` | Reparent / reorder a task | `list`, `id`, `under`, `after` |
| `delete` | Remove a task and its subtree | `list`, `id` |
| `delete_list` | Remove a whole list | `list` |
| `purge` | Remove fully-done branches | `list` |
| `next` | Highest-priority pending task | `list` (optional), `status`, `detail` |

Field semantics:

- Every action accepts `namespace` (`global`, a parent-assigned name, or `*` for parent discovery on `lists`). Omit it for the session's default: global when unbound, the bound namespace for a child. It is separate from the list path — never a path prefix.
- `detail` selects how much of the list comes back. Writes and `next` default to `brief`; `show` defaults to `full`. Brief mode keeps every task's line and id, inlines the detail of open tasks, collapses completed branches, and word-caps `project`/`goal` in the header (full mode keeps all of it).
- `update` with an `id` edits the task: `text`, `note`, `status`, `priority`, `tags`, `description`. `cascade` pushes a status change to all descendants. `''` clears `note`/`description`, `[]` clears `tags`.
- `update` without an `id` edits the list: `title`, `project_path`, `description`. `''` clears a field.
- `add` nests via `ref`/`underRef` (below) and attaches under an existing task with `under`.
- `next` is read-only. It returns `next_task: null` when nothing matches (not an error) and never changes a task's status; mark it `in_progress` after picking it up. Its response is a **focus window**: the picked task with its full note/description, its ancestor chain, nearby siblings and its open children — pass `detail: "full"` for the whole tree instead.
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

`/todo` lists the caller's default namespace, `/todo <path>` opens one list, `/todo <path>#<id>` opens a subtree. Namespaces are a leading flag only (other text stays a legacy path):

```text
/todo --namespace job-42-worker-a            lists that namespace
/todo --namespace job-42-worker-a tasks#7    opens a list/subtree there
/todo --namespace *                          parent only: every namespace, labelled
```

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

See the [contributor setup and development notes](docs/development.md).
