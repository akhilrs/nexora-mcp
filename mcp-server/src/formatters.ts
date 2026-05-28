import type { WorkItem } from './types.js';
import type { Attachment } from './types.js';

const PRIORITY_LABELS: Record<number, string> = {
  0: 'critical',
  1: 'high',
  2: 'medium',
  3: 'low',
  4: 'none',
};

export function esc(value: string | null | undefined): string {
  if (!value) return '';
  // Escape sequence-significant chars: CR, LF, NUL, ESC (ANSI), Unicode line separators,
  // plus ':' (used as key/value delimiter in our tool output). Defense against terminal /
  // log / agent-parser injection via untrusted filenames + mime types.
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\x00/g, '\\0')
    .replace(/\x1b/g, '\\x1b')
    .replace(/[\u2028\u2029]/g, '\\u2028')
    .replace(/:/g, '\\:');
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
    lines.push(`description: ${esc(item.description)}`);
  }
  if (item.acceptance_criteria?.length) {
    lines.push(`acceptance_criteria:`);
    for (const ac of item.acceptance_criteria) {
      lines.push(`  - [${ac.testable ? 'testable' : 'non-testable'}] ${ac.criterion}`);
    }
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

// PM-327: attachment formatting + parent-precedence helper.
// Parent precedence: comment > message > work_item > project (first non-null
// wins; matches Nexora's data model where an attachment is linked to exactly
// one of these — multi-non-null would be a Nexora data-integrity issue).

export function deriveAttachmentParent(a: Attachment): { type: string; id: string } {
  if (a.comment_id) return { type: 'comment', id: a.comment_id };
  if (a.message_id) return { type: 'message', id: a.message_id };
  if (a.work_item_id) return { type: 'work_item', id: a.work_item_id };
  if (a.project_id) return { type: 'project', id: a.project_id };
  return { type: 'unknown', id: '' };
}

export function formatAttachment(a: Attachment): string {
  const parent = deriveAttachmentParent(a);
  const created = a.created_at?.slice(0, 16).replace('T', ' ') ?? '';
  return [
    `- ${esc(a.file_name)} (${esc(a.mime_type)}, ${a.file_size_bytes}B)`,
    `  id: ${esc(a.id)}`,
    `  parent: ${esc(parent.type)}${parent.id ? ` (${esc(parent.id)})` : ''}`,
    `  uploaded_by: ${esc(a.uploaded_by_id)}`,
    `  created: ${esc(created)}`,
  ].join('\n');
}
