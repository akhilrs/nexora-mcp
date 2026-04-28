import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';

const ConfigSchema = z.object({
  apiUrl: z
    .string()
    .url()
    .default('http://localhost:8000/api/v1')
    .transform((url) => url.replace(/\/+$/, '')),
  apiKey: z.string().min(1, 'NEXORA_API_KEY is required'),
  organizationId: z.string().uuid('NEXORA_ORG_ID must be a valid UUID'),
  defaultProjectCode: z.string().optional(),
  requestTimeoutMs: z.coerce.number().int().positive().default(30_000),
});

export type NexoraConfig = z.infer<typeof ConfigSchema>;

function loadFileConfig(filePath?: string): Record<string, unknown> {
  const paths = filePath
    ? [filePath]
    : [
        resolve(process.cwd(), '.nexora-mcp.json'),
        resolve(homedir(), '.config', 'nexora-mcp', 'config.json'),
      ];

  for (const p of paths) {
    try {
      const raw = readFileSync(p, 'utf-8');
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // file not found or invalid — try next
    }
  }
  return {};
}

function mapFileKeys(file: Record<string, unknown>): Record<string, unknown> {
  return {
    apiUrl: file.api_url ?? file.apiUrl,
    apiKey: file.api_key ?? file.apiKey,
    organizationId: file.organization_id ?? file.organizationId,
    defaultProjectCode: file.default_project_code ?? file.defaultProjectCode,
    requestTimeoutMs: file.request_timeout_ms ?? file.requestTimeoutMs,
  };
}

export function loadConfig(): NexoraConfig {
  const fileConfig = mapFileKeys(loadFileConfig());

  const merged = {
    apiUrl: process.env.NEXORA_API_URL ?? fileConfig.apiUrl,
    apiKey: process.env.NEXORA_API_KEY ?? fileConfig.apiKey,
    organizationId: process.env.NEXORA_ORG_ID ?? fileConfig.organizationId,
    defaultProjectCode:
      process.env.NEXORA_PROJECT_CODE ?? fileConfig.defaultProjectCode,
    requestTimeoutMs: process.env.NEXORA_TIMEOUT_MS
      ? Number(process.env.NEXORA_TIMEOUT_MS)
      : fileConfig.requestTimeoutMs,
  };

  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Nexora MCP configuration error:\n${issues}`);
  }

  return result.data;
}
