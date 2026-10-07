import { isAPIError } from 'better-auth/api';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { Pools } from '../db/pools.js';
import type { Scope } from '../db/scope.js';
import type { KeptApp } from '../http/app.js';
import { AppError, invalid, unauthenticated } from '../http/errors.js';
import { AUTH_BASE_PATH, type Auth } from './auth.js';
import { authRequestHeaders, ClientIpError, requestClientIp } from './client-ip.js';
import { gateSession, type ResolvedSession, resolveSession } from './session.js';
import { limiterKey, reserveInWindow } from './sign-in-limiter.js';

// Better Auth on Fastify, and the session every Kept route sees (task 17; D176, D181, §7.14).
//
// How a route says who may call it (`config.auth`):
// - 'required' (the default, for every route that doesn't say otherwise; security review M1): a
//   signed-in session whose second factor, if the user enrolled one, was proven in it. Otherwise
//   401 `unauthenticated`, or 403 `mfa_required` for a pending session (spike S2's gate).
// - 'optional': the same session when there is one, else `req.scope` stays null. A pending
//   session counts as none.
// - 'none': no session lookup at all. Each public route says so itself: health, the web bundle
//   and its SPA fallback (the not-found handler), the OpenAPI document, the Better Auth mount,
//   token-holding links such as the magic-link POST, sign-up and setup.
// `config.allowMfaPending: true` lets a pending session
// through a 'required' route with `req.authSession` set but `req.scope` null: for the few routes
// that finish or abandon sign-in.
//
// A handler reads `req.scope` ({userId, mfa}) and runs its queries in
// `withScope(app.pools.app, req.scope, …)`; `requireScope(req)` narrows it for TypeScript.
// `req.authSession` carries the rest (session id, 2FA state) for the few routes that need it.

export type AuthMode = 'required' | 'optional' | 'none';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Who may call this route; see auth/http.ts. Default: 'required'. */
    auth?: AuthMode;
    /** Lets a session still waiting for its second factor reach a 'required' route. */
    allowMfaPending?: boolean;
  }
  interface FastifyRequest {
    /** The resolved Better Auth session, when the route looked one up; null otherwise. */
    authSession: ResolvedSession | null;
  }
}

/** The route's auth mode: its own `config.auth`, else 'required'. An unmatched URL reaches
 * only the not-found handler (a JSON 404, or the SPA's index.html), so it needs no session. */
export function authMode(req: FastifyRequest): AuthMode {
  if (req.is404) return 'none';
  return req.routeOptions.config.auth ?? 'required';
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** `Authorization: Bearer kpt_…`: a personal token (step 6, tokens/verify.ts). */
const PERSONAL_BEARER = /^Bearer\s+kpt_/i;

/**
 * CSRF (security review I4). A write that carries a cookie must come from Kept's own pages:
 * its `Origin` is the origin of KEPT_PUBLIC_URL, or, when the browser sent no usable Origin
 * (absent, or `null`), `Sec-Fetch-Site: same-origin`. Anything else is 403 `forbidden`, before
 * the session is looked up or the body is parsed, on every route: a `text/plain` or multipart
 * form posted from another site (a CORS "simple request", which no preflight stops) never
 * reaches a handler with the victim's cookie.
 *
 * Better Auth's mount runs its own origin check on the same requests (cookie + unsafe method →
 * Origin, or Referer, must be a trusted origin, which is exactly KEPT_PUBLIC_URL's). This hook
 * runs first and is the stricter of the two (no Referer fallback), so the two never disagree in
 * the permissive direction. A request without a cookie has no ambient authority to abuse and is
 * left to the route.
 */
export function csrfHook(publicUrl: string) {
  const expected = new URL(publicUrl).origin;
  return async function checkRequestOrigin(req: FastifyRequest) {
    if (SAFE_METHODS.has(req.method) || !req.headers.cookie) return;
    // A personal token's request ignores cookies (tokens/verify.ts): no ambient authority to
    // abuse, and another site can't set Authorization without a CORS preflight Kept never answers.
    if (PERSONAL_BEARER.test(String(req.headers.authorization ?? ''))) return;
    const origin = req.headers.origin;
    if (origin && origin !== 'null') {
      if (origin === expected) return;
    } else if (req.headers['sec-fetch-site'] === 'same-origin') {
      return;
    }
    throw new AppError('forbidden', 403, 'The request did not come from this site.');
  };
}

/** The scope of a route that required a session. */
export function requireScope(req: FastifyRequest): Scope {
  if (!req.scope) throw unauthenticated();
  return req.scope;
}

/** The request's headers as Better Auth must see them: the client address decided from the
 * socket and KEPT_TRUSTED_PROXIES (auth/client-ip.ts), never from what the client wrote. */
export function authHeaders(req: FastifyRequest, trustedProxies: readonly string[]): Headers {
  try {
    const headers = authRequestHeaders({
      headers: req.headers,
      remoteAddress: req.socket.remoteAddress,
      trustedProxies,
    });
    // Hop-by-hop and framing headers describe this connection, not the Request we build.
    for (const name of ['host', 'connection', 'content-length', 'transfer-encoding', 'expect']) {
      headers.delete(name);
    }
    return headers;
  } catch (err) {
    if (err instanceof ClientIpError) {
      throw invalid('The client address could not be determined.');
    }
    throw err;
  }
}

/** Copies Set-Cookie (each one separately) from a Better Auth response onto the reply. */
export function forwardCookies(reply: FastifyReply, headers: Headers | null | undefined): void {
  const cookies = headers?.getSetCookie() ?? [];
  if (cookies.length === 0) return;
  const existing = reply.getHeader('set-cookie');
  const before = existing === undefined ? [] : Array.isArray(existing) ? existing : [existing];
  reply.header('set-cookie', [...before.map(String), ...cookies]);
}

export type SessionHookOptions = {
  auth: Auth | null;
  pools: Pick<Pools, 'auth'>;
  trustedProxies: readonly string[];
  /** Runs for every request that got a scope (task 18: the cached ensureAccount check). */
  onScope?: (req: FastifyRequest, scope: Scope, headers: Headers) => Promise<void>;
};

/** The onRequest hook that decides `req.scope` and `req.authSession` for every route. */
export function sessionHook(opts: SessionHookOptions) {
  return async function resolveRequestSession(req: FastifyRequest, reply: FastifyReply) {
    const mode = authMode(req);
    if (mode === 'none') return;
    // A personal token already gave the request its scope (tokens/verify.ts bearerHook, which
    // runs first); its cookies, if any, are ignored.
    if (req.token) return;
    let session: ResolvedSession | null = null;
    let headers: Headers | null = null;
    // No cookie, no session: skip the lookup (and its database round trip).
    if (opts.auth && req.headers.cookie) {
      headers = authHeaders(req, opts.trustedProxies);
      const resolved = await resolveSession(opts.auth, opts.pools.auth, headers);
      // A sliding refresh re-issues the cookie (D181: never over plain HTTP).
      forwardCookies(reply, resolved.responseHeaders);
      session = resolved.session;
    }
    req.authSession = session;
    const decision = gateSession(session);
    if (decision.ok) {
      req.scope = decision.scope;
      if (opts.onScope && headers) await opts.onScope(req, decision.scope, headers);
      return;
    }
    if (mode === 'optional') return;
    if (decision.code === 'mfa_required' && req.routeOptions.config.allowMfaPending) return;
    throw new AppError(decision.code, decision.status);
  };
}

export type AuthRoutesOptions = {
  auth: Auth;
  pools: Pick<Pools, 'auth'>;
  publicUrl: string;
  trustedProxies: readonly string[];
};

/** Removes every `token` field, at any depth, from a Better Auth JSON body (security review
 * M6). The session lives in an HttpOnly cookie; a token in a body is one a script on the page
 * could read and carry off. */
export function withoutTokens(body: unknown): unknown {
  if (Array.isArray(body)) return body.map(withoutTokens);
  if (body === null || typeof body !== 'object') return body;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (key === 'token') continue;
    out[key] = withoutTokens(value);
  }
  return out;
}

const TOKEN = z.string().min(1).max(512);

/** The body limit of routes anyone may call without a session (security review M8). */
export const ANONYMOUS_BODY_LIMIT = 16_384;

/** Per client IP, attempts at the routes that redeem a mailed token (security review M5). */
export const TOKEN_ATTEMPTS_PER_IP_PER_HOUR = 30;

/** 429 with the wait in the body and in Retry-After (what the web client reads). */
export function rateLimited(reply: FastifyReply, retryAfter: number): AppError {
  reply.header('retry-after', String(retryAfter));
  return new AppError('rate_limited', 429, undefined, { retryAfter });
}

/**
 * Reserves one token redemption for the request's client IP (security review M5): the
 * magic-link and email-change confirmations. A token is 32 random bytes, so this bounds load
 * and log noise rather than guessing; it is shared across replicas like every Kept limiter.
 */
export async function reserveTokenAttempt(
  authPool: pg.Pool,
  headers: Headers,
  reply: FastifyReply,
): Promise<void> {
  const ip = requestClientIp(headers);
  if (!ip) throw invalid('The client address could not be determined.');
  const decision = await reserveInWindow(
    authPool,
    limiterKey('token-ip', ip),
    TOKEN_ATTEMPTS_PER_IP_PER_HOUR,
    3600,
  );
  if (!decision.allowed) throw rateLimited(reply, decision.retryAfter);
}

/** The Better Auth mount at /api/v1/auth/*, and Kept's magic-link confirm. */
export async function authRoutes(app: KeptApp, opts: AuthRoutesOptions): Promise<void> {
  const { auth, trustedProxies, pools } = opts;
  const origin = new URL(opts.publicUrl).origin;

  // OAuth's token, revoke and introspect endpoints take form bodies (step 6, T12; spike S6.2):
  // inside the mount only, a form body reaches Better Auth as the raw string it was sent as.
  await app.register(async (child) => {
    child.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => done(null, body),
    );
    child.route({
      method: ['GET', 'POST'],
      url: `${AUTH_BASE_PATH}/*`,
      config: { auth: 'none' },
      // Anonymous callers: no reason to accept more than a sign-in form (security review M8).
      bodyLimit: ANONYMOUS_BODY_LIMIT,
      schema: { hide: true },
      handler: async (req, reply) => {
        const headers = authHeaders(req, trustedProxies);
        // Our origin, never the Host header the client sent.
        const url = new URL(req.url, origin);
        const init: RequestInit = { method: req.method, headers };
        if (req.method === 'POST' && req.body !== undefined) {
          init.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
        }
        const res = await auth.handler(new Request(url, init));

        reply.code(res.status);
        for (const [name, value] of res.headers) {
          if (name === 'set-cookie' || name === 'content-length') continue;
          reply.header(name, value);
        }
        forwardCookies(reply, res.headers);
        const text = await res.text();
        const json = (res.headers.get('content-type') ?? '').includes('application/json');
        if (!json || !text || res.status >= 300) return reply.send(text || undefined);
        return reply.send(JSON.stringify(withoutTokens(JSON.parse(text))));
      },
    });
  });

  // D176: the emailed link opens /auth/confirm#token=…, and that page POSTs the token here:
  // Better Auth's own path, taken over for POST. Its GET (which would consume the token) is
  // switched off (DISABLED_AUTH_PATHS) and answers 404 through the mount, so a mail scanner
  // following any link reaches only the web page, which does nothing until the person acts.
  app.post(
    `${AUTH_BASE_PATH}/magic-link/verify`,
    {
      config: { auth: 'none' },
      bodyLimit: ANONYMOUS_BODY_LIMIT,
      schema: {
        body: z.object({ token: TOKEN }),
        response: { 200: z.object({ mfaRequired: z.boolean() }) },
      },
    },
    async (req, reply) => {
      const headers = authHeaders(req, trustedProxies);
      await reserveTokenAttempt(pools.auth, headers, reply);
      const result = await auth.api
        .magicLinkVerify({ query: { token: req.body.token }, headers, returnHeaders: true })
        .catch((err: unknown) => {
          // Unknown, used or expired: Better Auth answers with a redirect carrying the reason.
          if (isAPIError(err)) throw new AppError('token_invalid', 400);
          throw err;
        });
      forwardCookies(reply, result.headers);
      // With two-factor enrolled the new session is pending until TOTP, a backup code or a
      // passkey with user verification is proven in it (spike S2). Read afresh: a first magic
      // link to an unverified address has just removed any two-factor (D197), after Better Auth
      // built its answer.
      const { id } = result.response.user as { id: string };
      const { rows } = await pools.auth.query<{ tfa: boolean }>(
        'SELECT coalesce(two_factor_enabled, false) AS tfa FROM auth."user" WHERE id = $1',
        [id],
      );
      return { mfaRequired: rows[0]?.tfa === true };
    },
  );
}
