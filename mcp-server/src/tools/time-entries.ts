import { z } from 'zod';

import type { NexoraClient } from '../client.js';
import type { TimeEntry } from '../types.js';
import { errorResult, toolResult } from './helpers.js';

function formatHoursMinutes(totalMins: number): string {
  const m = Math.max(0, Math.floor(totalMins));
  const hrs = Math.floor(m / 60);
  return hrs > 0 ? `${hrs}h ${m % 60}m` : `${m}m`;
}

// PM-418: a TimeEntry returned by /my-active-timers can be in three states:
//   - is_running=true                              -> actively counting
//   - is_running=false, paused_at!=null, !ended_at -> paused, snapshot accumulated_minutes
//   - is_running=false, ended_at!=null             -> finalized (also: history rows)
// Old formatter labelled all three with `running since ${started_at}` or just
// `${duration_minutes}m`, conflating paused with running and showing 0m for
// pending pauses. Approval status was always shown, but for in-flight
// (running/paused) entries it's always "pending" and adds visual noise that
// looked like a state flag. We now drop approval_status from the in-flight
// path and only render it for finalized entries.
function formatTimeEntry(e: TimeEntry): string {
  const billable = e.is_billable ? 'billable' : 'non-billable';
  // Sanitize user-controlled description so newlines and pipe characters
  // don't break the table-like single-line output (Codex review #4).
  const desc = (e.description ?? '(no description)').replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|');
  if (e.is_running) {
    return `${e.date} | running since ${e.started_at?.slice(11, 16) ?? '?'} | ${billable} | ${desc}`;
  }
  if (e.paused_at && !e.ended_at) {
    return `${e.date} | paused since ${e.paused_at.slice(11, 16)} | ${billable} | ${desc}`;
  }
  return `${e.date} | ${formatHoursMinutes(e.duration_minutes)} | ${billable} | ${desc} | ${e.approval_status}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerTimeEntryTools(server: any, client: NexoraClient): void {
  // 1. START TIMER
  server.registerTool(
    'nexora_timer_start',
    {
      title: 'Start Timer',
      description: 'Start a time tracking timer. Only one timer can be active at a time.',
      inputSchema: {
        display_id: z.string().optional().describe('Work item display ID to track time against (e.g., PM-42)'),
        description: z.string().optional().describe('What you are working on'),
      },
    },
    async ({ display_id, description }: { display_id?: string; description?: string }) => {
      try {
        const projectId = await client.requireProjectId();

        let workItemId: string | undefined;
        if (display_id) {
          workItemId = await client.resolveDisplayId(display_id, projectId);
        }

        const entry = await client.post<TimeEntry>('/time-entries/timer/start', {
          project_id: projectId,
          work_item_id: workItemId,
          description,
        });

        const target = display_id ? ` on ${display_id}` : '';
        return toolResult(`Timer started${target}\n${formatTimeEntry(entry)}\nid: ${entry.id}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 2. STOP TIMER
  server.registerTool(
    'nexora_timer_stop',
    {
      title: 'Stop Timer',
      description:
        'Stop a running timer scoped to a specific work item. Omit display_id to stop the freelance (no work item) timer.',
      inputSchema: {
        display_id: z
          .string()
          .optional()
          .describe('Work item display ID (e.g., PM-42). Omit to stop the freelance timer.'),
      },
    },
    async ({ display_id }: { display_id?: string }) => {
      try {
        let workItemId: string | null = null;
        if (display_id) {
          const projectId = await client.requireProjectId();
          workItemId = await client.resolveDisplayId(display_id, projectId);
        }

        const entry = await client.post<TimeEntry>('/time-entries/timer/stop', {
          work_item_id: workItemId,
        });
        const target = display_id ? ` for ${display_id}` : ' (freelance)';
        return toolResult(`Timer stopped${target}: ${entry.duration_minutes}m logged\n${formatTimeEntry(entry)}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 3. TIMER STATUS — returns all currently running timers
  server.registerTool(
    'nexora_timer_status',
    {
      title: 'Timer Status',
      description:
        'List all currently active timers (running or paused, not yet finalized) for the ' +
        'authenticated user. Returns an empty list when nothing is active.',
      inputSchema: {},
    },
    async () => {
      try {
        const entries = await client.get<TimeEntry[]>('/time-entries/my-active-timers');
        if (!entries || entries.length === 0) {
          return toolResult('No active timers.');
        }

        const lines = [`# Active Timers (${entries.length})`];
        for (const entry of entries) {
          // PM-418: compute elapsed based on activity state, not always
          // now - started_at. Paused timers must NOT have a growing elapsed
          // value — they show the snapshot at pause time
          // (accumulated_minutes).
          let elapsed = 'unknown';
          if (entry.is_running && entry.started_at) {
            const startMs = new Date(entry.started_at).getTime();
            if (Number.isFinite(startMs)) {
              const sinceStartMins = Math.floor((Date.now() - startMs) / 60_000);
              const totalMins = (entry.accumulated_minutes ?? 0) + Math.max(0, sinceStartMins);
              elapsed = `${formatHoursMinutes(totalMins)} (live)`;
            }
          } else if (entry.paused_at && !entry.ended_at) {
            elapsed = `${formatHoursMinutes(entry.accumulated_minutes ?? 0)} (paused)`;
          } else if (entry.duration_minutes > 0) {
            elapsed = formatHoursMinutes(entry.duration_minutes);
          }
          const scope = entry.work_item_id
            ? `work_item ${entry.work_item_id.slice(0, 8)}…`
            : 'freelance';
          lines.push(`- ${scope} | elapsed: ${elapsed} | ${formatTimeEntry(entry)} | id: ${entry.id}`);
        }
        return toolResult(lines.join('\n'));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 4. LOG TIME (manual entry)
  server.registerTool(
    'nexora_time_log',
    {
      title: 'Log Time',
      description: 'Log a manual time entry (not using the timer).',
      inputSchema: {
        duration_minutes: z.number().min(1).describe('Duration in minutes'),
        display_id: z.string().optional().describe('Work item display ID (e.g., PM-42)'),
        date: z.string().optional().describe('Date (YYYY-MM-DD, defaults to today)'),
        description: z.string().optional().describe('What was done'),
        is_billable: z.boolean().default(true).describe('Whether this time is billable'),
      },
    },
    async ({ duration_minutes, display_id, date, description, is_billable }: {
      duration_minutes: number; display_id?: string; date?: string;
      description?: string; is_billable: boolean;
    }) => {
      try {
        const projectId = await client.requireProjectId();

        let workItemId: string | undefined;
        if (display_id) {
          workItemId = await client.resolveDisplayId(display_id, projectId);
        }

        const entryDate = date ?? new Date().toISOString().slice(0, 10);

        const entry = await client.post<TimeEntry>(
          `/projects/${encodeURIComponent(projectId)}/time-entries`,
          {
            project_id: projectId,
            work_item_id: workItemId,
            date: entryDate,
            duration_minutes,
            description,
            is_billable,
          },
        );

        const target = display_id ? ` on ${display_id}` : '';
        return toolResult(`Logged ${duration_minutes}m${target}\n${formatTimeEntry(entry)}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 5. TIME SUMMARY
  server.registerTool(
    'nexora_time_summary',
    {
      title: 'Time Summary',
      description: 'Show time entries for the active project, optionally filtered by date range.',
      inputSchema: {
        date_from: z.string().optional().describe('Start date (YYYY-MM-DD)'),
        date_to: z.string().optional().describe('End date (YYYY-MM-DD)'),
        limit: z.number().min(1).max(100).default(50).describe('Max entries'),
      },
    },
    async ({ date_from, date_to, limit }: { date_from?: string; date_to?: string; limit: number }) => {
      try {
        const projectId = await client.requireProjectId();

        const query: Record<string, string> = { limit: String(limit) };
        if (date_from) query.date_from = date_from;
        if (date_to) query.date_to = date_to;

        const result = await client.get<{ items: TimeEntry[]; total: number }>(
          `/projects/${encodeURIComponent(projectId)}/time-entries`,
          query,
        );

        if (result.items.length === 0) {
          return toolResult('No time entries found for the given period.');
        }

        const totalMinutes = result.items.reduce((sum, e) => sum + (e.duration_minutes ?? 0), 0);
        const hrs = Math.floor(totalMinutes / 60);
        const mins = totalMinutes % 60;

        const lines = [
          `# Time Summary (${result.items.length} of ${result.total} entries)`,
          `total: ${hrs}h ${mins}m`,
          '',
          ...result.items.map(formatTimeEntry),
        ];

        return toolResult(lines.join('\n'));
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
