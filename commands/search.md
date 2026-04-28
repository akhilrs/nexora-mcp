---
name: nexora:search
description: Search work items
---

Search work items in the active project.

## Arguments

- `$ARGUMENTS`: Search query

## Execution

1. Call `nexora_work_item_list` with relevant filters based on the query:
   - If query contains a status word (todo, in_progress, completed), filter by status
   - If query contains a type word (bug, task, story, epic), filter by type
   - Otherwise, list recent items and scan titles
2. Display matching items with display_id, status, type, title
3. Ask if the user wants to see details on any item
