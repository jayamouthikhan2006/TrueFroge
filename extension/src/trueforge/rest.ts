// Minimal typed REST client for TrueForge's settings/agents endpoints. These
// are driven by the declarative snake_case files in trueforge-config/, so they
// are sent as-is rather than through the SDK's camelCase serializers. Session,
// turn and streaming traffic goes through @truefoundry/trueforge-sdk instead
// (see TrueForgeClient.ts).

export class TrueForgeHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'TrueForgeHttpError';
  }
}

export interface RestOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
}

export class TrueForgeRest {
  private readonly baseUrl: string;

  constructor(private readonly options: RestOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
  }

  get origin(): string {
    return this.baseUrl;
  }

  async request<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    if (this.options.apiKey) {
      headers.authorization = `Bearer ${this.options.apiKey}`;
    }
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 15000);
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const text = await response.text();
    let parsed: unknown = undefined;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!response.ok) {
      const message = extractErrorMessage(parsed) ?? `${response.status} ${response.statusText}`;
      throw new TrueForgeHttpError(response.status, `${method} ${path} failed (${response.status}): ${message}`, parsed);
    }
    return parsed as T;
  }
}

function extractErrorMessage(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'error' in body) {
    const error = (body as { error?: { message?: unknown } }).error;
    if (error && typeof error.message === 'string') {
      return error.message;
    }
  }
  return typeof body === 'string' && body.length > 0 ? body.slice(0, 500) : undefined;
}
