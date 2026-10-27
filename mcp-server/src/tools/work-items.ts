import { z } from 'zod';

import { isBulkContractError, type NexoraClient } from '../client.js';
import { getConfig } from '../config.js';
import { NexoraApiError } from '../errors.js';
import {
  formatBatchOutcomeTable,
  formatWorkItem,
  formatWorkItemCompact,
  formatWorkItemList,
  type BatchOutcomeRow,
} from '../formatters.js';
import type { BulkCommentItem, BulkUpdateBody, TimeEntry, WorkItem } from '../types.js';
import { errorResult, toolResult } from './helpers.js';

function cleanQuery(params: Record<string, string | number | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(params)) {
    if (val != null && val !== '') result[key] = String(val);
  }
  return result;
}

/**
 * Auto-start/stop a timer when a work item transitions in or out of `in_progress`.
 *
 * - oldStatus ≠ in_progress AND newStatus = in_progress → start timer for this work item
 * - oldStatus = in_progress AND newStatus ≠ in_progress → stop the work item's timer
 * - same status → no-op
 *
 * Timer side-effects must never block or fail the parent transition; this helper
 * always returns an outcome string and never throws.
 */
async function applyAutoTimer(
  client: NexoraClient,
  projectId: string,
  workItemId: string,
  oldStatus: string,
  newStatus: string,
): Promise<string | null> {
  let autoTrack = true;
  try {
    autoTrack = getConfig().timerAutoTrack;
  } catch {
    return null;
  }
  if (!autoTrack) return null;
  if (oldStatus === newStatus) return null;

  const enteringInProgress = oldStatus !== 'in_progress' && newStatus === 'in_progress';
  const leavingInProgress = oldStatus === 'in_progress' && newStatus !== 'in_progress';

  if (!enteringInProgress && !leavingInProgress) return null;

  try {
    if (enteringInProgress) {
      const entry = await client.post<TimeEntry>('/time-entries/timer/start', {
        project_id: projectId,
        work_item_id: workItemId,
      });
      return `auto-timer: started (${entry.id})`;
    }
    await client.post<TimeEntry>('/time-entries/timer/stop', {
      work_item_id: workItemId,
    });
    return 'auto-timer: stopped';
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `auto-timer: skipped — ${msg}`;
  }
}

const BATCH_MAX_IDS = 100;
const BATCH_PAGE_SIZE = 200;
const BATCH_MAX_PAGES = 5;

/**
 * Map the requested display IDs to work items by paging the project list (at most
 * BATCH_MAX_PAGES pages of BATCH_PAGE_SIZE, stopping as soon as every ID is found).
 * The list endpoint shows active OR archived items, never both, so IDs missing from
 * the active listing get a second pass with show_archived=true.
 */
async function resolveBatchItems(
  client: NexoraClient,
  projectId: string,
  displayIds: string[],
): Promise<Map<string, WorkItem>> {
  const wanted = new Set(displayIds.map((d) => d.toUpperCase()));
  const found = new Map<string, WorkItem>();
  for (const showArchived of [false, true]) {
    if (found.size === wanted.size) break;
    for (let page = 0; page < BATCH_MAX_PAGES; page++) {
      const items = await client.get<WorkItem[]>(
        client.workItemsPath(projectId),
        cleanQuery({
          limit: BATCH_PAGE_SIZE,
          offset: page * BATCH_PAGE_SIZE,
          show_archived: showArchived ? 'true' : undefined,
        }),
      );
      for (const item of items) {
        const key = item.display_id.toUpperCase();
        if (wanted.has(key) && !found.has(key)) found.set(key, item);
      }
      if (items.length < BATCH_PAGE_SIZE || found.size === wanted.size) break;
    }
  }
  return found;
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
        assigned_to_id: z.string().optional().describe('User UUID to assign (defaults to the current user; your UUID is shown by nexora_context)'),
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
        assigned_to_id: z.string().optional().describe('Filter by assignee user UUID'),
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
        assigned_to_id: z.string().optional().describe('New assignee user UUID (see nexora_context for your own)'),
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

        // When status changes we need the old status for auto-timer — fetch the
        // full item. For status-less updates the cached resolveDisplayId path
        // is fine.
        let uuid: string;
        let oldStatus: string | null = null;
        if (params.status !== undefined) {
          const current = await client.get<WorkItem>(
            client.workItemsPath(projectId, params.display_id),
          );
          uuid = current.id;
          oldStatus = current.status;
        } else {
          uuid = await client.resolveDisplayId(params.display_id, projectId);
        }

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

        let timerNote: string | null = null;
        if (params.status !== undefined && oldStatus !== null) {
          timerNote = await applyAutoTimer(client, projectId, uuid, oldStatus, item.status);
        }
        const suffix = timerNote ? `\n${timerNote}` : '';
        return toolResult(`Updated:\n${formatWorkItem(item)}${suffix}`);
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

        // Single GET to fetch UUID + current status; same round-trip as resolveDisplayId.
        const current = await client.get<WorkItem>(
          client.workItemsPath(projectId, display_id),
        );
        const uuid = current.id;
        const oldStatus = current.status;

        const item = await client.patch<WorkItem>(
          client.workItemsPath(projectId, uuid),
          { status },
        );

        const timerNote = await applyAutoTimer(client, projectId, uuid, oldStatus, item.status);
        const suffix = timerNote ? `\n${timerNote}` : '';
        return toolResult(`${display_id}: ${status}\n${formatWorkItemCompact(item)}${suffix}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 9. BATCH UPDATE
  server.registerTool(
    'nexora_work_item_batch_update',
    {
      title: 'Batch Update Work Items',
      description:
        'Apply the SAME change (status, priority, assignee and/or one comment) to up to 100 work items ' +
        'in the active project in one call; returns a per-item outcome table. Use it instead of many ' +
        'nexora_work_item_transition / nexora_work_item_update / nexora_comment_add calls with identical values. ' +
        'Items with different values, or calls that depend on each other, stay separate calls.',
      inputSchema: {
        ids: z
          .array(z.string())
          .min(1)
          .max(BATCH_MAX_IDS)
          .describe('Work item display IDs (e.g., ["PM-42", "PM-43"]), at most 100'),
        status: z
          .enum(['backlog', 'todo', 'in_progress', 'in_review', 'completed', 'wont_do'])
          .optional()
          .describe('New status for every item'),
        priority: z.number().int().min(0).max(4).optional().describe('New priority: 0=critical, 4=none'),
        assignee_id: z.string().uuid().optional().describe('New assignee user UUID'),
        comment: z.string().min(1).optional().describe('Comment added to every updated item (markdown)'),
        is_internal: z.boolean().default(true).describe('Mark the comment internal'),
      },
    },
    async (params: { ids: string[]; status?: string; priority?: number; assignee_id?: string; comment?: string; is_internal: boolean }) => {
      try {
        const hasFields =
          params.status !== undefined || params.priority !== undefined || params.assignee_id !== undefined;
        if (!hasFields && params.comment === undefined) {
          return toolResult('Error: provide at least one of status, priority, assignee_id or comment.', true);
        }

        // No active project -> throws here, before any HTTP call.
        const projectId = await client.requireProjectId();

        // Dedupe on the upper-cased id: lookup is case-insensitive, so "pm-1" and "PM-1" are one item.
        const displayIds = [
          ...new Map(
            params.ids.map((d) => d.trim()).filter(Boolean).map((d) => [d.toUpperCase(), d] as const),
          ).values(),
        ];
        if (displayIds.length === 0) return toolResult('Error: ids is empty.', true);
        const resolved = await resolveBatchItems(client, projectId, displayIds);

        const rows = new Map<string, BatchOutcomeRow>();
        const eligible: WorkItem[] = [];
        for (const d of displayIds) {
          const row: BatchOutcomeRow = { display_id: d, update: '', comment: '', notes: [] };
          rows.set(d, row);
          const item = resolved.get(d.toUpperCase());
          if (!item) {
            row.update = 'not found';
            row.comment = params.comment !== undefined ? 'skipped' : '';
            row.notes.push(`not in the first ${BATCH_MAX_PAGES * BATCH_PAGE_SIZE} active or archived items`);
          } else if (item.is_archived === true) {
            row.update = 'archived (skipped)';
            row.comment = params.comment !== undefined ? 'skipped' : '';
          } else {
            row.display_id = item.display_id;
            eligible.push(item);
          }
        }
        const rowByKey = new Map([...rows.entries()].map(([d, r]) => [d.toUpperCase(), r]));
        const rowOf = (item: WorkItem): BatchOutcomeRow => rowByKey.get(item.display_id.toUpperCase())!;

        // ---- field update: one atomic /bulk call, item-by-item only on a contract rejection
        const updated: WorkItem[] = [];
        let fallbackNote = '';
        if (!hasFields) {
          for (const item of eligible) {
            rowOf(item).update = 'unchanged';
            updated.push(item);
          }
        } else if (eligible.length > 0) {
          const body: BulkUpdateBody = { ids: eligible.map((i) => i.id) };
          if (params.status !== undefined) body.status = params.status as WorkItem['status'];
          if (params.priority !== undefined) body.priority = params.priority;
          if (params.assignee_id !== undefined) body.assigned_to_id = params.assignee_id;
          const patchBody: Record<string, unknown> = { ...body };
          delete patchBody.ids;

          const oldStatus = new Map(eligible.map((i) => [i.id, i.status]));
          const done: WorkItem[] = [];
          try {
            done.push(...(await client.bulkUpdateWorkItems(projectId, body)));
            for (const item of done) rowOf(item).update = 'updated';
          } catch (error) {
            if (!isBulkContractError(error)) throw error;
            fallbackNote = `\nBulk endpoint rejected the batch (${errText(error)}); items were updated one by one.`;
            for (const item of eligible) {
              const row = rowOf(item);
              try {
                done.push(await client.patch<WorkItem>(client.workItemsPath(projectId, item.id), patchBody));
                row.update = 'updated';
                row.notes.push('fallback: per-item');
              } catch (e) {
                row.update = `failed: ${errText(e)}`;
                row.comment = params.comment !== undefined ? 'skipped' : '';
              }
            }
          }
          // /bulk is all-or-nothing, but never trust a short response: flag items it did not return.
          const returned = new Set(done.map((i) => i.id));
          for (const item of eligible) {
            if (returned.has(item.id)) continue;
            const row = rowOf(item);
            if (row.update === '') {
              row.update = 'no result returned';
              if (params.comment !== undefined) row.comment = 'skipped';
            }
          }
          updated.push(...done);

          // Auto-timer per item, old -> new; never fails the batch.
          for (const item of done) {
            const before = oldStatus.get(item.id);
            if (params.status === undefined || before === undefined) continue;
            const note = await applyAutoTimer(client, projectId, item.id, before, item.status);
            if (note) rowOf(item).notes.push(note);
          }
        }

        // ---- comment: separate call, failures reported separately from the update
        let commentSummary = '';
        if (params.comment !== undefined && updated.length > 0) {
          const items: BulkCommentItem[] = updated.map((i) => ({
            work_item_id: i.id,
            content: params.comment!,
            is_internal: params.is_internal,
          }));
          try {
            const res = await client.bulkCreateComments(projectId, items);
            const byId = new Map(res.results.map((r) => [r.work_item_id, r]));
            for (const item of updated) {
              const r = byId.get(item.id);
              rowOf(item).comment = r?.comment ? 'added' : `failed: ${r?.error ?? 'no result returned'}`;
            }
          } catch (error) {
            const missing =
              error instanceof NexoraApiError && (error.status === 404 || error.status === 405);
            const msg = missing ? 'backend not upgraded (no bulk-comments endpoint)' : `failed: ${errText(error)}`;
            for (const item of updated) rowOf(item).comment = msg;
            commentSummary = `\nComments: ${msg}. Field updates above were applied.`;
          }
        }

        const table = formatBatchOutcomeTable([...rows.values()]);
        const ok = [...rows.values()].filter((r) => r.update === 'updated' || r.update === 'unchanged').length;
        return toolResult(`# Batch update — ${ok}/${displayIds.length} items\n${table}${fallbackNote}${commentSummary}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
