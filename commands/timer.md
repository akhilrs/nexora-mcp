---
name: nexora:timer
description: Manage time tracking timer
---

Check, start, or stop the time tracking timer.

## Arguments

- `$ARGUMENTS`: Optional — "start PM-42", "stop", or empty for status

## Execution

If no arguments or "status":
1. Call `nexora_timer_status` to list ALL currently running timers (one per work item, plus optional freelance). Returns an empty list when nothing is running.

If "start" with optional display ID:
1. Call `nexora_timer_start` with the display ID. Multiple timers can run concurrently as long as each is for a distinct work item; one freelance (no work item) timer is also allowed. Auto-timer normally handles this on transition — only call this directly to override or for freelance work.

If "stop" with optional display ID:
1. Call `nexora_timer_stop` with the display ID to stop that specific timer. Omit `display_id` to stop the freelance timer.
2. Show the logged duration
