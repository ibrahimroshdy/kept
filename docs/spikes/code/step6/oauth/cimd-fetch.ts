/**
 * The CIMD metadata transport on Kept's own SSRF guard (apps/server/src/net/ssrf.ts), imported
 * as-is: this is the shape T12's `oauth/cimd-fetch.ts` would take.
 *
 * What the cimd plugin already does around the transport (read in @better-auth/cimd 1.7.6
 * dist/index.mjs, fetchClientMetadataDocument): validateClientIdUrl() (https, explicit path, no
 * fragment/credentials/dot segments, host not special-use *syntactically*), a 5 s timeout via
 * AbortSignal (passed in `init.signal`), `redirect: 'error'` in `init` plus a `response.redirected`
 * check, status must be 200 (or 304 with validators), Content-Type must be JSON, a 5 KB body
 * cap, JSON parse and the draft/profile validation. Any exception thrown by the transport is
 * swallowed into `invalid_client: Failed to fetch metadata document (network error or redirect
 * blocked)`, so the log below is the only place the guard's own verdict is visible.
 */
import type { ClientMetadataResourceFetch } from '@better-auth/oauth-provider';
import { guardedFetch, PrivateAddressError } from '../../../../../apps/server/src/net/ssrf.js';

export type Resolve = NonNullable<Parameters<typeof guardedFetch>[0]['resolve']>;

export type FetchLogEntry = {
  transport: string;
  url: string;
  ms: number;
  status?: number;
  error?: string;
};

export function createGuardedCimdFetch(opts: {
  allowPrivate: boolean;
  resolve?: Resolve;
  label: string;
  log: FetchLogEntry[];
}): ClientMetadataResourceFetch {
  const fetchGuarded = guardedFetch({ allowPrivate: opts.allowPrivate, resolve: opts.resolve });
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const started = performance.now();
    try {
      // Only what the plugin sends: GET, its Accept/conditional headers, its abort signal.
      // guardedFetch forces `redirect: 'error'` itself.
      const res = await fetchGuarded(url, {
        method: 'GET',
        headers: init?.headers,
        signal: init?.signal ?? null,
      });
      opts.log.push({ transport: opts.label, url, ms: performance.now() - started, status: res.status });
      return res;
    } catch (err) {
      opts.log.push({ transport: opts.label, url, ms: performance.now() - started, error: describe(err) });
      throw err;
    }
  };
}

/** The error and its cause chain, one line. */
export function describe(err: unknown): string {
  const parts: string[] = [];
  for (let c: unknown = err, i = 0; c && i < 5; c = (c as { cause?: unknown }).cause, i++) {
    const e = c as { name?: string; message?: string; code?: string; address?: string };
    if (c instanceof PrivateAddressError) {
      parts.push(`PrivateAddressError(${e.address})`);
      continue;
    }
    parts.push(`${e.name ?? 'Error'}${e.code ? `[${e.code}]` : ''}: ${e.message ?? String(c)}`);
  }
  return parts.join(' <- ');
}
