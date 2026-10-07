import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestApp, testApp } from './app.js';
import { testDb } from './db.js';

// The route catalogue (D188; step-1 carry-over, T2). Every route that writes must leave an audit
// row, and a test must prove it. The app is built with every route module, each non-GET route is
// collected as it is added (buildApp's onRoute), and each one must either:
// - have a `// catalogue: <METHOD> <url>` marker in a test file, directly above (comment lines
//   between are fine) an `it(` case that asserts the audit row; or
// - be on ALLOWLIST below, with the reason no audit row is right.
//
// Adding a route: write the test that asserts its audit row, and put the marker above that case.
// A read-only POST (T11/T13/T15's `…/preview`) goes on the allowlist instead.
//
// "Asserts the audit row" is checked on the case's code, comments and its `it(` title left out
// (security review #2; the title alone used to pass):
// - an `expect(` within a few lines of a read of the audit: a helper whose name says so
//   (`eventsOf(`, `auditOf(`, `accountAudit(`, `lastEvent(`, …) or the `audit_events` table;
// - the route's last literal path segment (`reveal` for …/:fieldKey/reveal), in the case or in a
//   helper it calls (its file's, or test/*.ts's), so the case calls the route it is marked for;
// - several markers on one case must each name their own route: when they share that segment,
//   each method must be named in the case too (`'DELETE'`, `method: 'PATCH'`, or a helper named
//   after it).

const db = await testDb();

/** Non-GET routes that write no audit row, and why. */
const ALLOWLIST: Record<string, string> = {
  'POST /api/v1/auth/*':
    "Better Auth's own endpoints (sign-in and -out, passkeys, 2FA, password reset): authentication, not a change to Kept's data; the security notices they trigger are mailed (D197)",
  'POST /api/v1/auth/magic-link/verify':
    "Better Auth's magic-link sign-in behind Kept's attempt limiter: a sign-in, not an audited change",
  'POST /api/v1/types/:id/preview':
    'read-only: answers what a type change would touch (kept.type_impact, D92, D123) and changes nothing; the PATCH it previews is audited (type.update)',
  'POST /api/v1/type-fields/:id/convert/preview':
    'read-only: counts per location what converting a field would convert and send to the notes (kept.field_conversion_preview, never a value, D172, D177) and changes nothing; the conversion itself is audited (type.field_convert)',
  'POST /api/v1/things/move/preview':
    'read-only: answers what a move would copy and who would lose sight of the things (D45, D161), counting the copies inside a savepoint it always rolls back; the move itself is audited (thing.move)',
  'POST /api/v1/files/:id/url':
    'read-only: signs a five-minute URL for a file the caller may already see (Q16, D157) and changes nothing; the upload, attachments and "delete original" are audited',
  'POST /api/v1/me/email-change':
    'only mails the old address a confirmation link; the change itself is audited when it completes (POST /api/v1/auth/email-change/confirm, account.email_change)',
  'POST /api/v1/scan/resolve':
    'read-only: answers what a scanned code is (open, claim, not in your Kept, legacy, barcode, not Kept, D137) and changes nothing, not even last_seen_at (D40); the phone marks seen with the audited POST /api/v1/things/:id/seen',
  'POST /api/v1/me/channels/:id/test':
    "a test send to the caller's own channel (a mail, a push or a signed test event), rate-limited to 5 an hour; it changes nothing but the channel's own verified_at bookkeeping, and the channel's creation is audited (channel.create)",
  'POST /api/v1/me/push-subscriptions/:id/test':
    "a test push to one of the caller's own devices, rate-limited with the channel tests; it records the push's delivery bookkeeping (last_success_at, or drops a subscription the push service says is gone) and nothing else; subscribing is audited (push_subscription.create)",
  'POST /api/v1/webhooks/:id/test':
    "a test ping to a location webhook its caller administers, rate-limited to 6 a minute; it records the ping's delivery row (as kept_system, the delivery job's own bookkeeping) and changes nothing else; adding, changing and removing the hook are audited (webhook.create, webhook.update, webhook.delete)",
  'POST /api/v1/notifications/read':
    "marks the caller's own notifications read (read_at only): a read receipt is the person's own bookkeeping, not a change to the household's data (plan T16)",
  'POST /api/v1/assistant/threads':
    "starts the caller's own private assistant thread (D23): threads are private from admins and the instance admin, never audit subjects, and deleted after 90 days; a write a thread leads to is audited when its card is confirmed",
  'DELETE /api/v1/assistant/threads/:id':
    "private data the owner deletes at once (D23): no audit copy may outlive the thread, whose messages and tool results are the person's own",
  'POST /api/v1/assistant/threads/:id/turns':
    "stores the caller's question in their private thread and queues its turn (D23, D166); the model's tool calls only read, and every write it proposes is audited when the person confirms it (POST /api/v1/assistant/proposals/confirm)",
  'POST /api/v1/assistant/turns/:id/cancel':
    "stops the caller's own assistant turn before its next step (Q21): the turn's status in their private thread, not a change to the household's data",
  'POST /api/v1/assistant/proposals/cancel':
    "dismisses the caller's own unconfirmed cards (D22): nothing was applied, so nothing is audited; the thread records that they were cancelled",
  'POST /mcp':
    'MCP endpoint; each tool call audits itself: a write tool runs the same audited operation as its route, as the token (tools/context.ts runTool, step-6 T11)',
  'DELETE /mcp':
    'answers 405 only: the MCP endpoint is stateless (D63), so there is no session to end and nothing changes',
  'POST /share':
    'redirect only; SW handles share-in: a share the service worker missed is answered 303 to /capture?share=unavailable before its body is read, and nothing is stored (http/share.ts, Q26)',
};

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);
const MARKER = /^\s*\/\/ catalogue: ([A-Z]+) (\S+)\s*$/;
const CASE = /^\s*it(?:\.each)?\(/;
const CASE_START = /^\s*(?:it|describe)(?:\.each|\.skip|\.only)?[(.]/;

type Marker = {
  route: string;
  file: string;
  line: number;
  block: string;
  /** The case's code without its `it(` line and without comments. */
  code: string;
  /** `code` plus the bodies of the helpers it calls (its file's, and test/*.ts's): a case that
   * calls `attach(…)` calls the route `attach` wraps. */
  reach: string;
  /** The first line of the case it sits above (markers sharing a case share this). */
  caseLine: number;
};

/** A read of the audit: a helper named for it (`auditOf(`, `eventsOf(`, `lastEvent(`, …), or the
 * table. */
const AUDIT_READ = /audit_events|\b\w*[Aa]udit\w*\s*\(|\b\w*[Ee]vents?(?:Of|For)?\s*\(/;
/** How near (in lines) an `expect(` must be to the audit read it checks. */
const EXPECT_WITHIN = 6;

/** Blank the `//` comments of a line (not inside a string: a URL's `//` stays). */
export function withoutComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

/** Whether `code` reads the audit and asserts on it nearby. */
export function assertsAudit(code: string): boolean {
  const lines = code.split('\n');
  return lines.some((l, i) => {
    if (!AUDIT_READ.test(l)) return false;
    const near = lines.slice(Math.max(0, i - 1), i + EXPECT_WITHIN + 1).join('\n');
    return near.includes('expect(');
  });
}

/** The last path segment of a route that isn't a parameter or a wildcard. */
export function lastLiteral(route: string): string {
  const url = route.split(' ')[1] ?? '';
  const parts = url.split('/').filter((p) => p !== '' && !p.startsWith(':') && p !== '*');
  return parts.at(-1) ?? '';
}

/** Whether `code` names `method` for a case shared by several markers. */
function namesMethod(code: string, method: string): boolean {
  const m = method.toLowerCase();
  return (
    new RegExp(`['"\`]${method}['"\`]`).test(code) ||
    new RegExp(`\\b${m === 'delete' ? '(?:del|delete|remove)' : m}\\w*\\s*\\(`, 'i').test(code)
  );
}

async function testFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'fixtures') {
        out.push(...(await testFiles(full)));
      }
    } else if (entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/** How many lines of a helper's definition count as its body. Helpers are short. */
const HELPER_LINES = 25;
const DEFINITION = /^\s{0,4}(?:export\s+)?(?:(?:async\s+)?function\s+(\w+)|const\s+(\w+)\s*=)/;

/** Helper name → the first lines of its definition, from one file's text. */
function helpersOf(lines: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  lines.forEach((text, i) => {
    const d = DEFINITION.exec(text);
    const name = d?.[1] ?? d?.[2];
    if (name && !out.has(name)) {
      out.set(
        name,
        lines
          .slice(i, i + HELPER_LINES)
          .map(withoutComment)
          .join('\n'),
      );
    }
  });
  return out;
}

/** `code` with the bodies of the helpers it calls appended (one level). */
function reachOf(code: string, ...scopes: ReadonlyMap<string, string>[]): string {
  const bodies: string[] = [];
  for (const [, name] of code.matchAll(/\b(\w+)\s*(?:<[^>()]*>)?\(/g)) {
    for (const helpers of scopes) {
      const body = name ? helpers.get(name) : undefined;
      if (body) {
        bodies.push(body);
        break;
      }
    }
  }
  return [code, ...bodies].join('\n');
}

/** The shared fixtures' helpers (test/*.ts, not the tests): exported ones only, since a test can
 * call nothing else, and a local `const call = …` inside one (test/leak-assistant.ts) must not
 * stand in for test/people.ts's `call`. */
async function sharedHelpers(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const dir = path.join(ROOT, 'test');
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
    const lines = (await readFile(path.join(dir, entry.name), 'utf8')).split('\n');
    for (const [k, v] of helpersOf(lines)) {
      if (!out.has(k) && /^\s*export\s/.test(v)) out.set(k, v);
    }
  }
  return out;
}

/** Every marker in the server's tests, with the text of the case it sits above. */
async function markers(): Promise<{ found: Marker[]; misplaced: string[] }> {
  const found: Marker[] = [];
  const misplaced: string[] = [];
  const files = [
    ...(await testFiles(path.join(ROOT, 'src'))),
    ...(await testFiles(path.join(ROOT, 'test'))),
  ];
  const shared = await sharedHelpers();
  for (const file of files) {
    const lines = (await readFile(file, 'utf8')).split('\n');
    const local = helpersOf(lines);
    lines.forEach((text, i) => {
      const m = MARKER.exec(text);
      if (!m) return;
      const where = `${path.relative(ROOT, file)}:${i + 1}`;
      // Only comments and blank lines between the marker and its case.
      let j = i + 1;
      while (j < lines.length && /^\s*(\/\/.*)?$/.test(lines[j] ?? '')) j++;
      if (!CASE.test(lines[j] ?? '')) {
        misplaced.push(`${where}: ${m[1]} ${m[2]} is not directly above an it( case`);
        return;
      }
      let end = j + 1;
      while (end < lines.length && !CASE_START.test(lines[end] ?? '')) end++;
      const code = lines
        .slice(j + 1, end)
        .map(withoutComment)
        .join('\n');
      found.push({
        route: `${m[1]} ${m[2]}`,
        file: where,
        line: i + 1,
        block: lines.slice(j, end).join('\n'),
        code,
        reach: reachOf(code, local, shared),
        caseLine: j + 1,
      });
    });
  }
  return { found, misplaced };
}

describe('the route catalogue (D188)', () => {
  let t: TestApp;
  const routes = new Set<string>();

  beforeAll(async () => {
    t = await testApp(db, {
      onRoute: (route) => {
        const methods = Array.isArray(route.method) ? route.method : [route.method];
        for (const method of methods) {
          if (!READS.has(method)) routes.add(`${method} ${route.url}`);
        }
      },
    });
  });
  afterAll(() => t.app.close());

  it('sees the step-1 writes (a sanity check that the hook caught the routes)', () => {
    expect(routes).toContain('POST /api/v1/locations');
    expect(routes).toContain('PUT /api/v1/admin/settings');
    expect(routes.size).toBeGreaterThanOrEqual(30);
  });

  it('has a marked, audit-asserting test for every non-GET route, or an allowlisted reason', async () => {
    const { found, misplaced } = await markers();
    expect(misplaced).toEqual([]);
    const marked = new Map<string, Marker[]>();
    for (const m of found) marked.set(m.route, [...(marked.get(m.route) ?? []), m]);

    const uncovered = [...routes].filter((r) => !marked.has(r) && !Object.hasOwn(ALLOWLIST, r));
    expect(
      uncovered,
      'add a `// catalogue: <METHOD> <url>` marker, or an ALLOWLIST reason',
    ).toEqual([]);

    // Each marker sits above a case that reads the audit and asserts on it (review #2).
    const unasserted = found.filter((m) => !assertsAudit(m.code)).map((m) => m.file);
    expect(
      unasserted,
      'the marked case must read the audit (eventsOf(), auditOf(), audit_events, …) and expect( on it',
    ).toEqual([]);

    // ...and calls the route it is marked for.
    const uncalled = found
      .filter((m) => !m.reach.includes(lastLiteral(m.route)))
      .map((m) => `${m.file} ${m.route} (no "${lastLiteral(m.route)}" in the case)`);
    expect(uncalled, 'the marked case must call its route').toEqual([]);

    // Markers sharing a case each name their own route.
    const byCase = new Map<string, Marker[]>();
    for (const m of found) {
      const key = `${m.file.split(':')[0]}:${m.caseLine}`;
      byCase.set(key, [...(byCase.get(key) ?? []), m]);
    }
    const shared: string[] = [];
    for (const group of byCase.values()) {
      if (group.length < 2) continue;
      for (const m of group) {
        const segment = lastLiteral(m.route);
        const twins = group.filter((o) => o !== m && lastLiteral(o.route) === segment);
        const method = m.route.split(' ')[0] ?? '';
        if (twins.length > 0 && !namesMethod(m.reach, method)) {
          shared.push(`${m.file} ${m.route}: shares its case, and the case never says ${method}`);
        }
      }
    }
    expect(shared, 'one case, several markers: each route must be called in it').toEqual([]);
  });

  it('flags what it looks for (self-checks, review #2)', () => {
    // A title that says "audits" is not an assertion; nor is a status code.
    expect(
      assertsAudit("  const res = await call(t, '/x');\n  expect(res.statusCode).toBe(200);"),
    ).toBe(false);
    // A read of the audit with nothing asserted on it isn't either.
    expect(assertsAudit('  await eventsOf(db, home, id);\n  const x = 1;')).toBe(false);
    expect(
      assertsAudit('  const [e] = await eventsOf(db, home, id);\n  expect(e?.action).toBe("x");'),
    ).toBe(true);
    expect(
      assertsAudit(
        "  const rows = await own('SELECT * FROM public.audit_events');\n  expect(rows).toHaveLength(1);",
      ),
    ).toBe(true);
    expect(withoutComment('  expect(x); // audit_events')).toBe('  expect(x); ');
    expect(withoutComment("  call(t, 'http://a/b'); // c")).toBe("  call(t, 'http://a/b'); ");
    expect(lastLiteral('POST /api/v1/things/:id/secrets/:fieldKey/reveal')).toBe('reveal');
    expect(lastLiteral('PATCH /api/v1/attachments/:id')).toBe('attachments');
    expect(lastLiteral('POST /api/v1/auth/*')).toBe('auth');
  });

  it('has no stale markers or allowlist entries, and nothing both marked and allowlisted', async () => {
    const { found } = await markers();
    const stale = found.filter((m) => !routes.has(m.route)).map((m) => `${m.file} ${m.route}`);
    expect(stale, 'a marker names a route that no longer exists').toEqual([]);
    expect(Object.keys(ALLOWLIST).filter((r) => !routes.has(r))).toEqual([]);
    const both = found.filter((m) => Object.hasOwn(ALLOWLIST, m.route)).map((m) => m.route);
    expect(both).toEqual([]);
    for (const [route, reason] of Object.entries(ALLOWLIST)) {
      expect(reason.length, route).toBeGreaterThan(20);
    }
  });
});
