import { z } from 'zod';

import type { NexoraClient } from '../client.js';
import { formatWorkItem, formatWorkItemCompact, formatWorkItemList } from '../formatters.js';
import type { WorkItem } from '../types.js';
import { errorResult, toolResult } from './helpers.js';

function cleanQuery(params: Record<string, string | number | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(params)) {
    if (val != null && val !== '') result[key] = String(val);
  }
  return result;
}

const acceptanceCriterionSchema = z.object({
  criterion: z.string().describe('The acceptance criterion text'),
  testable: z.boolean().default(true).describe('Whether this criterion is testable'),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerWorkItemTools(server: any, client: NexoraClient): void {
  // 1. CREATE
  server.registerTool(
    'nexora_work_item_create',
    {
      title: 'Create Work Item',
      description: 'Create a new work item (task, bug, story, epic, feature) in the active project.',
      inputSchema: {
        title: z.string().describe('Work item title'),
        type: z
          .enum(['task', 'bug', 'story', 'epic', 'feature'])
          .default('task')
          .describe('Item type'),
        description: z.string().optional().describe('Description (markdown)'),
        status: z
          .enum(['backlog', 'todo', 'in_progress', 'in_review', 'completed', 'wont_do'])
          .default('todo')
          .describe('Initial status'),
        priority: z.number().min(0).max(4).default(2).describe('Priority: 0=critical, 4=none'),
        parent_display_id: z.string().optional().describe('Parent work item display ID (e.g., PM-10)'),
        assigned_to_id: z.string().optional().describe('Employee UUID to assign'),
        due_date: z.string().optional().describe('Due date (YYYY-MM-DD)'),
        estimated_hours: z.number().optional().describe('Estimated hours'),
        tags: z.string().optional().describe('Comma-separated tags'),
        stream_id: z.string().optional().describe('Stream UUID'),
        acceptance_criteria: z.array(acceptanceCriterionSchema).optional().describe('Acceptance criteria list'),
      },
    },
    async (params: { title: string; type: string; description?: string; status: string; priority: number; parent_display_id?: string; assigned_to_id?: string; due_date?: string; estimated_hours?: number; tags?: string; stream_id?: string; acceptance_criteria?: Array<{ criterion: string; testable: boolean }> }) => {
      try {
        const projectId = await client.requireProjectId();

        let parentId: string | undefined;
        if (params.parent_display_id) {
          parentId = await client.resolveDisplayId(params.parent_display_id, projectId);
        }

        const assignedToId = params.assigned_to_id ?? await client.resolveCurrentUserId();

        const body: Record<string, unknown> = {
          title: params.title,
          item_type: params.type,
          status: params.status,
          priority: params.priority,
          description: params.description,
          parent_id: parentId,
          assigned_to_id: assignedToId,
          due_date: params.due_date,
          estimated_hours: params.estimated_hours,
          stream_id: params.stream_id,
          tags: params.tags ? params.tags.split(',').map((t: string) => t.trim()) : undefined,
          acceptance_criteria: params.acceptance_criteria,
        };

        const item = await client.post<WorkItem>(client.workItemsPath(projectId), body);
        return toolResult(`Created:\n${formatWorkItem(item)}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 2. LIST
  server.registerTool(
    'nexora_work_item_list',
    {
      title: 'List Work Items',
      description: 'List work items in the active project with optional filters.',
      inputSchema: {
        status: z
          .enum(['backlog', 'todo', 'in_progress', 'in_review', 'completed', 'wont_do'])
          .optional()
          .describe('Filter by status'),
        type: z
          .enum(['task', 'bug', 'story', 'epic', 'feature'])
          .optional()
          .describe('Filter by type'),
        assigned_to_id: z.string().optional().describe('Filter by assignee UUID'),
        stream_id: z.string().optional().describe('Filter by stream UUID'),
        limit: z.number().min(1).max(200).default(50).describe('Results per page'),
        offset: z.number().min(0).default(0).describe('Offset for pagination'),
      },
    },
    async (params: { status?: string; type?: string; assigned_to_id?: string; stream_id?: string; limit: number; offset: number }) => {
      try {
        const projectId = await client.requireProjectId();
        const query = cleanQuery({
          status: params.status,
          item_type: params.type,
          assigned_to_id: params.assigned_to_id,
          stream_id: params.stream_id,
          limit: params.limit,
          offset: params.offset,
        });

        const items = await client.get<WorkItem[]>(client.workItemsPath(projectId), query);
        return toolResult(formatWorkItemList(items));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 3. SHOW
  server.registerTool(
    'nexora_work_item_show',
    {
      title: 'Show Work Item',
      description: 'Show details of a work item by display ID (e.g., PM-42).',
      inputSchema: {
        display_id: z.string().describe('Work item display ID (e.g., PM-42)'),
      },
    },
    async ({ display_id }: { display_id: string }) => {
      try {
        const projectId = await client.requireProjectId();
        const item = await client.get<WorkItem>(
          client.workItemsPath(projectId, display_id),
        );
        return toolResult(formatWorkItem(item));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 4. UPDATE
  server.registerTool(
    'nexora_work_item_update',
    {
      title: 'Update Work Item',
      description: 'Update fields on a work item. Only provided fields are changed.',
      inputSchema: {
        display_id: z.string().describe('Work item display ID (e.g., PM-42)'),
        title: z.string().optional().describe('New title'),
        description: z.string().optional().describe('New description'),
        status: z
          .enum(['backlog', 'todo', 'in_progress', 'in_review', 'completed', 'wont_do'])
          .optional()
          .describe('New status'),
        priority: z.number().min(0).max(4).optional().describe('New priority'),
        assigned_to_id: z.string().optional().describe('New assignee UUID'),
        due_date: z.string().optional().describe('New due date (YYYY-MM-DD)'),
        estimated_hours: z.number().optional().describe('New estimated hours'),
        tags: z.string().optional().describe('New comma-separated tags'),
        stream_id: z.string().optional().describe('New stream UUID'),
        acceptance_criteria: z.array(acceptanceCriterionSchema).optional().describe('New acceptance criteria list'),
      },
    },
    async (params: { display_id: string; title?: string; description?: string; status?: string; priority?: number; assigned_to_id?: string; due_date?: string; estimated_hours?: number; tags?: string; stream_id?: string; acceptance_criteria?: Array<{ criterion: string; testable: boolean }> }) => {
      try {
        const projectId = await client.requireProjectId();
        const uuid = await client.resolveDisplayId(params.display_id, projectId);

        const body: Record<string, unknown> = {};
        if (params.title !== undefined) body.title = params.title;
        if (params.description !== undefined) body.description = params.description;
        if (params.status !== undefined) body.status = params.status;
        if (params.priority !== undefined) body.priority = params.priority;
        if (params.assigned_to_id !== undefined) body.assigned_to_id = params.assigned_to_id;
        if (params.due_date !== undefined) body.due_date = params.due_date;
        if (params.estimated_hours !== undefined) body.estimated_hours = params.estimated_hours;
        if (params.stream_id !== undefined) body.stream_id = params.stream_id;
        if (params.tags !== undefined) {
          body.tags = params.tags.split(',').map((t: string) => t.trim());
        }
        if (params.acceptance_criteria !== undefined) {
          body.acceptance_criteria = params.acceptance_criteria;
        }

        const item = await client.patch<WorkItem>(client.workItemsPath(projectId, uuid), body);
        return toolResult(`Updated:\n${formatWorkItem(item)}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 5. DELETE
  server.registerTool(
    'nexora_work_item_delete',
    {
      title: 'Delete Work Item',
      description: 'Mark a work item as "won\'t do" (soft delete).',
      inputSchema: {
        display_id: z.string().describe('Work item display ID (e.g., PM-42)'),
      },
    },
    async ({ display_id }: { display_id: string }) => {
      try {
        const projectId = await client.requireProjectId();
        const uuid = await client.resolveDisplayId(display_id, projectId);
        await client.delete(client.workItemsPath(projectId, uuid));
        return toolResult(`Deleted: ${display_id} (marked as wont_do)`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 6. READY
  server.registerTool(
    'nexora_work_item_ready',
    {
      title: 'Ready Work Items',
      description:
        'Show work items that are "todo" with all blocking dependencies completed. ' +
        'These are the items ready to be worked on next.',
      inputSchema: {},
    },
    async () => {
      try {
        const projectId = await client.requireProjectId();
        const items = await client.get<WorkItem[]>(
          client.workItemsPath(projectId, 'ready'),
        );
        if (items.length === 0) {
          return toolResult('No ready items — all todo items have incomplete dependencies.');
        }
        return toolResult(
          `# Ready Items (${items.length})\n` +
            items.map((i) => formatWorkItemCompact(i)).join('\n'),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 7. CHILDREN
  server.registerTool(
    'nexora_work_item_children',
    {
      title: 'List Children',
      description: 'List child work items of a parent (e.g., stories under an epic).',
      inputSchema: {
        parent_display_id: z.string().describe('Parent work item display ID (e.g., PM-10)'),
      },
    },
    async ({ parent_display_id }: { parent_display_id: string }) => {
      try {
        const projectId = await client.requireProjectId();
        const parentUuid = await client.resolveDisplayId(parent_display_id, projectId);
        const items = await client.get<WorkItem[]>(
          client.workItemsPath(projectId),
          { parent_id: parentUuid },
        );
        if (items.length === 0) {
          return toolResult(`No children found for ${parent_display_id}.`);
        }
        return toolResult(
          `# Children of ${parent_display_id} (${items.length})\n` +
            items.map((i) => formatWorkItemCompact(i)).join('\n'),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 8. TRANSITION
  server.registerTool(
    'nexora_work_item_transition',
    {
      title: 'Transition Work Item',
      description: 'Change the status of a work item (shorthand for update with status only).',
      inputSchema: {
        display_id: z.string().describe('Work item display ID (e.g., PM-42)'),
        status: z
          .enum(['backlog', 'todo', 'in_progress', 'in_review', 'completed', 'wont_do'])
          .describe('New status'),
      },
    },
    async ({ display_id, status }: { display_id: string; status: string }) => {
      try {
        const projectId = await client.requireProjectId();
        const uuid = await client.resolveDisplayId(display_id, projectId);
        const item = await client.patch<WorkItem>(
          client.workItemsPath(projectId, uuid),
          { status },
        );
        return toolResult(`${display_id}: ${status}\n${formatWorkItemCompact(item)}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
