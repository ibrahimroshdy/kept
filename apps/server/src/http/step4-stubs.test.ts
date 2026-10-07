import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestApp, testApp } from '../../test/app.js';
import { testDb } from '../../test/db.js';

// Step 4 (plan T2): the public token routes exist from the start, need no session, and answer
// JSON 404 for any token until T17 (the calendar feed) builds its own. They must never fall
// through to the SPA's index.html, nor ask for a sign-in. T18 built claim packs: an unknown
// `/x/` token is the 410 "This link has expired" page (incidents/incidents.test.ts covers it).

const db = await testDb();

describe('the step-4 public token routes (T2)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await testApp(db);
  });
  afterAll(() => t.app.close());

  it.each(['/cal/abc123'])('GET %s is public and a JSON 404 for an unknown token', async (url) => {
    const res = await t.app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.json()).toMatchObject({ code: 'not_found' });
  });

  it('GET /x/<unknown> is public: the 410 expired page, not the SPA', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/x/abc123' });
    expect(res.statusCode).toBe(410);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.body).toContain('This link has expired');
  });
});
