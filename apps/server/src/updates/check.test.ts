import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type TestDb, testDb } from '../../test/db.js';
import { withSystem } from '../db/scope.js';
import { guardedFetch } from '../net/ssrf.js';
import {
  checkForUpdate,
  githubRepoOf,
  readUpdateCheck,
  runScheduledUpdateCheck,
  UPDATE_CHECK_ENABLED_KEY,
  UPDATE_CHECK_STATE_KEY,
  updateCheckDue,
} from './check.js';

// The update check (D65; plan T11) against a local stand-in for GitHub's API: never the
// internet. The stub records every request it gets, so "nothing sent but the request" and "no
// request at all" are both read off it.

type Seen = { method: string; url: string; headers: IncomingHttpHeaders };
type Answer = { status: number; headers?: Record<string, string>; body?: string };

let server: Server;
let apiBase: string;
const seen: Seen[] = [];
let answer: (url: string) => Answer = () => ({ status: 500 });

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    const a = answer(req.url ?? '');
    res.writeHead(a.status, { 'content-type': 'application/json', ...a.headers });
    res.end(a.body ?? '');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  seen.length = 0;
  answer = () => ({ status: 500 });
});

const SOURCE = 'https://github.com/bruce/kept/tree/0123456789abcdef';
// The stub is on 127.0.0.1, which the production fetch refuses: tests allow private addresses.
const local = {
  fetch: guardedFetch({ allowPrivate: true }),
  get apiBase() {
    return apiBase;
  },
};
const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  html_url: `https://github.com/bruce/kept/releases/tag/${tag}`,
  draft: false,
  prerelease: false,
  published_at: '2026-10-01T09:00:00Z',
  body: 'Notes.',
  assets: [],
  ...extra,
});
const ok = (body: unknown): Answer => ({ status: 200, body: JSON.stringify(body) });

describe('githubRepoOf (spike U1 rule)', () => {
  it('reads owner and repo from the image source label and nothing else', () => {
    expect(githubRepoOf(SOURCE)).toEqual({ owner: 'bruce', repo: 'kept' });
    expect(githubRepoOf('https://github.com/bruce/kept')).toEqual({ owner: 'bruce', repo: 'kept' });
    expect(githubRepoOf('https://github.com/bruce/kept.git')).toEqual({
      owner: 'bruce',
      repo: 'kept',
    });
    expect(githubRepoOf('https://github.com/x/y@abc123')).toEqual({ owner: 'x', repo: 'y' });
  });

  it('refuses anything that is not https://github.com/<owner>/<repo>', () => {
    for (const bad of [
      undefined,
      null,
      '',
      'not a url',
      'http://github.com/bruce/kept',
      'https://gitlab.com/bruce/kept',
      'https://github.com.evil.example/bruce/kept',
      'https://api.github.com/bruce/kept',
      'https://github.com:8443/bruce/kept',
      'https://u:p@github.com/bruce/kept',
      'https://github.com/bruce',
      'https://github.com/bru%2Fce/kept',
      'https://github.com/bruce/..',
    ]) {
      expect(githubRepoOf(bad), String(bad)).toBeNull();
    }
  });
});

describe('checkForUpdate', () => {
  it('asks the latest-release endpoint of that repository, with only the three headers', async () => {
    answer = () => ok(release('v1.3.0'));
    const result = await checkForUpdate({ sourceUrl: SOURCE, version: '1.2.0', ...local });
    expect(result).toEqual({
      latest: {
        version: '1.3.0',
        url: 'https://github.com/bruce/kept/releases/tag/v1.3.0',
        publishedAt: '2026-10-01T09:00:00Z',
      },
      error: null,
    });
    expect(seen).toHaveLength(1);
    const [req] = seen;
    expect(req?.method).toBe('GET');
    expect(req?.url).toBe('/repos/bruce/kept/releases/latest');
    expect(req?.headers['user-agent']).toBe('Kept');
    expect(req?.headers.accept).toBe('application/vnd.github+json');
    expect(req?.headers['x-github-api-version']).toBe('2026-03-10');
    // Nothing that identifies the instance or its version: no cookie, no auth, no referer, and
    // the running version appears nowhere in what was sent.
    for (const h of ['authorization', 'cookie', 'referer', 'origin', 'x-kept-version']) {
      expect(req?.headers[h]).toBeUndefined();
    }
    expect(JSON.stringify(req)).not.toContain('1.2.0');
  });

  it('the same or an older release is no update', async () => {
    answer = () => ok(release('v1.2.0'));
    expect(await checkForUpdate({ sourceUrl: SOURCE, version: '1.2.0', ...local })).toEqual({
      latest: null,
      error: null,
    });
    answer = () => ok(release('1.1.9'));
    expect(await checkForUpdate({ sourceUrl: SOURCE, version: '1.2.0', ...local })).toEqual({
      latest: null,
      error: null,
    });
  });

  it('a 404 (private, no release, gone) is not_found', async () => {
    answer = () => ({ status: 404, body: '{"message":"Not Found"}' });
    expect(await checkForUpdate({ sourceUrl: SOURCE, version: '1.2.0', ...local })).toEqual({
      latest: null,
      error: 'not_found',
    });
  });

  it('a 403 or 429 with no requests left is rate_limited; another 403 is unreachable', async () => {
    answer = () => ({ status: 403, headers: { 'x-ratelimit-remaining': '0' } });
    expect((await checkForUpdate({ sourceUrl: SOURCE, version: '1.2.0', ...local })).error).toBe(
      'rate_limited',
    );
    answer = () => ({ status: 429, headers: { 'x-ratelimit-remaining': '0' } });
    expect((await checkForUpdate({ sourceUrl: SOURCE, version: '1.2.0', ...local })).error).toBe(
      'rate_limited',
    );
    answer = () => ({ status: 403, body: 'Request forbidden by administrative rules.' });
    expect((await checkForUpdate({ sourceUrl: SOURCE, version: '1.2.0', ...local })).error).toBe(
      'unreachable',
    );
  });

  it('a redirect is never followed, and a 5xx or 410 is unreachable', async () => {
    answer = () => ({ status: 301, headers: { location: 'http://127.0.0.1:9/elsewhere' } });
    expect((await checkForUpdate({ sourceUrl: SOURCE, version: '1.2.0', ...local })).error).toBe(
      'unreachable',
    );
    expect(seen).toHaveLength(1);
    for (const status of [410, 502]) {
      answer = () => ({ status });
      expect((await checkForUpdate({ sourceUrl: SOURCE, version: '1.2.0', ...local })).error).toBe(
        'unreachable',
      );
    }
  });

  it('an unreadable answer is bad_response: not JSON, no semver tag, over the size cap', async () => {
    answer = () => ({ status: 200, body: '<html>' });
    expect((await checkForUpdate({ sourceUrl: SOURCE, version: '1.2.0', ...local })).error).toBe(
      'bad_response',
    );
    answer = () => ok(release('nightly'));
    expect((await checkForUpdate({ sourceUrl: SOURCE, version: '1.2.0', ...local })).error).toBe(
      'bad_response',
    );
    answer = () => ok(release('v9.0.0', { body: 'x'.repeat(4096) }));
    expect(
      (await checkForUpdate({ sourceUrl: SOURCE, version: '1.2.0', ...local, maxBodyBytes: 1024 }))
        .error,
    ).toBe('bad_response');
  });

  it('a source URL that is not GitHub sends nothing', async () => {
    const result = await checkForUpdate({
      sourceUrl: 'https://git.example.org/bruce/kept',
      version: '1.2.0',
      ...local,
    });
    expect(result).toEqual({ latest: null, error: 'not_github' });
    expect(seen).toHaveLength(0);
  });

  it('a running prerelease reads the release list and may be offered a newer prerelease', async () => {
    answer = () =>
      ok([
        release('v1.3.0-rc.2', { prerelease: true, draft: true }),
        release('v1.3.0-rc.1', { prerelease: true }),
        release('v1.2.0'),
      ]);
    const result = await checkForUpdate({ sourceUrl: SOURCE, version: '1.3.0-beta.4', ...local });
    expect(seen[0]?.url).toBe('/repos/bruce/kept/releases?per_page=10');
    // The draft is ignored even if a list ever held one.
    expect(result.latest?.version).toBe('1.3.0-rc.1');
    // A stable running version never sees prereleases: /latest has none.
    seen.length = 0;
    answer = () => ok(release('v1.2.0'));
    await checkForUpdate({ sourceUrl: SOURCE, version: '1.2.0', ...local });
    expect(seen[0]?.url).toBe('/repos/bruce/kept/releases/latest');
  });

  it('the default fetch refuses a private address, so a test can only reach its stub on purpose', async () => {
    answer = () => ok(release('v1.3.0'));
    const result = await checkForUpdate({ sourceUrl: SOURCE, version: '1.2.0', apiBase });
    expect(result.error).toBe('unreachable');
    expect(seen).toHaveLength(0);
  });
});

describe('updateCheckDue', () => {
  const at = (iso: string) => new Date(iso);
  it('asks once a day at the instance hour, or after two days whatever the hour', () => {
    const empty = { lastCheckedAt: null, latest: null, error: null };
    expect(updateCheckDue(empty, 5, at('2026-10-06T12:07:00Z'))).toBe(true);
    const asked = { ...empty, lastCheckedAt: '2026-10-05T05:07:00Z' };
    expect(updateCheckDue(asked, 5, at('2026-10-05T23:07:00Z'))).toBe(false);
    expect(updateCheckDue(asked, 5, at('2026-10-06T04:07:00Z'))).toBe(false);
    expect(updateCheckDue(asked, 5, at('2026-10-06T05:07:00Z'))).toBe(true);
    expect(updateCheckDue(asked, 5, at('2026-10-06T06:07:00Z'))).toBe(false);
    expect(updateCheckDue(asked, 5, at('2026-10-07T04:07:00Z'))).toBe(true);
  });
});

describe('the scheduled check, on the database', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await testDb();
  });
  beforeEach(async () => {
    await db.reset();
  });
  const inTx = <T>(fn: (c: import('pg').ClientBase) => Promise<T>) =>
    withSystem(db.pools.system, (_tx, c) => fn(c));
  const setEnabled = (on: boolean) =>
    inTx((c) =>
      c.query(
        `INSERT INTO public.instance_settings (key, value) VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        [UPDATE_CHECK_ENABLED_KEY, JSON.stringify(on)],
      ),
    );
  const state = () => inTx((c) => readUpdateCheck(c, {}));

  it('off (the default): no request at all', async () => {
    answer = () => ok(release('v9.9.9'));
    const asked = await runScheduledUpdateCheck(inTx, {
      env: {},
      sourceUrl: SOURCE,
      version: '1.2.0',
      ...local,
    });
    expect(asked).toBe(false);
    expect(seen).toHaveLength(0);
    expect(await state()).toEqual({
      enabled: false,
      locked: false,
      lastCheckedAt: null,
      latest: null,
      error: null,
    });
  });

  it('locked off by KEPT_UPDATE_CHECK=false even when the admin turned it on', async () => {
    await setEnabled(true);
    const asked = await runScheduledUpdateCheck(inTx, {
      env: { KEPT_UPDATE_CHECK: false },
      sourceUrl: SOURCE,
      version: '1.2.0',
      ...local,
    });
    expect(asked).toBe(false);
    expect(seen).toHaveLength(0);
    expect(await inTx((c) => readUpdateCheck(c, { KEPT_UPDATE_CHECK: false }))).toMatchObject({
      enabled: false,
      locked: true,
    });
  });

  it('on: asks, stores a newer release, then waits for the next day', async () => {
    await setEnabled(true);
    answer = () => ok(release('v1.3.0'));
    const now = new Date('2026-10-06T12:07:00Z');
    const run = () =>
      runScheduledUpdateCheck(inTx, {
        env: {},
        sourceUrl: SOURCE,
        version: '1.2.0',
        now,
        ...local,
      });
    expect(await run()).toBe(true);
    expect(await state()).toEqual({
      enabled: true,
      locked: false,
      lastCheckedAt: now.toISOString(),
      latest: {
        version: '1.3.0',
        url: 'https://github.com/bruce/kept/releases/tag/v1.3.0',
        publishedAt: '2026-10-01T09:00:00Z',
      },
      error: null,
    });
    // The hour is picked once and kept.
    const stored = await inTx(async (c) => {
      const { rows } = await c.query<{ value: { hour: number } }>(
        'SELECT value FROM public.instance_settings WHERE key = $1',
        [UPDATE_CHECK_STATE_KEY],
      );
      return rows[0]?.value;
    });
    expect(stored?.hour).toBeGreaterThanOrEqual(0);
    expect(stored?.hour).toBeLessThan(24);
    expect(await run()).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it('a rate limit is stored and not retried within the day', async () => {
    await setEnabled(true);
    answer = () => ({ status: 403, headers: { 'x-ratelimit-remaining': '0' } });
    const now = new Date('2026-10-06T12:07:00Z');
    await runScheduledUpdateCheck(inTx, {
      env: {},
      sourceUrl: SOURCE,
      version: '1.2.0',
      now,
      ...local,
    });
    expect((await state()).error).toBe('rate_limited');
    const hourLater = new Date('2026-10-06T13:07:00Z');
    expect(
      await runScheduledUpdateCheck(inTx, {
        env: {},
        sourceUrl: SOURCE,
        version: '1.2.0',
        now: hourLater,
        ...local,
      }),
    ).toBe(false);
    expect(seen).toHaveLength(1);
  });
});
