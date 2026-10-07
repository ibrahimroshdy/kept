/**
 * The mock server's building blocks, shared by server.ts and the per-area handler modules under
 * api/inventory/mock/. A handler returns a body (200), a `MockReply` (any status), or a promise of
 * either; `routes()` lists an area's handlers so server.ts can compose them.
 */
import type { MockState } from './fixtures';

export type MockRequest = {
  method: string;
  path: string;
  params: Record<string, string>;
  /** The query string, e.g. `query.get('cursor')`. */
  query: URLSearchParams;
  /** Lower-cased request header names (`if-match`, `x-kept-sha256`, …). */
  headers: Record<string, string>;
  body: unknown;
};

export class MockReply {
  constructor(
    readonly status: number,
    readonly body?: unknown,
  ) {}
}

export type Handler = (req: MockRequest) => MockReply | unknown | Promise<MockReply | unknown>;

/** A handler's answer for "not mine": the server tries the next matching route. For paths two
 * areas share (step 3's import routes, which step 7's archive runs use too). */
export const PASS: unique symbol = Symbol('pass');

export type MockRoute = { method: string; template: string; handler: Handler };

/** An area's handlers, given the live state (api/inventory/mock/*.ts). */
export type AreaRoutes = (state: MockState) => MockRoute[];

export const reply = (status: number, body?: unknown) => new MockReply(status, body);

/** Kept's error shape (§7.7), with any extra top-level fields (`conflicts`, `counts`, …). */
export const err = (
  status: number,
  code: string,
  error: string,
  hint?: string,
  extra?: Record<string, unknown>,
) => reply(status, { error, code, ...(hint ? { hint } : {}), ...extra });

export const notFound = () => err(404, 'not_found', 'Not found.');
export const forbidden = () => err(403, 'forbidden', "You don't have permission.");

export const route = (method: string, template: string, handler: Handler): MockRoute => ({
  method,
  template,
  handler,
});

/** A 401 while signed out or mid-MFA, like the server's session gate; null when fine. */
export function sessionGate(state: MockState): MockReply | null {
  if (!state.signedIn) return err(401, 'unauthenticated', 'Sign in to continue.');
  if (state.mfaPending) return err(403, 'mfa_required', 'Confirm your second factor to continue.');
  return null;
}
