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

1. Call `nexora_timer_stop` to stop any active timer
2. Ask for or generate a completion summary
3. Call `nexora_comment_add` with the summary (content: "Completed: <summary>")
4. Call `nexora_work_item_transition` to set status to `completed`
5. Call `nexora_work_item_ready` to show what's unblocked next
