---
name: nexora:plan
description: Create work items from an implementation plan
---

Break down an implementation plan into work items in the active project.

## Arguments

- `$ARGUMENTS`: Description of the plan or feature to break down

## Execution

1. Call `nexora_project_show` to confirm the active project
2. Ask the user to describe the feature/plan (or use $ARGUMENTS)
3. Break the plan into a hierarchy:
   - Create an Epic for the overall feature (nexora_work_item_create type=epic)
   - Create Stories for major components (nexora_work_item_create type=story parent_display_id=<epic>)
   - Create Tasks for specific implementation steps (nexora_work_item_create type=task parent_display_id=<story>)
4. Add dependencies between tasks where order matters (nexora_dep_add)
5. Show the created hierarchy with `nexora_work_item_children` on the epic
6. Show ready items with `nexora_work_item_ready`
