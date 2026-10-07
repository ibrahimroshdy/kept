import { randomBytes } from 'node:crypto';
import { newId } from '@kept/shared';
import type { LightMyRequestResponse } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import { createLocation, type Loc, own as ownOf, setDisplayName } from '../../test/things.js';
import { withScope } from '../db/scope.js';
import { converterFor } from './convert.js';
import { rateIn } from './fx.js';

// Step-4 T8 through the front door: exchange rates, valuations and the thing's current value
// (D76, D136, D158; plan Q21, Q22, Q25), in the web contract's shapes
// (apps/web/src/api/household/types.ts, "money").
//
// Ibrahim owns Home (household: money on) and Garage (essentials: money off). In Home, Bruce is an
// admin, Louis a member and Talia a viewer (Home hides money from viewers). Alfred has his own
// account and sees nothing of Ibrahim's.

let db: TestDb;
let t: TestApp;
let ibrahim: Person;
let bruce: Person;
let louis: Person;
let talia: Person;
let alfred: Person;
let home: Loc;
let garage: Loc;

const own = <T extends import('pg').QueryResultRow>(text: string, values: unknown[] = []) =>
  ownOf<T>(db, text, values);

const ok = <T>(res: LightMyRequestResponse, status = 200): T => {
  expect(res.statusCode, res.body).toBe(status);
  return (status === 204 ? undefined : res.json()) as T;
};

const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());

async function thing(loc: Loc, name = 'Television'): Promise<string> {
  const id = newId();
  await own(`INSERT INTO public.things (id, location_id, place_id, name) VALUES ($1, $2, $3, $4)`, [
    id,
    loc.id,
    loc.unplacedId,
    name,
  ]);
  return id;
}

/** The account-level audit events of an action, oldest first. */
const accountEvents = (action: string) =>
  own<{ id: string; location_id: string | null; owner_account_id: string; diff: unknown }>(
    `SELECT id, location_id, owner_account_id, diff FROM public.audit_events
      WHERE action = $1 ORDER BY at, id`,
    [action],
  );

/** The audit events of an entity, oldest first. */
const eventsOf = (entityId: string) =>
  own<{ id: string; action: string; root_thing_id: string | null; diff: Record<string, never> }>(
    `SELECT id, action, root_thing_id, diff FROM public.audit_events
      WHERE entity_id = $1 ORDER BY at, id`,
    [entityId],
  );

const undo = (as: Person, eventId: string) =>
  call(t, `/api/v1/audit/${eventId}/undo`, { as, method: 'POST', body: {} });

const rates = (as: Person, query = '') =>
  call(t, `/api/v1/accounts/${home.accountId}/fx-rates${query}`, { as });

const putRate = (as: Person, body: object, version?: number) =>
  call(t, `/api/v1/accounts/${home.accountId}/fx-rates`, {
    as,
    method: 'PUT',
    body,
    headers: version === undefined ? {} : { 'if-match': String(version) },
  });

const delRate = (as: Person, from: string, to: string, on: string, version: number) =>
  call(t, `/api/v1/accounts/${home.accountId}/fx-rates/${from}/${to}/${on}`, {
    as,
    method: 'DELETE',
    headers: { 'if-match': String(version) },
  });

type FxRate = {
  fromCcy: string;
  toCcy: string;
  rate: string;
  validFrom: string;
  rowVersion: number;
  updatedBy: { displayName: string };
  updatedAt: string;
};
type Valuation = {
  id: string;
  value: { amount: string; currency: string } | { moneyHidden: true };
  valuedOn: string;
  source: string;
  notes: string | null;
  documents: { id: string; url: string | null; file: { id: string } | null }[];
  rowVersion: number;
  createdBy: { displayName: string };
};

const valuations = (as: Person, thingId: string) =>
  call(t, `/api/v1/things/${thingId}/valuations`, { as });
const addValuation = (as: Person, thingId: string, body: object) =>
  call(t, `/api/v1/things/${thingId}/valuations`, { as, body });
const patchValuation = (as: Person, id: string, version: number, body: object) =>
  call(t, `/api/v1/valuations/${id}`, {
    as,
    method: 'PATCH',
    body,
    headers: { 'if-match': String(version) },
  });
const delValuation = (as: Person, id: string, version: number) =>
  call(t, `/api/v1/valuations/${id}`, {
    as,
    method: 'DELETE',
    headers: { 'if-match': String(version) },
  });

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db);
  ibrahim = await person(t, db, 'ibrahim');
  bruce = await person(t, db, 'bruce');
  louis = await person(t, db, 'louis');
  talia = await person(t, db, 'talia');
  alfred = await person(t, db, 'alfred');
  for (const [p, name] of [
    [ibrahim, 'Ibrahim'],
    [bruce, 'Bruce'],
    [louis, 'Louis'],
    [talia, 'Talia'],
    [alfred, 'Alfred'],
  ] as const) {
    await setDisplayName(db, p, name);
  }
  home = await createLocation(t, db, ibrahim, 'household', 'Home');
  garage = await createLocation(t, db, ibrahim, 'essentials', 'Garage');
  await join(db, home.id, bruce.userId, 'admin');
  await join(db, home.id, louis.userId, 'member');
  await join(db, home.id, talia.userId, 'viewer');
  await join(db, garage.id, louis.userId, 'member');
});

// ---------------------------------------------------------------------------------------------
// Exchange rates
// ---------------------------------------------------------------------------------------------

describe('exchange rates (D76, D136)', () => {
  it('reads a rate as typed: Eastern Arabic digits, the Arabic decimal point, never 0', () => {
    expect(rateIn('٤٨٫٢٥', 'rate')).toBe('48.25');
    expect(rateIn('0.02000', 'rate')).toBe('0.02');
    expect(rateIn('0050', 'rate')).toBe('50');
    for (const bad of ['0', '0.000', '-1', '1e3', '12345678901', '1.123456789', '']) {
      expect(() => rateIn(bad, 'rate')).toThrow();
    }
  });

  // catalogue: PUT /api/v1/accounts/:accountId/fx-rates
  it('lets the owner set a rate, audited on the account; replacing it needs If-Match', async () => {
    const set = ok<FxRate>(
      await putRate(ibrahim, {
        fromCcy: 'usd',
        toCcy: 'EGP',
        rate: '48.5',
        validFrom: '2026-09-01',
      }),
    );
    expect(set).toMatchObject({
      fromCcy: 'USD',
      toCcy: 'EGP',
      rate: '48.5',
      validFrom: '2026-09-01',
      rowVersion: 1,
      updatedBy: { displayName: 'Ibrahim' },
    });
    const events = await accountEvents('fx_rate.set');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ location_id: null, owner_account_id: home.accountId });

    // Replacing: without If-Match 428, with a stale one 412, with the current one 200.
    const again = { fromCcy: 'USD', toCcy: 'EGP', rate: '49', validFrom: '2026-09-01' };
    expect((await putRate(ibrahim, again)).statusCode).toBe(428);
    expect((await putRate(ibrahim, again, 7)).statusCode).toBe(412);
    const replaced = ok<FxRate>(await putRate(ibrahim, again, 1));
    expect(replaced).toMatchObject({ rate: '49', rowVersion: 2 });
    // The same rate again changes nothing, and writes no event.
    ok(await putRate(ibrahim, again, 2));
    expect(await accountEvents('fx_rate.set')).toHaveLength(2);
  });

  it('refuses a bad rate, one currency twice, "$", or a currency that is off', async () => {
    const base = { fromCcy: 'USD', toCcy: 'EGP', validFrom: '2026-01-01' };
    expect((await putRate(ibrahim, { ...base, rate: '0' })).statusCode).toBe(400);
    expect((await putRate(ibrahim, { ...base, toCcy: 'USD', rate: '1' })).statusCode).toBe(400);
    expect((await putRate(ibrahim, { ...base, fromCcy: '$', rate: '1' })).statusCode).toBe(400);
    expect((await putRate(ibrahim, { ...base, toCcy: 'XYZ', rate: '1' })).statusCode).toBe(400);
    expect(
      (await putRate(ibrahim, { ...base, validFrom: '2026-02-30', rate: '1' })).statusCode,
    ).toBe(400);
  });

  it('is read by anyone who sees a location of the account; written by its owner and admins', async () => {
    const seen = ok<{ items: FxRate[] }>(await rates(talia));
    expect(seen.items.map((r) => `${r.fromCcy}/${r.toCcy}@${r.validFrom}=${r.rate}`)).toEqual([
      'USD/EGP@2026-09-01=49',
    ]);
    expect((await rates(alfred)).statusCode).toBe(404);
    const body = { fromCcy: 'EUR', toCcy: 'EGP', rate: '52', validFrom: '2026-09-01' };
    expect((await putRate(talia, body)).statusCode).toBe(403);
    expect((await putRate(louis, body)).statusCode).toBe(403);
    expect((await putRate(alfred, body)).statusCode).toBe(404);
    // An admin of the account sets one too, audited at the account level (0056).
    const admin = ok<FxRate>(await putRate(bruce, { ...body, fromCcy: 'GBP', rate: '61' }));
    expect(admin).toMatchObject({ fromCcy: 'GBP', toCcy: 'EGP', rate: '61' });
    const [last] = await own<{ actor_id: string }>(
      `SELECT actor_id FROM public.audit_events WHERE action = 'fx_rate.set'
        ORDER BY at DESC, id DESC LIMIT 1`,
    );
    expect(last?.actor_id).toBe(bruce.userId);
  });

  it('filters by pair and lists the newest date first', async () => {
    ok(
      await putRate(ibrahim, { fromCcy: 'USD', toCcy: 'EGP', rate: '47', validFrom: '2026-06-01' }),
    );
    ok(
      await putRate(ibrahim, {
        fromCcy: 'EUR',
        toCcy: 'USD',
        rate: '1.1',
        validFrom: '2026-06-01',
      }),
    );
    const usd = ok<{ items: FxRate[] }>(await rates(ibrahim, '?from=USD&to=EGP'));
    expect(usd.items.map((r) => r.validFrom)).toEqual(['2026-09-01', '2026-06-01']);
  });

  // catalogue: DELETE /api/v1/accounts/:accountId/fx-rates/:from/:to/:validFrom
  it('deletes a rate with If-Match, audited; undo puts it back, and undo of a set restores the old rate', async () => {
    expect((await delRate(ibrahim, 'EUR', 'USD', '2026-06-01', 9)).statusCode).toBe(412);
    const res = await delRate(ibrahim, 'EUR', 'USD', '2026-06-01', 1);
    ok(res, 204);
    const deleted = await accountEvents('fx_rate.delete');
    expect(deleted).toHaveLength(1);
    expect(deleted[0]?.diff).toMatchObject({
      fx_rate: {
        before: { from_ccy: 'EUR', to_ccy: 'USD', valid_from: '2026-06-01', rate: '1.1' },
        after: null,
      },
    });
    const eventId = res.headers['x-kept-audit-event'] as string;
    expect(eventId).toBe(deleted[0]?.id);
    ok(await undo(ibrahim, eventId));
    const back = ok<{ items: FxRate[] }>(await rates(ibrahim, '?from=EUR&to=USD'));
    expect(back.items).toMatchObject([{ rate: '1.1', validFrom: '2026-06-01' }]);
    // A second undo of it is refused.
    expect((await undo(ibrahim, eventId)).json()).toMatchObject({ reason: 'already_undone' });

    // Undo of a replace: 49 back to 48.5, only while it is still 49.
    const replace = (await accountEvents('fx_rate.set')).find(
      (e) => JSON.stringify(e.diff).includes('"48.5"') && JSON.stringify(e.diff).includes('"49"'),
    );
    ok(await undo(ibrahim, replace?.id as string));
    const now = ok<{ items: FxRate[] }>(await rates(ibrahim, '?from=USD&to=EGP'));
    expect(now.items[0]).toMatchObject({ validFrom: '2026-09-01', rate: '48.5' });
    // Nobody but the account's owner and admins undoes an account's change (0056 lets its
    // admins read its `fx_rate` events): not a member.
    const first = (await accountEvents('fx_rate.set'))[0]?.id as string;
    expect((await undo(louis, first)).statusCode).not.toBe(200);
    expect((await undo(alfred, first)).statusCode).toBe(404);
  });

  it('converts through a rate or its inverse, never chained, and names a missing pair (Q21)', async () => {
    const c = await withScope(db.pools.app, { userId: ibrahim.userId, mfa: false }, (_tx, client) =>
      converterFor(client, home.accountId),
    );
    // USD→EGP 48.5 from 2026-09-01; 47 from 2026-06-01.
    expect(c.convert('10', 'USD', 'EGP', '2026-09-15')).toEqual({ amount: '485' });
    expect(c.convert('10', 'USD', 'EGP', '2026-07-01')).toEqual({ amount: '470' });
    // The inverse: 97 EGP is 2 USD at 48.5.
    expect(c.convert('97', 'EGP', 'USD', '2026-09-15')).toEqual({ amount: '2' });
    // Before any rate, and through a third currency (EUR→USD→EGP): missing, never estimated.
    expect(c.convert('1', 'USD', 'EGP', '2026-01-01')).toEqual({
      missing: { from: 'USD', to: 'EGP' },
    });
    expect(c.convert('1', 'EUR', 'EGP', '2026-09-15')).toEqual({
      missing: { from: 'EUR', to: 'EGP' },
    });
  });

  it("counts a money cap's other currencies through the account's rates (step-3 carry-over)", async () => {
    // A USD 10 cap on the account, and EGP 97 spent this month: uncounted without a rate for
    // today, then counted once one is entered (0049 kept.ai_spent, ai/caps.ts).
    const cap = await call(t, '/api/v1/ai/caps', {
      as: ibrahim,
      method: 'PUT',
      body: { scope: 'account', monthlyCap: { amount: '10', currency: 'USD' } },
    });
    expect(cap.statusCode, cap.body).toBe(200);
    await own(
      `INSERT INTO public.ai_cost_windows (bucket, month_start, currency, amount)
       VALUES ($1, date_trunc('month', now(), 'UTC')::date, 'EGP', 97)`,
      [`account:${home.accountId}`],
    );
    const capOf = async () =>
      ok<{ caps: { scope: string; percent: number | null; used: { notCounted: string[] } }[] }>(
        await call(t, '/api/v1/ai/caps?scope=account', { as: ibrahim }),
      ).caps.find((c) => c.scope === 'account');
    // The 2026-09-01 USD→EGP rate already counts it (inverse): EGP 97 is USD 2, 20%.
    expect(await capOf()).toMatchObject({ percent: 20, used: { notCounted: [] } });
    // Without it (deleted), EGP is named and not counted.
    const usd = ok<{ items: FxRate[] }>(await rates(ibrahim, '?from=USD&to=EGP'));
    for (const r of usd.items) {
      ok(await delRate(ibrahim, 'USD', 'EGP', r.validFrom, r.rowVersion), 204);
    }
    expect(await capOf()).toMatchObject({ percent: 0, used: { notCounted: ['EGP'] } });
  });
});

// ---------------------------------------------------------------------------------------------
// Valuations
// ---------------------------------------------------------------------------------------------

describe('valuations and the current value (D158)', () => {
  let tv: string;

  beforeAll(async () => {
    tv = await thing(home, 'Television');
  });

  // catalogue: POST /api/v1/things/:id/valuations
  it('adds a valuation on the thing’s timeline; the newest is its current value', async () => {
    const first = ok<Valuation>(
      await addValuation(louis, tv, {
        value: '٢٥٬٠٠٠',
        currency: 'EGP',
        valuedOn: '2026-01-10',
        source: 'purchase',
      }),
      201,
    );
    expect(first).toMatchObject({
      value: { amount: '25000', currency: 'EGP' },
      valuedOn: '2026-01-10',
      source: 'purchase',
      notes: null,
      documents: [],
      rowVersion: 1,
      createdBy: { displayName: 'Louis' },
    });
    const second = ok<Valuation>(
      await addValuation(ibrahim, tv, {
        value: '18000.50',
        currency: 'EGP',
        valuedOn: '2026-08-01',
        source: 'estimate',
        notes: 'Market price',
      }),
      201,
    );
    const list = ok<{ items: Valuation[]; current: Valuation | null }>(await valuations(bruce, tv));
    expect(list.items.map((v) => v.id)).toEqual([second.id, first.id]);
    expect(list.current?.id).toBe(second.id);
    const events = await eventsOf(first.id);
    expect(events).toMatchObject([{ action: 'valuation.create', root_thing_id: tv }]);
    expect(events[0]?.diff).toMatchObject({ value: { class: 'money', after: '25000' } });

    const view = ok<{ currentValue?: unknown }>(
      await call(t, `/api/v1/things/${tv}`, { as: louis }),
    );
    expect(view.currentValue).toEqual({
      amount: '18000.5',
      currency: 'EGP',
      valuedOn: '2026-08-01',
      source: 'estimate',
    });
  });

  it('refuses a future date, a bad amount, "$", and anyone who can’t change things there', async () => {
    const body = { value: '1', currency: 'EGP', valuedOn: today(), source: 'appraisal' };
    ok(await addValuation(louis, tv, body), 201);
    expect((await addValuation(louis, tv, { ...body, valuedOn: '2999-01-01' })).statusCode).toBe(
      400,
    );
    expect((await addValuation(louis, tv, { ...body, value: '-3' })).statusCode).toBe(400);
    expect((await addValuation(louis, tv, { ...body, currency: '$' })).statusCode).toBe(400);
    expect((await addValuation(talia, tv, body)).statusCode).toBe(403);
    expect((await addValuation(alfred, tv, body)).statusCode).toBe(404);
  });

  it('hides the value and its documents from a viewer where viewers don’t see money', async () => {
    const list = ok<{ items: Valuation[]; current: Valuation | null }>(await valuations(talia, tv));
    expect(list.items.length).toBeGreaterThan(0);
    for (const v of list.items) {
      expect(v.value).toEqual({ moneyHidden: true });
      expect(v.documents).toEqual([]);
    }
    expect(JSON.stringify(list)).not.toContain('18000');
    const view = ok<{ currentValue?: unknown }>(
      await call(t, `/api/v1/things/${tv}`, { as: talia }),
    );
    expect(view.currentValue).toEqual({ moneyHidden: true });
  });

  it('is off with Money off: 404 to read, 409 to write, no current value on the thing', async () => {
    const bike = await thing(garage, 'Bicycle');
    const read = await valuations(louis, bike);
    expect(read.statusCode).toBe(404);
    expect(read.json()).toMatchObject({ code: 'module_off' });
    const write = await addValuation(louis, bike, {
      value: '1',
      currency: 'EGP',
      valuedOn: '2026-01-01',
      source: 'estimate',
    });
    expect(write.statusCode).toBe(409);
    expect(write.json()).toMatchObject({ code: 'module_off' });
    const view = ok<Record<string, unknown>>(
      await call(t, `/api/v1/things/${bike}`, { as: louis }),
    );
    expect('currentValue' in view).toBe(false);
  });

  // catalogue: PATCH /api/v1/valuations/:id
  it('edits with If-Match, audited as money; undo writes the old value back while it holds', async () => {
    const v = ok<Valuation>(
      await addValuation(louis, tv, {
        value: '900',
        currency: 'EGP',
        valuedOn: '2026-02-01',
        source: 'appraisal',
      }),
      201,
    );
    expect((await patchValuation(louis, v.id, 5, { value: '950' })).statusCode).toBe(412);
    expect((await patchValuation(talia, v.id, 1, { value: '950' })).statusCode).toBe(403);
    const res = await patchValuation(louis, v.id, 1, { value: '950', notes: 'Rechecked' });
    const edited = ok<Valuation>(res);
    expect(edited).toMatchObject({
      value: { amount: '950', currency: 'EGP' },
      notes: 'Rechecked',
      rowVersion: 2,
    });
    const update = (await eventsOf(v.id)).find((e) => e.action === 'valuation.update');
    expect(update?.diff).toMatchObject({
      value: { before: '900', after: '950', class: 'money' },
      notes: { before: null, after: 'Rechecked' },
    });
    expect(res.headers['x-kept-audit-event']).toBe(update?.id);
    ok(await undo(louis, update?.id as string));
    const back = ok<{ items: Valuation[] }>(await valuations(louis, tv)).items.find(
      (x) => x.id === v.id,
    );
    expect(back).toMatchObject({ value: { amount: '900' }, notes: null });

    // Changed since: refused, naming who.
    const again = ok<Valuation>(await patchValuation(louis, v.id, 3, { source: 'insurer' }));
    const second = (await eventsOf(v.id)).filter((e) => e.action === 'valuation.update').at(-1);
    ok(await patchValuation(ibrahim, v.id, again.rowVersion, { source: 'estimate' }));
    const refused = await undo(louis, second?.id as string);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      reason: 'changed_since',
      field: 'source',
      changedBy: { displayName: 'Ibrahim' },
    });
  });

  // catalogue: DELETE /api/v1/valuations/:id
  it('deletes with If-Match, keeping the row and its documents in the event; undo restores both', async () => {
    const v = ok<Valuation>(
      await addValuation(louis, tv, {
        value: '12000',
        currency: 'EGP',
        valuedOn: '2026-03-01',
        source: 'insurer',
      }),
      201,
    );
    // A link and a file, both Louis's.
    ok(
      await call(t, '/api/v1/attachments', {
        as: louis,
        body: {
          locationId: home.id,
          url: 'https://insurer.example/valuation/123',
          subject: { valuationId: v.id },
          role: 'document',
        },
      }),
      201,
    );
    const fileId = newId();
    await own(
      `INSERT INTO public.files (id, location_id, storage_key, sha256, bytes, mime, class,
                                 derivative_state, created_by)
       VALUES ($1, $2, $3, $4, 10, 'application/pdf', 'document', 'not_applicable', $5)`,
      [fileId, home.id, `f/${home.id}/${fileId}`, randomBytes(32).toString('hex'), louis.userId],
    );
    ok(
      await call(t, '/api/v1/attachments', {
        as: louis,
        body: {
          locationId: home.id,
          fileId,
          subject: { valuationId: v.id },
          role: 'document',
          sort: 1,
        },
      }),
      201,
    );
    const withDocs = ok<{ items: Valuation[] }>(await valuations(louis, tv)).items.find(
      (x) => x.id === v.id,
    );
    expect(withDocs?.documents).toHaveLength(2);

    const res = await delValuation(louis, v.id, 1);
    ok(res, 204);
    expect(
      ok<{ items: Valuation[] }>(await valuations(louis, tv)).items.some((x) => x.id === v.id),
    ).toBe(false);
    const events = await eventsOf(v.id);
    const deleted = events.find((e) => e.action === 'valuation.delete');
    expect(deleted?.diff).toMatchObject({
      value: { before: '12000', after: null, class: 'money' },
      documents: { before: [{ role: 'document' }, { file_id: fileId }] },
    });
    expect(res.headers['x-kept-audit-event']).toBe(deleted?.id);

    ok(await undo(louis, deleted?.id as string));
    const back = ok<{ items: Valuation[] }>(await valuations(louis, tv)).items.find(
      (x) => x.id === v.id,
    );
    expect(back).toMatchObject({ value: { amount: '12000', currency: 'EGP' }, source: 'insurer' });
    expect(back?.documents.map((d) => d.url ?? d.file?.id)).toEqual([
      'https://insurer.example/valuation/123',
      fileId,
    ]);
  });
});
