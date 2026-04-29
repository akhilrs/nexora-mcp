#!/usr/bin/env node
// @ts-expect-error — MCP SDK subpath exports lack .d.ts for individual files; esbuild resolves at build time
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
// @ts-expect-error — same as above
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { NexoraClient } from './client.js';
import { getConfig } from './config.js';
import { NexoraApiError, NetworkError } from './errors.js';
import { registerCommentTools } from './tools/comments.js';
import { registerDependencyTools } from './tools/dependencies.js';
import { registerProjectTools } from './tools/projects.js';
import { registerSearchActivityTools } from './tools/search-activity.js';
import { registerTimeEntryTools } from './tools/time-entries.js';
import { registerWorkItemTools } from './tools/work-items.js';

const VERSION = '0.5.0';

/**
 * Lazy client proxy — config is resolved on first tool call, not at startup.
 * This allows the MCP server to start even when launched from the plugin
 * cache directory where .nexora.toml is not discoverable.
 */
function createLazyClient(): NexoraClient {
  let _client: NexoraClient | null = null;
  return new Proxy({} as NexoraClient, {
    get(_target, prop, receiver) {
      if (!_client) {
        _client = new NexoraClient(getConfig());
      }
      const value = Reflect.get(_client, prop, _client);
      return typeof value === 'function' ? value.bind(_client) : value;
    },
  });
}

function createServer(): McpServer {
  const client = createLazyClient();

  const server = new McpServer({
    name: 'nexora-mcp',
    version: VERSION,
  });

  // Work item CRUD tools
  registerWorkItemTools(server, client);
  registerDependencyTools(server, client);
  registerCommentTools(server, client);
  registerTimeEntryTools(server, client);
  registerProjectTools(server, client);
  registerSearchActivityTools(server, client);

  // Connectivity / context tool — validates the connection works
  server.registerTool(
    'nexora_context',
    {
      title: 'Nexora Context',
      description:
        'Show current Nexora MCP configuration: connected project, organization, API status. ' +
        'Use this to verify the connection is working.',
      inputSchema: {},
    },
    async () => {
      try {
        const projectCode = client.currentProjectCode;
        let projectInfo = 'No default project configured';

        if (projectCode) {
          try {
            const projects = await client.get<Array<{ id: string; name: string; code: string; status: string }>>(
              '/projects',
              { limit: '50' },
            );
            const match = projects.find(
              (p) => typeof p.code === 'string' && p.code.toLowerCase() === projectCode.toLowerCase(),
            );
            if (match) {
              projectInfo = `${match.code} — ${match.name} (${match.status})`;
            } else {
              projectInfo = `${projectCode} (not found)`;
            }
          } catch {
            projectInfo = `${projectCode} (lookup failed)`;
          }
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: [
                '# Nexora MCP Context',
                `api: ${getConfig().apiUrl}`,
                `organization: ${getConfig().organizationId}`,
                `project: ${projectInfo}`,
                `status: connected`,
              ].join('\n'),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `# Nexora MCP Context\nstatus: error\n${formatError(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // Quickstart guide
  server.registerTool(
    'nexora_quickstart',
    {
      title: 'Nexora Quickstart',
      description: 'Show available Nexora MCP tools and recommended workflow.',
      inputSchema: {},
    },
    async () => ({
      content: [
        {
          type: 'text' as const,
          text: QUICKSTART_GUIDE,
        },
      ],
    }),
  );

  return server;
}

const QUICKSTART_GUIDE = `# Nexora MCP — Quick Reference

## Work Items
nexora_work_item_create   Create task/bug/story/epic/feature
nexora_work_item_list     List with status/type/assignee filters
nexora_work_item_show     Show details by display ID (PM-42)
nexora_work_item_update   Update any field
nexora_work_item_delete   Soft-delete (mark as wont_do)
nexora_work_item_ready    Unblocked todo items
nexora_work_item_children List children of a parent item
nexora_work_item_transition Change status only

## Dependencies
nexora_dep_add            Add blocking dependency
nexora_dep_remove         Remove dependency
nexora_dep_list           List all deps (blocked_by + blocks)

## Comments
nexora_comment_add        Add comment to work item
nexora_comment_list       List comments
nexora_comment_update     Edit comment
nexora_comment_delete     Delete comment

## Search & Activity
nexora_search             Full-text search across project
nexora_activity           Recent activity feed
nexora_my_assignments     My work items across projects

## Utility
nexora_context            Show connection status + active project
nexora_quickstart         This guide

## Recommended Workflow
1. nexora_work_item_ready — find what to work on
2. nexora_work_item_show PM-42 — understand the task
3. nexora_work_item_transition PM-42 in_progress — start
4. nexora_comment_add PM-42 "Working on..." — track progress
5. [do the work]
6. nexora_work_item_transition PM-42 completed — done
7. nexora_comment_add PM-42 "Completed: summary" — close out
`;

function formatError(error: unknown): string {
  if (error instanceof NexoraApiError) {
    return `API Error ${error.status}: ${error.message}`;
  }
  if (error instanceof NetworkError) {
    return `Network Error: ${error.message}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  const msg = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Failed to start nexora-mcp: ${msg}\n`);
  process.exit(1);
});
