---
name: nexora:switch
description: Switch active project
---

Switch the active project context for all subsequent Nexora MCP operations.

## Arguments

- `$ARGUMENTS`: Project code (e.g., PRJ-001)

If no project code provided:
1. Call `nexora_project_list` to show available projects
2. Ask which project to switch to

## Execution

1. Call `nexora_project_switch` with the project code
2. Call `nexora_project_show` to confirm the switch
3. Call `nexora_project_stats` for a quick overview
