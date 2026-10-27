---
name: nexora:ready
description: Find tasks ready to work on
---

Find unblocked work items ready to be worked on.

## Execution

If the user wants to start or re-prioritise several ready items the same way, use `nexora_work_item_batch_update` rather than one call per item. Calls that depend on a previous result stay sequential.

1. Call `nexora_work_item_ready` to get unblocked todo items
2. For each ready item, show: display_id, type, priority, title
3. If items found, ask which one to start working on
4. If user picks one, invoke `/nexora:start <display_id>`
