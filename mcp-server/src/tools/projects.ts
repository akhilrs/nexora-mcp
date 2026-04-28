import { z } from 'zod';

import type { NexoraClient } from '../client.js';
import type { Project, Stream } from '../types.js';
import { errorResult, toolResult } from './helpers.js';

function formatProject(p: Project): string {
  const lines = [
    `# ${p.code} — ${p.name}`,
    `status: ${p.status}`,
    `priority: ${p.priority}`,
  ];
  if (p.description) lines.push(`description: ${(p.description ?? '').slice(0, 300)}`);
  if (p.start_date) lines.push(`start: ${p.start_date.slice(0, 10)}`);
  if (p.target_end_date) lines.push(`target_end: ${p.target_end_date.slice(0, 10)}`);
  if (p.project_lead_id) lines.push(`lead: ${p.project_lead_id}`);
  lines.push(`id: ${p.id}`);
  return lines.join('\n');
}

function formatStream(s: Stream): string {
  return `${s.name} [${s.status}]${s.color_code ? ` (${s.color_code})` : ''} — ${(s.description ?? 'no description').slice(0, 100)}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerProjectTools(server: any, client: NexoraClient): void {
  // 1. SHOW PROJECT
  server.registerTool(
    'nexora_project_show',
    {
      title: 'Show Project',
      description: 'Show details of the active project (or a specific project by code).',
      inputSchema: {
        project_code: z.string().optional().describe('Project code (defaults to active project)'),
      },
    },
    async ({ project_code }: { project_code?: string }) => {
      try {
        const code = project_code ?? client.currentProjectCode;
        if (!code) {
          return toolResult('No project configured. Set NEXORA_PROJECT_CODE or use nexora_project_switch.', true);
        }

        const projects = await client.get<Project[]>('/projects', { limit: '50' });
        const match = projects.find(
          (p) => typeof p.code === 'string' && p.code.toLowerCase() === code.toLowerCase(),
        );
        if (!match) {
          return toolResult(`Project '${code}' not found.`, true);
        }

        return toolResult(formatProject(match));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 2. LIST PROJECTS
  server.registerTool(
    'nexora_project_list',
    {
      title: 'List Projects',
      description: 'List all projects in the organization.',
      inputSchema: {
        status: z.enum(['planning', 'active', 'paused', 'completed', 'archived']).optional().describe('Filter by status'),
        limit: z.number().min(1).max(100).default(20).describe('Max results'),
      },
    },
    async ({ status, limit }: { status?: string; limit: number }) => {
      try {
        const query: Record<string, string> = { limit: String(limit) };
        if (status) query.status = status;

        const projects = await client.get<Project[]>('/projects', query);
        if (projects.length === 0) {
          return toolResult('No projects found.');
        }

        const lines = [`# Projects (${projects.length})`];
        for (const p of projects) {
          const active = p.code === client.currentProjectCode ? ' ← active' : '';
          lines.push(`${p.code} | ${p.status.padEnd(10)} | ${p.name}${active}`);
        }
        return toolResult(lines.join('\n'));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 3. SWITCH PROJECT
  server.registerTool(
    'nexora_project_switch',
    {
      title: 'Switch Project',
      description: 'Switch the active project context. All subsequent tools will operate on this project.',
      inputSchema: {
        project_code: z.string().describe('Project code to switch to (e.g., PRJ-001)'),
      },
    },
    async ({ project_code }: { project_code: string }) => {
      try {
        const prevCode = client.currentProjectCode;
        client.switchProject(project_code);
        try {
          const projectId = await client.requireProjectId();
          return toolResult(`Switched to project: ${project_code} (id: ${projectId})`);
        } catch (error) {
          if (prevCode) client.switchProject(prevCode);
          throw error;
        }
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 4. PROJECT STATS (placeholder — needs TREK-123 backend endpoint)
  server.registerTool(
    'nexora_project_stats',
    {
      title: 'Project Stats',
      description: 'Show project statistics (work items by status, hours logged, etc.).',
      inputSchema: {},
    },
    async () => {
      try {
        const projectId = await client.requireProjectId();
        const items = await client.get<Array<{ status: string }>>(
          client.workItemsPath(projectId),
          { limit: '200' },
        );

        const counts: Record<string, number> = {};
        for (const item of items) {
          counts[item.status] = (counts[item.status] ?? 0) + 1;
        }

        const total = items.length;
        const completed = counts['completed'] ?? 0;
        const progress = total > 0 ? Math.round((completed / total) * 100) : 0;

        const lines = [
          `# Project Stats (${client.currentProjectCode})`,
          `total_items: ${total}`,
          `progress: ${progress}%`,
          '',
          ...Object.entries(counts)
            .sort(([, a], [, b]) => b - a)
            .map(([status, count]) => `${status}: ${count}`),
        ];

        return toolResult(lines.join('\n'));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 5. LIST STREAMS
  server.registerTool(
    'nexora_stream_list',
    {
      title: 'List Streams',
      description: 'List work streams in the active project.',
      inputSchema: {},
    },
    async () => {
      try {
        const projectId = await client.requireProjectId();
        const streams = await client.get<Stream[]>(
          `/projects/${encodeURIComponent(projectId)}/streams`,
        );

        if (streams.length === 0) {
          return toolResult('No streams in this project.');
        }

        const lines = [`# Streams (${streams.length})`];
        for (const s of streams) {
          lines.push(`${formatStream(s)} | id: ${s.id}`);
        }
        return toolResult(lines.join('\n'));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 6. CREATE STREAM
  server.registerTool(
    'nexora_stream_create',
    {
      title: 'Create Stream',
      description: 'Create a new work stream in the active project.',
      inputSchema: {
        name: z.string().describe('Stream name'),
        description: z.string().optional().describe('Stream description'),
        color_code: z.string().optional().describe('Color hex code (e.g., #3B82F6)'),
      },
    },
    async ({ name, description, color_code }: { name: string; description?: string; color_code?: string }) => {
      try {
        const projectId = await client.requireProjectId();
        const stream = await client.post<Stream>(
          `/projects/${encodeURIComponent(projectId)}/streams`,
          { name, description, color_code },
        );
        return toolResult(`Stream created: ${formatStream(stream)}\nid: ${stream.id}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 7. SHOW STREAM
  server.registerTool(
    'nexora_stream_show',
    {
      title: 'Show Stream',
      description: 'Show details of a stream.',
      inputSchema: {
        stream_id: z.string().describe('Stream UUID'),
      },
    },
    async ({ stream_id }: { stream_id: string }) => {
      try {
        const projectId = await client.requireProjectId();
        const stream = await client.get<Stream>(
          `/projects/${encodeURIComponent(projectId)}/streams/${encodeURIComponent(stream_id)}`,
        );
        return toolResult(`${formatStream(stream)}\nid: ${stream.id}\nposition: ${stream.position}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
