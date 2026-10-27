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
Steps 3 and 4 are read-only and independent of the transition: issue `nexora_dep_list` and `nexora_comment_list` in the same message (parallel), and `nexora_work_item_show` from step 1 may be sent together with them. The transition in step 2 stays its own call.

3. Call `nexora_dep_list` to check for any dependencies
4. Call `nexora_comment_list` for prior context/decisions
5. Display summary: title, description, dependencies, comments, timer state from the transition response

To start several items at once, use `nexora_work_item_batch_update` with `status=in_progress` and the list of display IDs.

If `[timer] auto_track = false` in `.nexora.toml`, call `nexora_timer_start` with the display ID after the transition to start tracking manually.
