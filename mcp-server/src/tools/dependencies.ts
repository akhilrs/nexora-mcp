import { z } from 'zod';

import type { NexoraClient } from '../client.js';
import type { Dependency } from '../types.js';
import { errorResult, toolResult } from './helpers.js';

interface DependencyDetail {
  id: string;
  direction: 'outgoing' | 'incoming';
  dependency_type: string;
  related_item: {
    id: string;
    display_id: string;
    title: string;
    status: string;
    item_type: string;
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerDependencyTools(server: any, client: NexoraClient): void {
  // 1. ADD DEPENDENCY
  server.registerTool(
    'nexora_dep_add',
    {
      title: 'Add Dependency',
      description:
        'Add a dependency: the first item depends on (is blocked by) the second. ' +
        'Both are specified by display ID (e.g., PM-42).',
      inputSchema: {
        display_id: z.string().describe('Work item that has the dependency (e.g., PM-42)'),
        depends_on_display_id: z.string().describe('Work item that must be completed first (e.g., PM-10)'),
        type: z.enum(['blocks', 'relates_to']).default('blocks').describe('Dependency type'),
      },
    },
    async ({ display_id, depends_on_display_id, type }: { display_id: string; depends_on_display_id: string; type: string }) => {
      try {
        const projectId = await client.requireProjectId();
        const itemUuid = await client.resolveDisplayId(display_id, projectId);
        const depsOnUuid = await client.resolveDisplayId(depends_on_display_id, projectId);

        const dep = await client.post<Dependency>(
          client.workItemsPath(projectId, itemUuid, 'dependencies'),
          { depends_on_id: depsOnUuid, dependency_type: type },
        );

        return toolResult(
          `Dependency added: ${display_id} ${type === 'blocks' ? 'blocked by' : 'relates to'} ${depends_on_display_id}\nid: ${dep.id}`,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 2. REMOVE DEPENDENCY
  server.registerTool(
    'nexora_dep_remove',
    {
      title: 'Remove Dependency',
      description: 'Remove a dependency between two work items.',
      inputSchema: {
        display_id: z.string().describe('Work item display ID (e.g., PM-42)'),
        depends_on_display_id: z.string().describe('The dependency target display ID (e.g., PM-10)'),
      },
    },
    async ({ display_id, depends_on_display_id }: { display_id: string; depends_on_display_id: string }) => {
      try {
        const projectId = await client.requireProjectId();
        const itemUuid = await client.resolveDisplayId(display_id, projectId);

        const deps = await client.get<DependencyDetail[]>(
          client.workItemsPath(projectId, itemUuid, 'dependencies'),
        );

        const depsOnUuid = await client.resolveDisplayId(depends_on_display_id, projectId);
        const match = deps.find(
          (d) => d.related_item.id === depsOnUuid,
        );

        if (!match) {
          return toolResult(`No dependency found between ${display_id} and ${depends_on_display_id}. Use nexora_dep_list to see current dependencies.`);
        }

        await client.delete(
          client.workItemsPath(projectId, 'dependencies', match.id),
        );

        return toolResult(`Dependency removed: ${display_id} ↔ ${depends_on_display_id}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 3. LIST DEPENDENCIES
  server.registerTool(
    'nexora_dep_list',
    {
      title: 'List Dependencies',
      description: 'List all dependencies for a work item (both blocking and blocked-by).',
      inputSchema: {
        display_id: z.string().describe('Work item display ID (e.g., PM-42)'),
      },
    },
    async ({ display_id }: { display_id: string }) => {
      try {
        const projectId = await client.requireProjectId();
        const itemUuid = await client.resolveDisplayId(display_id, projectId);

        const deps = await client.get<DependencyDetail[]>(
          client.workItemsPath(projectId, itemUuid, 'dependencies'),
        );

        if (deps.length === 0) {
          return toolResult(`${display_id} has no dependencies.`);
        }

        const blockedBy = deps.filter((d) => d.direction === 'outgoing' && d.dependency_type === 'blocks');
        const blocks = deps.filter((d) => d.direction === 'incoming' && d.dependency_type === 'blocks');
        const relatesTo = deps.filter((d) => d.dependency_type === 'relates_to');

        const lines: string[] = [`# Dependencies for ${display_id}`];

        if (blockedBy.length > 0) {
          lines.push(`\nblocked_by (${blockedBy.length}):`);
          for (const d of blockedBy) {
            lines.push(`  ${d.related_item.display_id} [${d.related_item.status}] ${d.related_item.title}`);
          }
        }

        if (blocks.length > 0) {
          lines.push(`\nblocks (${blocks.length}):`);
          for (const d of blocks) {
            lines.push(`  ${d.related_item.display_id} [${d.related_item.status}] ${d.related_item.title}`);
          }
        }

        if (relatesTo.length > 0) {
          lines.push(`\nrelates_to (${relatesTo.length}):`);
          for (const d of relatesTo) {
            lines.push(`  ${d.related_item.display_id} [${d.related_item.status}] ${d.related_item.title}`);
          }
        }

        return toolResult(lines.join('\n'));
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
