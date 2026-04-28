import type { WorkItem } from './types.js';

const PRIORITY_LABELS: Record<number, string> = {
  0: 'critical',
  1: 'high',
  2: 'medium',
  3: 'low',
  4: 'none',
};

function esc(value: string | null | undefined): string {
  if (!value) return '';
  return value.replace(/\n/g, '\\n').replace(/:/g, '\\:');
}

function formatDate(iso: string | null): string {
  if (!iso) return '';
  return iso.slice(0, 10);
}

export function formatWorkItem(item: WorkItem): string {
  const lines: string[] = [
    `# ${item.display_id} — ${esc(item.title)}`,
    `type: ${item.item_type}`,
    `status: ${item.status}`,
    `priority: ${PRIORITY_LABELS[item.priority] ?? item.priority} (${item.priority})`,
  ];

  if (item.assigned_to_id) lines.push(`assigned_to: ${item.assigned_to_id}`);
  if (item.due_date) lines.push(`due_date: ${formatDate(item.due_date)}`);
  if (item.estimated_hours != null) lines.push(`estimated_hours: ${item.estimated_hours}`);
  if (item.parent_id) lines.push(`parent_id: ${item.parent_id}`);
  if (item.stream_id) lines.push(`stream_id: ${item.stream_id}`);
  if (item.tags?.length) lines.push(`tags: ${item.tags.join(', ')}`);
  if (item.description) {
    lines.push(`description: ${esc(item.description).slice(0, 500)}`);
  }
  if (item.completed_at) lines.push(`completed_at: ${formatDate(item.completed_at)}`);

  lines.push(`created: ${formatDate(item.created_at)}`);
  lines.push(`id: ${item.id}`);

  return lines.join('\n');
}

export function formatWorkItemList(items: WorkItem[], total?: number): string {
  if (items.length === 0) return 'No work items found.';

  const header = total != null
    ? `# Work Items (${items.length} of ${total})`
    : `# Work Items (${items.length})`;

  const rows = items.map((item) => {
    const priority = PRIORITY_LABELS[item.priority] ?? String(item.priority);
    const due = item.due_date ? formatDate(item.due_date) : '';
    return `${item.display_id} | ${item.status.padEnd(11)} | ${priority.padEnd(8)} | ${item.item_type.padEnd(7)} | ${esc(item.title).slice(0, 60)}${due ? ` (due ${due})` : ''}`;
  });

  return [header, ...rows].join('\n');
}

export function formatWorkItemCompact(item: WorkItem): string {
  const priority = PRIORITY_LABELS[item.priority] ?? String(item.priority);
  return `${item.display_id} [${item.status}] ${priority} ${item.item_type}: ${esc(item.title)}`;
}
