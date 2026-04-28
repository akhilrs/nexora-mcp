# Nexora MCP

Claude Code plugin for [Nexora HRM](https://github.com/akhilrs/nexora) — Project Management agent integration.

Manage work items, dependencies, comments, time tracking, and projects directly from Claude Code via MCP tools.

## Quick Start

### 1. Install the plugin

```bash
claude plugin add akhilrs/nexora-mcp
```

### 2. Configure

Set environment variables:

```bash
export NEXORA_API_URL="http://localhost:8000/api/v1"
export NEXORA_API_KEY="nxr_your_api_key_here"
export NEXORA_ORG_ID="your-organization-uuid"
export NEXORA_PROJECT_CODE="PRJ-001"  # optional default project
```

Or create `~/.config/nexora-mcp/config.json`:

```json
{
  "api_url": "http://localhost:8000/api/v1",
  "api_key": "nxr_your_api_key_here",
  "organization_id": "your-org-uuid",
  "default_project_code": "PRJ-001"
}
```

### 3. Create an API key

In the Nexora web UI (admin), go to Settings > API Keys and create a new agent key.

### 4. Use it

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
| `nexora_timer_start` | Start timer (one at a time) |
| `nexora_timer_stop` | Stop active timer |
| `nexora_timer_status` | Check active timer + elapsed |
| `nexora_time_log` | Manual time entry |
| `nexora_time_summary` | Aggregated time view |

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

### Utility (2)
| Tool | Description |
|------|-------------|
| `nexora_context` | Connection status + project info |
| `nexora_quickstart` | Workflow guide |

## Slash Commands (9)

| Command | Description |
|---------|-------------|
| `/nexora:ready` | Find unblocked work items |
| `/nexora:start <ID>` | Start task (transition + timer + context) |
| `/nexora:done <ID>` | Complete task (stop timer + summary + transition) |
| `/nexora:status` | Project overview |
| `/nexora:plan` | Break down feature into work items |
| `/nexora:timer` | Manage timer (start/stop/status) |
| `/nexora:switch <CODE>` | Switch active project |
| `/nexora:search <query>` | Search work items |
| `/nexora:my` | Show my assignments |

## Architecture

```
Claude Code --> MCP Server (TypeScript) --> HTTP --> Nexora REST API --> PostgreSQL
```

The MCP server is a stateless HTTP client — no local database, no business logic duplication. All data lives in the Nexora backend.

## Development

```bash
cd mcp-server
npm install
npm run build        # esbuild bundle to dist/index.js
npm run dev          # tsc --watch (type checking)
npm run typecheck    # one-shot type check
```

## License

MIT
