#!/usr/bin/env node
process.stdout.write(`Nexora: Use the MCP tools to show session context:
1. Call nexora_context to verify connection
2. Call nexora_timer_status to check for active timer
3. Call nexora_work_item_list with status=in_progress to show active work
4. Briefly summarize: active project, in-progress items, timer status

Keep the output concise — 3-5 lines maximum.`.trimEnd());
