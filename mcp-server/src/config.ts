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
  timerAutoTrack: z
    .preprocess(
      (v) => (v === undefined || v === null || v === '' ? undefined : v),
      z.union([z.boolean(), z.string().transform((s) => s.toLowerCase() !== 'false')]),
    )
    .default(true),
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

  // Also check home directory as last resort
  const homeCandidate = join(home, CONFIG_FILENAME);
  if (existsSync(homeCandidate)) return homeCandidate;

  return null;
}

type FileConfigValues = Record<string, string | boolean | undefined>;

function loadTomlConfig(filePath: string): FileConfigValues {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const doc = parseToml(content) as Record<string, unknown>;

    const api = doc.api as Record<string, unknown> | undefined;
    const org = doc.organization as Record<string, unknown> | undefined;
    const project = doc.project as Record<string, unknown> | undefined;
    const request = doc.request as Record<string, unknown> | undefined;
    const timer = doc.timer as Record<string, unknown> | undefined;

    return {
      apiUrl: asString(api?.url),
      organizationId: asString(org?.id),
      defaultProjectCode: asString(project?.code),
      requestTimeoutMs: asString(request?.timeout_ms),
      timerAutoTrack: asBoolean(timer?.auto_track),
    };
  } catch {
    return {};
  }
}

function asString(value: unknown): string | undefined {
  if (value == null) return undefined;
  return String(value);
}

function asBoolean(value: unknown): boolean | undefined {
  if (value == null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() !== 'false';
  return undefined;
}

function resolveFileConfig(): FileConfigValues {
  // 1. Explicit config path
  if (process.env.NEXORA_CONFIG_PATH) {
    const explicit = resolve(process.env.NEXORA_CONFIG_PATH);
    if (existsSync(explicit)) return loadTomlConfig(explicit);
  }

  // 2. Walk up from NEXORA_PROJECT_DIR if set
  if (process.env.NEXORA_PROJECT_DIR) {
    const dir = resolve(process.env.NEXORA_PROJECT_DIR);
    if (existsSync(dir)) {
      const found = findConfigFile(dir);
      if (found) return loadTomlConfig(found);
    }
  }

  // 3. Walk up from cwd
  const found = findConfigFile(process.cwd());
  if (found) return loadTomlConfig(found);

  return {};
}

function buildConfig(): NexoraConfig {
  const fileConfig = resolveFileConfig();

  const merged = {
    apiUrl: process.env.NEXORA_API_URL ?? fileConfig.apiUrl,
    apiKey: process.env.NEXORA_API_KEY,
    organizationId: process.env.NEXORA_ORG_ID ?? fileConfig.organizationId,
    defaultProjectCode: process.env.NEXORA_PROJECT_CODE ?? fileConfig.defaultProjectCode,
    requestTimeoutMs: process.env.NEXORA_TIMEOUT_MS ?? fileConfig.requestTimeoutMs,
    timerAutoTrack:
      process.env.NEXORA_TIMER_AUTO_TRACK ?? fileConfig.timerAutoTrack,
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
      `Set the API key as an environment variable:\n` +
      `  export NEXORA_API_KEY=nxr_your_key_here\n\n` +
      `If running as a Claude Code plugin, also set:\n` +
      `  export NEXORA_PROJECT_DIR=/path/to/your/project`,
    );
  }

  return result.data;
}

/**
 * Lazy config loader — doesn't fail until first tool call.
 *
 * The MCP server starts from the plugin cache directory where
 * process.cwd() won't find .nexora.toml. Config resolution uses:
 *   1. NEXORA_CONFIG_PATH — explicit path to .nexora.toml
 *   2. NEXORA_PROJECT_DIR — walk up from this directory
 *   3. process.cwd() — walk up from current directory
 *   4. ~ (home directory) — last resort
 *
 * Environment variables override file config:
 *   NEXORA_API_URL, NEXORA_API_KEY, NEXORA_ORG_ID,
 *   NEXORA_PROJECT_CODE, NEXORA_TIMEOUT_MS
 *
 * API key is ONLY loaded from env vars — never from the config file.
 */
export function loadConfig(): NexoraConfig {
  return buildConfig();
}

let _cachedConfig: NexoraConfig | null = null;
let _configError: Error | null = null;

/**
 * Get config lazily — caches on first successful load.
 * Throws only when actually called, not at server startup.
 */
export function getConfig(): NexoraConfig {
  if (_cachedConfig) return _cachedConfig;
  if (_configError) throw _configError;

  try {
    _cachedConfig = buildConfig();
    return _cachedConfig;
  } catch (error) {
    _configError = error as Error;
    throw error;
  }
}

/**
 * Reset cached config — useful if env vars change at runtime.
 */
export function resetConfig(): void {
  _cachedConfig = null;
  _configError = null;
}
