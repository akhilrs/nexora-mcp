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
2. Call `nexora_timer_status` to check for active timer — if one is running, ask to stop it first
3. Call `nexora_work_item_transition` to set status to `in_progress`
4. Call `nexora_timer_start` with the display ID to begin tracking time
4. Call `nexora_dep_list` to check for any dependencies
5. Call `nexora_comment_list` for prior context/decisions
6. Display summary: title, description, dependencies, comments, timer started
