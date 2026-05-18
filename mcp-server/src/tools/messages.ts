import { z } from 'zod';

import type { NexoraClient } from '../client.js';
import type { Comment, Message, MessageCategory } from '../types.js';
import { errorResult, toolResult } from './helpers.js';

// Tuple literal lets z.enum infer the union directly. The `satisfies` clause
// keeps CATEGORIES in lockstep with the MessageCategory union — drift becomes
// a type error instead of a silent runtime mismatch.
const CATEGORIES = [
  'announcement',
  'update',
  'pitch',
  'question',
  'fyi',
] as const satisfies readonly MessageCategory[];

// ── Path builders ─────────────────────────────────────────────────────────
function messagesPath(projectId: string, ...segments: string[]): string {
  const base = `/projects/${encodeURIComponent(projectId)}/messages`;
  if (segments.length === 0) return base;
  return `${base}/${segments.map((s) => encodeURIComponent(s)).join('/')}`;
}

// ── Formatters ────────────────────────────────────────────────────────────
function formatMessage(m: Message): string {
  const date = m.created_at?.slice(0, 16).replace('T', ' ') ?? '';
  const flags = [m.is_pinned ? 'pinned' : '', m.is_draft ? 'draft' : ''].filter(Boolean).join(', ');
  const tail = flags ? ` (${flags})` : '';
  return [
    `[${date}] ${m.category.toUpperCase()}${tail}`,
    `${m.id}  ${m.title}`,
    (m.content ?? '').slice(0, 300),
  ].join('\n');
}

function formatMessageRow(m: Message): string {
  const date = m.created_at?.slice(0, 10) ?? '';
  const pin = m.is_pinned ? '📌 ' : '';
  const draft = m.is_draft ? ' [DRAFT]' : '';
  return `${date}  ${m.category.padEnd(12)}  ${pin}${m.title}${draft}\n        ${m.id}`;
}

function formatComment(c: Comment): string {
  const date = c.created_at?.slice(0, 16).replace('T', ' ') ?? '';
  const flags = [c.is_ai_generated ? 'ai' : '', c.is_internal ? 'internal' : 'public']
    .filter(Boolean)
    .join(', ');
  return `[${date}] (${flags}) ${(c.content ?? '').slice(0, 500)}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerMessageTools(server: any, client: NexoraClient): void {
  // 1. CREATE MESSAGE
  server.registerTool(
    'nexora_message_create',
    {
      title: 'Create Project Message',
      description:
        'Post a project-level message (Basecamp-style board). ' +
        'Use category to type the post: announcement, update, pitch, question, fyi.',
      inputSchema: {
        title: z.string().min(1).max(500).describe('Message title'),
        content: z.string().min(1).describe('Message body (markdown supported)'),
        category: z
          .enum(CATEGORIES)
          .default('update')
          .describe('Type of message'),
        is_pinned: z.boolean().default(false).describe('Pin to top of the message board'),
        is_draft: z.boolean().default(false).describe('Save as draft (not visible to the team yet)'),
      },
    },
    async ({
      title,
      content,
      category,
      is_pinned,
      is_draft,
    }: {
      title: string;
      content: string;
      category: MessageCategory;
      is_pinned: boolean;
      is_draft: boolean;
    }) => {
      try {
        const projectId = await client.requireProjectId();
        const msg = await client.post<Message>(messagesPath(projectId), {
          title,
          content,
          category,
          is_pinned,
          is_draft,
        });
        return toolResult(`Message created:\n${formatMessage(msg)}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 2. LIST MESSAGES
  // Backend supports include_drafts/limit/offset; category and pinned_only
  // are applied client-side after fetching the page.
  server.registerTool(
    'nexora_message_list',
    {
      title: 'List Project Messages',
      description:
        'List messages on the current project. ' +
        'NOTE: `limit`/`offset` are sent to the backend; `category` and `pinned_only` are applied client-side AFTER the page is fetched, so the returned list can be shorter than `limit` even when more matches exist on later pages. ' +
        'When filtering, raise `limit` toward the backend max (200) to widen the search window.',
      inputSchema: {
        category: z
          .enum(CATEGORIES)
          .optional()
          .describe('Filter to a single category'),
        pinned_only: z.boolean().default(false).describe('Return only pinned messages'),
        include_drafts: z.boolean().default(false).describe('Include draft messages in the result'),
        limit: z.number().int().min(1).max(200).default(50).describe('Max messages to fetch (1-200)'),
        offset: z.number().int().min(0).default(0).describe('Pagination offset'),
      },
    },
    async ({
      category,
      pinned_only,
      include_drafts,
      limit,
      offset,
    }: {
      category?: MessageCategory;
      pinned_only: boolean;
      include_drafts: boolean;
      limit: number;
      offset: number;
    }) => {
      try {
        const projectId = await client.requireProjectId();
        const msgs = await client.get<Message[]>(messagesPath(projectId), {
          include_drafts: String(include_drafts),
          limit: String(limit),
          offset: String(offset),
        });

        const filtered = msgs.filter((m) => {
          if (category && m.category !== category) return false;
          if (pinned_only && !m.is_pinned) return false;
          return true;
        });

        if (filtered.length === 0) {
          return toolResult('No messages match the filter.');
        }

        const lines = filtered.map(formatMessageRow);
        const head = `${filtered.length} message${filtered.length === 1 ? '' : 's'}` +
          (category ? ` · category=${category}` : '') +
          (pinned_only ? ' · pinned only' : '') +
          (include_drafts ? ' · drafts included' : '');
        return toolResult(`${head}\n\n${lines.join('\n\n')}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 3. SHOW MESSAGE
  server.registerTool(
    'nexora_message_show',
    {
      title: 'Show Project Message',
      description: 'Show a single project message by UUID.',
      inputSchema: {
        message_id: z.string().describe('Message UUID'),
      },
    },
    async ({ message_id }: { message_id: string }) => {
      try {
        const projectId = await client.requireProjectId();
        const msg = await client.get<Message>(messagesPath(projectId, message_id));
        return toolResult(formatMessage(msg));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 4. UPDATE MESSAGE
  server.registerTool(
    'nexora_message_update',
    {
      title: 'Update Project Message',
      description:
        'Patch any subset of fields on a project message. Omit a field to leave it unchanged. ' +
        'Use this to pin/unpin, publish a draft, or recategorize.',
      inputSchema: {
        message_id: z.string().describe('Message UUID'),
        title: z.string().min(1).max(500).optional(),
        content: z.string().min(1).optional(),
        category: z.enum(CATEGORIES).optional(),
        is_pinned: z.boolean().optional(),
        is_draft: z.boolean().optional(),
      },
    },
    async ({
      message_id,
      title,
      content,
      category,
      is_pinned,
      is_draft,
    }: {
      message_id: string;
      title?: string;
      content?: string;
      category?: MessageCategory;
      is_pinned?: boolean;
      is_draft?: boolean;
    }) => {
      try {
        const projectId = await client.requireProjectId();
        const patch: Record<string, unknown> = {};
        if (title !== undefined) patch.title = title;
        if (content !== undefined) patch.content = content;
        if (category !== undefined) patch.category = category;
        if (is_pinned !== undefined) patch.is_pinned = is_pinned;
        if (is_draft !== undefined) patch.is_draft = is_draft;

        if (Object.keys(patch).length === 0) {
          return errorResult(new Error('No fields to update — pass at least one field.'));
        }

        const msg = await client.patch<Message>(messagesPath(projectId, message_id), patch);
        return toolResult(`Message updated:\n${formatMessage(msg)}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 5. DELETE MESSAGE
  // Hard-delete. Require an explicit `confirm: true` so accidental or
  // prompt-injected calls can't silently nuke a message.
  server.registerTool(
    'nexora_message_delete',
    {
      title: 'Delete Project Message',
      description:
        'Permanently delete a project message. Requires `confirm: true`. ' +
        'There is no soft-delete or undo — the row is removed.',
      inputSchema: {
        message_id: z.string().describe('Message UUID'),
        confirm: z
          .literal(true)
          .describe('Must be true. Guards against accidental or prompt-injected deletes.'),
      },
    },
    async ({ message_id, confirm }: { message_id: string; confirm: true }) => {
      try {
        if (!confirm) {
          return errorResult(new Error('Refusing to delete without confirm:true.'));
        }
        const projectId = await client.requireProjectId();
        // Fetch first so we can echo what was deleted (helps when the agent
        // re-reads the conversation later).
        let label = message_id;
        try {
          const existing = await client.get<Message>(messagesPath(projectId, message_id));
          label = `${existing.id} — ${existing.title} (${existing.category})`;
        } catch {
          /* if the show fails we still attempt the delete with the bare id */
        }
        await client.delete(messagesPath(projectId, message_id));
        return toolResult(`Deleted: ${label}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 6. ADD COMMENT TO MESSAGE
  server.registerTool(
    'nexora_message_comment_add',
    {
      title: 'Comment on Project Message',
      description: 'Reply to a project message with a comment (markdown supported).',
      inputSchema: {
        message_id: z.string().describe('Message UUID'),
        content: z.string().min(1).describe('Comment content (markdown supported)'),
        is_internal: z
          .boolean()
          .default(true)
          .describe('Internal comment (hidden from external stakeholders)'),
        is_ai_generated: z
          .boolean()
          .default(true)
          .describe(
            'Mark this comment as AI-authored. Defaults to true since this tool is invoked by Claude; set false when scripting on behalf of a human user.',
          ),
      },
    },
    async ({
      message_id,
      content,
      is_internal,
      is_ai_generated,
    }: {
      message_id: string;
      content: string;
      is_internal: boolean;
      is_ai_generated: boolean;
    }) => {
      try {
        const projectId = await client.requireProjectId();
        const comment = await client.post<Comment>(
          messagesPath(projectId, message_id, 'comments'),
          { content, is_internal, is_ai_generated },
        );
        return toolResult(`Reply posted on message ${message_id}:\n${formatComment(comment)}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 7. LIST COMMENTS ON MESSAGE
  server.registerTool(
    'nexora_message_comment_list',
    {
      title: 'List Comments on Project Message',
      description: 'List replies on a project message.',
      inputSchema: {
        message_id: z.string().describe('Message UUID'),
        limit: z.number().int().min(1).max(200).default(50).describe('Max comments to return'),
      },
    },
    async ({ message_id, limit }: { message_id: string; limit: number }) => {
      try {
        const projectId = await client.requireProjectId();
        const comments = await client.get<Comment[]>(
          messagesPath(projectId, message_id, 'comments'),
        );
        const sliced = comments.slice(0, limit);
        if (sliced.length === 0) {
          return toolResult('No comments on this message yet.');
        }
        const lines = sliced.map(formatComment).join('\n');
        return toolResult(`${sliced.length} comment${sliced.length === 1 ? '' : 's'}:\n\n${lines}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
