import { newId, type ScheduleRule, scheduleNext } from '@kept/shared';
import type pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testDb } from '../../test/db.js';
import {
  addMember,
  ownerTx,
  pgError,
  seedTenant,
  seedUser,
  type Tenant,
} from '../../test/tenancy.js';
import { withScope } from './scope.js';

// Step-4 T6 (0052, 0053): schedules and their anchor (D162), kept.schedule_point() as the twin of
// @kept/shared scheduleNext() (Q2, Q27, Q28), and expiring documents renewed while the old one is
// kept (D155, D172; Q31). The agenda view and module state are in src/db/agenda.test.ts.

const db = await testDb();
vi.setConfig({ testTimeout: 60_000 });

let ibrahim: Tenant;
let louis: string; // member
let kitchen: string;
let car: string;
let meter: string;

const as = <T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  withScope(db.pools.app, { userId, mfa: true }, (_tx, c) => fn(c));
const own = <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(sql, values)).rows);

beforeEach(async () => {
  await db.reset();
  ibrahim = await seedTenant(db, 'sch-ibrahim');
  louis = await seedUser(db, 'sch-louis');
  await addMember(db, ibrahim.locationId, louis, 'member');
  kitchen = newId();
  car = newId();
  meter = newId();
  await own(`INSERT INTO public.places (id, location_id, name) VALUES ($1, $2, 'Kitchen')`, [
    kitchen,
    ibrahim.locationId,
  ]);
  await own(
    `INSERT INTO public.things (id, location_id, place_id, name) VALUES ($1, $2, $3, 'Car')`,
    [car, ibrahim.locationId, ibrahim.unplacedId],
  );
  await own(
    `INSERT INTO public.meters (id, location_id, thing_id, kind, unit, "offset")
     VALUES ($1, $2, $3, 'distance', 'km', 100)`,
    [meter, ibrahim.locationId, car],
  );
});

const anchor = async (id: string) =>
  (
    await own<{ anchor_on: string; anchor_value: string | null; base_on: string }>(
      `SELECT anchor_on::text, anchor_value::text, base_on::text FROM public.schedules WHERE id = $1`,
      [id],
    )
  )[0];

const service = (
  userId: string,
  on: string,
  subject: { place?: string; thing?: string },
  reading?: string,
) =>
  as(userId, async (c) => {
    const id = newId();
    await c.query(
      `INSERT INTO public.service_records (id, location_id, thing_id, place_id, serviced_on,
                                           meter_reading_id, logged_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        ibrahim.locationId,
        subject.thing ?? null,
        subject.place ?? null,
        on,
        reading ?? null,
        userId,
      ],
    );
    return id;
  });
const complete = (userId: string, record: string, schedule: string) =>
  as(userId, (c) =>
    c.query(
      `INSERT INTO public.service_completions (location_id, service_record_id, schedule_id)
       VALUES ($1, $2, $3)`,
      [ibrahim.locationId, record, schedule],
    ),
  );

describe('the anchor (D162)', () => {
  it('follows completions as they are added, back-dated, edited and removed', async () => {
    const boiler = await as(louis, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO public.schedules (location_id, place_id, name, every_months, anchor_on,
                                       snoozed_until, skip_next, created_by)
         VALUES ($1, $2, 'Boiler service', 12, '2025-10-01', '2026-11-01', true, $3) RETURNING id`,
        [ibrahim.locationId, kitchen, louis],
      );
      return rows[0]?.id as string;
    });
    expect(await anchor(boiler)).toEqual({
      anchor_on: '2025-10-01',
      anchor_value: null,
      base_on: '2025-10-01',
    });
    const march = await service(louis, '2026-03-10', { place: kitchen });
    await complete(louis, march, boiler);
    expect((await anchor(boiler))?.anchor_on).toBe('2026-03-10');
    // Completing ends the snooze and the skip (Q28).
    expect(
      await own('SELECT snoozed_until, skip_next FROM public.schedules WHERE id = $1', [boiler]),
    ).toEqual([{ snoozed_until: null, skip_next: false }]);
    // A later one, then the earlier one back-dated: the latest date wins.
    const june = await service(louis, '2026-06-01', { place: kitchen });
    await complete(louis, june, boiler);
    expect((await anchor(boiler))?.anchor_on).toBe('2026-06-01');
    await as(louis, (c) =>
      c.query(`UPDATE public.service_records SET serviced_on = '2026-07-01' WHERE id = $1`, [
        march,
      ]),
    );
    expect((await anchor(boiler))?.anchor_on).toBe('2026-07-01');
    // The record goes (a hard delete): the next latest.
    await as(louis, (c) => c.query('DELETE FROM public.service_records WHERE id = $1', [march]));
    expect((await anchor(boiler))?.anchor_on).toBe('2026-06-01');
    // The completion goes: back to the base.
    await as(louis, (c) =>
      c.query('DELETE FROM public.service_completions WHERE schedule_id = $1', [boiler]),
    );
    expect((await anchor(boiler))?.anchor_on).toBe('2025-10-01');
    // "Last done on …" told again: the anchor follows the base while nothing completes it.
    await as(louis, (c) =>
      c.query(`UPDATE public.schedules SET base_on = '2026-01-05' WHERE id = $1`, [boiler]),
    );
    expect((await anchor(boiler))?.anchor_on).toBe('2026-01-05');
  });

  it("takes a unit schedule's value from the completing reading, with the meter's offset", async () => {
    const oil = await as(louis, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO public.schedules (location_id, thing_id, name, every_units, meter_id,
                                       anchor_on, anchor_value, created_by)
         VALUES ($1, $2, 'Oil change', 10000, $3, '2026-01-01', 50000, $4) RETURNING id`,
        [ibrahim.locationId, car, meter, louis],
      );
      return rows[0]?.id as string;
    });
    const reading = newId();
    await own(
      `INSERT INTO public.meter_readings (id, location_id, meter_id, value, taken_at)
       VALUES ($1, $2, $3, 59800, '2026-09-01')`,
      [reading, ibrahim.locationId, meter],
    );
    const record = await service(louis, '2026-09-01', { thing: car }, reading);
    await complete(louis, record, oil);
    expect(await anchor(oil)).toMatchObject({ anchor_on: '2026-09-01', anchor_value: '59900.000' });
    expect(
      (
        await own<{ due_value: string }>(
          `SELECT due_value::text FROM kept.schedule_next($1, '2026-09-02')`,
          [oil],
        )
      )[0]?.due_value,
    ).toBe('69900');
  });

  it("isn't a request's to write, and the anchor bumps change_seq, not row_version", async () => {
    const id = await as(louis, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO public.schedules (location_id, place_id, name, every_months, anchor_on,
                                       created_by)
         VALUES ($1, $2, 'Filter', 6, '2026-01-01', $3) RETURNING id`,
        [ibrahim.locationId, kitchen, louis],
      );
      return rows[0]?.id as string;
    });
    expect(
      (
        await pgError(
          as(louis, (c) =>
            c.query(`UPDATE public.schedules SET anchor_on = '2026-05-01' WHERE id = $1`, [id]),
          ),
        )
      ).code,
    ).toBe('42501');
    const before = (
      await own<{ row_version: number; change_seq: string }>(
        'SELECT row_version, change_seq FROM public.schedules WHERE id = $1',
        [id],
      )
    )[0];
    await complete(louis, await service(louis, '2026-04-01', { place: kitchen }), id);
    const after = (
      await own<{ row_version: number; change_seq: string }>(
        'SELECT row_version, change_seq FROM public.schedules WHERE id = $1',
        [id],
      )
    )[0];
    expect(after?.row_version).toBe(before?.row_version);
    expect(BigInt(after?.change_seq ?? 0)).toBeGreaterThan(BigInt(before?.change_seq ?? 0));
  });

  it('refuses a schedule with no rule, a meter on a place, a one-off with an interval', async () => {
    const bad = (columns: string, values: string) =>
      pgError(
        own(
          `INSERT INTO public.schedules (location_id, name, anchor_on, created_by, ${columns})
           VALUES ($1, 'x', current_date, $2, ${values})`,
          [ibrahim.locationId, ibrahim.userId],
        ),
      );
    expect((await bad('place_id', `'${kitchen}'`)).constraint).toBe('schedules_rule_chk');
    expect(
      (await bad('place_id, every_units, meter_id', `'${kitchen}', 10, '${meter}'`)).constraint,
    ).toBe('schedules_meter_thing_chk');
    expect(
      (await bad('place_id, every_months, due_on', `'${kitchen}', 6, current_date`)).constraint,
    ).toBe('schedules_one_off_chk');
  });
});

describe('kept.schedule_point() is scheduleNext() (Q2, Q27, Q28)', () => {
  type Case = { rule: ScheduleRule; today: string; latest?: string | null };
  const base = { anchorOn: '2026-01-31', leadDays: 14 };
  const cases: Case[] = [];
  const todays = ['2026-02-10', '2026-02-14', '2026-02-28', '2026-03-01', '2026-03-30'];
  for (const today of todays) {
    cases.push({ rule: { ...base, everyMonths: 1 }, today });
    cases.push({ rule: { ...base, everyMonths: 1, skipNext: true }, today });
    cases.push({ rule: { ...base, dueOn: '2026-02-20', leadDays: 3 }, today });
    cases.push({ rule: { ...base, everyMonths: 1, snoozedUntil: '2026-03-05' }, today });
  }
  for (const latest of [null, '8999', '9000', '9500', '10000', '10000.5', '12000']) {
    cases.push({
      rule: { anchorOn: '2026-01-01', anchorValue: '0', everyUnits: '10000' },
      today: '2026-02-01',
      latest,
    });
    cases.push({
      rule: {
        anchorOn: '2025-08-01',
        anchorValue: '0',
        everyUnits: '10000',
        everyMonths: 6,
        leadUnits: '250',
      },
      today: '2026-01-20',
      latest,
    });
  }
  cases.push({ rule: { anchorOn: '2024-02-29', everyMonths: 12 }, today: '2025-02-28' });
  cases.push({ rule: { anchorOn: '2024-02-29', everyMonths: 12 }, today: '2025-03-01' });
  cases.push({
    rule: { anchorOn: '2023-03-31', everyMonths: 11, leadDays: 0 },
    today: '2024-02-29',
  });
  cases.push({
    rule: { anchorOn: '2026-01-01', anchorValue: '100.25', everyUnits: '0.5', leadUnits: '0' },
    today: '2026-01-02',
    latest: '100.75',
  });
  cases.push({
    rule: { anchorOn: '2026-01-01', everyUnits: '5000', snoozedUntilValue: '5200' },
    today: '2026-06-01',
    latest: '5100',
  });
  cases.push({
    rule: { anchorOn: '2026-01-01', everyUnits: '5000', skipNext: true },
    today: '2026-06-01',
    latest: '9600',
  });

  it(`agrees on ${cases.length} cases: month ends, leap days, meters, snooze and skip`, async () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
    for (const { rule, today, latest } of cases) {
      const ts = scheduleNext(rule, { today, latestValue: latest ?? null });
      const [sql] = await own<{
        due_on: string | null;
        due_value: string | null;
        state: string;
        basis: string;
      }>(
        `SELECT due_on::text, due_value::text, state, basis
           FROM kept.schedule_point($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          rule.everyMonths ?? null,
          rule.everyUnits ?? null,
          rule.dueOn ?? null,
          rule.anchorOn,
          rule.anchorValue ?? null,
          rule.snoozedUntil ?? null,
          rule.snoozedUntilValue ?? null,
          rule.skipNext ?? false,
          rule.leadDays ?? 14,
          rule.leadUnits ?? null,
          today,
          latest ?? null,
        ],
      );
      expect(sql, JSON.stringify({ rule, today, latest })).toEqual({
        due_on: ts.dueOn,
        due_value: ts.dueValue,
        state: ts.state,
        basis: ts.basis,
      });
    }
  });
});

describe('kept.schedule_next() with the estimate is scheduleNext() with at.eta (step 5, T7)', () => {
  // Each case: a series (days before now, value), a replacement, and a rule. The TS twin gets the
  // meter's newest reading (kept.meter_latest) and, for the value it asks, kept.meter_eta, the one
  // implementation of the estimate (Q8).
  type Case = {
    name: string;
    series: [number, number][];
    replaced?: { daysAgo: number; offset: number };
    rule: Omit<ScheduleRule, 'anchorOn'> & { anchorDaysAgo: number };
  };
  const units = { everyUnits: '10000', anchorValue: '50000', anchorDaysAgo: 200 };
  const cases: Case[] = [
    {
      name: 'fresh, upcoming',
      series: [
        [60, 50000],
        [0, 56000],
      ],
      rule: units,
    },
    {
      name: 'estimate past today: due',
      series: [
        [90, 50000],
        [35, 55700],
      ],
      rule: units,
    },
    {
      name: 'stale but rated',
      series: [
        [80, 50000],
        [40, 54000],
      ],
      rule: units,
    },
    {
      name: 'unknown after 60 days',
      series: [
        [120, 50000],
        [70, 58000],
      ],
      rule: units,
    },
    { name: 'one reading: no rate', series: [[3, 55000]], rule: units },
    { name: 'no reading', series: [], rule: units },
    {
      name: 'a replacement in the window',
      series: [
        [60, 50000],
        [0, 900],
      ],
      replaced: { daysAgo: 30, offset: 55000 },
      rule: units,
    },
    {
      name: 'months first',
      series: [
        [60, 50000],
        [0, 51000],
      ],
      rule: { ...units, everyMonths: 6, anchorDaysAgo: 100 },
    },
    {
      name: 'due by its date, an estimate further off',
      series: [
        [60, 50000],
        [0, 51000],
      ],
      rule: { ...units, everyMonths: 6, anchorDaysAgo: 175 },
    },
    {
      name: 'estimate first',
      series: [
        [60, 50000],
        [0, 58000],
      ],
      rule: { ...units, everyMonths: 12, anchorDaysAgo: 100 },
    },
    {
      name: 'snoozed by reading',
      series: [
        [60, 50000],
        [0, 59500],
      ],
      rule: { ...units, snoozedUntilValue: '61000' },
    },
    {
      name: 'skipped once',
      series: [
        [60, 50000],
        [0, 62000],
      ],
      rule: { ...units, skipNext: true },
    },
    {
      name: 'already due by its reading',
      series: [
        [60, 50000],
        [0, 59200],
      ],
      rule: units,
    },
  ];

  it(`agrees on ${cases.length} cases: stale, unknown, a replacement, months or estimate first`, async () => {
    const outcomes = new Set<string>();
    for (const c of cases) {
      const m = newId();
      await own(
        `INSERT INTO public.meters (id, location_id, thing_id, kind, unit, "offset")
         VALUES ($1, $2, $3, 'distance', 'km', $4)`,
        [m, ibrahim.locationId, car, c.replaced?.offset ?? 0],
      );
      if (c.replaced) {
        await own(
          `INSERT INTO public.meter_events (location_id, meter_id, kind, at, "offset")
           VALUES ($1, $2, 'replaced', now() - make_interval(days => $3), $4)`,
          [ibrahim.locationId, m, c.replaced.daysAgo, c.replaced.offset],
        );
      }
      for (const [daysAgo, value] of c.series) {
        await own(
          `INSERT INTO public.meter_readings (location_id, meter_id, value, taken_at)
           VALUES ($1, $2, $3, now() - make_interval(days => $4))`,
          [ibrahim.locationId, m, value, daysAgo],
        );
      }
      const [s] = await own<{ id: string; anchor_on: string; today: string }>(
        `INSERT INTO public.schedules (location_id, thing_id, name, every_months, every_units,
                                       meter_id, anchor_on, anchor_value, snoozed_until_value,
                                       skip_next, created_by)
         VALUES ($1, $2, $3, $4, $5, $6,
                 (now() AT TIME ZONE 'Africa/Cairo')::date - $7::int, $8, $9, $10, $11)
         RETURNING id, anchor_on::text, (now() AT TIME ZONE 'Africa/Cairo')::date::text AS today`,
        [
          ibrahim.locationId,
          car,
          c.name,
          c.rule.everyMonths ?? null,
          c.rule.everyUnits ?? null,
          m,
          c.rule.anchorDaysAgo,
          c.rule.anchorValue ?? null,
          c.rule.snoozedUntilValue ?? null,
          c.rule.skipNext ?? false,
          ibrahim.userId,
        ],
      );
      const {
        id,
        anchor_on: anchorOn,
        today,
      } = s as { id: string; anchor_on: string; today: string };
      const [latest] = await own<{ v: string | null }>(
        'SELECT trim_scale(kept.meter_latest($1))::text AS v',
        [m],
      );
      const rule: ScheduleRule = { ...c.rule, anchorOn };
      const asked: string[] = [];
      scheduleNext(rule, {
        today,
        latestValue: latest?.v ?? null,
        eta: (v) => {
          asked.push(v);
          return null;
        },
      });
      const etas = new Map<string, string | null>();
      for (const v of asked) {
        const [r] = await own<{ d: string | null }>('SELECT kept.meter_eta($1, $2)::text AS d', [
          m,
          v,
        ]);
        etas.set(v, r?.d ?? null);
      }
      const ts = scheduleNext(rule, {
        today,
        latestValue: latest?.v ?? null,
        eta: (v) => etas.get(v) ?? null,
      });
      const [sql] = await own(
        `SELECT due_on::text, trim_scale(due_value)::text AS due_value, state, basis,
                estimated_on::text, estimated
           FROM kept.schedule_next($1, $2)`,
        [id, today],
      );
      expect(sql, c.name).toEqual({
        due_on: ts.dueOn,
        due_value: ts.dueValue,
        state: ts.state,
        basis: ts.basis,
        estimated_on: ts.estimatedOn,
        estimated: ts.estimated,
      });
      outcomes.add(`${ts.state}:${ts.estimated}:${ts.estimatedOn !== null}`);
    }
    // The table reaches each branch: due by the estimate, estimated ahead, a date side first, no
    // estimate at all.
    expect([...outcomes].sort()).toEqual(
      expect.arrayContaining([
        'due:true:true',
        'upcoming:true:true',
        'upcoming:false:true',
        'upcoming:false:false',
      ]),
    );
  });
});

describe('expiring documents (D155, D172; Q31)', () => {
  const add = (userId: string, values: Record<string, unknown>) =>
    as(userId, async (c) => {
      const v = { kind: 'insurance', title: null, thing: null, place: null, ...values };
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO public.expiring_documents (location_id, thing_id, place_id, kind, title,
                                                expires_on, created_by)
         VALUES ($1, $2, $3, $4, $5, '2026-10-20', $6) RETURNING id`,
        [ibrahim.locationId, v.thing, v.place, v.kind, v.title, userId],
      );
      return rows[0]?.id as string;
    });

  it('need a title for "other", and one subject at most (both none: the location)', async () => {
    expect((await pgError(add(louis, { kind: 'other' }))).constraint).toBe(
      'expiring_documents_other_chk',
    );
    await add(louis, { kind: 'other', title: 'Gym contract' });
    expect((await pgError(add(louis, { thing: car, place: kitchen }))).constraint).toBe(
      'expiring_documents_subject_chk',
    );
  });

  it('renew by pointing the old one at the new; deleting the new frees the old', async () => {
    const old = await add(louis, {});
    const renewed = await add(louis, {});
    await as(louis, (c) =>
      c.query('UPDATE public.expiring_documents SET superseded_by_id = $2 WHERE id = $1', [
        old,
        renewed,
      ]),
    );
    await as(louis, (c) =>
      c.query('DELETE FROM public.expiring_documents WHERE id = $1', [renewed]),
    );
    expect(
      await own('SELECT superseded_by_id FROM public.expiring_documents WHERE id = $1', [old]),
    ).toEqual([{ superseded_by_id: null }]);
  });
});
