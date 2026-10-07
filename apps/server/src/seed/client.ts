import type { LightMyRequestResponse } from 'fastify';
import type { KeptApp } from '../http/app.js';

// The seed's HTTP client on an in-process Kept app (app.inject): the real routes, so every
// policy, audit event, hook and invariant a person would meet applies to what the seed makes.

export class SeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedError';
  }
}

export type Json = Record<string, unknown>;

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export type CallOptions = {
  cookie?: string;
  /** A JSON body, or raw bytes (an upload). */
  body?: unknown;
  headers?: Record<string, string>;
};

/** A browser-like client on the in-process app: an Origin on every request (CSRF), a fresh
 * documentation-range address per request (per-IP limits), cookies kept by the caller. */
export class Client {
  #n = 0;
  constructor(
    readonly app: KeptApp,
    private readonly publicUrl: string,
  ) {}

  async call(method: Method, url: string, opts: CallOptions = {}): Promise<LightMyRequestResponse> {
    this.#n += 1;
    const headers: Record<string, string> = { origin: this.publicUrl, ...opts.headers };
    if (opts.cookie) headers.cookie = opts.cookie;
    return this.app.inject({
      method,
      url,
      headers,
      remoteAddress: `198.51.100.${(this.#n % 250) + 1}`,
      ...(opts.body !== undefined ? { payload: opts.body as object } : {}),
    });
  }
}

/** The Cookie header a browser would send after this response. */
export function cookieOf(res: LightMyRequestResponse): string {
  const raw = res.headers['set-cookie'];
  const lines = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  return lines
    .map((line) => line.split(';')[0] ?? '')
    .filter((pair) => pair && !pair.endsWith('='))
    .join('; ');
}

/** The response's JSON when its status is one of `ok`; otherwise a SeedError naming `what`. */
export function expectStatus(res: LightMyRequestResponse, ok: number[], what: string): Json {
  if (!ok.includes(res.statusCode)) {
    throw new SeedError(`${what}: ${res.statusCode} ${res.body.slice(0, 300)}`);
  }
  return res.body ? (res.json() as Json) : {};
}
