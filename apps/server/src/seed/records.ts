import { newId } from '@kept/shared';
import type pg from 'pg';
import type { Pools } from '../db/pools.js';
import { type Scope, withScope } from '../db/scope.js';
import { PEOPLE, type PersonKey } from './cast.js';
import { type Client, expectStatus, type Json, SeedError } from './client.js';
import { photoJpeg, sha256Hex } from './photos.js';

// What the households did with their things (step-4 plan T30's carry-over, step-5 plan T16; D152,
// D185), after seed/stock.ts has made the things: warranties, a claim, valuations, loans,
// schedules, expiring documents, an incident and the account's exchange rates (step 4); and the
// vehicles (step 5): the Corolla's six months of fills (a partial, one after a missed fill-up),
// its starter schedules, two services (an oil change completing "Oil change", and front brake
// pads), a vehicle licence due in 23 days with its renewal cost and an insurance document, and
// proof photos on two of its readings; Alfred's Hyundai in بيت العائلة with Arabic entries and an
// EGP fill history; and a generator with an hours meter. Alfred logs most, Bruce one service.
//
// Every write goes through the real routes as the person the board shows doing it. Idempotent as
// stock.ts is: each step looks first and does only what is missing. The looks are reads in the
// person's own scope (kept_app, row-level security), by natural keys: a schedule's or a
// document's name, a warranty's kind, a fill history's existence.
//
// Fuel is the Complete preset's (D113): the seed turns it on in the Garage and بيت العائلة.

export type RecordsContext = {
  client: Client;
  pools: Pick<Pools, 'app'>;
  cookieOf: (key: PersonKey) => string;
  /** Household name → location id. */
  locations: ReadonlyMap<string, string>;
  hasFiles: boolean;
  now: Date;
  made: () => void;
  note: (text: string) => void;
};

const DAY_MS = 86_400_000;
const CAIRO = 'Africa/Cairo';

/** The Corolla's odometer as stock.ts reads it: 51,200 km 40 days ago, 52,340 6 days ago; the
 * fills before it follow a steady 60 km a day back to 41,100 km, 179 days ago. */
const COROLLA_CURVE: readonly [number, number][] = [
  [179, 41_100],
  [40, 51_200],
  [6, 52_340],
];

/** km on day `daysAgo`, interpolated on the curve (its first segment carried on before it). */
function odometerAt(curve: readonly [number, number][], daysAgo: number): number {
  for (let i = 0; i < curve.length - 1; i++) {
    const [d0, v0] = curve[i] as [number, number];
    const [d1, v1] = curve[i + 1] as [number, number];
    if ((daysAgo <= d0 || i === 0) && daysAgo >= d1) {
      return Math.round(v0 + ((d0 - daysAgo) / (d0 - d1)) * (v1 - v0));
    }
  }
  throw new SeedError(`no odometer for ${daysAgo} days ago`);
}

type Fill = {
  daysAgo: number;
  odometer: number;
  litres: string;
  cost: string;
  isFull: boolean;
  missedBefore: boolean;
  by: PersonKey;
  note?: string;
};

/** Fills every `every` days from `from` to `to` days ago at `per100` L/100 km and `price` a
 * litre; `partial` is half a tank (the next full one takes the rest), `missed` follows a missed
 * fill-up. */
function fillsOf(o: {
  curve: readonly [number, number][];
  from: number;
  to: number;
  every: number;
  per100: number;
  price: (i: number) => number;
  partial: number;
  missed: number;
  by: (i: number) => PersonKey;
  note?: (i: number) => string | undefined;
}): Fill[] {
  const out: Fill[] = [];
  let prev = odometerAt(o.curve, o.from + o.every);
  let carry = 0;
  for (let d = o.from, i = 0; d >= o.to; d -= o.every, i++) {
    const odometer = odometerAt(o.curve, d);
    const used = ((odometer - prev) * o.per100) / 100 + carry;
    const partial = i === o.partial;
    const litres = partial ? used / 2 : used;
    carry = partial ? used / 2 : 0;
    prev = odometer;
    const note = o.note?.(i);
    out.push({
      daysAgo: d,
      odometer,
      litres: litres.toFixed(2),
      cost: (litres * o.price(i)).toFixed(2),
      isFull: !partial,
      missedBefore: i === o.missed,
      by: o.by(i),
      ...(note ? { note } : {}),
    });
  }
  return out;
}

export async function stockRecords(ctx: RecordsContext): Promise<void> {
  const { client } = ctx;
  const send = async (
    who: PersonKey,
    method: 'POST' | 'PUT',
    url: string,
    body: unknown,
    ok: number[],
    what: string,
    headers?: Record<string, string>,
  ): Promise<Json> =>
    expectStatus(
      await client.call(method, url, {
        cookie: ctx.cookieOf(who),
        body,
        headers: {
          'accept-language': PEOPLE[who].locale,
          ...(method === 'POST' ? { 'idempotency-key': newId() } : {}),
          ...headers,
        },
      }),
      ok,
      what,
    );
  const userIds = new Map<PersonKey, string>();
  const userId = async (who: PersonKey): Promise<string> => {
    let id = userIds.get(who);
    if (!id) {
      const res = await client.call('GET', '/api/v1/me', { cookie: ctx.cookieOf(who) });
      const me = expectStatus(res, [200], `me of ${who}`);
      id = String((me.user as Json).id);
      userIds.set(who, id);
    }
    return id;
  };
  /** A read in `who`'s scope (kept_app, row-level security): what a step looks at first. */
  const read = async <T extends pg.QueryResultRow>(
    who: PersonKey,
    text: string,
    values: unknown[] = [],
  ): Promise<T[]> => {
    const scope: Scope = { userId: await userId(who), mfa: false };
    return withScope(ctx.pools.app, scope, async (_tx, c) => (await c.query<T>(text, values)).rows);
  };
  const dayOf = (daysAgo: number) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: CAIRO }).format(
      new Date(ctx.now.getTime() - daysAgo * DAY_MS),
    );
  /** Mid-morning in Cairo, `daysAgo` days before now. */
  const atOf = (daysAgo: number) => {
    const d = new Date(ctx.now.getTime() - daysAgo * DAY_MS);
    d.setUTCHours(7, 30, 0, 0);
    return d.toISOString();
  };
  const location = (name: string) => {
    const id = ctx.locations.get(name);
    if (!id) throw new SeedError(`no location ${name}`);
    return id;
  };
  const thingIn = async (who: PersonKey, locationId: string, name: string) => {
    const [row] = await read<{ id: string }>(
      who,
      `SELECT id FROM public.things WHERE location_id = $1 AND name = $2 AND deleted_at IS NULL
        ORDER BY created_at LIMIT 1`,
      [locationId, name],
    );
    return row?.id ?? null;
  };
  const mustThing = async (who: PersonKey, locationId: string, name: string) => {
    const id = await thingIn(who, locationId, name);
    if (!id) throw new SeedError(`no thing ${name}`);
    return id;
  };
  const placeIn = async (who: PersonKey, locationId: string, name: string) => {
    const [row] = await read<{ id: string }>(
      who,
      `SELECT id FROM public.places WHERE location_id = $1 AND name = $2 AND deleted_at IS NULL
        ORDER BY created_at LIMIT 1`,
      [locationId, name],
    );
    if (!row) throw new SeedError(`no place ${name}`);
    return row.id;
  };
  const meterOf = async (who: PersonKey, thingId: string) => {
    const [row] = await read<{ id: string }>(
      who,
      'SELECT id FROM public.meters WHERE thing_id = $1 ORDER BY created_at, id LIMIT 1',
      [thingId],
    );
    if (!row) throw new SeedError(`no meter on ${thingId}`);
    return row.id;
  };
  const upload = async (who: PersonKey, locationId: string, colour: string) => {
    const bytes = await photoJpeg(colour, 'photo');
    const res = await send(
      who,
      'PUT',
      `/api/v1/files/${newId()}?locationId=${locationId}&class=photo`,
      bytes,
      [200, 201],
      'upload of a photo',
      { 'content-type': 'image/jpeg', 'x-kept-sha256': sha256Hex(bytes) },
    );
    return String(res.id);
  };
  const turnOn = async (owner: PersonKey, locationId: string, module: string) => {
    const [row] = await read<{ on: boolean }>(owner, 'SELECT kept.module_on($1, $2) AS on', [
      locationId,
      module,
    ]);
    if (row?.on) return;
    await send(
      owner,
      'POST',
      `/api/v1/locations/${locationId}/modules`,
      { module, enabled: true },
      [200],
      `${module} on`,
    );
    ctx.made();
  };

  const home = location('Home');
  const garage = location('Garage');
  const family = location('بيت العائلة');
  const [{ account: homeAccount } = { account: '' }] = await read<{ account: string }>(
    'ibrahim',
    'SELECT owner_account_id AS account FROM public.locations WHERE id = $1',
    [home],
  );

  // --- exchange rates (step 4, D76): the account's own, for converted totals -------------------
  const rates = await read<{ from_ccy: string; to_ccy: string }>(
    'ibrahim',
    'SELECT from_ccy, to_ccy FROM public.fx_rates WHERE owner_account_id = $1',
    [homeAccount],
  );
  for (const [fromCcy, toCcy, rate] of [
    ['USD', 'EGP', '48.35'],
    ['EUR', 'EGP', '56.1'],
  ] as const) {
    if (rates.some((r) => r.from_ccy === fromCcy && r.to_ccy === toCcy)) continue;
    await send(
      'ibrahim',
      'PUT',
      `/api/v1/accounts/${homeAccount}/fx-rates`,
      { fromCcy, toCcy, rate, validFrom: dayOf(30) },
      [200, 201],
      `rate ${fromCcy}→${toCcy}`,
    );
    ctx.made();
  }

  // --- warranties, a claim and valuations (step 4) ------------------------------------------------
  type WarrantySpec = {
    who: PersonKey;
    location: string;
    thing: string;
    kind: 'manufacturer' | 'extended' | 'store';
    provider: string;
    startsOn: string;
    termMonths: number;
    registrationDeadline?: string;
  };
  const warranties: WarrantySpec[] = [
    {
      who: 'ibrahim',
      location: home,
      thing: 'Samsung TV, 55″',
      kind: 'manufacturer',
      provider: 'Samsung',
      startsOn: dayOf(400),
      termMonths: 24,
    },
    {
      who: 'ibrahim',
      location: home,
      thing: 'Wi-Fi router',
      kind: 'manufacturer',
      provider: 'TP-Link',
      startsOn: '2025-06-02',
      termMonths: 36,
    },
    {
      who: 'ibrahim',
      location: home,
      thing: 'ThinkPad T14',
      kind: 'manufacturer',
      provider: 'Lenovo',
      startsOn: '2024-11-20',
      termMonths: 12,
    },
    {
      who: 'ibrahim',
      location: garage,
      thing: 'Bosch drill, 18 V',
      kind: 'manufacturer',
      provider: 'Bosch',
      startsOn: '2025-03-14',
      termMonths: 24,
      registrationDeadline: dayOf(-10),
    },
    {
      who: 'alfred',
      location: family,
      thing: 'ثلاجة توشيبا',
      kind: 'store',
      provider: 'كارفور',
      startsOn: '2026-02-11',
      termMonths: 12,
    },
  ];
  const warrantyIds = new Map<string, string>();
  for (const w of warranties) {
    const thingId = await mustThing(w.who, w.location, w.thing);
    const [have] = await read<{ id: string }>(
      w.who,
      'SELECT id FROM public.warranties WHERE thing_id = $1 AND kind = $2 LIMIT 1',
      [thingId, w.kind],
    );
    let id = have?.id;
    if (!id) {
      const made = await send(
        w.who,
        'POST',
        `/api/v1/things/${thingId}/warranties`,
        {
          kind: w.kind,
          provider: w.provider,
          startsOn: w.startsOn,
          termMonths: w.termMonths,
          ...(w.registrationDeadline
            ? { registered: false, registrationDeadline: w.registrationDeadline }
            : {}),
        },
        [201],
        `warranty on ${w.thing}`,
      );
      id = String(made.id);
      ctx.made();
    }
    warrantyIds.set(w.thing, id);
  }

  // The TV is in repair under its warranty, at the service centre (screens §5's claim card).
  const tv = await mustThing('ibrahim', home, 'Samsung TV, 55″');
  const [claim] = await read<{ id: string }>(
    'ibrahim',
    'SELECT id FROM public.claims WHERE thing_id = $1 LIMIT 1',
    [tv],
  );
  if (!claim) {
    await send(
      'ibrahim',
      'POST',
      `/api/v1/things/${tv}/claims`,
      {
        warrantyId: warrantyIds.get('Samsung TV, 55″'),
        openedOn: dayOf(9),
        reference: 'SSC-48213',
        vendor: { name: 'Samsung Service Centre' },
        status: 'in_repair',
        notes: 'Lines across the top of the screen.',
      },
      [201],
      'claim on the TV',
    );
    ctx.made();
  }

  for (const v of [
    {
      who: 'ibrahim',
      location: home,
      thing: 'Samsung TV, 55″',
      value: '18000',
      days: 30,
      source: 'estimate',
    },
    {
      who: 'ibrahim',
      location: home,
      thing: 'ThinkPad T14',
      value: '35000',
      days: 60,
      source: 'appraisal',
    },
    {
      who: 'alfred',
      location: family,
      thing: 'ثلاجة توشيبا',
      value: '17500',
      days: 20,
      source: 'estimate',
    },
  ] as const) {
    const thingId = await mustThing(v.who, v.location, v.thing);
    const [have] = await read<{ id: string }>(
      v.who,
      'SELECT id FROM public.valuations WHERE thing_id = $1 LIMIT 1',
      [thingId],
    );
    if (have) continue;
    await send(
      v.who,
      'POST',
      `/api/v1/things/${thingId}/valuations`,
      { value: v.value, currency: 'EGP', valuedOn: dayOf(v.days), source: v.source },
      [201],
      `valuation of ${v.thing}`,
    );
    ctx.made();
  }

  // --- loans (step 4, D56, D57): the drill with Murdock, and Catan overdue ------------------------
  for (const l of [
    {
      who: 'ibrahim',
      location: garage,
      thing: 'Bosch drill, 18 V',
      person: 'Murdock',
      started: 9,
      due: -5,
    },
    { who: 'ibrahim', location: home, thing: 'Catan', person: 'Murdock', started: 20, due: 3 },
  ] as const) {
    const thingId = await mustThing(l.who, l.location, l.thing);
    const [open] = await read<{ id: string }>(
      l.who,
      'SELECT id FROM public.loans WHERE thing_id = $1 AND returned_at IS NULL LIMIT 1',
      [thingId],
    );
    if (open) continue;
    const [person] = await read<{ id: string }>(
      l.who,
      `SELECT pe.id FROM public.people pe
         JOIN public.locations lo ON lo.owner_account_id = pe.owner_account_id
        WHERE lo.id = $1 AND pe.display_name = $2 ORDER BY pe.created_at LIMIT 1`,
      [l.location, l.person],
    );
    await send(
      l.who,
      'POST',
      `/api/v1/things/${thingId}/lend`,
      {
        person: person ? { id: person.id } : { name: l.person },
        startedAt: atOf(l.started),
        dueOn: dayOf(l.due),
      },
      [201],
      `loan of ${l.thing}`,
    );
    ctx.made();
  }

  // --- schedules (step 4, D29, D146) ------------------------------------------------------------
  type ScheduleSpec = {
    who: PersonKey;
    location: string;
    subject: { thing: string } | { place: string };
    name: string;
    everyMonths: number;
    anchorDaysAgo: number;
  };
  const schedules: ScheduleSpec[] = [
    {
      who: 'ibrahim',
      location: home,
      subject: { thing: 'Water filter cartridge' },
      name: 'Replace the water filter',
      everyMonths: 6,
      anchorDaysAgo: 175,
    },
    {
      who: 'ibrahim',
      location: home,
      subject: { thing: 'Smoke alarm' },
      name: 'Test the smoke alarm',
      everyMonths: 12,
      anchorDaysAgo: 300,
    },
    {
      who: 'bruce',
      location: home,
      subject: { place: 'Living room' },
      name: 'Clean the AC filters',
      everyMonths: 3,
      anchorDaysAgo: 100,
    },
    {
      who: 'alfred',
      location: family,
      subject: { thing: 'الغلاية الكهربائية' },
      name: 'إزالة الترسبات',
      everyMonths: 3,
      anchorDaysAgo: 80,
    },
  ];
  for (const s of schedules) {
    const subject =
      'thing' in s.subject
        ? { thingId: await mustThing(s.who, s.location, s.subject.thing) }
        : { placeId: await placeIn(s.who, s.location, s.subject.place) };
    const [have] = await read<{ id: string }>(
      s.who,
      'SELECT id FROM public.schedules WHERE location_id = $1 AND name = $2 LIMIT 1',
      [s.location, s.name],
    );
    if (have) continue;
    await send(
      s.who,
      'POST',
      '/api/v1/schedules',
      { subject, name: s.name, everyMonths: s.everyMonths, anchorOn: dayOf(s.anchorDaysAgo) },
      [201],
      `schedule ${s.name}`,
    );
    ctx.made();
  }

  // --- documents (step 4, D155; step 5's issue dates and costs) ---------------------------------
  type DocumentSpec = {
    who: PersonKey;
    location: string;
    subject: { thing: string } | 'location';
    kind: 'lease' | 'insurance' | 'licence' | 'contract';
    title?: string;
    expiresIn: number;
    issuedDaysAgo?: number;
    cost?: string;
    leadDays?: number;
  };
  const documents: DocumentSpec[] = [
    {
      who: 'ibrahim',
      location: home,
      subject: 'location',
      kind: 'lease',
      title: 'Flat lease',
      expiresIn: 75,
      issuedDaysAgo: 290,
      leadDays: 60,
    },
    {
      who: 'ibrahim',
      location: home,
      subject: 'location',
      kind: 'insurance',
      title: 'Home contents insurance',
      expiresIn: 200,
      issuedDaysAgo: 165,
      cost: '4200',
    },
    {
      who: 'alfred',
      location: family,
      subject: 'location',
      kind: 'contract',
      title: 'عقد صيانة المصعد',
      expiresIn: 40,
      issuedDaysAgo: 325,
      cost: '2400',
    },
  ];

  // --- an incident (step 4, D158): water in the bathroom took the hair dryer ---------------------
  const dryer = await mustThing('ibrahim', home, 'Hair dryer');
  const [incident] = await read<{ id: string }>(
    'ibrahim',
    'SELECT id FROM public.incidents WHERE location_id = $1 LIMIT 1',
    [home],
  );
  if (!incident) {
    await send(
      'ibrahim',
      'POST',
      `/api/v1/locations/${home}/incidents`,
      {
        kind: 'flood',
        occurredOn: dayOf(12),
        insurerReference: 'HC-2026-0412',
        notes: 'A pipe under the sink burst overnight.',
        thingIds: [dryer],
      },
      [201],
      'incident',
    );
    ctx.made();
  }

  // --- vehicles (step 5) ----------------------------------------------------------------------------
  await turnOn('ibrahim', garage, 'fuel');
  await turnOn('alfred', family, 'fuel');

  const corolla = await mustThing('ibrahim', garage, 'Toyota Corolla');
  const corollaMeter = await meterOf('ibrahim', corolla);
  await stockFills(corolla, 'alfred', {
    station: 'Ring Road Station',
    fills: fillsOf({
      curve: COROLLA_CURVE,
      from: 179,
      to: 8,
      every: 9,
      per100: 7.3,
      price: (i) => (i < 10 ? 22.75 : 23.75),
      partial: 13,
      missed: 6,
      by: (i) => (i % 5 === 4 ? 'ibrahim' : 'alfred'),
    }),
  });

  // Starter schedules, asked for once from the empty Schedules tab (Q25).
  const [starter] = await read<{ id: string }>(
    'ibrahim',
    `SELECT id FROM public.schedules WHERE thing_id = $1 AND name = 'Oil change' LIMIT 1`,
    [corolla],
  );
  if (!starter) {
    await send(
      'ibrahim',
      'POST',
      `/api/v1/things/${corolla}/starter-schedules`,
      {},
      [201],
      'starter schedules',
    );
    ctx.made();
  }
  const [oilSchedule] = await read<{ id: string }>(
    'ibrahim',
    `SELECT id FROM public.schedules WHERE thing_id = $1 AND name = 'Oil change' LIMIT 1`,
    [corolla],
  );

  // Two services: Alfred's oil change (completing "Oil change") and Bruce's brake pads.
  /** A vendor of the location's account by name, so two services name one vendor (D11). */
  const vendorRef = async (who: PersonKey, locationId: string, name: string) => {
    const [row] = await read<{ id: string }>(
      who,
      `SELECT v.id FROM public.vendors v
         JOIN public.locations l ON l.owner_account_id = v.owner_account_id
        WHERE l.id = $1 AND v.name = $2 ORDER BY v.created_at LIMIT 1`,
      [locationId, name],
    );
    return row ? { id: row.id } : { name };
  };
  const services = [
    {
      who: 'alfred' as PersonKey,
      daysAgo: 52,
      vendor: 'Corner Service Centre',
      total: '1850',
      completes: oilSchedule ? [oilSchedule.id] : [],
      lines: [
        { kind: 'fluid', description: 'Engine oil 5W-30', quantity: '4', unitCost: '350' },
        { kind: 'part', description: 'Oil filter', unitCost: '250' },
        { kind: 'labour', description: 'Labour', unitCost: '200' },
      ],
    },
    {
      who: 'bruce' as PersonKey,
      daysAgo: 20,
      vendor: 'Corner Service Centre',
      total: '3600',
      completes: [] as string[],
      lines: [
        { kind: 'part', description: 'Front brake pads', unitCost: '3200' },
        { kind: 'labour', description: 'Labour', unitCost: '400' },
      ],
    },
  ];
  const haveServices = await read<{ serviced_on: string }>(
    'ibrahim',
    'SELECT serviced_on::text FROM public.service_records WHERE thing_id = $1',
    [corolla],
  );
  for (const s of services) {
    if (haveServices.some((h) => h.serviced_on === dayOf(s.daysAgo))) continue;
    await send(
      s.who,
      'POST',
      '/api/v1/service-records',
      {
        subject: { thingId: corolla },
        servicedOn: dayOf(s.daysAgo),
        reading: {
          meterId: corollaMeter,
          value: String(odometerAt(COROLLA_CURVE, s.daysAgo)),
        },
        vendor: await vendorRef(s.who, garage, s.vendor),
        total: s.total,
        currency: 'EGP',
        lines: s.lines,
        ...(s.completes.length ? { completes: s.completes } : {}),
      },
      [201],
      `service ${s.lines[0]?.description}`,
    );
    ctx.made();
  }

  documents.push(
    {
      who: 'alfred',
      location: garage,
      subject: { thing: 'Toyota Corolla' },
      kind: 'licence',
      title: 'Vehicle licence',
      expiresIn: 23,
      issuedDaysAgo: 342,
      cost: '1200',
      leadDays: 30,
    },
    {
      who: 'alfred',
      location: garage,
      subject: { thing: 'Toyota Corolla' },
      kind: 'insurance',
      title: 'Car insurance',
      expiresIn: 214,
      issuedDaysAgo: 151,
      cost: '3500',
    },
  );

  // Proof photos on two of the Corolla's readings (D27, D195): Ibrahim's 51,200 and Alfred's
  // 52,340, photographed when they were read.
  if (ctx.hasFiles) {
    const readings = await read<{ id: string; value: string; proofs: number }>(
      'ibrahim',
      `SELECT d.id, trim_scale(d.value)::text AS value,
              (SELECT count(*)::int FROM public.attachments a
                WHERE a.meter_reading_id = d.id AND a.role = 'proof') AS proofs
         FROM public.meter_readings d WHERE d.meter_id = $1 AND d.value IN (51200, 52340)`,
      [corollaMeter],
    );
    for (const [value, who, colour] of [
      ['51200', 'ibrahim', '#2b2f33'],
      ['52340', 'alfred', '#30363b'],
    ] as const) {
      const r = readings.find((x) => x.value === value);
      if (!r || r.proofs > 0) continue;
      await send(
        who,
        'POST',
        '/api/v1/attachments',
        {
          locationId: garage,
          fileId: await upload(who, garage, colour),
          subject: { meterReadingId: r.id },
          role: 'proof',
        },
        [201],
        `proof of ${value}`,
      );
      ctx.made();
    }
  } else {
    ctx.note('proof photos skipped: the app has no file storage.');
  }

  // Alfred's Hyundai in بيت العائلة, with an EGP fill history in Arabic, and the generator.
  const carType = await builtinTypeId('car');
  const generatorType = await builtinTypeId('generator');
  let hyundai = await thingIn('alfred', family, 'هيونداي إلنترا');
  if (!hyundai) {
    const made = await send(
      'alfred',
      'POST',
      '/api/v1/things',
      {
        locationId: family,
        placeId: await placeIn('alfred', family, 'الشُّرفة'),
        name: 'هيونداي إلنترا',
        typeId: carType,
        model: 'Elantra 1.6',
        custom: { plate: 'ق ع ن ٤٥٦٧' },
      },
      [201],
      'Hyundai',
    );
    hyundai = String(made.id);
    ctx.made();
  }
  await stockFills(hyundai, 'alfred', {
    station: 'محطة الطريق الدائري',
    fills: fillsOf({
      curve: [
        [130, 87_400],
        [4, 92_150],
      ],
      from: 130,
      to: 4,
      every: 14,
      per100: 8.1,
      price: () => 23.75,
      partial: 4,
      missed: -1,
      by: () => 'alfred',
      note: (i) => (i === 0 ? 'تعبئة كاملة قبل السفر' : undefined),
    }),
  });

  let generator = await thingIn('alfred', family, 'مولد كهربائي');
  if (!generator) {
    const made = await send(
      'alfred',
      'POST',
      '/api/v1/things',
      {
        locationId: family,
        placeId: await placeIn('alfred', family, 'الشُّرفة'),
        name: 'مولد كهربائي',
        typeId: generatorType,
      },
      [201],
      'generator',
    );
    generator = String(made.id);
    ctx.made();
  }
  const generatorMeter = await meterOf('alfred', generator);
  const hours = await read<{ value: string }>(
    'alfred',
    'SELECT trim_scale(value)::text AS value FROM public.meter_readings WHERE meter_id = $1',
    [generatorMeter],
  );
  for (const [value, daysAgo] of [
    ['120', 30],
    ['134.5', 3],
  ] as const) {
    if (hours.some((h) => h.value === value)) continue;
    await send(
      'alfred',
      'POST',
      `/api/v1/meters/${generatorMeter}/readings`,
      { value, takenAt: atOf(daysAgo) },
      [201],
      `generator at ${value} h`,
    );
    ctx.made();
  }

  for (const d of documents) {
    const subject =
      d.subject === 'location'
        ? { locationId: d.location }
        : { thingId: await mustThing(d.who, d.location, d.subject.thing) };
    const [have] = await read<{ id: string }>(
      d.who,
      'SELECT id FROM public.expiring_documents WHERE location_id = $1 AND title = $2 LIMIT 1',
      [d.location, d.title ?? ''],
    );
    if (have) continue;
    await send(
      d.who,
      'POST',
      '/api/v1/documents',
      {
        subject,
        kind: d.kind,
        ...(d.title ? { title: d.title } : {}),
        expiresOn: dayOf(-d.expiresIn),
        ...(d.leadDays !== undefined ? { leadDays: d.leadDays } : {}),
        ...(d.issuedDaysAgo !== undefined ? { issuedOn: dayOf(d.issuedDaysAgo) } : {}),
        ...(d.cost ? { cost: d.cost, currency: 'EGP' } : {}),
      },
      [201],
      `document ${d.title ?? d.kind}`,
    );
    ctx.made();
  }

  async function builtinTypeId(key: string): Promise<string> {
    const [row] = await read<{ id: string }>(
      'alfred',
      'SELECT id FROM public.types WHERE owner_account_id IS NULL AND builtin_key = $1',
      [key],
    );
    if (!row) throw new SeedError(`no built-in type ${key}`);
    return row.id;
  }

  /** A vehicle's fills, each with its odometer, once: none if it has any already. */
  async function stockFills(
    thingId: string,
    owner: PersonKey,
    o: { station: string; fills: readonly Fill[] },
  ): Promise<void> {
    const [any] = await read<{ id: string }>(
      owner,
      'SELECT id FROM public.fuel_entries WHERE thing_id = $1 LIMIT 1',
      [thingId],
    );
    if (any) return;
    for (const f of o.fills) {
      await send(
        f.by,
        'POST',
        `/api/v1/things/${thingId}/fuel`,
        {
          id: newId(),
          takenAt: atOf(f.daysAgo),
          amount: f.litres,
          unit: 'L',
          cost: f.cost,
          currency: 'EGP',
          isFull: f.isFull,
          missedBefore: f.missedBefore,
          vendor: { name: o.station },
          reading: { value: String(f.odometer) },
          ...(f.note ? { note: f.note } : {}),
        },
        [201],
        `fill of ${f.daysAgo} days ago`,
      );
      ctx.made();
    }
  }
}
