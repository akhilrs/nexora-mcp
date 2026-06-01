#!/usr/bin/env node
// Nexora MCP SubagentStop hook — guarded checkpoint prompt.
//
// Only emits a checkpoint prompt when there is evidence the subagent was
// working on a Nexora item: either an active timer is running, or a
// /tmp/nexora-session-task file was written by the nexora skill/commands.
//
// Fails open on every error — never blocks the subagent from stopping.
//
// Output: a single JSON document on stdout per the Claude Code hook contract
// when a prompt should be injected. Otherwise exits 0 silently.

const TIMEOUT_MS = 3_000;
const SESSION_TASK_FILE = `/tmp/nexora-session-task-${process.env.CLAUDE_SESSION_ID ?? ''}`;

function exitSilently() {
  process.exit(0);
}

async function hasActiveTimer() {
  const apiKey = process.env.NEXORA_API_KEY;
  const apiUrl = (process.env.NEXORA_API_URL ?? '').replace(/\/+$/, '');
  const orgId = process.env.NEXORA_ORG_ID;

  if (!apiKey || !apiUrl || !orgId) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${apiUrl}/time-entries/my-active-timers`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'X-Organization-ID': orgId,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const data = await response.json();
    return Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function hasSessionTaskFile() {
  const { existsSync } = await import('fs');
  if (SESSION_TASK_FILE.endsWith('-') || SESSION_TASK_FILE.endsWith('-undefined')) {
    return false;
  }
  return existsSync(SESSION_TASK_FILE);
}

async function main() {
  const [timerActive, taskFile] = await Promise.all([
    hasActiveTimer(),
    hasSessionTaskFile(),
  ]);

  if (!timerActive && !taskFile) exitSilently();

  const payload = {
    hookSpecificOutput: {
      hookEventName: 'SubagentStop',
      additionalContext:
        'Subagent session ending. You were working on a Nexora work item. ' +
        'Add a checkpoint comment with nexora_comment_add summarizing what ' +
        'was accomplished in this subagent session.',
    },
  };

  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

main().catch(() => exitSilently());
