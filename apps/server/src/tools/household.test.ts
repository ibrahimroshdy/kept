import {
  byteLength,
  type Envelope,
  envelopeSchema,
  isToolError,
  OUTPUT_LIMIT_BYTES,
  TOOL_DEFS,
  type ToolName,
} from '@kept/mcp';
import { addDays } from '@kept/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import {
  builtinType,
  createLocation,
  createThing,
  type Json,
  type Loc,
  ok,
  own,
} from '../../test/things.js';
import { runTool } from './context.js';
import type { ToolContext } from './types.js';

// Step 4's tools through runTool(): lending, schedules, warranties and claims, and `upcoming`,
// as Louis (member of Home, a Complete location) and in Garage (Essentials: lending,
// schedules and warranties off).

let db: TestDb;
let t: TestApp;
let ibrahim: Person;
let louis: Person;
let talia: Person;
let home: Loc;
let garage: Loc;
let today: string;

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db);
  ibrahim = await person(t, db, 'ibrahim');
  louis = await person(t, db, 'louis');
  talia = await person(t, db, 'talia');
  home = await createLocation(t, db, ibrahim, 'complete');
  garage = await createLocation(t, db, ibrahim, 'essentials', 'Garage');
  await join(db, home.id, louis.userId, 'member');
  await join(db, home.id, talia.userId, 'viewer');
  await join(db, garage.id, louis.userId, 'member');
  const [row] = await own<{ today: string }>(
    db,
    `SELECT (now() AT TIME ZONE 'Africa/Cairo')::date::text AS today`,
  );
  today = row?.today as string;
});

/** A tool's answer, already checked against its TOOL_DEFS schema by tool(): read loosely. */
// biome-ignore lint/suspicious/noExplicitAny: the envelope was validated against its zod schema
type Answer = Record<string, any>;

let seq = 0;
const ctx = (who: Person): ToolContext => {
  seq += 1;
  return {
    deps: { pools: db.pools, jobs: null, files: null, providerResolved: async () => true },
    principal: { userId: who.userId, mfa: false, scope: 'write' },
    locale: 'en',
    requestId: `household-tool-${seq}`,
    via: 'assistant',
  };
};

async function tool(who: Person, name: ToolName, args: Record<string, unknown>) {
  const env = (await runTool(ctx(who), name, args)) as Envelope<Answer>;
  const parsed = envelopeSchema(TOOL_DEFS[name].output).safeParse(env);
  expect(parsed.success, `${name}: ${JSON.stringify(parsed.error?.issues?.slice(0, 3))}`).toBe(
    true,
  );
  expect(byteLength(env)).toBeLessThanOrEqual(OUTPUT_LIMIT_BYTES);
  return env;
}

async function data(who: Person, name: ToolName, args: Record<string, unknown>) {
  const env = await tool(who, name, args);
  if (isToolError(env)) throw new Error(`${name}: ${env.error} (${env.hint})`);
  return env.data;
}

describe('lending', () => {
  it('lends to a person by name, once per name, and returns it; undoable by the route', async () => {
    const drill = await createThing(t, ibrahim, home, { name: 'Drill' });
    const lent = await data(louis, 'lend_thing', {
      thing_id: drill.id,
      person: 'Murdock',
      due_on: addDays(today, 7),
    });
    expect(lent.thing.id).toBe(drill.id);
    const again = await createThing(t, ibrahim, home, { name: 'Ladder' });
    await data(louis, 'lend_thing', { thing_id: again.id, person: 'murdock' });
    const people = await own(
      db,
      `SELECT 1 FROM public.people WHERE owner_account_id = $1 AND display_name = 'Murdock'`,
      [home.accountId],
    );
    expect(people).toHaveLength(1);

    const found = await data(louis, 'where_is', { location_id: home.id, query: 'drill' });
    expect(found.items[0].loan).toEqual({
      direction: 'out',
      due_on: addDays(today, 7),
      untrusted: { person: 'Murdock' },
    });

    const back = await data(louis, 'return_thing', { thing_id: drill.id });
    expect(back.loan_id).toBe(lent.loan_id);
    expect(back.undo_until).not.toBeNull();
    ok(await call(t, `/api/v1/audit/${back.audit_event_id}/undo`, { as: louis, body: {} }));
    const [loan] = await own<{ returned_at: Date | null }>(
      db,
      'SELECT returned_at FROM public.loans WHERE id = $1',
      [lent.loan_id],
    );
    expect(loan?.returned_at).toBeNull();
  });

  it('borrows a thing in as the lender’s, in the Unplaced area when no place is named', async () => {
    const d = await data(louis, 'borrow_thing', {
      location_id: home.id,
      name: 'Tile cutter',
      person: 'Bruce',
    });
    expect(d.thing.untrusted).toEqual({ name: 'Tile cutter', path: ['Home', 'Unplaced'] });
    const [row] = await own<{ direction: string }>(
      db,
      'SELECT direction FROM public.loans WHERE id = $1',
      [d.loan_id],
    );
    expect(row?.direction).toBe('in');
  });

  it('is tool_unavailable where lending is off, and forbidden for a viewer', async () => {
    const box = await createThing(t, ibrahim, garage, { name: 'Jack' });
    expect(await tool(louis, 'lend_thing', { thing_id: box.id, person: 'Murdock' })).toMatchObject({
      error: 'tool_unavailable',
    });
    const cup = await createThing(t, ibrahim, home, { name: 'Cup' });
    expect(await tool(talia, 'lend_thing', { thing_id: cup.id, person: 'Murdock' })).toMatchObject({
      error: 'forbidden',
    });
  });

  it('lend_thing ≡ POST /things/:id/lend', async () => {
    const a = await createThing(t, ibrahim, home, { name: 'Saw' });
    const b = await createThing(t, ibrahim, home, { name: 'Saw' });
    const [m] = await own<{ id: string }>(
      db,
      `SELECT id FROM public.people WHERE owner_account_id = $1 AND display_name = 'Murdock'`,
      [home.accountId],
    );
    ok(
      await call(t, `/api/v1/things/${a.id}/lend`, {
        as: louis,
        body: { person: { id: m?.id }, dueOn: addDays(today, 3) },
      }),
      201,
    );
    await data(louis, 'lend_thing', { thing_id: b.id, person: m?.id, due_on: addDays(today, 3) });
    const loanOf = (thingId: string) =>
      own<Record<string, unknown>>(
        db,
        `SELECT direction, person_id, due_on::text, previous_place_id, created_by
           FROM public.loans WHERE thing_id = $1`,
        [thingId],
      ).then((r) => r[0]);
    expect(await loanOf(b.id)).toEqual(await loanOf(a.id));
  });
});

describe('schedules and upcoming', () => {
  it('completes and snoozes a schedule, and upcoming lists what is due', async () => {
    const boiler = await createThing(t, ibrahim, home, { name: 'Boiler' });
    const s = ok(
      await call(t, '/api/v1/schedules', {
        as: ibrahim,
        body: {
          subject: { thingId: boiler.id },
          name: 'Service',
          everyMonths: 12,
          // Anchored a year ago less five days: due in five days.
          anchorOn: addDays(`${Number(today.slice(0, 4)) - 1}${today.slice(4)}`, 5),
        },
      }),
      201,
    );
    const up = await data(louis, 'upcoming', { location_id: home.id, within_days: 30 });
    const row = up.items.find((i: Json) => i.source_id === s.id);
    expect(row).toMatchObject({
      kind: 'due',
      due_on: addDays(today, 5),
      untrusted: { title: 'Service' },
    });
    expect(row.thing).toMatchObject({ id: boiler.id, untrusted: { name: 'Boiler' } });

    const snoozed = await data(louis, 'snooze_schedule', {
      schedule_id: s.id,
      until_date: addDays(today, 20),
    });
    expect(snoozed.undo_until).not.toBeNull();
    const done = await data(louis, 'complete_schedule', { schedule_id: s.id });
    expect(done.schedule_id).toBe(s.id);
    expect(done.next_due_on).not.toBeNull();
    const records = await own(db, 'SELECT 1 FROM public.service_records WHERE thing_id = $1', [
      boiler.id,
    ]);
    expect(records).toHaveLength(1);
  });

  it('upcoming lists low stock as low_stock (0104), and leaves it out when not asked for', async () => {
    const aa = await createThing(t, ibrahim, home, {
      name: 'AA batteries',
      typeId: await builtinType(db, 'batteries'),
      quantity: 2,
    });
    ok(
      await call(t, `/api/v1/things/${aa.id}/stock-rule`, {
        as: ibrahim,
        method: 'PUT',
        body: { minQuantity: 4 },
      }),
    );
    const up = await data(louis, 'upcoming', { location_id: home.id });
    expect(up.items.find((i: Json) => (i.thing as Json | undefined)?.id === aa.id)).toMatchObject({
      kind: 'low_stock',
      source_type: 'stock',
      due_on: today,
    });
    const dueOnly = await data(louis, 'upcoming', { location_id: home.id, kinds: ['due'] });
    expect(dueOnly.items.some((i: Json) => (i.thing as Json | undefined)?.id === aa.id)).toBe(
      false,
    );
  });
});

describe('warranties and claims', () => {
  it('adds a warranty, opens a claim and moves it to repair', async () => {
    const tv = await createThing(t, ibrahim, home, { name: 'TV' });
    const w = await data(louis, 'add_warranty', {
      thing_id: tv.id,
      kind: 'manufacturer',
      term_months: 24,
    });
    expect(w.ends_on.slice(0, 4)).toBe(String(Number(today.slice(0, 4)) + 2));
    const [row] = await own<{ term_months: number; starts_on: string }>(
      db,
      'SELECT term_months, starts_on::text AS starts_on FROM public.warranties WHERE id = $1',
      [w.warranty_id],
    );
    expect(row).toEqual({ term_months: 24, starts_on: today });
    const noTerm = await tool(louis, 'add_warranty', { thing_id: tv.id, kind: 'store' });
    expect(noTerm).toMatchObject({ error: 'validation' });

    const c = await data(louis, 'open_claim', { thing_id: tv.id, warranty_id: w.warranty_id });
    expect(c.status).toBe('open');
    const u = await data(louis, 'update_claim', {
      thing_id: tv.id,
      status: 'in_repair',
      reference: 'RMA-7',
    });
    expect(u).toMatchObject({ claim_id: c.claim_id, status: 'in_repair' });
  });
});
