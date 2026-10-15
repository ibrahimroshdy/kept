import {
  byteLength,
  type Envelope,
  envelopeSchema,
  isToolError,
  OUTPUT_LIMIT_BYTES,
  TOOL_DEFS,
  type ToolName,
} from '@kept/mcp';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import {
  builtinType,
  createLocation,
  createThing,
  eventsOf,
  type Loc,
  ok,
  own,
} from '../../test/things.js';
import { runTool, toolsFor } from './context.js';
import { handledTools } from './registry.js';
import type { ToolContext } from './types.js';

// `log_service` (step 5) through runTool(), as the assistant (after the person confirms its
// card, step-6 T13) and MCP call it: step 4's createService, so the same rules as
// POST /api/v1/service-records, and always a confirmed record, never a draft.

let db: TestDb;
let t: TestApp;
let ibrahim: Person;
let louis: Person;
let talia: Person;
let home: Loc;
let garage: Loc; // essentials: Schedules off, Consumables off
let filters: string;

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
  filters = await builtinType(db, 'filters');
});

let seq = 0;
function ctx(who: Person): ToolContext {
  seq += 1;
  return {
    deps: { pools: db.pools, jobs: null, files: null, providerResolved: async () => true },
    principal: { userId: who.userId, mfa: false, scope: 'write' },
    locale: 'en',
    requestId: `log-service-${seq}`,
    via: 'assistant',
  };
}

async function tool(who: Person, name: ToolName, args: Record<string, unknown>) {
  const env = (await runTool(ctx(who), name, args)) as Envelope<Record<string, unknown>>;
  const parsed = envelopeSchema(TOOL_DEFS[name].output).safeParse(env);
  expect(parsed.success, JSON.stringify(parsed.error?.issues?.slice(0, 3))).toBe(true);
  expect(byteLength(env)).toBeLessThanOrEqual(OUTPUT_LIMIT_BYTES);
  return env;
}

// biome-ignore lint/suspicious/noExplicitAny: the envelope was validated against its zod schema
async function data(who: Person, name: ToolName, args: Record<string, unknown>): Promise<any> {
  const env = await tool(who, name, args);
  if (isToolError(env)) throw new Error(`${name}: ${env.error} (${env.hint})`);
  return env.data;
}

const today = async () =>
  (
    await own<{ d: string }>(
      db,
      `SELECT (now() AT TIME ZONE timezone)::date::text AS d
                                    FROM public.locations WHERE id = $1`,
      [home.id],
    )
  )[0]?.d as string;

async function car(name: string, loc = home): Promise<string> {
  const d = await data(louis, 'add_thing', { location_id: loc.id, items: [{ name, type: 'Car' }] });
  return d.things[0].id;
}

describe('log_service (step 5)', () => {
  it('is handled, offered to a member and not to a viewer', async () => {
    expect(handledTools()).toContain('log_service');
    const forLouis = await toolsFor(ctx(louis), [home.id]);
    expect(forLouis[0]?.tools).toContain('log_service');
    const forTalia = await toolsFor(ctx(talia), [home.id]);
    expect(forTalia[0]?.tools).not.toContain('log_service');
  });

  it('logs a confirmed service with its vendor, lines and total, completing a schedule, undoable', async () => {
    const thing = await car('Service car');
    const schedule = ok(
      await call(t, '/api/v1/schedules', {
        as: ibrahim,
        body: { subject: { thingId: thing }, name: 'Oil & filter', everyMonths: 6 },
      }),
      201,
    );
    const day = await today();
    const out = await data(louis, 'log_service', {
      location_id: home.id,
      thing_id: thing,
      serviced_on: day,
      vendor: 'Bay Motors',
      lines: [
        { description: 'Oil 5W-30', amount: { amount: '900', currency: 'EGP' } },
        { description: 'Oil filter', amount: { amount: '350.50', currency: 'EGP' } },
      ],
      completes: [schedule.id],
    });
    expect(out.undo_until).not.toBeNull();
    const [row] = await own<Record<string, unknown>>(
      db,
      `SELECT r.review_state, trim_scale(r.total)::text AS total, r.currency, v.name AS vendor,
              r.logged_by, (SELECT count(*)::int FROM public.service_lines l
                             WHERE l.service_record_id = r.id) AS lines,
              (SELECT array_agg(c.schedule_id) FROM public.service_completions c
                WHERE c.service_record_id = r.id) AS completes
         FROM public.service_records r LEFT JOIN public.vendors v ON v.id = r.vendor_id
        WHERE r.id = $1`,
      [out.service_id],
    );
    expect(row).toEqual({
      review_state: 'confirmed',
      total: '1250.5',
      currency: 'EGP',
      vendor: 'Bay Motors',
      logged_by: louis.userId,
      lines: 2,
      completes: [schedule.id],
    });
    // Audited as Louis, the person who confirmed it.
    const events = await eventsOf(db, home.id, out.service_id);
    expect(events.map((e) => [e.action, e.actor_id])).toEqual([
      ['service_record.create', louis.userId],
    ]);

    // The same vendor name again is the same vendor.
    const again = await data(louis, 'log_service', {
      location_id: home.id,
      thing_id: thing,
      serviced_on: day,
      vendor: 'bay motors',
    });
    expect(again.undo_until).toBeNull();
    const vendors = await own<{ n: number }>(
      db,
      `SELECT count(DISTINCT vendor_id)::int AS n FROM public.service_records
        WHERE id = ANY($1::uuid[])`,
      [[out.service_id, again.service_id]],
    );
    expect(vendors).toEqual([{ n: 1 }]);

    ok(await call(t, `/api/v1/audit/${out.audit_event_id}/undo`, { as: louis, body: {} }));
    expect(
      await own(db, 'SELECT 1 FROM public.service_records WHERE id = $1', [out.service_id]),
    ).toEqual([]);
  });

  it('refuses a viewer, a future day, two currencies and a subject in two ways', async () => {
    const thing = await car('Refused car');
    const day = await today();
    expect(
      await tool(talia, 'log_service', {
        location_id: home.id,
        thing_id: thing,
        serviced_on: day,
      }),
    ).toMatchObject({ error: 'forbidden' });
    expect(
      await tool(louis, 'log_service', {
        location_id: home.id,
        thing_id: thing,
        serviced_on: '2099-01-01',
      }),
    ).toMatchObject({ error: 'validation' });
    expect(
      await tool(louis, 'log_service', {
        location_id: home.id,
        thing_id: thing,
        serviced_on: day,
        total: { amount: '10', currency: 'EGP' },
        lines: [{ description: 'Wash', amount: { amount: '10', currency: 'USD' } }],
      }),
    ).toMatchObject({ error: 'validation' });
    expect(
      await tool(louis, 'log_service', { location_id: home.id, serviced_on: day }),
    ).toMatchObject({ error: 'validation' });
    expect(
      await own(db, 'SELECT 1 FROM public.service_records WHERE thing_id = $1', [thing]),
    ).toEqual([]);
  });

  it('logs where Schedules is off, but completes nothing there', async () => {
    const thing = await car('Garage car', garage);
    const day = await today();
    const out = await data(louis, 'log_service', {
      location_id: garage.id,
      thing_id: thing,
      serviced_on: day,
      lines: [{ description: 'Tyre rotation' }],
    });
    expect(out.service_id).toEqual(expect.any(String));
    const env = await tool(louis, 'log_service', {
      location_id: garage.id,
      thing_id: thing,
      serviced_on: day,
      completes: ['0192f0c3-7c55-7000-8000-000000000009'],
    });
    expect(isToolError(env)).toBe(true);
  });
});

describe('log_service from stock (D236)', () => {
  const quantityOf = async (id: string) =>
    (
      await own<{ q: string }>(
        db,
        'SELECT trim_scale(quantity)::text AS q FROM public.things WHERE id = $1',
        [id],
      )
    )[0]?.q;
  const shelf = async (name: string, quantity: number, loc: Loc = home) =>
    (await createThing(t, ibrahim, loc, { name, typeId: filters, quantity })).id as string;
  const codeOf = async (id: string) =>
    (
      await own<{ code: string }>(
        db,
        'SELECT code FROM public.short_ids WHERE thing_id = $1 AND is_primary',
        [id],
      )
    )[0]?.code as string;

  it('a line takes stock from a consumable named by short ID; how much, else 1', async () => {
    const thing = await car('Stock car');
    const oil = await shelf('Engine oil 5W-30', 5);
    const filter = await shelf('Oil filter', 3);
    const out = await data(louis, 'log_service', {
      location_id: home.id,
      thing_id: thing,
      serviced_on: await today(),
      lines: [
        {
          description: 'Oil change',
          amount: { amount: '900', currency: 'EGP' },
          consumable_thing_id: (await codeOf(oil)).toLowerCase(),
          consumed_quantity: 4.5,
        },
        { description: 'Oil filter', consumable_thing_id: filter },
        { description: 'Check-up' },
      ],
    });
    expect(await quantityOf(oil)).toBe('0.5');
    expect(await quantityOf(filter)).toBe('2');
    const lines = await own<Record<string, unknown>>(
      db,
      `SELECT description, consumable_thing_id AS stock,
              trim_scale(consumed_quantity)::text AS consumed
         FROM public.service_lines WHERE service_record_id = $1 ORDER BY sort`,
      [out.service_id],
    );
    expect(lines).toEqual([
      { description: 'Oil change', stock: oil, consumed: '4.5' },
      { description: 'Oil filter', stock: filter, consumed: null },
      { description: 'Check-up', stock: null, consumed: null },
    ]);
    // On the consumable's history, as Louis, linked to the service.
    const events = (await eventsOf(db, home.id, oil)).filter((e) => e.action === 'thing.stock_use');
    expect(events.map((e) => e.actor_id)).toEqual([louis.userId]);
    expect(events[0]?.diff.quantity).toMatchObject({ after: '0.5' });
    expect(events[0]?.diff.service_record_id).toMatchObject({ after: out.service_id });
  });

  it('refuses more than is left, saying what is left on which line, and writes nothing', async () => {
    const thing = await car('Short car');
    const oil = await shelf('Gear oil', 2);
    const env = await tool(louis, 'log_service', {
      location_id: home.id,
      thing_id: thing,
      serviced_on: await today(),
      lines: [
        { description: 'Wash' },
        { description: 'Gearbox oil', consumable_thing_id: oil, consumed_quantity: 3 },
      ],
    });
    expect(env).toMatchObject({ error: 'not_enough_stock' });
    const hint = (env as { hint: string }).hint;
    expect(hint).toContain('lines.1.consumed_quantity');
    expect(hint).toContain('only 2 left');
    // A name is user-written text: never in a hint (D179).
    expect(hint).not.toContain('Gear oil');
    expect(await quantityOf(oil)).toBe('2');
    expect(
      await own(db, 'SELECT 1 FROM public.service_records WHERE thing_id = $1', [thing]),
    ).toEqual([]);
  });

  it('refuses a thing that is not a consumable, one elsewhere, a lone quantity, and Consumables off', async () => {
    const thing = await car('Picky car');
    const day = await today();
    const drill = (await createThing(t, ibrahim, home, { name: 'Drill' })).id as string;
    const notConsumable = await tool(louis, 'log_service', {
      location_id: home.id,
      thing_id: thing,
      serviced_on: day,
      lines: [{ description: 'Drilled', consumable_thing_id: drill }],
    });
    expect(notConsumable).toMatchObject({ error: 'not_consumable' });
    expect((notConsumable as { hint: string }).hint).toContain('lines.0.consumable_thing_id');

    const elsewhere = await shelf('Garage filter', 4, garage);
    expect(
      await tool(louis, 'log_service', {
        location_id: home.id,
        thing_id: thing,
        serviced_on: day,
        lines: [{ description: 'Filter', consumable_thing_id: elsewhere }],
      }),
    ).toMatchObject({ error: 'not_found', hint: expect.stringContaining('lines.0') });

    expect(
      await tool(louis, 'log_service', {
        location_id: home.id,
        thing_id: thing,
        serviced_on: day,
        lines: [{ description: 'Oil', consumed_quantity: 2 }],
      }),
    ).toMatchObject({ error: 'validation' });

    // The garage is on Essentials: no Consumables, so the line can't take stock there (D113).
    const garageCar = await car('Garage stock car', garage);
    expect(
      await tool(louis, 'log_service', {
        location_id: garage.id,
        thing_id: garageCar,
        serviced_on: day,
        lines: [{ description: 'Filter', consumable_thing_id: elsewhere }],
      }),
    ).toMatchObject({ error: 'tool_unavailable' });
    expect(await quantityOf(elsewhere)).toBe('4');
    expect(
      await own(db, 'SELECT 1 FROM public.service_records WHERE thing_id = ANY($1::uuid[])', [
        [thing, garageCar],
      ]),
    ).toEqual([]);
  });
});
