import { z } from 'zod';

import type { NexoraClient } from '../client.js';
import type { TimeEntry } from '../types.js';
import { errorResult, toolResult } from './helpers.js';

function formatTimeEntry(e: TimeEntry): string {
  const duration = e.is_running
    ? `running since ${e.started_at?.slice(11, 16) ?? '?'}`
    : `${e.duration_minutes}m`;
  const billable = e.is_billable ? 'billable' : 'non-billable';
  return `${e.date} | ${duration} | ${billable} | ${e.description ?? '(no description)'} | ${e.approval_status}`;
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
      description: 'Stop the currently running timer.',
      inputSchema: {},
    },
    async () => {
      try {
        const entry = await client.post<TimeEntry>('/time-entries/timer/stop');
        return toolResult(`Timer stopped: ${entry.duration_minutes}m logged\n${formatTimeEntry(entry)}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 3. TIMER STATUS
  server.registerTool(
    'nexora_timer_status',
    {
      title: 'Timer Status',
      description: 'Check if a timer is currently running and show elapsed time.',
      inputSchema: {},
    },
    async () => {
      try {
        const entry = await client.get<TimeEntry | null>('/time-entries/my-active-timer');
        if (!entry) {
          return toolResult('No active timer.');
        }

        let elapsed = 'unknown';
        if (entry.started_at) {
          const startMs = new Date(entry.started_at).getTime();
          if (Number.isFinite(startMs)) {
            const elapsedMs = Math.max(0, Date.now() - startMs);
            const mins = Math.floor(elapsedMs / 60_000);
            const hrs = Math.floor(mins / 60);
            elapsed = hrs > 0 ? `${hrs}h ${mins % 60}m` : `${mins}m`;
          }
        }

        return toolResult(
          `# Active Timer\nelapsed: ${elapsed}\n${formatTimeEntry(entry)}\nid: ${entry.id}`,
        );
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
