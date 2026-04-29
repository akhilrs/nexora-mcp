#!/usr/bin/env node
// Nexora MCP Stop hook — anomaly-only guard.
//
// Replaces the older prompt-type Stop hook that nagged on every assistant turn.
// This script:
//   • reads NEXORA_API_KEY / NEXORA_API_URL / NEXORA_ORG_ID from env
//   • GETs /time-entries/my-active-timers
//   • if any timer is running, emits an additionalContext block instructing the
//     model to ask the user about stopping it / checkpointing the work item
//   • otherwise exits 0 silently
//
// Fails open on every error (network, auth, JSON parse) — the hook must never
// block the user, only surface state when it's anomalous.
//
// Stdin (Claude Code passes the hook payload as JSON) is ignored — we only need
// the runtime env.
//
// Output: a single JSON document on stdout per the Claude Code hook contract
// when context should be injected. Otherwise no output.

const TIMEOUT_MS = 4_000;

function exitSilently() {
  process.exit(0);
}

async function main() {
  const apiKey = process.env.NEXORA_API_KEY;
  const apiUrl = (process.env.NEXORA_API_URL ?? '').replace(/\/+$/, '');
  const orgId = process.env.NEXORA_ORG_ID;

  if (!apiKey || !apiUrl || !orgId) exitSilently();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let entries = [];
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
    if (!response.ok) exitSilently();
    const data = await response.json();
    entries = Array.isArray(data) ? data : [];
  } catch {
    exitSilently();
  } finally {
    clearTimeout(timer);
  }

  if (entries.length === 0) exitSilently();

  const summary = entries
    .map((e) => {
      const scope = e.work_item_id
        ? `work_item ${String(e.work_item_id).slice(0, 8)}…`
        : 'freelance';
      return scope;
    })
    .join(', ');

  const payload = {
    hookSpecificOutput: {
      hookEventName: 'Stop',
      additionalContext:
        `Nexora has ${entries.length} active timer(s) (${summary}). ` +
        `Before ending the session, ask the user whether to stop them and ` +
        `whether to add a checkpoint comment summarizing progress on any ` +
        `in_progress work items. Do NOT auto-stop or auto-complete; just prompt.`,
    },
  };

  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

main().catch(() => exitSilently());
