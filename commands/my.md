---
name: nexora:my
description: Show my assignments across projects
---

Show work items assigned to the current user, optionally across all projects.

## Execution

1. Call `nexora_work_item_list` with assigned_to_id filter (from current auth context)
2. Group by status: in_progress first, then todo, then in_review
3. Display compact list with display_id, status, priority, title
4. If items are in_progress, highlight them as "currently working on"

Note: Cross-project assignments require the backend /my/assignments endpoint (TREK-126).
For now, this shows assignments in the active project only.
