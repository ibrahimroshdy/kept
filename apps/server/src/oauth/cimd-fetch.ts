import type { ClientMetadataResourceFetch } from '@better-auth/oauth-provider';
import { guardedFetch, type Resolve } from '../net/ssrf.js';

// The transport for Client ID Metadata Documents (step-6 plan T12; D125, D128; spike S6.2 §7).
// A connector's `client_id` is a URL the client chose, so its metadata is fetched through Kept's
// SSRF guard **always with private addresses refused**, whatever `ssrf_allow_private` says for AI
// base URLs: the address is resolved once inside the connection's lookup and that connection is
// pinned to it (no check-then-connect gap), redirects are refused, and every special-use range
// is refused (net/ssrf.ts). The cimd plugin itself checks the URL's form, the 5 s timeout, the
// JSON content type, the 5 KB cap and the metadata (S6.2 §7), and swallows the transport's own
// error into `invalid_client`; so the guard's verdict is logged here (the URL without its query).

export type CimdLog = { warn: (obj: object, msg: string) => void };

export function cimdFetch(
  opts: { log?: CimdLog; resolve?: Resolve } = {},
): ClientMetadataResourceFetch {
  const fetchGuarded = guardedFetch({
    allowPrivate: false,
    ...(opts.resolve ? { resolve: opts.resolve } : {}),
  });
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    try {
      // Only what the plugin sends: GET, its Accept and conditional headers, its abort signal.
      return await fetchGuarded(url, {
        method: 'GET',
        ...(init?.headers ? { headers: init.headers } : {}),
        signal: init?.signal ?? null,
      });
    } catch (err) {
      const where = URL.canParse(url) ? new URL(url) : null;
      opts.log?.warn(
        {
          clientIdUrl: where ? `${where.origin}${where.pathname}` : 'unparseable',
          reason: describe(err),
        },
        'client metadata fetch refused',
      );
      throw err;
    }
  };
}

/** The error and its causes, one line, no values beyond names and codes. */
function describe(err: unknown): string {
  const parts: string[] = [];
  for (let c: unknown = err, i = 0; c && i < 4; c = (c as { cause?: unknown }).cause, i++) {
    const e = c as { name?: string; code?: string; message?: string };
    parts.push(`${e.name ?? 'Error'}${e.code ? `[${e.code}]` : ''}: ${e.message ?? ''}`);
  }
  return parts.join(' <- ');
}
