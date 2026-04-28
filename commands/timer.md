---
name: nexora:timer
description: Manage time tracking timer
---

Check, start, or stop the time tracking timer.

## Arguments

- `$ARGUMENTS`: Optional — "start PM-42", "stop", or empty for status

## Execution

If no arguments or "status":
1. Call `nexora_timer_status` to show current timer

If "start" with optional display ID:
1. Call `nexora_timer_start` with the display ID

If "stop":
1. Call `nexora_timer_stop`
2. Show the logged duration
