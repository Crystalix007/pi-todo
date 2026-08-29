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

### Mutations return the tree

After `add`, `update`, `move`, `delete`, `purge` — the response includes the full updated tree and counts. Do **not** follow up with `show`.

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

```
list: "feature/auth#7"       // show only task #7 and its children
list: "feature/auth#7"       // next: find tasks within that subtree
```

Useful for assigning a subagent a focused subset of work.

### Lists

Named `$scope/$name` (scoped) or just `$name` (root). Auto-created on first `add`.

### Viewer

- `/todo` — browse all lists (Enter to drill in, Esc/Backspace to go back)
- `/todo path` — view a specific list
- `/todo path#id` — view a subtree
- `↑/↓` navigate, `s` sort (creation/completion/priority), `d` toggle descriptions, `b` back from subtree
