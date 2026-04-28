import { z } from 'zod';

import type { NexoraClient } from '../client.js';
import type { WorkItem } from '../types.js';
import { formatWorkItemCompact } from '../formatters.js';
import { errorResult, toolResult } from './helpers.js';

interface SearchResult {
  entity_type: string;
  entity_id: string;
  title: string;
  snippet: string;
  rank: number;
}

interface ActivityEntry {
  id: string;
  module: string;
  actor_type: string;
  action: string;
  entity_type: string;
  summary: string;
  created_at: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerSearchActivityTools(server: any, client: NexoraClient): void {
  // 1. SEARCH
  server.registerTool(
    'nexora_search',
    {
      title: 'Search',
      description: 'Full-text search across work items, messages, and comments in the active project.',
      inputSchema: {
        query: z.string().describe('Search query'),
        limit: z.number().min(1).max(100).default(20).describe('Max results'),
      },
    },
    async ({ query, limit }: { query: string; limit: number }) => {
      try {
        const projectId = await client.requireProjectId();
        const results = await client.get<SearchResult[]>(
          `/projects/${encodeURIComponent(projectId)}/search`,
          { q: query, limit: String(limit) },
        );

        if (results.length === 0) {
          return toolResult(`No results for "${query}".`);
        }

        const lines = [`# Search: "${query}" (${results.length} results)`];
        for (const r of results) {
          lines.push(`[${r.entity_type}] ${r.title}`);
          if (r.snippet) lines.push(`  ${r.snippet.slice(0, 200)}`);
        }
        return toolResult(lines.join('\n'));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 2. ACTIVITY FEED
  server.registerTool(
    'nexora_activity',
    {
      title: 'Activity Feed',
      description: 'Show recent activity in the active project.',
      inputSchema: {
        entity_type: z.string().optional().describe('Filter by entity type (work_item, comment, etc.)'),
        limit: z.number().min(1).max(100).default(20).describe('Max entries'),
      },
    },
    async ({ entity_type, limit }: { entity_type?: string; limit: number }) => {
      try {
        const projectId = await client.requireProjectId();
        const query: Record<string, string> = { limit: String(limit) };
        if (entity_type) query.entity_type = entity_type;

        const entries = await client.get<ActivityEntry[]>(
          `/projects/${encodeURIComponent(projectId)}/activity`,
          query,
        );

        if (entries.length === 0) {
          return toolResult('No recent activity.');
        }

        const lines = [`# Activity (${entries.length} entries)`];
        for (const e of entries) {
          const date = e.created_at?.slice(0, 16).replace('T', ' ') ?? '';
          lines.push(`[${date}] ${e.summary}`);
        }
        return toolResult(lines.join('\n'));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 3. MY ASSIGNMENTS
  server.registerTool(
    'nexora_my_assignments',
    {
      title: 'My Assignments',
      description: 'Show work items assigned to the current user (cross-project).',
      inputSchema: {
        status: z
          .enum(['backlog', 'todo', 'in_progress', 'in_review', 'completed', 'wont_do'])
          .optional()
          .describe('Filter by status (defaults to active items only)'),
        limit: z.number().min(1).max(100).default(50).describe('Max results'),
      },
    },
    async ({ status, limit }: { status?: string; limit: number }) => {
      try {
        const query: Record<string, string> = { limit: String(limit) };
        if (status) query.status = status;

        const items = await client.get<WorkItem[]>('/my/assignments', query);

        if (items.length === 0) {
          return toolResult('No assignments found.');
        }

        const lines = [`# My Assignments (${items.length})`];
        for (const item of items) {
          lines.push(formatWorkItemCompact(item));
        }
        return toolResult(lines.join('\n'));
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
