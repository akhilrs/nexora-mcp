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
  private currentUserIdCache: string | undefined;

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

  async resolveCurrentUserId(): Promise<string | undefined> {
    if (this.currentUserIdCache) return this.currentUserIdCache;

    try {
      const me = await this.get<{ id: string; employee_id?: string }>('/me');
      const userId = me.employee_id ?? me.id;
      if (userId) {
        this.currentUserIdCache = userId;
      }
      return this.currentUserIdCache;
    } catch {
      return undefined;
    }
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

  /**
   * PM-424: multipart/form-data upload. The shared `request()` always sets
   * `Content-Type: application/json` and JSON-stringifies the body; for
   * file uploads we need fetch to derive the boundary-bearing Content-Type
   * from the FormData itself and stream the body as-is.
   *
   * Auth + retry semantics: same as request() except POST is NOT idempotent,
   * so we don't retry on 5xx/429 here (an upload partial-success is worse
   * than a clean error the caller can act on). Timeout via AbortController.
   */
  async uploadFile<T = unknown>(path: string, formData: FormData): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'X-Organization-ID': this.organizationId,
          // Deliberately NO Content-Type — fetch + FormData set the right
          // multipart/form-data; boundary=... header automatically.
          Accept: 'application/json',
        },
        body: formData,
        signal: controller.signal,
      });

      if (response.status === 204) {
        return undefined as T;
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) {
        const text = await response.text().catch(() => '');
        // Upload callers always parse JSON off the response (Attachment.id etc.).
        // A 2xx with non-JSON body is server misconfiguration; surface it as
        // an error so callers don't try to deref a string. Codex review #1.
        throw new NexoraApiError(
          `HTTP ${response.status}: ${text.slice(0, 200) || 'non-JSON response on upload'}`,
          response.status,
        );
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
        const message = apiError?.error?.message ?? `HTTP ${response.status}`;
        const code = apiError?.error?.code;
        const details = apiError?.error?.details;
        throw this.mapHttpError(response.status, message, code, details);
      }

      return data as T;
    } catch (error) {
      if (error instanceof NexoraApiError) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new NetworkError(`Upload timed out after ${this.timeoutMs}ms`);
      }
      if (error instanceof TypeError) {
        throw new NetworkError(`Network error: ${error.message}`, error);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
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

  // PM-327: getBytes — raw binary download with redirect inspection + byte cap.
  // Used by nexora_attachment_download to follow Nexora's 302 to a signed
  // storage URL (s3.qs0.dev by default), validate the redirect target, then
  // stream bytes with a hard byte budget. Server-side SSRF defense:
  // - HTTPS-only on every hop
  // - Host allowlist (canonicalized: lowercase + strip trailing dot)
  // - Rejects IPv4/IPv6 literals + userinfo in redirect Location
  // - Accept-Encoding: identity to prevent gzip-bomb amplification
  // - Streaming byte cap (does NOT trust Content-Length as ground truth)
  // - connect + body timeouts via AbortController
  async getBytes(path: string, opts: {
    maxBytes: number;
    allowedRedirectHosts: string[];
    connectTimeoutMs?: number;
    bodyTimeoutMs?: number;
    maxRedirectHops?: number;
  }): Promise<{ bytes: Buffer; mimeType: string; sha256: string; hops: number }> {
    const crypto = await import('node:crypto');
    const connectTimeout = opts.connectTimeoutMs ?? 10000;
    const bodyTimeout = opts.bodyTimeoutMs ?? 60000;
    const maxHops = opts.maxRedirectHops ?? 2;
    // Canonicalize allowlist (defense-in-depth: don't trust caller to have done it)
    const allowedHosts = opts.allowedRedirectHosts
      .map((h) => h.trim().toLowerCase().replace(/\.+$/, ''))
      .filter(Boolean);

    let currentUrl = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    let useAuth = true;
    let hops = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const controller = new AbortController();
      const connectTimer = setTimeout(() => controller.abort(), connectTimeout);

      const headers: Record<string, string> = {
        'Accept-Encoding': 'identity',
      };
      if (useAuth) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
        headers['X-Organization-ID'] = this.organizationId;
      }

      let response: Response;
      try {
        response = await fetch(currentUrl, {
          method: 'GET',
          headers,
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(connectTimer);
        if (err instanceof DOMException && err.name === 'AbortError') {
          throw new NetworkError(`getBytes connect timed out after ${connectTimeout}ms`);
        }
        if (err instanceof TypeError) {
          throw new NetworkError(`getBytes network error: ${err.message}`, err);
        }
        throw err;
      }
      clearTimeout(connectTimer);

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        hops++;
        if (hops > maxHops) {
          throw new NetworkError(`getBytes exceeded ${maxHops} redirect hops`);
        }
        const location = response.headers.get('location');
        if (!location || location.trim().length === 0) {
          throw new NetworkError(`${response.status} redirect missing Location header`);
        }
        let nextUrl: URL;
        try {
          nextUrl = new URL(location, currentUrl);
        } catch {
          throw new NetworkError(`invalid redirect URL: ${location.slice(0, 120)}`);
        }
        if (nextUrl.protocol !== 'https:') {
          throw new NetworkError(`redirect to non-https scheme: ${nextUrl.protocol}`);
        }
        if (nextUrl.username || nextUrl.password) {
          throw new NetworkError(`redirect contains userinfo — refused`);
        }
        let host = nextUrl.hostname.toLowerCase();
        if (host.endsWith('.')) host = host.replace(/\.+$/, '');
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
          throw new NetworkError(`redirect to IPv4 literal refused: ${host}`);
        }
        if (host.startsWith('[') || host.includes(':')) {
          throw new NetworkError(`redirect to IPv6 literal refused: ${host}`);
        }
        // #5: constrain port — default 443 only (no s3.qs0.dev:4443 bypass)
        if (nextUrl.port !== '' && nextUrl.port !== '443') {
          throw new NetworkError(`redirect to non-default port refused: ${nextUrl.port}`);
        }
        if (!allowedHosts.includes(host)) {
          throw new NetworkError(
            `redirect to disallowed host: ${host} (allowed: ${allowedHosts.join(', ')})`,
          );
        }
        currentUrl = nextUrl.href;
        useAuth = false;
        try { await response.body?.cancel(); } catch { /* swallow */ }
        continue;
      }

      if (!response.ok) {
        try { await response.body?.cancel(); } catch { /* swallow */ }
        throw new NetworkError(`getBytes failed: ${response.status} ${response.statusText}`);
      }

      const declared = response.headers.get('content-length');
      if (declared) {
        const declaredN = parseInt(declared, 10);
        if (!isNaN(declaredN) && declaredN > opts.maxBytes) {
          throw new NetworkError(
            `Content-Length ${declaredN} exceeds byte budget ${opts.maxBytes}`,
          );
        }
      }

      const mimeType = (response.headers.get('content-type') ?? 'application/octet-stream')
        .split(';')[0]
        .trim();

      if (!response.body) {
        throw new NetworkError('getBytes: no response body');
      }

      const hash = crypto.createHash('sha256');
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let total = 0;
      const bodyTimer = setTimeout(() => controller.abort(), bodyTimeout);
      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > opts.maxBytes) {
            try { await reader.cancel(); } catch { /* swallow */ }
            throw new NetworkError(
              `streamed bytes exceeded budget during download (cap ${opts.maxBytes})`,
            );
          }
          const buf = Buffer.from(value);
          hash.update(buf);
          chunks.push(buf);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          throw new NetworkError(`getBytes body read timed out after ${bodyTimeout}ms`);
        }
        throw err;
      } finally {
        clearTimeout(bodyTimer);
      }

      return {
        bytes: Buffer.concat(chunks, total),
        mimeType,
        sha256: hash.digest('hex'),
        hops,
      };
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
