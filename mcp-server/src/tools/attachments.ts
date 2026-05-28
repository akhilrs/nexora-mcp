// PM-327: attachment list + download tools.
//
// These tools wrap Nexora's attachment REST endpoints with server-side
// SSRF/byte-budget enforcement so agents don't have to re-implement the
// safety constraints (PM-326 spec).
//
// Tools:
//   nexora_attachment_list { display_id }
//     → text list of attachments on a work item (covers both direct-on-task
//       and comment-attached, distinguished via the derived `parent` field).
//
//   nexora_attachment_download { display_id, attachment_id }
//     → result: path to a tmpdir file containing the downloaded bytes
//       (${TMPDIR}/nexora-mcp-attachments/<sha256>.<ext>). Agent uses the
//       Read tool on the path — handles images natively via multimodal Read.
//       Rejects files > 10 MiB (the published cap from PM-326).
//       PM-329: dropped the previous inline-base64 branch entirely; MCP
//       transport's per-response token cap was too tight for the 2 MiB raw
//       threshold to be useful in practice (316 KB raw → 421 KB base64 →
//       transport-cap fallback on every real attachment).
//     Storage host allowlist defaults to ['s3.qs0.dev']; override via env var
//     NEXORA_ATTACHMENT_HOSTS=host1,host2,... for self-hosted deployments.

import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';

import type { NexoraClient } from '../client.js';
import type { Attachment } from '../types.js';
import { formatAttachment, esc } from '../formatters.js';
import { createHash } from 'node:crypto';
import { errorResult, toolResult } from './helpers.js';
import { basename, extname } from 'node:path';

// PM-424: minimal MIME map by extension. The backend has its own
// document_allowed_types_list; we just need to emit a plausible Content-Type
// in the multipart part so the server can match. Anything not on this map
// falls back to application/octet-stream and the backend's allowlist gates.
const _MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.log': 'text/plain',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
};

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // backend's default platform.max_upload_size

async function readLocalFileAsBlob(
  path: string,
  fileNameOverride?: string,
): Promise<{ blob: Blob; name: string }> {
  let stat;
  try {
    stat = await fsp.stat(path);
  } catch (err) {
    throw new Error(`File not found: ${path}`);
  }
  if (!stat.isFile()) {
    throw new Error(`Path is not a regular file: ${path}`);
  }
  if (stat.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `File too large: ${stat.size} bytes (limit ${MAX_UPLOAD_BYTES} bytes). ` +
        `Compress or split before uploading.`,
    );
  }
  if (stat.size === 0) {
    throw new Error(`File is empty: ${path}`);
  }
  const bytes = await fsp.readFile(path);
  // Sanitize filename: defense-in-depth alongside backend _sanitize_filename.
  // Strip CR/LF (multipart header injection guard) and path separators (the
  // backend rejects them too, but failing fast here is cheaper than a 422).
  const rawName = fileNameOverride ?? basename(path);
  const name = rawName.replace(/[\r\n]+/g, ' ').replace(/[/\\]/g, '_').slice(0, 255);
  const ext = extname(path).toLowerCase();
  const mime = _MIME_BY_EXT[ext] ?? 'application/octet-stream';
  return { blob: new Blob([new Uint8Array(bytes)], { type: mime }), name };
}

const MAX_BYTES = 10 * 1024 * 1024;               // 10 MiB hard cap (PM-326 spec)

// Fixed MIME → extension map. Extension comes from this map, NEVER from the
// MIME header or filename directly (defense against arbitrary path content).
const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/json': 'json',
};

function extensionFor(mimeType: string): string {
  return MIME_TO_EXT[mimeType.toLowerCase()] ?? 'bin';
}

const DEFAULT_ALLOWED_HOSTS = ['s3.qs0.dev'];

function allowedRedirectHosts(): string[] {
  // Env override comma-separated; default to Nexora's published storage host.
  // Empty env / all-empty entries fall back to default rather than silently
  // disabling all redirects (which would surprise the operator).
  const env = process.env.NEXORA_ATTACHMENT_HOSTS;
  if (env && env.trim()) {
    const parsed = env
      .split(',')
      .map((h) => h.trim().toLowerCase().replace(/\.+$/, ''))
      .filter(Boolean);
    if (parsed.length > 0) return parsed;
  }
  return DEFAULT_ALLOWED_HOSTS;
}

async function writeAttachmentAtomically(
  bytes: Buffer,
  sha256: string,
  mimeType: string,
): Promise<string> {
  const dir = pathJoin(tmpdir(), 'nexora-mcp-attachments');
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  // Symlink/squat defense: if the dir was pre-created with lax perms or as a
  // symlink, reject up-front. Reset perms to 0o700 if the dir is genuinely ours.
  const lstat = await fsp.lstat(dir);
  if (!lstat.isDirectory() || lstat.isSymbolicLink()) {
    throw new Error(`nexora-mcp-attachments path is not a regular directory: ${dir}`);
  }
  // Best-effort chmod; ignore EPERM if we don't own it (download still safe — sha-keyed).
  try { await fsp.chmod(dir, 0o700); } catch { /* swallow */ }
  const ext = extensionFor(mimeType);
  const finalPath = pathJoin(dir, `${sha256}.${ext}`);

  // Sha-keyed filename: if file already exists with matching sha, content is
  // identical by collision-resistance — skip write.
  try {
    await fsp.access(finalPath);
    // Verify on-disk content matches expected sha (defense vs. partial/corrupt prior write).
    const existing = await fsp.readFile(finalPath);
    const onDiskSha = createHash('sha256').update(existing).digest('hex');
    if (onDiskSha === sha256) return finalPath;
    // Stale/corrupt: fall through to rewrite (atomic via tmp + rename below).
  } catch {
    // doesn't exist; write atomically via .tmp + rename
  }

  const tmpPath = `${finalPath}.tmp.${process.pid}-${Math.random().toString(36).slice(2,10)}`;
  // 'wx' fails if tmpPath already exists; pid + random suffix makes collisions vanishingly rare.
  await fsp.writeFile(tmpPath, bytes, { flag: 'wx', mode: 0o600 });
  try {
    await fsp.rename(tmpPath, finalPath);
  } catch (err) {
    // Rename can fail on Windows (target exists) or if another process won the race.
    // Clean up our tmp + verify the existing finalPath matches our sha; succeed if so.
    try { await fsp.unlink(tmpPath); } catch { /* swallow */ }
    try {
      const existing = await fsp.readFile(finalPath);
      const onDiskSha = createHash('sha256').update(existing).digest('hex');
      if (onDiskSha === sha256) return finalPath;
    } catch { /* fall through to original error */ }
    throw err;
  }
  return finalPath;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerAttachmentTools(server: any, client: NexoraClient): void {
  // 1. LIST ATTACHMENTS
  server.registerTool(
    'nexora_attachment_list',
    {
      title: 'List Attachments',
      description:
        'List file attachments on a work item (covers direct-on-task uploads ' +
        'AND attachments uploaded inside comments — the derived `parent` field ' +
        'distinguishes them). Use this in Phase 0 step 3d (PM-326) to inventory ' +
        'attachments before deciding whether to download bytes.',
      inputSchema: {
        display_id: z.string().trim().min(1).describe('Work item display ID (e.g., PM-42)'),
      },
    },
    async ({ display_id }: { display_id: string }) => {
      try {
        const projectId = await client.requireProjectId();
        const itemUuid = await client.resolveDisplayId(display_id, projectId);

        const attachments = await client.get<Attachment[]>(
          client.workItemsPath(projectId, itemUuid, 'attachments'),
        );

        if (attachments.length === 0) {
          return toolResult(`No attachments on ${display_id}.`);
        }

        const lines = [`# Attachments on ${display_id} (${attachments.length})`, ''];
        for (const a of attachments) {
          lines.push(formatAttachment(a));
          lines.push('');
        }
        return toolResult(lines.join('\n').trimEnd());
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 2. DOWNLOAD ATTACHMENT
  server.registerTool(
    'nexora_attachment_download',
    {
      title: 'Download Attachment',
      description:
        'Download an attachment with server-side SSRF + byte-budget enforcement. ' +
        'Downloads the attachment server-side (SSRF + byte-budget enforced) and ' +
        'writes bytes to a tmpdir path (${TMPDIR}/nexora-mcp-attachments/<sha256>.<ext>). ' +
        'Agent uses Read on the returned path — handles images natively via multimodal Read. ' +
        'POSIX paths only (the `path:` field is NOT esc-unescaped for Windows backslashes; ' +
        'agents on POSIX hosts use it verbatim). Requires the agent + MCP server to share a ' +
        'filesystem — typical stdio deployment. Remote MCP deployments where filesystem is ' +
        'not shared would need a different tool variant returning bytes via MCP dynamic-resource ' +
        'semantics (readResource), not in scope for this version. ' +
        'Rejects files >10 MiB. Follows Nexora\'s signed-URL redirect (302 → ' +
        's3.qs0.dev by default; configurable via NEXORA_ATTACHMENT_HOSTS env var).',
      inputSchema: {
        display_id: z.string().trim().min(1).describe('Work item display ID (parent context for the URL)'),
        attachment_id: z.string().trim().uuid().describe('Attachment UUID (from nexora_attachment_list)'),
      },
    },
    async ({ display_id, attachment_id }: { display_id: string; attachment_id: string }) => {
      try {
        const projectId = await client.requireProjectId();
        const itemUuid = await client.resolveDisplayId(display_id, projectId);

        // Construct the download endpoint per the confirmed API shape.
        const downloadPath = client.workItemsPath(
          projectId,
          itemUuid,
          'attachments',
          attachment_id,
          'download',
        );

        const result = await client.getBytes(downloadPath, {
          maxBytes: MAX_BYTES,
          allowedRedirectHosts: allowedRedirectHosts(),
        });

        const size = result.bytes.length;
        const header = [
          `# Downloaded attachment`,
          `mime_type: ${esc(result.mimeType)}`,
          `size_bytes: ${size}`,
          `sha256: ${esc(result.sha256)}`,
          `redirect_hops: ${result.hops}`,
        ];

        // Always write to tmpdir + return path (PM-329 — removed inline base64
        // branch; MCP per-response token cap is tighter than the 2 MiB raw
        // threshold could ever fit). Agent uses Read on the path — Claude's
        // multimodal Read handles images natively.
        const filePath = await writeAttachmentAtomically(
          result.bytes,
          result.sha256,
          result.mimeType,
        );
        header.push(`mode: tmpdir-path`);
        header.push(`path: ${esc(filePath)}`);
        return toolResult(header.join('\n'));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 3. UPLOAD ATTACHMENT (work item)
  server.registerTool(
    'nexora_attachment_upload',
    {
      title: 'Upload Attachment',
      description:
        'Upload a local file as a work-item attachment (PM-424). Reads the file at `path`, ' +
        'sends multipart/form-data to `POST /projects/{p}/work-items/{wi}/attachments`. ' +
        'MIME type is inferred from the file extension; backend rejects types outside ' +
        'its document_allowed_types_list. Rejects files >50 MiB before upload.',
      inputSchema: {
        display_id: z.string().trim().min(1).describe('Work item display ID (e.g., PM-42)'),
        path: z.string().trim().min(1).describe('Local filesystem path to the file to upload'),
        file_name: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe('Override the displayed filename (defaults to basename(path))'),
      },
    },
    async ({ display_id, path, file_name }: { display_id: string; path: string; file_name?: string }) => {
      try {
        const { blob, name } = await readLocalFileAsBlob(path, file_name);
        const projectId = await client.requireProjectId();
        const itemUuid = await client.resolveDisplayId(display_id, projectId);

        const fd = new FormData();
        fd.set('file', blob, name);

        const attachment = await client.uploadFile<Attachment>(
          client.workItemsPath(projectId, itemUuid, 'attachments'),
          fd,
        );

        return toolResult(
          [
            `Uploaded attachment to ${display_id}`,
            formatAttachment(attachment),
            `id: ${attachment.id}`,
          ].join('\n'),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 4. UPLOAD COMMENT ATTACHMENT
  server.registerTool(
    'nexora_comment_attachment_upload',
    {
      title: 'Upload Comment Attachment',
      description:
        'Upload a local file as an attachment on a work-item comment (PM-424). ' +
        'Provide either `comment_id` (attach to an existing comment) OR `create_comment` ' +
        '(mint a fresh comment first, then attach). Exactly one of the two is required.',
      inputSchema: {
        display_id: z.string().trim().min(1).describe('Work item display ID (e.g., PM-42)'),
        path: z.string().trim().min(1).describe('Local filesystem path to the file to upload'),
        comment_id: z
          .string()
          .trim()
          .uuid()
          .optional()
          .describe('Existing comment UUID to attach to. Mutually exclusive with create_comment.'),
        create_comment: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe('Body of a new comment to create + attach the file to. Mutually exclusive with comment_id.'),
        file_name: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe('Override the displayed filename (defaults to basename(path))'),
      },
    },
    async ({
      display_id,
      path,
      comment_id,
      create_comment,
      file_name,
    }: {
      display_id: string;
      path: string;
      comment_id?: string;
      create_comment?: string;
      file_name?: string;
    }) => {
      try {
        if (!!comment_id === !!create_comment) {
          return errorResult(
            new Error('Provide exactly one of `comment_id` (existing comment) or `create_comment` (mint new).'),
          );
        }
        const { blob, name } = await readLocalFileAsBlob(path, file_name);
        const projectId = await client.requireProjectId();
        const itemUuid = await client.resolveDisplayId(display_id, projectId);

        let targetCommentId: string;
        let preface = '';
        let createdNewComment = false;
        if (comment_id) {
          targetCommentId = comment_id;
        } else {
          // Create the comment first, then upload to its endpoint.
          const created = await client.post<{ id: string }>(
            client.workItemsPath(projectId, itemUuid, 'comments'),
            { content: create_comment },
          );
          targetCommentId = created.id;
          createdNewComment = true;
          preface = `Created comment ${targetCommentId}\n`;
        }

        const fd = new FormData();
        fd.set('file', blob, name);

        let attachment: Attachment;
        try {
          attachment = await client.uploadFile<Attachment>(
            client.workItemsPath(projectId, itemUuid, 'comments', targetCommentId, 'attachments'),
            fd,
          );
        } catch (uploadErr) {
          // PM-424 / Codex review #3: best-effort rollback so a partial
          // success doesn't leave an empty comment behind. If the rollback
          // delete itself fails (network blip, race), the upload error is
          // what the caller cares about — surface that.
          if (createdNewComment) {
            try {
              await client.delete(
                client.workItemsPath(projectId, itemUuid, 'comments', targetCommentId),
              );
            } catch {
              /* swallow rollback failure; original upload error wins */
            }
          }
          throw uploadErr;
        }

        return toolResult(
          [
            preface +
              `Uploaded attachment to comment ${targetCommentId} on ${display_id}`,
            formatAttachment(attachment),
            `id: ${attachment.id}`,
          ].join('\n'),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
