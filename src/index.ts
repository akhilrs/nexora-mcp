#!/usr/bin/env node
// @ts-expect-error — MCP SDK subpath exports lack .d.ts for individual files; esbuild resolves at build time
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
// @ts-expect-error — same as above
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { NexoraClient } from './client.js';
import { loadConfig } from './config.js';
import { NexoraApiError, NetworkError } from './errors.js';

const VERSION = '0.1.0';

function createServer(): McpServer {
  const config = loadConfig();
  const client = new NexoraClient(config);

  const server = new McpServer({
    name: 'nexora-mcp',
    version: VERSION,
  });

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
            const projects = await client.get<{ items: Array<{ id: string; name: string; code: string; status: string }> }>(
              '/projects',
              { search: projectCode, limit: '1' },
            );
            if (projects.items?.length > 0) {
              const p = projects.items[0];
              projectInfo = `${p.code} — ${p.name} (${p.status})`;
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
                `api: ${config.apiUrl}`,
                `organization: ${config.organizationId}`,
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

  return server;
}

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
