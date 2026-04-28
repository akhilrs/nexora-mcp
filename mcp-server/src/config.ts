import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';

const CONFIG_FILENAME = '.nexora.toml';

const ConfigSchema = z.object({
  apiUrl: z
    .string()
    .url()
    .default('http://localhost:8000/api/v1')
    .transform((url) => url.replace(/\/+$/, '')),
  apiKey: z.string().min(1, 'NEXORA_API_KEY is required (set as environment variable)'),
  organizationId: z.string().uuid('organization.id must be a valid UUID'),
  defaultProjectCode: z.string().optional(),
  requestTimeoutMs: z.coerce.number().int().positive().default(30_000),
});

export type NexoraConfig = z.infer<typeof ConfigSchema>;

/**
 * Walk up from startDir looking for .nexora.toml (like .git discovery).
 * Stops at filesystem root or home directory.
 */
function findConfigFile(startDir: string): string | null {
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
 * Parse a .nexora.toml file and extract config values.
 *
 * Expected format:
 *   [api]
 *   url = "https://nexora.example.com/api/v1"
 *
 *   [organization]
 *   id = "uuid-here"
 *
 *   [project]
 *   code = "PRJ-001"
 *
 *   [request]
 *   timeout_ms = 30000
 */
function loadTomlConfig(filePath: string): Record<string, string | undefined> {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const doc = parseToml(content) as Record<string, unknown>;

    const api = doc.api as Record<string, unknown> | undefined;
    const org = doc.organization as Record<string, unknown> | undefined;
    const project = doc.project as Record<string, unknown> | undefined;
    const request = doc.request as Record<string, unknown> | undefined;

    return {
      apiUrl: asString(api?.url),
      organizationId: asString(org?.id),
      defaultProjectCode: asString(project?.code),
      requestTimeoutMs: asString(request?.timeout_ms),
    };
  } catch {
    return {};
  }
}

function asString(value: unknown): string | undefined {
  if (value == null) return undefined;
  return String(value);
}

/**
 * Load and validate Nexora MCP configuration.
 *
 * Priority (highest wins):
 *   1. Environment variables — NEXORA_API_KEY (secrets), NEXORA_API_URL, etc.
 *   2. .nexora.toml — project-level config, walked up from cwd
 *   3. Defaults (api url = localhost:8000)
 *
 * API key is ONLY loaded from env vars — never from the config file.
 */
export function loadConfig(): NexoraConfig {
  const configPath = findConfigFile(process.cwd());
  const fileConfig = configPath ? loadTomlConfig(configPath) : {};

  const merged = {
    apiUrl: process.env.NEXORA_API_URL ?? fileConfig.apiUrl,
    apiKey: process.env.NEXORA_API_KEY,
    organizationId: process.env.NEXORA_ORG_ID ?? fileConfig.organizationId,
    defaultProjectCode: process.env.NEXORA_PROJECT_CODE ?? fileConfig.defaultProjectCode,
    requestTimeoutMs: process.env.NEXORA_TIMEOUT_MS ?? fileConfig.requestTimeoutMs,
  };

  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Nexora MCP configuration error:\n${issues}\n\n` +
      `Create a ${CONFIG_FILENAME} file in your project root:\n\n` +
      `  [api]\n` +
      `  url = "http://localhost:8000/api/v1"\n\n` +
      `  [organization]\n` +
      `  id = "your-org-uuid"\n\n` +
      `  [project]\n` +
      `  code = "PRJ-001"\n\n` +
      `And set the API key as an environment variable:\n` +
      `  export NEXORA_API_KEY=nxr_your_key_here`,
    );
  }

  return result.data;
}
