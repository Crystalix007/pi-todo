---
name: pi-todo
description: Use the todo tool for hierarchical, persisted task planning — creating nested plans, checking off work, scoping subtree assignments to subagents. Do not write plan files to disk; use todo instead.
---

# pi-todo

Use the `todo` tool and `/todo` viewer for task planning. No plan files on disk.

## Quick reference

### Nesting (flat-ref)

Author a full nested plan in ONE `add` call — no recursion:

```
items: [{ref:"p", text:"Ship feature"}, {text:"Write tests", underRef:"p"}]
```

Each item gets a `ref` (label, unique in this batch) and optionally an `underRef` pointing to another item's `ref`. The tool resolves refs → real parent IDs.

### Mutations return a change receipt + a brief digest

After `add`, `update`, `move`, `delete`, `purge` the response is:

1. a `changed:` line describing what really happened (`#12 status pending → done`, `note cleared (was 142 chars)`, `moved #3 → #7`, `deleted #9 (+4 subtasks, 2 open)`) — or `no change:` when the write was a no-op;
2. a **brief** view of the whole list: every task's line and id, with notes/descriptions of **open** tasks inline, and completed branches collapsed to `(+N done)`;
3. a trailer naming anything else omitted and how to expand it.

So you can normally keep working without another read. Call `show` with `detail: "full"` when you need the notes of **completed** tasks (for a summary or report) or the whole history.

### Priority

`critical` > `high` > `medium` (default) > `low`. Use `next` (action: "next") to pull the highest-priority pending task from a list. `next` is **read-only**: it does not mark the task `in_progress` — call `update` with `status: "in_progress"` when you start work. When nothing matches, `next` returns `next_task: null` (a normal result, not an error); the response also marks the pick as `next → #<id>`.

### Recovering from errors

- List not found / bad id → the error message tells you; run `lists` or `show` to discover valid paths and ids.
- Task ids are SQLite-persisted: ids from earlier calls stay valid across sessions.
- `add` with `under` rejects ids from another list (nothing is inserted).
- A bare `move {list, id}` (no `under`) moves the task to **top level** — pass `under` to keep it nested.
- `next` on an exhausted queue is not an error: treat `next_task: null` as "nothing to do".

### Tags

Optional `tags` string array — e.g. `["blocked", "waiting-on-input"]`. Tags signal that a task cannot be completed yet and needs revisiting. Displayed inline in the tree.

### Description

Optional multi-line `description` for context beyond the title. Shown as indented block in tool output. In the `/todo` viewer, press `d` to toggle inline display.

### Subtree references

Append `#task-id` to a list path to scope to a specific task's subtree (the task itself and its descendants):

```js
list: "feature/auth#7"       // show only task #7 and its children
list: "feature/auth#7"       // next: find tasks within that subtree
```

Useful for assigning a subagent a focused subset of work.

### Lists

Named `$scope/$name` (scoped) or just `$name` (root). Auto-created on first `add`. `create` on a list that already exists refuses to replace a non-empty `title`/`project_path`/`description` unless you repeat it with `force: true`; to change metadata on purpose, use `update` without an `id`.

### Project filter (`lists project`)

The DB is shared across projects, so `lists` takes a `project` directory filter — the way to answer "which lists belong to THIS repo".

```js
{ action: "lists", project: "." }                 // this session's working directory
{ action: "lists", project: "/repo", scope: "auth" }  // composed with a scope prefix
{ action: "lists", project: ".", namespace: "*" }    // this repo across every namespace
```

- `.` and other relative values resolve against the session's cwd; absolute paths pass through; `~` expands.
- A list pinned in a parent or child directory also matches (a list at `/repo` is found from `/repo/src`). Matching is segment-bounded: `/repo` never matches `/repo-old`.
- The header names the directory (`TODO lists in /repo (3):`), and a trailer counts the lists with no `project_path` that the filter could not match — so a narrowed result never reads as "that's everything".
- `project_path` is stored absolute (a relative value is resolved on write), so a pinned list keeps meaning the same directory across sessions.
- A relative `project` with no session cwd (direct dispatch, scripts) is an error rather than a silent full listing. `project` is rejected outside action `lists`; to set a list's directory use `project_path`.

### Namespaces (subagent isolation)

Ordinary sessions are unbound: keep omitting `namespace`; global lists and `next` are unchanged.

Parent workflow:

1. Choose a unique, case-sensitive namespace before launch (e.g. `job-42-worker-a`). It is separate from the list path.
2. Precreate with `create {list: "tasks", namespace: "job-42-worker-a"}` and `add` in the same namespace. **Or**, without precreating the destination, snapshot a global plan: `create {list: "tasks", namespace: "job-42-worker-a", from: "feature/tasks", from_namespace: "global"}`. Copies require a new destination, are atomic and independent — not a sync.
3. Launch a native background subagent with `options.extensionBindings: {"pi-todo/1":{"namespace":"job-42-worker-a"}}`. pi-subagents delivers this through `PI_SUBAGENT_EXTENSION_BINDINGS`. pi-todo must be loaded (ambient or explicit extension path); include `todo` in a restrictive tool allowlist. Keep the same `PI_TODO_DB`.
4. Read with `show {list: "tasks", namespace: "job-42-worker-a"}`. Discover with `lists {namespace: "*"}` or `/todo --namespace *`; browse with `/todo --namespace job-42-worker-a [path]`. Default `lists`/`next` stay global and exclude children.

Child session: every todo call defaults to its namespace. `namespace: "global"` reaches ordinary shared root/scoped lists and permits all mutations of existing ones, including metadata, `purge` and `delete_list`; new global lists, siblings, and `*` are refused. Retained subagent resume replays the original binding — do not rebind. Nested subagent launches need an explicit binding to opt in.

V1 targets native background children. External CLI adapters, standalone session resume, and foreground reload are unsupported. Isolation is API-level, not an OS sandbox; shell-spawned processes may inherit the binding environment.

### Viewer

- `/todo` — browse the caller's default namespace (Enter to drill in, Esc/Backspace to go back)
- `/todo path` — view a specific list
- `/todo path#id` — view a subtree
- `/todo --namespace <name>` — browse a child/parent-chosen namespace (only a leading flag; other text stays a legacy path)
- `/todo --namespace "*"` — parent-only: every namespace, labelled
- `↑/↓` navigate, `s` sort (creation/completion/priority), `d` toggle descriptions, `b` back from subtree
