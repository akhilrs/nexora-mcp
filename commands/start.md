---
name: nexora:start
description: Start working on a task
---

Start working on a work item — set to in_progress and optionally start a timer.

## Arguments

- `$ARGUMENTS`: Work item display ID (e.g., PM-42)

If no display ID provided, call `nexora_work_item_ready` and ask which to start.

## Execution

1. Call `nexora_work_item_show` with the display ID to get full context
2. Call `nexora_work_item_transition` to set status to `in_progress` — this auto-starts a timer for this work item when `[timer] auto_track` is enabled (default). No separate `nexora_timer_start` call needed.
3. Call `nexora_dep_list` to check for any dependencies
4. Call `nexora_comment_list` for prior context/decisions
5. Display summary: title, description, dependencies, comments, timer state from the transition response

If `[timer] auto_track = false` in `.nexora.toml`, call `nexora_timer_start` with the display ID after the transition to start tracking manually.
