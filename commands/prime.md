---
name: nexora:prime
description: Load full session context in one shot — project, assignments, ready items, activity, and memories
---

Load complete session context before starting work. Call this at the start of any session to orient yourself without making 5 separate tool calls.

## Execution

Call the following tools in order. If any tool call fails, note the error inline under that section and continue — do not abort the whole command.

Record the current time as the `as-of` timestamp before calling any tools.

### 1. Project (nexora_context)

Call `nexora_context`. Show: API URL, organization, project code and name, connection status.

### 2. My Assignments (nexora_my_assignments)

Call `nexora_my_assignments`. Show up to **10 items**, ordered by priority (lowest number = highest priority). For each: display_id, type, priority, status, title.

If the call fails, show: `[My Assignments — unavailable: <error>]`

### 3. Ready Items (nexora_work_item_ready)

Call `nexora_work_item_ready`. Show up to **10 items**, ordered by priority. For each: display_id, type, priority, title.

If the call fails, show: `[Ready Items — unavailable: <error>]`

### 4. Recent Activity (nexora_activity)

Call `nexora_activity` with `limit=10`. Show the 10 most recent events: timestamp, action, entity type, and title or summary. If an event has neither a title nor a summary field, show the entity ID instead.

If the call fails, show: `[Recent Activity — unavailable: <error>]`

### 5. Memories (nexora_search)

Call `nexora_search` with query `"MEMORY:"`. Show up to **5 results**. For each: display_id, title with the `MEMORY:` prefix stripped (case-insensitive, trim surrounding whitespace), content summary.

- If the call returns no results: show `[Memories — none stored]`
- If the call fails: show `[Memories — unavailable: <error>]` (preserve the error for debugging)

## Output Format

Present the results as a structured summary with five labeled sections. Always include the `as-of` timestamp at the top:

```
# Nexora Session Context
as-of: <ISO timestamp>

## Project
<project code> — <project name> | <connection status>

## My Assignments (<N> items)
- <display_id> [<priority>/<status>] <title>
...

## Ready Items (<N> items)
- <display_id> [<priority>] <title>
...

## Recent Activity
- <timestamp> <action> <entity>: <summary>
...

## Memories
- <slug>: <insight>
...
```

Always render all five sections. Never silently drop a section — show the error note if the tool call failed.
