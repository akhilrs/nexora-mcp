# Nexora MCP

Claude Code plugin for [Nexora HRM](https://github.com/akhilrs/nexora) — AI-native project management integration.

Manage work items, dependencies, comments, time tracking, and projects directly from Claude Code via MCP tools.

## Install

```bash
/plugin marketplace add akhilrs/nexora-mcp
/plugin add nexora
/reload-plugins
```

## Setup

### 1. Create an API key

In the Nexora web UI, go to **Settings > API Keys** and create a new agent key.
Set it as an environment variable (add to your shell profile):

```bash
export NEXORA_API_KEY=nxr_your_key_here
```

### 2. Configure your project

Create a `.nexora.toml` file in your project root:

```toml
[api]
url = "https://nexora.example.com/api/v1"

[organization]
id = "your-organization-uuid"

[project]
code = "PRJ-001"
```

Copy from `.nexora.toml.example` as a starting point.

This file is safe to commit — it contains no secrets (API key is env-only).
The MCP server walks up from the current directory to find this file (like `.git` discovery).

**Config priority**: env vars > `.nexora.toml` > defaults

### 3. Use it

```
/nexora:ready          # find unblocked work items
/nexora:start PM-42    # start working on PM-42
/nexora:done PM-42     # complete with summary
```

## Tools (30)

### Work Items (8)
| Tool | Description |
|------|-------------|
| `nexora_work_item_create` | Create task, bug, story, epic, or feature |
| `nexora_work_item_list` | List with status/type/assignee/stream filters |
| `nexora_work_item_show` | Show details by display ID (PM-42) |
| `nexora_work_item_update` | Update any field |
| `nexora_work_item_delete` | Soft-delete (mark as wont_do) |
| `nexora_work_item_ready` | Unblocked todo items |
| `nexora_work_item_children` | List children of a parent |
| `nexora_work_item_transition` | Change status |

### Dependencies (3)
| Tool | Description |
|------|-------------|
| `nexora_dep_add` | Add blocking or relates_to dependency |
| `nexora_dep_remove` | Remove dependency |
| `nexora_dep_list` | List all deps (blocked_by + blocks) |

### Comments (4)
| Tool | Description |
|------|-------------|
| `nexora_comment_add` | Add comment to work item |
| `nexora_comment_list` | List comments |
| `nexora_comment_update` | Edit comment |
| `nexora_comment_delete` | Delete comment |

### Time Tracking (5)
| Tool | Description |
|------|-------------|
| `nexora_timer_start` | Start a timer for a specific work item (concurrent across distinct work items; one optional freelance) |
| `nexora_timer_stop` | Stop a timer scoped by `display_id` (omit to stop the freelance timer) |
| `nexora_timer_status` | List ALL active timers with elapsed time |
| `nexora_time_log` | Manual time entry |
| `nexora_time_summary` | Aggregated time view |

#### Auto-timer on transitions
By default, transitioning a work item INTO `in_progress` auto-starts a timer scoped to that work item, and transitioning OUT (`in_review`, `completed`, `todo`, `backlog`, `wont_do`) auto-stops that work item's timer. Multiple work items can have concurrent timers running.

Opt out by adding to `.nexora.toml`:
```toml
[timer]
auto_track = false
```
Or via env: `NEXORA_TIMER_AUTO_TRACK=false`.

#### Breaking changes (vs. pre-PM-51 versions)
- `nexora_timer_status` now returns a **list** of active timers (was a single object). When nothing is running, returns "No active timers."
- `nexora_timer_stop` now accepts an optional `display_id` argument; omitting it targets the freelance timer specifically (not "any active timer"). Pair with the new karya backend that requires `work_item_id` in the stop request body.

### Projects + Streams (7)
| Tool | Description |
|------|-------------|
| `nexora_project_show` | Show project details |
| `nexora_project_list` | List all projects |
| `nexora_project_switch` | Switch active project context |
| `nexora_project_stats` | Work item counts + progress |
| `nexora_stream_list` | List work streams |
| `nexora_stream_create` | Create stream |
| `nexora_stream_show` | Show stream details |

### Search + Activity (3)
| Tool | Description |
|------|-------------|
| `nexora_search` | Full-text search across project |
| `nexora_activity` | Recent activity feed |
| `nexora_my_assignments` | My work items across projects |

### Utility (2)
| Tool | Description |
|------|-------------|
| `nexora_context` | Connection status + project info |
| `nexora_quickstart` | Workflow guide |

## Slash Commands

| Command | Description |
|---------|-------------|
| `/nexora:prime` | Load full session context in one shot (project, assignments, ready items, activity, memories) |
| `/nexora:ready` | Find unblocked work items |
| `/nexora:start <ID>` | Start task (transition + context) |
| `/nexora:done <ID>` | Complete task with summary |
| `/nexora:status` | Project overview |
| `/nexora:plan` | Break down feature into work items |
| `/nexora:timer` | Manage timer (start/stop/status) |
| `/nexora:switch <CODE>` | Switch active project |
| `/nexora:search <query>` | Search work items |
| `/nexora:my` | Show my assignments |

## Persistent Agent Memory

Agents can store project insights in Nexora and retrieve them automatically at session start via `/nexora:prime`.

> **Security**: never store secrets, tokens, passwords, or PII in memory items — use your secrets manager for those. Memory items are marked internal-only but are still stored in Nexora's database.

### Storing an insight

```
nexora_work_item_create
  type=task
  title="MEMORY:<slug>"
  tags="memory"
  is_internal=true
  description="<insight text>"
```

**Slug convention**: lowercase, `[a-z0-9-]` only, hyphens as separators, max 40 characters. Examples: `MEMORY:auth-token-expiry`, `MEMORY:db-pool-size`, `MEMORY:rate-limit-window`.

**Upsert**: before creating, search for an existing item with the same title (case-insensitive exact match). If found, update it in place — concurrent agents writing the same slug would otherwise create conflicting duplicates.

```
nexora_search query="MEMORY:<slug>"   # check before creating
```

### Retrieving memories

`/nexora:prime` surfaces memory items automatically in the **Memories** section. You can also search directly:

```
nexora_search query="MEMORY:"
```

Note: the search may return items that mention `MEMORY:` in their description, not just the title. Verify the `title` starts with `MEMORY:` before treating a result as a stored memory.

### Lifecycle

Memory items are regular work items scoped to the active project. Retire stale ones:

- `nexora_work_item_transition status=completed` — insight is superseded or no longer relevant (preserves history)
- `nexora_work_item_transition status=wont_do` — insight was incorrect or never valid (marks as discarded)

### vs MEMORY.md

| | `MEMORY.md` | Nexora memories |
|--|--|--|
| **Purpose** | Session gaps log — where clarification failed, so next session avoids the same mistake | Project insights — facts discovered during implementation (timeouts, constraints, gotchas) |
| **Written by** | Workflow self-improvement loop (Phase 7 memory delta) | Any agent, any phase |
| **Retrieved by** | Claude reads at Phase 0 start | `/nexora:prime` → Memories section |

Both are complementary — use both.

## Architecture

```
Claude Code --> MCP Server (TypeScript) --> HTTP --> Nexora REST API --> PostgreSQL
```

The MCP server is a stateless HTTP client — no local database, no business logic duplication. All data lives in the Nexora backend.

## Development

```bash
cd mcp-server
pnpm install
pnpm build        # esbuild bundle to dist/index.js
pnpm dev          # tsc --watch (type checking)
pnpm typecheck    # one-shot type check
```

## License

MIT
