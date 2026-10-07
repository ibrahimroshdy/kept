import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, type Person, peopleApp, person } from '../../test/people.js';
import { ownerTx } from '../../test/tenancy.js';
import { withScope } from '../db/scope.js';

// Task 12: the currency list and the instance admin's currency switch (D136, D168, D189), as
// apps/web/src/routes/_app/admin.currencies.tsx calls them. `currencies` is a reference table
// that survives test resets (test/db.ts), so every switch made here is put back in afterAll.

let db: TestDb;
let t: TestApp;
let admin: Person;
let pat: Person;
let home: string;

type Currency = {
  code: string;
  name: string;
  minorUnits: number;
  symbol: string;
  enabled: boolean;
  inUse?: boolean;
};

const own = <T extends pg.QueryResultRow>(text: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(text, values)).rows);

const list = async (as: Person, all = false) => {
  const res = await call(t, `/api/v1/currencies${all ? '?all=1' : ''}`, { as });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { currencies: Currency[] }).currencies;
};

const patch = (as: Person, code: string, enabled: boolean) =>
  call(t, `/api/v1/admin/currencies/${code}`, { as, method: 'PATCH', body: { enabled } });

/** Instance-level audit rows for currencies, oldest first. */
const currencyAudit = () =>
  own<{ action: string; actor_id: string; location_id: string | null; diff: unknown }>(
    `SELECT action, actor_id, location_id, diff FROM public.audit_events
      WHERE entity_type = 'currency' ORDER BY at, id`,
  );

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db);
  admin = await person(t, db, 'admin');
  pat = await person(t, db, 'pat');
  await own('INSERT INTO public.instance_admins (user_id) VALUES ($1)', [admin.userId]);
  const res = await call(t, '/api/v1/locations', {
    as: pat,
    body: {
      name: 'Pat home',
      kind: 'home',
      preset: 'household',
      timezone: 'Africa/Cairo',
      currency: 'EGP',
      rooms: [],
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  home = (res.json() as { id: string }).id;
});

afterAll(async () => {
  await own(`UPDATE public.locations SET currency = 'EGP' WHERE currency IN ('TRY', 'JPY')`);
  await own(`UPDATE public.currencies SET enabled = false WHERE code IN ('TRY', 'JPY')`);
});

describe('GET /api/v1/currencies', () => {
  it('lists the enabled currencies for anyone signed in, the five defaults included', async () => {
    const currencies = await list(pat);
    const codes = currencies.map((c) => c.code);
    expect(codes).toEqual(expect.arrayContaining(['CAD', 'EGP', 'EUR', 'GBP', 'USD']));
    expect(currencies.every((c) => c.enabled)).toBe(true);
    expect(codes).not.toContain('TRY');
    const egp = currencies.find((c) => c.code === 'EGP');
    expect(egp).toEqual({
      code: 'EGP',
      name: expect.any(String),
      minorUnits: 2,
      symbol: expect.any(String),
      enabled: true,
    });
    expect(codes).toEqual([...codes].sort());
  });

  it('answers ?all=1 from anyone else with the enabled list, without inUse', async () => {
    const currencies = await list(pat, true);
    expect(currencies.map((c) => c.code)).not.toContain('TRY');
    expect(currencies.some((c) => 'inUse' in c)).toBe(false);
  });

  it('gives an instance admin every ISO currency with inUse (D168)', async () => {
    const currencies = await list(admin, true);
    expect(currencies.length).toBeGreaterThan(100);
    const byCode = new Map(currencies.map((c) => [c.code, c]));
    expect(byCode.get('TRY')).toMatchObject({ enabled: false, inUse: false });
    // Pat's home uses EGP; nothing uses CAD (a default, on anyway).
    expect(byCode.get('EGP')).toMatchObject({ enabled: true, inUse: true });
    expect(byCode.get('CAD')).toMatchObject({ enabled: true, inUse: false });
    expect(byCode.get('JPY')?.minorUnits).toBe(0);
  });

  it('refuses anonymous callers', async () => {
    const res = await call(t, '/api/v1/currencies');
    expect(res.statusCode).toBe(401);
  });
});

describe('PATCH /api/v1/admin/currencies/:code', () => {
  // catalogue: PATCH /api/v1/admin/currencies/:code
  it('lets an instance admin turn a currency on and off, audited at instance level', async () => {
    const on = await patch(admin, 'try', true);
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json()).toMatchObject({ code: 'TRY', enabled: true, inUse: false });
    expect((await list(pat)).map((c) => c.code)).toContain('TRY');

    const off = await patch(admin, 'TRY', false);
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json()).toMatchObject({ code: 'TRY', enabled: false });
    expect((await list(pat)).map((c) => c.code)).not.toContain('TRY');

    const rows = await currencyAudit();
    expect(rows.map((r) => [r.action, r.actor_id, r.location_id])).toEqual([
      ['admin.currency_enable', admin.userId, null],
      ['admin.currency_disable', admin.userId, null],
    ]);
    expect(rows[0]?.diff).toEqual({ enabled_try: { before: false, after: true, class: 'plain' } });
    expect(rows[1]?.diff).toEqual({ enabled_try: { before: true, after: false, class: 'plain' } });
  });

  it('changes nothing, and writes nothing, when the switch is already there', async () => {
    const before = (await currencyAudit()).length;
    const res = await patch(admin, 'USD', true);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ code: 'USD', enabled: true });
    expect(await currencyAudit()).toHaveLength(before);
  });

  it('keeps the five defaults on (D136): 409 with reason default', async () => {
    for (const code of ['USD', 'CAD', 'GBP', 'EUR', 'EGP']) {
      const res = await patch(admin, code, false);
      expect(res.statusCode, `${code} ${res.body}`).toBe(409);
      expect(res.json()).toMatchObject({ code: 'conflict', reason: 'default' });
    }
    expect((await list(pat)).map((c) => c.code)).toEqual(
      expect.arrayContaining(['CAD', 'EGP', 'EUR', 'GBP', 'USD']),
    );
  });

  it('keeps a currency a location uses on, until no location does (D168)', async () => {
    expect((await patch(admin, 'JPY', true)).statusCode).toBe(200);
    // The owner picks the newly enabled currency for their location (step 1's settings route).
    const [loc] = await own<{ row_version: number }>(
      'SELECT row_version FROM public.locations WHERE id = $1',
      [home],
    );
    const moved = await call(t, `/api/v1/locations/${home}`, {
      as: pat,
      method: 'PATCH',
      body: { currency: 'JPY' },
      headers: { 'if-match': String(loc?.row_version) },
    });
    expect(moved.statusCode, moved.body).toBe(200);
    const listed = new Map((await list(admin, true)).map((c) => [c.code, c]));
    expect(listed.get('JPY')).toMatchObject({ enabled: true, inUse: true });

    const refused = await patch(admin, 'JPY', false);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'conflict', reason: 'in_use' });

    // A deleted location still counts: restoring it brings its currency back.
    await own('UPDATE public.locations SET deleted_at = now() WHERE id = $1', [home]);
    expect((await patch(admin, 'JPY', false)).statusCode).toBe(409);
    await own(`UPDATE public.locations SET deleted_at = NULL, currency = 'EGP' WHERE id = $1`, [
      home,
    ]);
    const off = await patch(admin, 'JPY', false);
    expect(off.statusCode, off.body).toBe(200);
  });

  it('refuses everyone but instance admins (403), and unknown codes (404)', async () => {
    const res = await patch(pat, 'TRY', true);
    expect(res.statusCode).toBe(403);
    expect((await list(admin, true)).find((c) => c.code === 'TRY')?.enabled).toBe(false);
    expect((await patch(admin, 'ZZZ', true)).statusCode).toBe(404);
    expect((await patch(admin, 'EURO', true)).statusCode).toBe(400);
  });

  it('is refused underneath too: 0027 guards the switch in the database', async () => {
    const scope = { userId: admin.userId, mfa: false };
    for (const [code, constraint] of [
      ['USD', 'currencies_default_fixed'],
      ['EGP', 'currencies_default_fixed'],
    ] as const) {
      const err = await withScope(db.pools.app, scope, (_tx, c) =>
        c.query('UPDATE public.currencies SET enabled = false WHERE code = $1', [code]),
      ).catch((e: { code?: string; constraint?: string }) => e);
      expect(err, code).toMatchObject({ code: '23514', constraint });
    }
    await own(`UPDATE public.currencies SET enabled = true WHERE code = 'TRY'`);
    await own(`UPDATE public.locations SET currency = 'TRY' WHERE id = $1`, [home]);
    const err = await withScope(db.pools.app, scope, (_tx, c) =>
      c.query(`UPDATE public.currencies SET enabled = false WHERE code = 'TRY'`),
    ).catch((e: { code?: string; constraint?: string }) => e);
    expect(err).toMatchObject({ code: '23514', constraint: 'currencies_in_use' });
    await own(`UPDATE public.locations SET currency = 'EGP' WHERE id = $1`, [home]);
    await own(`UPDATE public.currencies SET enabled = false WHERE code = 'TRY'`);
  });

  it('keeps kept.currencies_in_use() to instance admins', async () => {
    const err = await withScope(db.pools.app, { userId: pat.userId, mfa: false }, (_tx, c) =>
      c.query('SELECT * FROM kept.currencies_in_use()'),
    ).catch((e: { code?: string }) => e);
    expect(err).toMatchObject({ code: '42501' });
  });
});
