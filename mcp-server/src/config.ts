import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

const CONFIG_FILENAME = '.nexora.properties';

const ConfigSchema = z.object({
  apiUrl: z
    .string()
    .url()
    .default('http://localhost:8000/api/v1')
    .transform((url) => url.replace(/\/+$/, '')),
  apiKey: z.string().min(1, 'NEXORA_API_KEY is required (set as environment variable)'),
  organizationId: z.string().uuid('nexora.organization.id must be a valid UUID'),
  defaultProjectCode: z.string().optional(),
  requestTimeoutMs: z.coerce.number().int().positive().default(30_000),
});

export type NexoraConfig = z.infer<typeof ConfigSchema>;

/**
 * Parse a .properties file (key=value per line, # comments, blank lines ignored).
 */
function parseProperties(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

/**
 * Walk up from startDir looking for .nexora.properties (like .git discovery).
 * Stops at filesystem root or home directory.
 */
function findPropertiesFile(startDir: string): string | null {
  const home = homedir();
  let dir = resolve(startDir);

  for (let depth = 0; depth < 50; depth++) {
    const candidate = join(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;

    const parent = dirname(dir);
    if (parent === dir || dir === home) break;
    dir = parent;
  }

  return null;
}

/**
 * Load config from .nexora.properties file.
 * Maps dotted property keys to flat config keys.
 */
function loadPropertiesConfig(): Record<string, string> {
  const filePath = findPropertiesFile(process.cwd());
  if (!filePath) return {};

  try {
    const content = readFileSync(filePath, 'utf-8');
    return parseProperties(content);
  } catch {
    return {};
  }
}

/**
 * Map property keys (nexora.api.url) to internal config keys (apiUrl).
 */
function mapPropertyKeys(props: Record<string, string>): Record<string, string | undefined> {
  return {
    apiUrl: props['nexora.api.url'],
    organizationId: props['nexora.organization.id'],
    defaultProjectCode: props['nexora.project.code'],
    requestTimeoutMs: props['nexora.request.timeout.ms'],
  };
}

/**
 * Load and validate Nexora MCP configuration.
 *
 * Priority (highest wins):
 *   1. Environment variables — NEXORA_API_KEY (secrets), NEXORA_API_URL, etc.
 *   2. .nexora.properties — project-level file, walked up from cwd
 *   3. Defaults (api url = localhost:8000)
 *
 * API key is ONLY loaded from env vars — never from the properties file.
 */
export function loadConfig(): NexoraConfig {
  const props = mapPropertyKeys(loadPropertiesConfig());

  const merged = {
    apiUrl: process.env.NEXORA_API_URL ?? props.apiUrl,
    apiKey: process.env.NEXORA_API_KEY,
    organizationId: process.env.NEXORA_ORG_ID ?? props.organizationId,
    defaultProjectCode: process.env.NEXORA_PROJECT_CODE ?? props.defaultProjectCode,
    requestTimeoutMs: process.env.NEXORA_TIMEOUT_MS ?? props.requestTimeoutMs,
  };

  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Nexora MCP configuration error:\n${issues}\n\n` +
      `Create a ${CONFIG_FILENAME} file in your project root:\n` +
      `  nexora.api.url=http://localhost:8000/api/v1\n` +
      `  nexora.organization.id=your-org-uuid\n` +
      `  nexora.project.code=PRJ-001\n\n` +
      `And set the API key as an environment variable:\n` +
      `  export NEXORA_API_KEY=nxr_your_key_here`,
    );
  }

  return result.data;
}
