import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestApp, testApp } from '../../test/app.js';
import { testDb } from '../../test/db.js';
import { NEVER_FOR_TOKENS, TOKEN_ROUTES, tokenAccessOf } from './access.js';

// The token column of the route catalogue (plan T10, Q20): every entry names a real route, none
// is on the "never" list, and the user-level surfaces (the person's settings and profile, AI
// providers and keys, tokens and OAuth grants, the assistant) stay closed to tokens.

const db = await testDb();

describe('token access (Q20)', () => {
  let t: TestApp;
  const routes = new Set<string>();

  beforeAll(async () => {
    t = await testApp(db, {
      onRoute: (route) => {
        const methods = Array.isArray(route.method) ? route.method : [route.method];
        for (const m of methods) routes.add(`${m} ${route.url}`);
      },
    });
  });
  afterAll(() => t.app.close());

  it('lists only routes that exist', () => {
    const missing = Object.keys(TOKEN_ROUTES).filter((r) => !routes.has(r));
    expect(missing, 'a token entry names a route that is not registered').toEqual([]);
  });

  it('opens nothing on the never list', () => {
    const never = Object.keys(TOKEN_ROUTES).filter((r) => {
      const url = r.split(' ')[1] ?? '';
      return NEVER_FOR_TOKENS.some((re) => re.test(url));
    });
    expect(never).toEqual([]);
  });

  it('keeps every user-level route closed to tokens', () => {
    const userLevel = [...routes].filter((r) =>
      /^\S+ \/api\/v1\/(me|ai|tokens|connections|oauth|assistant|admin|auth)(\/|$)/.test(r),
    );
    expect(userLevel.length).toBeGreaterThan(10);
    const open = userLevel.filter((r) => {
      const [method, url] = r.split(' ') as [string, string];
      return tokenAccessOf(method, url) !== 'none';
    });
    expect(open).toEqual([]);
    // A GET never needs a write token, and a write route is never open to a read one.
    for (const [route, access] of Object.entries(TOKEN_ROUTES)) {
      if (route.startsWith('GET ')) expect(access, route).toBe('read');
      else expect(access, route).toBe('write');
    }
  });
});
