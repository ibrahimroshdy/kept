import { pgErrorOf } from '../http/errors.js';

// Optional error reporting (D84; step-8 plan T14; docs/spikes/2026-10-06-step8-observability.md):
// with KEPT_ERROR_DSN (any Sentry-compatible DSN) a request that fails with a 5xx is reported.
// Unset, nothing is loaded and nothing leaves the server; there is no telemetry of any kind.
//
// `@sentry/core` alone, not `@sentry/node` (whose tree carries a FSL-licensed CLI and 64 MiB),
// imported only when the DSN is set. No integrations, no default PII, and an event rebuilt from
// an allowlist before it is sent: the exception's type and stack, the request id and the route
// pattern (`/api/v1/things/:id`, never the path with its ids or a query string). Never a body, a
// header, a cookie, a user, breadcrumbs, or the error's message, which can quote a value (a pg
// error's `Key (email)=(…)`); a database error is named by its SQLSTATE code instead.

type ReportContext = { requestId: string; route: string | null };

type Reporter = {
  capture: (err: unknown, ctx: ReportContext) => void;
  close: (timeoutMs: number) => Promise<void>;
};

let reporter: Reporter | null = null;

const SEND_TIMEOUT_MS = 5_000;
const ROUTE = /^[A-Za-z0-9/:_.*-]{1,200}$/;

/** What the event may say about the error in place of its message. */
function summary(err: unknown): { type: string; value: string } {
  const pg = pgErrorOf(err);
  if (pg) return { type: 'DatabaseError', value: `SQLSTATE ${pg.code ?? 'unknown'}` };
  const name = err instanceof Error ? err.name : 'Error';
  const type = /^[A-Za-z0-9_$.]{1,64}$/.test(name) ? name : 'Error';
  return { type, value: `${type} (message withheld)` };
}

export type ErrorReportingOptions = {
  dsn: string;
  release: string;
  /** Default: `fetch`. Tests pass their own. */
  fetch?: typeof fetch;
};

/** Starts reporting to `dsn`. Throws on a DSN Sentry's client can't parse, at boot. */
export async function startErrorReporting(opts: ErrorReportingOptions): Promise<void> {
  const [{ createStackParser, createTransport }, { nodeStackLineParser, ServerRuntimeClient }] =
    await Promise.all([import('@sentry/core'), import('@sentry/core/server')]);
  const doFetch = opts.fetch ?? fetch;
  const client = new ServerRuntimeClient({
    dsn: opts.dsn,
    release: opts.release,
    environment: 'production',
    integrations: [],
    sendDefaultPii: false,
    maxBreadcrumbs: 0,
    stackParser: createStackParser(nodeStackLineParser()),
    transport: (options) =>
      createTransport(options, async (request) => {
        const res = await doFetch(options.url, {
          method: 'POST',
          body: request.body as BodyInit,
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        await res.body?.cancel().catch(() => {});
        return {
          statusCode: res.status,
          headers: {
            'x-sentry-rate-limits': res.headers.get('x-sentry-rate-limits'),
            'retry-after': res.headers.get('retry-after'),
          },
        };
      }),
    beforeSend(event, hint) {
      const ctx = hint.data as ReportContext | undefined;
      const { type, value } = summary(hint.originalException);
      const values = event.exception?.values ?? [];
      // Only these fields leave: the rest of the event (contexts, extra, request, user, …) is
      // dropped, whatever the SDK put there.
      return {
        type: undefined,
        event_id: event.event_id,
        timestamp: event.timestamp,
        level: 'error',
        platform: event.platform,
        release: event.release,
        environment: event.environment,
        exception: {
          values: values.slice(-1).map((v) => ({
            type,
            value,
            ...(v.stacktrace ? { stacktrace: v.stacktrace } : {}),
            ...(v.mechanism ? { mechanism: v.mechanism } : {}),
          })),
        },
        tags: {
          request_id: ctx?.requestId ?? 'none',
          route: ctx?.route && ROUTE.test(ctx.route) ? ctx.route : 'unknown',
        },
      };
    },
  });
  client.init();
  reporter = {
    capture: (err, ctx) => {
      client.captureException(err, { data: ctx });
    },
    close: async (timeoutMs) => {
      await client.close(timeoutMs).then(
        () => {},
        () => {},
      );
    },
  };
}

/** Reports one failed request; nothing at all when reporting is off. Never throws. */
export function reportError(err: unknown, ctx: ReportContext): void {
  try {
    reporter?.capture(err, ctx);
  } catch {
    // Reporting must never turn into a second failure.
  }
}

/** Sends what is queued (bounded) and stops. */
export async function stopErrorReporting(timeoutMs = 2_000): Promise<void> {
  const r = reporter;
  reporter = null;
  await r?.close(timeoutMs);
}

export function errorReportingActive(): boolean {
  return reporter !== null;
}
