import type { NexoraConfig } from './config.js';
import {
  AuthenticationError,
  ForbiddenError,
  NetworkError,
  NexoraApiError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from './errors.js';

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

const IDEMPOTENT_METHODS = new Set<HttpMethod>(['GET', 'DELETE']);
const MAX_RETRIES = 1;
const BASE_BACKOFF_MS = 1_000;
const DISPLAY_ID_CACHE_MAX = 500;

interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
  };
}

export class NexoraClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly organizationId: string;
  private readonly timeoutMs: number;
  private projectCode: string | undefined;

  private readonly displayIdCache = new Map<string, string>();

  constructor(config: NexoraConfig) {
    this.baseUrl = config.apiUrl;
    this.apiKey = config.apiKey;
    this.organizationId = config.organizationId;
    this.projectCode = config.defaultProjectCode;
    this.timeoutMs = config.requestTimeoutMs;
  }

  get currentProjectCode(): string | undefined {
    return this.projectCode;
  }

  private projectIdCache: string | undefined;

  switchProject(code: string): void {
    this.projectCode = code;
    this.projectIdCache = undefined;
    this.displayIdCache.clear();
  }

  async requireProjectId(): Promise<string> {
    if (this.projectIdCache) return this.projectIdCache;

    if (!this.projectCode) {
      throw new NexoraApiError(
        'No project configured. Set NEXORA_PROJECT_CODE or call nexora_project_switch first.',
        400,
        'NO_PROJECT',
      );
    }

    const result = await this.get<Array<{ id: string; code: string }>>(
      '/projects',
      { limit: '50' },
    );
    const projects = Array.isArray(result) ? result : [];
    const match = projects.find(
      (p) => typeof p.code === 'string' && p.code.toLowerCase() === this.projectCode!.toLowerCase(),
    );
    if (!match) {
      throw new NotFoundError(`Project '${this.projectCode}' not found`);
    }

    this.projectIdCache = match.id;
    return match.id;
  }

  workItemsPath(projectId: string, ...segments: string[]): string {
    const base = `/projects/${encodeURIComponent(projectId)}/work-items`;
    if (segments.length === 0) return base;
    const encoded = segments.map((s) => encodeURIComponent(s)).join('/');
    return `${base}/${encoded}`;
  }

  async get<T = unknown>(path: string, query?: Record<string, string>): Promise<T> {
    const url = query ? `${path}?${new URLSearchParams(query)}` : path;
    return this.request<T>('GET', url);
  }

  async post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  async patch<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }

  async delete<T = unknown>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  async resolveDisplayId(displayId: string, projectId: string): Promise<string> {
    const cacheKey = `${projectId}:${displayId}`;
    const cached = this.displayIdCache.get(cacheKey);
    if (cached) return cached;

    const item = await this.get<{ id: string }>(
      `/projects/${projectId}/work-items/${displayId}`,
    );

    if (this.displayIdCache.size >= DISPLAY_ID_CACHE_MAX) {
      const firstKey = this.displayIdCache.keys().next().value;
      if (firstKey) this.displayIdCache.delete(firstKey);
    }

    this.displayIdCache.set(cacheKey, item.id);
    return item.id;
  }

  private async request<T>(
    method: HttpMethod,
    path: string,
    body?: unknown,
    retryCount = 0,
  ): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.apiKey}`,
        'X-Organization-ID': this.organizationId,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };

      const response = await fetch(url, {
        method,
        headers,
        body: body != null ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (response.status === 204) {
        return undefined as T;
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) {
        const text = await response.text().catch(() => '');
        if (!response.ok) {
          throw new NexoraApiError(
            `HTTP ${response.status}: ${text.slice(0, 200) || 'non-JSON response'}`,
            response.status,
          );
        }
        return text as T;
      }

      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw new NexoraApiError(
          `HTTP ${response.status}: invalid JSON in response`,
          response.status,
        );
      }

      if (!response.ok) {
        const apiError = data as ApiErrorBody;
        const message =
          apiError?.error?.message ?? `HTTP ${response.status}`;
        const code = apiError?.error?.code;
        const details = apiError?.error?.details;

        if (
          retryCount < MAX_RETRIES &&
          IDEMPOTENT_METHODS.has(method) &&
          (response.status === 429 || response.status >= 500)
        ) {
          const retryAfter = response.headers.get('retry-after');
          const parsedRetry = retryAfter ? Number(retryAfter) : NaN;
          const retryMs = Number.isFinite(parsedRetry) && parsedRetry > 0
            ? Math.min(parsedRetry * 1_000, 60_000)
            : undefined;
          const backoff = retryMs ?? (BASE_BACKOFF_MS * 2 ** retryCount + Math.random() * 500);
          await sleep(backoff);
          return this.request<T>(method, path, body, retryCount + 1);
        }

        throw this.mapHttpError(response.status, message, code, details);
      }

      return data as T;
    } catch (error) {
      if (error instanceof NexoraApiError) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new NetworkError(`Request timed out after ${this.timeoutMs}ms`);
      }
      if (error instanceof TypeError) {
        throw new NetworkError(`Network error: ${error.message}`, error);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private mapHttpError(
    status: number,
    message: string,
    code?: string,
    details?: Record<string, unknown>,
  ): NexoraApiError {
    switch (status) {
      case 401:
        return new AuthenticationError(message);
      case 403:
        return new ForbiddenError(message);
      case 404:
        return new NotFoundError(message);
      case 422:
        return new ValidationError(message, details);
      case 429:
        return new RateLimitError(message);
      default:
        return new NexoraApiError(message, status, code, details);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
