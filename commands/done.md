---
name: nexora:done
description: Complete a task with summary
---

Complete a work item — stop timer, add summary comment, transition to completed.

## Arguments

- `$ARGUMENTS`: Work item display ID (e.g., PM-42)

If no display ID provided, call `nexora_work_item_list` with status=in_progress and ask which to complete.

## CRITICAL: Summary comment is mandatory

Never complete without a summary. Good summaries include:
- What was done (specific changes)
- Files modified
- Decisions made
- Any follow-up tasks identified

## Execution

1. Ask for or generate a completion summary
2. Call `nexora_activity_add` with activity_type `completed`, title "Task completed", and content with the structured summary
3. Call `nexora_comment_add` with a human-readable completion note (content: "Completed: <summary>")
4. Call `nexora_work_item_transition` to set status to `completed` — this auto-stops the work item's timer when `[timer] auto_track` is enabled (default). No separate `nexora_timer_stop` call needed.
5. Call `nexora_work_item_ready` to show what's unblocked next

If `[timer] auto_track = false` in `.nexora.toml`, call `nexora_timer_stop` with the display ID before the transition to log the time manually.
