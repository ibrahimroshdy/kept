/**
 * The one fetch wrapper. Same origin, cookies included, JSON in and out. Every failure becomes an
 * `ApiError` with a Kept `ErrorCode`, whether the body is Kept's `{error, hint, code}` (§7.7) or
 * Better Auth's `{message, code}` (its codes are upper-case, e.g. INVALID_EMAIL_OR_PASSWORD, and
 * are kept in `authCode`). A network failure is `offline`, so a screen can say "Needs a
 * connection" (§3) instead of a generic error.
 */
import { type ErrorCode, isErrorCode } from '@kept/shared';

export type ApiErrorCode = ErrorCode | 'offline';

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly hint: string | undefined;
  /** Better Auth's own code, when the error came from /api/v1/auth. */
  readonly authCode: string | undefined;
  /** Seconds, from a 429's Retry-After / X-Retry-After header. */
  readonly retryAfter: number | undefined;
  /**
   * A Kept body's fields beyond `{error, hint, code}`: a 412's `{conflicts, row_version,
   * changedBy}` (D156), a 409's `{counts}` (contents_choice_required) or `{existingId}`.
   */
  readonly details: Record<string, unknown>;
  /** Kept's `code` when this client doesn't know it yet (`code` then falls back to the status). */
  readonly serverCode: string | undefined;

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    opts: {
      hint?: string;
      authCode?: string;
      retryAfter?: number;
      details?: Record<string, unknown>;
      serverCode?: string;
    } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.hint = opts.hint;
    this.authCode = opts.authCode;
    this.retryAfter = opts.retryAfter;
    this.details = opts.details ?? {};
    this.serverCode = opts.serverCode;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/** Better Auth answers with HTTP statuses and its own codes; map them onto Kept's. */
function codeFromStatus(status: number, authCode: string | undefined): ErrorCode {
  if (authCode === 'MFA_REQUIRED') return 'mfa_required';
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 412) return 'precondition_failed';
  if (status === 429) return 'rate_limited';
  if (status >= 400 && status < 500) return 'validation';
  return 'internal';
}

function retryAfterOf(res: Response): number | undefined {
  const raw = res.headers.get('retry-after') ?? res.headers.get('x-retry-after');
  const n = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** A failed response as an ApiError, its extra body fields in `details`. */
export async function toApiError(res: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Not JSON (a proxy's HTML error page, say): fall back to the status.
  }
  const b = (body ?? {}) as { error?: unknown; hint?: unknown; code?: unknown; message?: unknown };
  const rawCode = typeof b.code === 'string' ? b.code : undefined;
  const retryAfter = retryAfterOf(res);
  const { error: _e, hint: _h, code: _c, message: _m, ...details } = b as Record<string, unknown>;
  if (rawCode && isErrorCode(rawCode)) {
    return new ApiError(res.status, rawCode, typeof b.error === 'string' ? b.error : rawCode, {
      ...(typeof b.hint === 'string' ? { hint: b.hint } : {}),
      ...(retryAfter !== undefined ? { retryAfter } : {}),
      details,
    });
  }
  // Kept's own shape with a code this build doesn't list yet (a newer server): keep it all.
  if (rawCode && typeof b.error === 'string') {
    return new ApiError(res.status, codeFromStatus(res.status, undefined), b.error, {
      ...(typeof b.hint === 'string' ? { hint: b.hint } : {}),
      ...(retryAfter !== undefined ? { retryAfter } : {}),
      details,
      serverCode: rawCode,
    });
  }
  const message =
    typeof b.message === 'string'
      ? b.message
      : typeof b.error === 'string'
        ? b.error
        : res.statusText || `HTTP ${res.status}`;
  return new ApiError(res.status, codeFromStatus(res.status, rawCode), message, {
    ...(rawCode ? { authCode: rawCode } : {}),
    ...(retryAfter !== undefined ? { retryAfter } : {}),
  });
}

export type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

/**
 * The browser's IANA time zone, sent as `x-kept-timezone` on every call: the server reads it when
 * it creates an account (accounts/ensure-account.ts), so a new profile and its Personal location
 * start in the person's zone rather than UTC. Omitted if the browser can't say.
 */
function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The header on a write that recorded an undoable change (engineering spec §7.7; the server's
 * `AUDIT_EVENT_HEADER` in apps/server/src/http/write.ts): the audit event's id, for the Undo
 * toast's `POST /api/v1/audit/:eventId/undo`.
 */
export const AUDIT_EVENT_HEADER = 'x-kept-audit-event';

/**
 * The event ids in an `X-Kept-Audit-Event` value: one, or one per thing for a bulk move
 * (comma-separated, in write order), or none when the header is absent (nothing undoable).
 */
export function auditEventIds(value: string | null): string[] {
  return value
    ? value
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
    : [];
}

/** A write's body, with the undoable audit events it recorded (`auditEventIds`). */
export type Written<T> = { body: T; auditEvents: string[] };

async function send<T>(path: string, opts: RequestOptions): Promise<{ body: T; res: Response }> {
  const tz = browserTimeZone();
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(tz ? { 'x-kept-timezone': tz } : {}),
    ...opts.headers,
  };
  const init: RequestInit = {
    method: opts.method ?? 'GET',
    credentials: 'include',
    headers,
  };
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  if (opts.signal) init.signal = opts.signal;
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'offline', 'Needs a connection');
  }
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return { body: undefined as T, res };
  const text = await res.text();
  return { body: (text ? JSON.parse(text) : undefined) as T, res };
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  return (await send<T>(path, opts)).body;
}

/** `request`, keeping the undoable audit events the write recorded, for its Undo toast. */
export async function requestWritten<T>(
  path: string,
  opts: RequestOptions = {},
): Promise<Written<T>> {
  const { body, res } = await send<T>(path, opts);
  return { body, auditEvents: auditEventIds(res.headers.get(AUDIT_EVENT_HEADER)) };
}

/** `If-Match: <rowVersion>` for a versioned write (§7.7), or nothing. */
export const ifMatch = (rowVersion: number | undefined): Record<string, string> | undefined =>
  rowVersion === undefined ? undefined : { 'if-match': String(rowVersion) };

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, signal ? { signal } : {}),
  post: <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
    request<T>(path, { method: 'POST', body: body ?? {}, ...(headers ? { headers } : {}) }),
  put: <T>(path: string, body: unknown, headers?: Record<string, string>) =>
    request<T>(path, { method: 'PUT', body, ...(headers ? { headers } : {}) }),
  patch: <T>(path: string, body: unknown, headers?: Record<string, string>) =>
    request<T>(path, { method: 'PATCH', body, ...(headers ? { headers } : {}) }),
  del: <T = void>(path: string, body?: unknown) =>
    request<T>(path, { method: 'DELETE', ...(body === undefined ? {} : { body }) }),
};

/** Writes that can be undone: the body plus the audit event ids to undo them with (D150). */
export const written = {
  post: <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
    requestWritten<T>(path, {
      method: 'POST',
      body: body ?? {},
      ...(headers ? { headers } : {}),
    }),
  patch: <T>(path: string, body: unknown, headers?: Record<string, string>) =>
    requestWritten<T>(path, { method: 'PATCH', body, ...(headers ? { headers } : {}) }),
};

/** The server's largest page (§7.7). */
const PAGE = 200;
/** A bound on pages followed, so a server bug can't loop the client forever. */
const MAX_PAGES = 100;

/**
 * Follows `nextCursor` through every page of a paginated list (§7.7), `query` added to each
 * request. Step 1's lists are short (locations, members, admin lists), so screens hold them
 * whole; a list that grows gets real paging with the list-surface standard.
 */
export async function allPages<P extends { nextCursor?: string | null }>(
  path: string,
  collect: (page: P) => void,
  query: Record<string, string> = {},
): Promise<void> {
  let cursor: string | null | undefined = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const params = new URLSearchParams({ ...query, limit: String(PAGE) });
    if (cursor) params.set('cursor', cursor);
    const page: P = await api.get<P>(`${path}?${params}`);
    collect(page);
    cursor = page.nextCursor;
    if (!cursor) return;
  }
}
