---
name: nexora:status
description: Show project status overview
---

Show current project status: active items, timer, stats.

## Execution

1. Call `nexora_context` to show connection info
2. Call `nexora_timer_status` to check for active timer
3. Call `nexora_work_item_list` with status=in_progress to show active work
4. Call `nexora_project_stats` for overall progress
5. Display a compact summary of all the above
