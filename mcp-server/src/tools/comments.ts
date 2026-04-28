import { z } from 'zod';

import type { NexoraClient } from '../client.js';
import type { Comment } from '../types.js';
import { errorResult, toolResult } from './helpers.js';

function formatComment(c: Comment): string {
  const date = c.created_at?.slice(0, 16).replace('T', ' ') ?? '';
  const flags = [
    c.is_ai_generated ? 'ai' : '',
    c.is_internal ? 'internal' : 'public',
  ].filter(Boolean).join(', ');
  return `[${date}] (${flags}) ${(c.content ?? '').slice(0, 500)}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerCommentTools(server: any, client: NexoraClient): void {
  // 1. ADD COMMENT
  server.registerTool(
    'nexora_comment_add',
    {
      title: 'Add Comment',
      description: 'Add a comment to a work item.',
      inputSchema: {
        display_id: z.string().describe('Work item display ID (e.g., PM-42)'),
        content: z.string().describe('Comment content (markdown supported)'),
        is_internal: z.boolean().default(true).describe('Internal comment (hidden from external stakeholders)'),
      },
    },
    async ({ display_id, content, is_internal }: { display_id: string; content: string; is_internal: boolean }) => {
      try {
        const projectId = await client.requireProjectId();
        const itemUuid = await client.resolveDisplayId(display_id, projectId);

        const comment = await client.post<Comment>(
          client.workItemsPath(projectId, itemUuid, 'comments'),
          { content, is_internal, is_ai_generated: true },
        );

        return toolResult(`Comment added to ${display_id}:\n${formatComment(comment)}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 2. LIST COMMENTS
  server.registerTool(
    'nexora_comment_list',
    {
      title: 'List Comments',
      description: 'List comments on a work item.',
      inputSchema: {
        display_id: z.string().describe('Work item display ID (e.g., PM-42)'),
        limit: z.number().min(1).max(100).default(20).describe('Max comments to return'),
      },
    },
    async ({ display_id, limit }: { display_id: string; limit: number }) => {
      try {
        const projectId = await client.requireProjectId();
        const itemUuid = await client.resolveDisplayId(display_id, projectId);

        const comments = await client.get<Comment[]>(
          client.workItemsPath(projectId, itemUuid, 'comments'),
          { limit: String(limit) },
        );

        if (comments.length === 0) {
          return toolResult(`No comments on ${display_id}.`);
        }

        const lines = [`# Comments on ${display_id} (${comments.length})`, ''];
        for (const c of comments) {
          lines.push(formatComment(c));
          lines.push(`  id: ${c.id}`);
        }

        return toolResult(lines.join('\n'));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 3. UPDATE COMMENT
  server.registerTool(
    'nexora_comment_update',
    {
      title: 'Update Comment',
      description: 'Update the content of a comment.',
      inputSchema: {
        display_id: z.string().describe('Work item display ID (e.g., PM-42)'),
        comment_id: z.string().describe('Comment UUID'),
        content: z.string().describe('New comment content'),
      },
    },
    async ({ display_id, comment_id, content }: { display_id: string; comment_id: string; content: string }) => {
      try {
        const projectId = await client.requireProjectId();
        const itemUuid = await client.resolveDisplayId(display_id, projectId);

        const comment = await client.patch<Comment>(
          client.workItemsPath(projectId, itemUuid, 'comments', comment_id),
          { content },
        );
        return toolResult(`Comment updated:\n${formatComment(comment)}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 4. DELETE COMMENT
  server.registerTool(
    'nexora_comment_delete',
    {
      title: 'Delete Comment',
      description: 'Delete a comment.',
      inputSchema: {
        display_id: z.string().describe('Work item display ID (e.g., PM-42)'),
        comment_id: z.string().describe('Comment UUID'),
      },
    },
    async ({ display_id, comment_id }: { display_id: string; comment_id: string }) => {
      try {
        const projectId = await client.requireProjectId();
        const itemUuid = await client.resolveDisplayId(display_id, projectId);

        await client.delete(
          client.workItemsPath(projectId, itemUuid, 'comments', comment_id),
        );
        return toolResult(`Comment ${comment_id} deleted.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
