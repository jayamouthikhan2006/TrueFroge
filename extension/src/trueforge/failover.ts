// Classifies TrueForge turn errors for automatic model failover.
//
// TrueForge reports model-side failures as `turn.done` with
// `state.status === "error"` and a message prefixed `[Model Error]`, e.g.
//   [Model Error] Cannot connect to API:
//   [Model Error] Request failed (401): Incorrect API key provided
//   [Model Error] Request failed (503): upstream overloaded
// (observed against TrueForge 0.185). ForgeCode adds its own
// `[Model Error] Timed out ...` when the model produces no output in time.

export type FailureKind = 'connection' | 'timeout' | 'auth' | 'not_found' | 'rate_limit' | 'server' | 'request' | 'harness' | 'other';

export interface FailureClass {
  kind: FailureKind;
  status?: number;
  /** Short human label for banners/toasts: "Connection Refused", "401 Unauthorized", ... */
  label: string;
  /** Whether re-dispatching on another model can help. */
  failover: boolean;
}

const STATUS_LABELS: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Model Not Found',
  408: 'Request Timeout',
  409: 'Conflict',
  413: 'Payload Too Large',
  422: 'Unprocessable',
  429: 'Rate Limited',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  529: 'Overloaded',
};

export function classifyFailure(message: string): FailureClass {
  const text = message.trim();
  const isModel = /\[Model Error\]/i.test(text);
  const status = Number(/(?:Request failed|status(?: code)?)\s*\(?\s*(\d{3})\)?/i.exec(text)?.[1] ?? NaN);
  if (Number.isFinite(status)) {
    const label = `${status} ${STATUS_LABELS[status] ?? 'Error'}`;
    if (status === 401 || status === 403) {
      return { kind: 'auth', status, label, failover: true };
    }
    if (status === 404) {
      return { kind: 'not_found', status, label, failover: true };
    }
    if (status === 408) {
      return { kind: 'timeout', status, label, failover: true };
    }
    if (status === 429) {
      return { kind: 'rate_limit', status, label, failover: true };
    }
    if (status >= 500) {
      return { kind: 'server', status, label, failover: true };
    }
    return { kind: 'request', status, label, failover: false };
  }
  if (/cannot connect|ECONNREFUSED|connection refused|ENOTFOUND|EAI_AGAIN|ECONNRESET|socket hang up|fetch failed|network|getaddrinfo|EHOSTUNREACH/i.test(text)) {
    return { kind: 'connection', label: 'Connection Refused', failover: isModel || /api|model/i.test(text) };
  }
  if (/timed? ?out|ETIMEDOUT|UND_ERR_(CONNECT|HEADERS|BODY)_TIMEOUT|deadline/i.test(text)) {
    return { kind: 'timeout', label: 'Timeout', failover: true };
  }
  if (isModel) {
    return { kind: 'other', label: 'Model Error', failover: true };
  }
  return { kind: 'harness', label: 'TrueForge Error', failover: false };
}

export function failoverMessage(primary: FailureClass, fallbackModel: string): string {
  return `Primary model failed (${primary.label}). Automatically failing over to Backup Model (${fallbackModel})...`;
}
