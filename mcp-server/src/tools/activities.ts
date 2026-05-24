import { z } from 'zod';

import type { NexoraClient } from '../client.js';
import type { WorkItemActivity } from '../types.js';
import { errorResult, toolResult } from './helpers.js';

function formatActivity(a: WorkItemActivity): string {
  const date = a.created_at?.slice(0, 16).replace('T', ' ') ?? '';
  const source = a.agent_name ? `${a.source}/${a.agent_name}` : a.source;
  return `[${date}] [${a.activity_type}] (${source}) ${a.title}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerActivityTools(server: any, client: NexoraClient): void {
  // 1. ADD ACTIVITY
  server.registerTool(
    'nexora_activity_add',
    {
      title: 'Add Activity',
      description: 'Add a workflow activity entry to a work item (separate from comments). Use for phase tracking: clarify, classify, design_plan, plan_review, code_review, ac_check, memory_delta, completed, status_change, custom.',
      inputSchema: {
        display_id: z.string().describe('Work item display ID (e.g., PM-42)'),
        activity_type: z.string().describe('Activity type: clarify, classify, explore, design_plan, plan_review, code_review, ac_check, memory_delta, status_change, completed, custom'),
        title: z.string().describe('Short summary (e.g., "Plan Review — PASS")'),
        content: z.string().optional().describe('Full details (markdown supported)'),
        source: z.string().default('agent').describe('Source: agent, human, system'),
        agent_name: z.string().optional().describe('Agent name (e.g., claude, codex, gemini)'),
        extra_data: z.record(z.unknown()).optional().describe('Structured metadata (JSON object)'),
      },
    },
    async ({ display_id, activity_type, title, content, source, agent_name, extra_data }: {
      display_id: string;
      activity_type: string;
      title: string;
      content?: string;
      source: string;
      agent_name?: string;
      extra_data?: Record<string, unknown>;
    }) => {
      try {
        const projectId = await client.requireProjectId();
        const itemUuid = await client.resolveDisplayId(display_id, projectId);

        const activity = await client.post<WorkItemActivity>(
          client.workItemsPath(projectId, itemUuid, 'activities'),
          {
            activity_type,
            title,
            content: content ?? null,
            source,
            agent_name: agent_name ?? null,
            extra_data: extra_data ?? null,
          },
        );

        return toolResult(`Activity added to ${display_id}:\n${formatActivity(activity)}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 2. LIST ACTIVITIES
  server.registerTool(
    'nexora_activity_list',
    {
      title: 'List Activities',
      description: 'List workflow activity entries on a work item. Content is truncated to 200 chars per entry — use nexora_activity_show with the entry id for full content.',
      inputSchema: {
        display_id: z.string().describe('Work item display ID (e.g., PM-42)'),
        activity_type: z.string().optional().describe('Filter by type (e.g., code_review)'),
        limit: z.number().min(1).max(100).default(20).describe('Max entries to return'),
      },
    },
    async ({ display_id, activity_type, limit }: { display_id: string; activity_type?: string; limit: number }) => {
      try {
        const projectId = await client.requireProjectId();
        const itemUuid = await client.resolveDisplayId(display_id, projectId);

        const params: Record<string, string> = { limit: String(limit) };
        if (activity_type) params.activity_type = activity_type;

        const activities = await client.get<WorkItemActivity[]>(
          client.workItemsPath(projectId, itemUuid, 'activities'),
          params,
        );

        if (activities.length === 0) {
          return toolResult(`No activities on ${display_id}.`);
        }

        const lines = [`# Activities on ${display_id} (${activities.length})`, ''];
        for (const a of activities) {
          lines.push(formatActivity(a));
          if (a.content) {
            lines.push(`  ${a.content.slice(0, 200)}${a.content.length > 200 ? '...' : ''}`);
          }
          lines.push(`  id: ${a.id}`);
        }

        return toolResult(lines.join('\n'));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 3. SHOW ACTIVITY (full content, no truncation)
  server.registerTool(
    'nexora_activity_show',
    {
      title: 'Show Activity',
      description: 'Show a single workflow activity entry by id, returning the FULL content (no truncation). Use when nexora_activity_list previews are cut off at 200 chars and you need the complete body of a specific activity (e.g. a long code-review or retrospective entry).',
      inputSchema: {
        display_id: z.string().describe('Work item display ID (e.g., PM-42)'),
        activity_id: z.string().uuid().describe('Activity UUID (from nexora_activity_list output)'),
        include_extra_data: z.boolean().default(true).describe('Include the extra_data JSON block in the response. Default true. Set false when extra_data may contain noise or sensitive metadata you do not want surfaced.'),
      },
    },
    async ({ display_id, activity_id, include_extra_data }: { display_id: string; activity_id: string; include_extra_data: boolean }) => {
      try {
        const projectId = await client.requireProjectId();
        const itemUuid = await client.resolveDisplayId(display_id, projectId);

        const activity = await client.get<WorkItemActivity>(
          client.workItemsPath(projectId, itemUuid, 'activities', activity_id),
        );

        const lines = [
          `# Activity ${activity.id} on ${display_id}`,
          '',
          formatActivity(activity),
          '',
        ];
        if (activity.content) {
          lines.push('## Content', '', activity.content);
        }
        if (include_extra_data && activity.extra_data && Object.keys(activity.extra_data).length > 0) {
          lines.push(
            '',
            '## Extra data',
            '',
            '```json',
            JSON.stringify(activity.extra_data, null, 2),
            '```',
          );
        }
        return toolResult(lines.join('\n'));
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
