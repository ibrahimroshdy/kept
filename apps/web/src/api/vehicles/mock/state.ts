/**
 * The step-5 half of the mock server (plan T3): its state, its fixtures, and the helpers every
 * vehicles area shares (the usage estimate, the ETA, a meter's series, the money gate, gates on a
 * vehicle). Kept in a WeakMap beside the MockState, so the shared fixtures file stays step 4's.
 *
 * What the fixtures hold (plan T3), all from the sample cast:
 * - Ibrahim's Toyota Corolla (CAR7TY, Garage): 22 fills from 1 Apr to 1 Oct 2026 Cairo time (a
 *   missed fill-up in May, a partial in August), two services (Alfred's oil change completing
 *   "Oil & filter" on 18 Jun, Bruce's front brake pads on 27 Aug), the "Oil & filter" schedule,
 *   a licence due in 23 days and an insurance document issued 15 May for 3,500 EGP, and proof
 *   photos on two readings. Its numbers are the board's: April to September 2026 cost 29,800 EGP
 *   (fuel 19,855.50, service 6,444.50, fees 3,500) over 11,346 km, 2.63 EGP a km, fuel 1.75 EGP a
 *   km and about 3,300 EGP a month, and the last 5 full fills give 7.3 L/100 km. The odometer
 *   reads 41,195 at 1 Apr 00:00 and 52,541 at 1 Oct 00:00 Cairo (a fill at each), so the
 *   distance over the full months needs no interpolation.
 * - بيت العائلة: Alfred's Hyundai Elantra (Arabic name and plate, EGP fills), last read 34 days
 *   ago (`stale`), and a generator on an hours meter last read 70 days ago (`unknown`).
 * - Home: a sold motorbike (listed only under `f.state=sold`).
 *
 * Seeded on the first request to a step-5 route (`ensureVehiclesSeeded`), as step 4 seeds its
 * own, so the earlier steps' fixtures and their tests keep their counts. Seeding turns Vehicles,
 * Fuel & charging, Money, Schedules and Paperwork on in the Garage (the shared fixtures' Garage is
 * Essentials with Lending; step 4's document routes need Paperwork, and "Paperwork or Vehicles" is
 * the server's rule, T12). A test that wants a module off turns it off after calling
 * `ensureVehiclesSeeded(state)`. Step 5's fields on the earlier steps' routes (a meter's estimate,
 * Home's `meteredThings`, a reading's `undo`, a document's cost) also start with the seeding, so
 * those steps' tests see their routes unchanged. Test and demo data only.
 */
import { type FuelUnit, type ModuleId, milli, readingAdvice } from '@kept/shared';
import { hh, localDate, locOf, moduleOn, showsMoney, todayIn } from '../../household/mock/db';
import type {
  StoredDocument,
  StoredSchedule,
  StoredServiceRecord,
} from '../../household/mock/state';
import { accessOf, liveThing, type StoredThing } from '../../inventory/mock/db';
import { INV_IDS } from '../../inventory/mock/fixtures';
import type { ActorRef, Reading, ReadingSource, TypeDetail } from '../../inventory/types';
import type { MockState } from '../../mock/fixtures';
import { IDS } from '../../mock/fixtures';
import { err, type MockReply, notFound } from '../../mock/kit';
import type { Estimate, ProofRef, ReadingOwner, ServiceSuggestion } from '../types';

const vid = (n: number) => `01926f00-0000-7000-8000-0000005${String(n).padStart(5, '0')}`;

export const VEHICLE_IDS = {
  type: { motorbike: vid(1), generator: vid(2) },
  thing: { elantra: vid(10), generator: vid(11), motorbike: vid(12) },
  meter: { elantra: vid(20), generator: vid(21), motorbike: vid(22) },
  vendor: { serviceCentre: vid(30), station: vid(31), familyStation: vid(32) },
  serviceRecord: { oilChange: vid(40), brakePads: vid(41) },
  schedule: { oilFilter: vid(45) },
  document: { licence: vid(50), insurance: vid(51), elantraLicence: vid(52) },
  file: { proofA: vid(60), proofB: vid(61), receipt: vid(62) },
} as const;
const V = VEHICLE_IDS;
const I = INV_IDS;

/** The Corolla and its odometer (step 2's fixtures). */
export const COROLLA = { thing: I.thing.car, meter: I.meter.carOdometer } as const;

// ----- stored shapes ----------------------------------------------------------------------------

export type StoredFill = {
  id: string;
  thingId: string;
  locationId: string;
  takenAt: string;
  amount: string;
  unit: FuelUnit;
  isFull: boolean;
  missedBefore: boolean;
  cost: string | null;
  currency: string | null;
  vendorId: string | null;
  readingId: string | null;
  receipt: ProofRef | null;
  note: string | null;
  loggedBy: ActorRef;
  loggedById: string;
  rowVersion: number;
};

/** A proof photo on the strip: on its reading, or (step 3's) still on the thing (Q10). */
export type StoredProof = {
  thingId: string;
  meterId: string;
  readingId: string | null;
  takenAt: string;
  fileId: string;
  attachmentId: string;
  by: ActorRef;
};

export type StoredDraft = {
  reviewState: 'draft' | 'confirmed';
  suggestions: ServiceSuggestion[];
  extraction: { id: string; status: string } | null;
  invoiceFileIds: string[];
};

export type VehiclesState = {
  seeded: boolean;
  fills: StoredFill[];
  /** Reading id → the fill or service that owns it (Q11). */
  owners: Map<string, ReadingOwner>;
  proofs: StoredProof[];
  /** Meter id → its stale-reading nudge (absent: the default, 30). */
  nudgeDays: Map<string, number | null>;
  /** Document id → its issue date and cost (T12). */
  documentCosts: Map<
    string,
    { issuedOn: string | null; cost: string | null; currency: string | null }
  >;
  /** Service record id → its draft state (T9). Absent: confirmed. */
  drafts: Map<string, StoredDraft>;
  /** `Idempotency-Key` → the answer it got (drafts, fills). */
  idempotency: Map<string, unknown>;
};

const STATES = new WeakMap<MockState, VehiclesState>();

export function vehiclesOf(state: MockState): VehiclesState {
  let v = STATES.get(state);
  if (!v) {
    v = {
      seeded: false,
      fills: [],
      owners: new Map(),
      proofs: [],
      nudgeDays: new Map(),
      documentCosts: new Map(),
      drafts: new Map(),
      idempotency: new Map(),
    };
    STATES.set(state, v);
  }
  return v;
}

// ----- fixtures ---------------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();
const cairo = (days = 0) => localDate('Africa/Cairo', new Date(Date.now() + days * DAY_MS));
const actor = (displayName: string): ActorRef => ({ displayName });

/**
 * The Corolla's fills: [takenAt, litres, full, missed a fill-up before, odometer, cost EGP].
 * Litres are 7.3 per 100 km of the distance since the previous fill, except the first (March's
 * driving), the missed fill-up (short) and the partial (whose rest the next full carries).
 */
const COROLLA_FILLS: readonly [string, string, boolean, boolean, string, string][] = [
  ['2026-03-31T22:00:00.000Z', '40.387', true, false, '41195', '918.8'],
  ['2026-04-09T05:30:00.000Z', '42.559', true, false, '41778', '968.22'],
  ['2026-04-18T05:30:00.000Z', '46.136', true, false, '42410', '1049.59'],
  ['2026-04-27T05:30:00.000Z', '46.063', true, false, '43041', '1047.93'],
  ['2026-05-06T05:30:00.000Z', '46.136', true, false, '43673', '1049.59'],
  ['2026-05-15T05:30:00.000Z', '27.638', true, true, '44304', '628.76'],
  ['2026-05-24T05:30:00.000Z', '46.136', true, false, '44936', '1049.59'],
  ['2026-06-02T05:30:00.000Z', '46.063', true, false, '45567', '1082.48'],
  ['2026-06-11T05:30:00.000Z', '46.136', true, false, '46199', '1084.2'],
  ['2026-06-20T05:30:00.000Z', '46.063', true, false, '46830', '1082.48'],
  ['2026-06-29T05:30:00.000Z', '46.136', true, false, '47462', '1084.2'],
  ['2026-07-08T05:30:00.000Z', '46.136', true, false, '48094', '1118.8'],
  ['2026-07-17T05:30:00.000Z', '46.063', true, false, '48725', '1117.03'],
  ['2026-07-26T05:30:00.000Z', '46.136', true, false, '49357', '1118.8'],
  ['2026-08-04T05:30:00.000Z', '46.063', true, false, '49988', '1117.03'],
  ['2026-08-13T05:30:00.000Z', '27.682', false, false, '50620', '671.29'],
  ['2026-08-22T05:30:00.000Z', '62.546', true, false, '51224', '1516.74'],
  ['2026-08-31T05:30:00.000Z', '21.827', true, false, '51523', '529.3'],
  ['2026-09-09T05:30:00.000Z', '21.827', true, false, '51822', '540.22'],
  ['2026-09-18T05:30:00.000Z', '21.827', true, false, '52121', '540.22'],
  ['2026-09-27T05:30:00.000Z', '21.827', true, false, '52420', '540.23'],
  ['2026-09-30T21:00:00.000Z', '8.833', true, false, '52541', '218.62'],
];

/** Alfred's Elantra (بيت العائلة): [days ago, litres, odometer, cost EGP]. */
const ELANTRA_FILLS: readonly [number, string, string, string][] = [
  [80, '38.5', '84210', '905.5'],
  [62, '41.2', '84760', '968.2'],
  [34, '40.8', '85310', '1009.8'],
];

function reading(
  id: string,
  value: string,
  takenAt: string,
  source: ReadingSource,
  by: string,
): Reading {
  return {
    id,
    value,
    takenAt,
    source,
    state: 'accepted',
    reviewReason: null,
    loggedBy: actor(by),
    note: null,
    rowVersion: 1,
  };
}

function seedTypes(state: MockState): void {
  const types = state.inventory.types;
  const car = types.find((t) => t.id === I.type.car);
  if (!car) return;
  const add = (id: string, key: string, icon: string, meter: TypeDetail['defaultMeter']) => {
    if (types.some((t) => t.id === id)) return;
    types.push({
      ...structuredClone(car),
      id,
      builtinKey: key,
      icon,
      defaultMeter: meter,
      fields: car.fields.filter((f) => f.key === 'vin'),
    } as TypeDetail);
  };
  add(V.type.motorbike, 'motorbike', 'lucide:motorbike', { kind: 'distance', unit: 'km' });
  add(V.type.generator, 'generator', 'tabler:engine', { kind: 'hours', unit: 'h' });
}

function seedThings(state: MockState): void {
  const inv = state.inventory;
  const base = inv.things.find((t) => t.id === COROLLA.thing);
  if (!base) return;
  const typeRef = (id: string) => {
    const ty = inv.types.find((t) => t.id === id);
    return ty ? { id, icon: ty.icon, name: ty.name, builtinKey: ty.builtinKey } : null;
  };
  const make = (
    id: string,
    extra: Partial<StoredThing> & { meter: { id: string; kind: string; unit: string } },
  ) => {
    if (inv.things.some((t) => t.id === id)) return;
    const { meter, ...rest } = extra;
    inv.things.push({
      ...structuredClone(base),
      serial: null,
      barcode: null,
      purchase: null,
      photos: [],
      links: [],
      secrets: [],
      attachmentsCount: 0,
      custom: {},
      ...rest,
      id,
      meters: [{ ...meter, label: null, latest: null, needsReview: 0, rowVersion: 1 }],
    } as StoredThing);
  };
  make(V.thing.elantra, {
    locationId: IDS.family,
    name: 'هيونداي إلنترا',
    shortCode: 'EL4N7R',
    type: typeRef(I.type.car),
    placeId: I.place.familyUnplaced,
    containerId: null,
    brand: null,
    custom: { plate: 'ن ب ط ٤٥٧', vin: 'KMHD841CAMU123456' },
    meter: { id: V.meter.elantra, kind: 'distance', unit: 'km' },
  });
  make(V.thing.generator, {
    locationId: IDS.family,
    name: 'مولد الكهرباء',
    shortCode: 'GEN8H2',
    type: typeRef(V.type.generator),
    placeId: I.place.familyUnplaced,
    containerId: null,
    brand: null,
    meter: { id: V.meter.generator, kind: 'hours', unit: 'h' },
  });
  make(V.thing.motorbike, {
    locationId: IDS.home,
    name: 'Honda CB500',
    shortCode: 'MB5K0D',
    type: typeRef(V.type.motorbike),
    lifecycle: 'sold',
    brand: null,
    meter: { id: V.meter.motorbike, kind: 'distance', unit: 'km' },
  });

  const readings = inv.readings;
  readings[V.meter.elantra] ??= [];
  readings[V.meter.generator] ??= [
    reading(vid(200), '412', ago(160), 'manual', 'Alfred'),
    reading(vid(201), '436.5', ago(70), 'manual', 'Alfred'),
  ];
  readings[V.meter.motorbike] ??= [reading(vid(202), '18450', ago(220), 'manual', 'Ibrahim')];
}

function seedVendors(state: MockState): void {
  const inv = state.inventory;
  const owner = (loc: string) => inv.accountOf[loc] ?? '';
  const add = (id: string, name: string, kind: 'service_centre' | 'station', loc: string) => {
    if (inv.vendors.some((x) => x.id === id)) return;
    inv.vendors.push({
      id,
      ownerAccountId: owner(loc),
      name,
      kind,
      address: null,
      phone: null,
      website: null,
      rowVersion: 1,
    });
  };
  add(V.vendor.serviceCentre, 'City Service Centre', 'service_centre', IDS.garage);
  add(V.vendor.station, 'Ring Road Station', 'station', IDS.garage);
  add(V.vendor.familyStation, 'محطة الطريق الدائري', 'station', IDS.family);
}

function seedFills(state: MockState, v: VehiclesState): void {
  const odo = readingList(state, COROLLA.meter);
  COROLLA_FILLS.forEach(([takenAt, amount, isFull, missedBefore, value, cost], i) => {
    const id = vid(1000 + i);
    const readingId = vid(1100 + i);
    // Alfred logs most; Ibrahim the first and the last.
    const by = i === 0 || i === COROLLA_FILLS.length - 1 ? 'Ibrahim' : 'Alfred';
    odo.push(reading(readingId, value, takenAt, 'fuel', by));
    v.owners.set(readingId, { type: 'fuel', id });
    v.fills.push({
      id,
      thingId: COROLLA.thing,
      locationId: IDS.garage,
      takenAt,
      amount,
      unit: 'L',
      isFull,
      missedBefore,
      cost,
      currency: 'EGP',
      vendorId: V.vendor.station,
      readingId,
      receipt:
        i === COROLLA_FILLS.length - 2
          ? { attachmentId: vid(1300), fileId: V.file.receipt, thumbUrl: thumb(V.file.receipt) }
          : null,
      note: null,
      loggedBy: actor(by),
      loggedById: by === 'Ibrahim' ? IDS.ibrahim : vid(900),
      rowVersion: 1,
    });
  });
  const elantra = readingList(state, V.meter.elantra);
  ELANTRA_FILLS.forEach(([days, amount, value, cost], i) => {
    const id = vid(1200 + i);
    const readingId = vid(1250 + i);
    elantra.push(reading(readingId, value, ago(days), 'fuel', 'Alfred'));
    v.owners.set(readingId, { type: 'fuel', id });
    v.fills.push({
      id,
      thingId: V.thing.elantra,
      locationId: IDS.family,
      takenAt: ago(days),
      amount,
      unit: 'L',
      isFull: true,
      missedBefore: false,
      cost,
      currency: 'EGP',
      vendorId: V.vendor.familyStation,
      readingId,
      receipt: null,
      note: i === 0 ? 'امتلاء كامل' : null,
      loggedBy: actor('Alfred'),
      loggedById: vid(900),
      rowVersion: 1,
    });
  });
}

/** A meter's readings in the inventory, made empty when it has none yet. */
export function readingList(state: MockState, meterId: string): Reading[] {
  const all = state.inventory.readings;
  const list = all[meterId] ?? [];
  all[meterId] = list;
  return list;
}

/** The mock serves every file's thumbnail at one blank data URL; the id keeps them apart. */
export const thumb = (fileId: string) => `/f/${fileId}/thumb`;

function seedProofs(state: MockState, v: VehiclesState): void {
  const odo = state.inventory.readings[COROLLA.meter] ?? [];
  // Two dashboard photos on the latest accepted manual readings, and one step-3 proof still on
  // the thing (no reading, Q10).
  const manual = odo
    .filter((r) => r.source === 'manual' && r.state === 'accepted')
    .sort((a, b) => b.takenAt.localeCompare(a.takenAt));
  [V.file.proofA, V.file.proofB].forEach((fileId, i) => {
    const r = manual[i];
    if (!r) return;
    v.proofs.push({
      thingId: COROLLA.thing,
      meterId: COROLLA.meter,
      readingId: r.id,
      takenAt: r.takenAt,
      fileId,
      attachmentId: vid(1400 + i),
      by: r.loggedBy,
    });
  });
  v.proofs.push({
    thingId: COROLLA.thing,
    meterId: COROLLA.meter,
    readingId: null,
    takenAt: '2026-05-02T09:00:00.000Z',
    fileId: vid(63),
    attachmentId: vid(1402),
    by: actor('Alfred'),
  });
}

function seedServices(state: MockState): void {
  const h = hh(state);
  const odo = readingList(state, COROLLA.meter);
  const v = vehiclesOf(state);
  const garage = IDS.garage;
  const service = (
    id: string,
    servicedOn: string,
    readingId: string,
    value: string,
    by: string,
    byId: string,
    total: string,
    lines: StoredServiceRecord['lines'],
    completes: StoredServiceRecord['completes'],
  ) => {
    if (h.serviceRecords.some((r) => r.id === id)) return;
    odo.push(reading(readingId, value, `${servicedOn}T09:00:00.000Z`, 'service', by));
    v.owners.set(readingId, { type: 'service', id });
    h.serviceRecords.push({
      id,
      locationId: garage,
      subject: { thingId: COROLLA.thing },
      servicedOn,
      reading: { id: readingId, value, unit: 'km' },
      vendor: { id: V.vendor.serviceCentre, name: 'City Service Centre' },
      total: { amount: total, currency: 'EGP' },
      lines,
      completes,
      notes: null,
      invoices: [],
      loggedBy: actor(by),
      loggedById: byId,
      rowVersion: 1,
    });
  };
  const egp = (amount: string) => ({ amount, currency: 'EGP' });
  service(
    V.serviceRecord.oilChange,
    '2026-06-18',
    vid(1500),
    '46695',
    'Alfred',
    vid(900),
    '2250',
    [
      {
        id: vid(1510),
        kind: 'fluid',
        description: 'Engine oil 5W-30',
        quantity: '4',
        unitCost: egp('350'),
      },
      {
        id: vid(1511),
        kind: 'part',
        description: 'Oil filter',
        quantity: '1',
        unitCost: egp('450'),
      },
      { id: vid(1512), kind: 'labour', description: 'Labour', quantity: '1', unitCost: egp('400') },
    ],
    [{ scheduleId: V.schedule.oilFilter, name: 'Oil & filter' }],
  );
  service(
    V.serviceRecord.brakePads,
    '2026-08-27',
    vid(1501),
    '51392',
    'Bruce',
    vid(901),
    '4194.5',
    [
      {
        id: vid(1520),
        kind: 'part',
        description: 'Front brake pads',
        quantity: '1',
        unitCost: egp('3200'),
      },
      {
        id: vid(1521),
        kind: 'labour',
        description: 'Brake disc skim',
        quantity: '1',
        unitCost: egp('594.5'),
      },
      { id: vid(1522), kind: 'labour', description: 'Labour', quantity: '1', unitCost: egp('400') },
    ],
    [],
  );
  if (!h.schedules.some((s) => s.id === V.schedule.oilFilter)) {
    const schedule: StoredSchedule = {
      id: V.schedule.oilFilter,
      locationId: garage,
      subject: { thingId: COROLLA.thing },
      meterId: COROLLA.meter,
      name: 'Oil & filter',
      everyMonths: 12,
      everyUnits: '10000',
      dueOn: null,
      leadDays: 14,
      leadUnits: '1000',
      anchorOn: '2026-06-18',
      anchorValue: '46695',
      snoozedUntil: null,
      snoozedUntilValue: null,
      skipNext: false,
      active: true,
      rowVersion: 1,
    };
    h.schedules.push(schedule);
  }
}

function seedDocuments(state: MockState, v: VehiclesState): void {
  const h = hh(state);
  const doc = (
    d: Omit<StoredDocument, 'createdAt' | 'documents' | 'supersededById' | 'rowVersion'>,
  ) => {
    if (h.documents.some((x) => x.id === d.id)) return;
    h.documents.push({
      ...d,
      supersededById: null,
      documents: [],
      rowVersion: 1,
      createdAt: ago(30),
    });
  };
  const licenceExpires = cairo(23);
  doc({
    id: V.document.licence,
    locationId: IDS.garage,
    subject: { thingId: COROLLA.thing },
    kind: 'licence',
    title: null,
    expiresOn: licenceExpires,
    leadDays: 30,
  });
  v.documentCosts.set(V.document.licence, {
    issuedOn: `${Number(licenceExpires.slice(0, 4)) - 1}${licenceExpires.slice(4)}`,
    cost: '1200',
    currency: 'EGP',
  });
  doc({
    id: V.document.insurance,
    locationId: IDS.garage,
    subject: { thingId: COROLLA.thing },
    kind: 'insurance',
    title: null,
    expiresOn: '2027-05-14',
    leadDays: 30,
  });
  v.documentCosts.set(V.document.insurance, {
    issuedOn: '2026-05-15',
    cost: '3500',
    currency: 'EGP',
  });
  doc({
    id: V.document.elantraLicence,
    locationId: IDS.family,
    subject: { thingId: V.thing.elantra },
    kind: 'licence',
    title: null,
    expiresOn: cairo(140),
    leadDays: 30,
  });
  v.documentCosts.set(V.document.elantraLicence, {
    issuedOn: cairo(-225),
    cost: null,
    currency: null,
  });
}

/** Recomputes each seeded meter's latest accepted reading, as step 2's mock does after a write. */
export function touchMeter(state: MockState, meterId: string): void {
  const inv = state.inventory;
  const list = inv.readings[meterId] ?? [];
  for (const t of inv.things) {
    const m = t.meters.find((x) => x.id === meterId);
    if (!m) continue;
    const accepted = list
      .filter((r) => r.state === 'accepted')
      .sort((a, b) => b.takenAt.localeCompare(a.takenAt))[0];
    m.latest = accepted ? { value: accepted.value, takenAt: accepted.takenAt } : null;
    m.needsReview = list.filter((r) => r.state === 'needs_review').length;
  }
}

/** Seeds the vehicles once (see the module comment). */
export function ensureVehiclesSeeded(state: MockState): VehiclesState {
  const v = vehiclesOf(state);
  if (v.seeded) return v;
  v.seeded = true;
  const garage = state.locations.find((l) => l.id === IDS.garage);
  if (garage) {
    const on = [
      ...new Set<ModuleId>([
        ...garage.modules,
        'vehicles',
        'fuel',
        'money',
        'schedules',
        'paperwork',
      ]),
    ];
    garage.modules = on;
    if (garage.effectiveModules) garage.effectiveModules = on;
  }
  seedTypes(state);
  seedThings(state);
  seedVendors(state);
  seedFills(state, v);
  seedServices(state);
  seedDocuments(state, v);
  seedProofs(state, v);
  for (const meterId of [COROLLA.meter, V.meter.elantra, V.meter.generator, V.meter.motorbike])
    touchMeter(state, meterId);
  return v;
}

// ----- gates ------------------------------------------------------------------------------------

/**
 * A vehicle route's gate on one thing (screens §3), after step 4's `gateFor`: invisible → 404;
 * the module off → 404 on a read, 409 `module_off` on a write; a viewer's write → 403.
 */
export function thingGate(
  state: MockState,
  thingId: string | undefined,
  module: 'vehicles' | 'fuel' | null,
  mode: 'read' | 'write',
): { thing: StoredThing } | { reply: MockReply } {
  const t = liveThing(state.inventory, thingId ?? null);
  const access = accessOf(state);
  if (!t || !access.visible(t.locationId)) return { reply: notFound() };
  const needs = module === 'fuel' ? (['vehicles', 'fuel'] as const) : module ? [module] : [];
  if (needs.some((m) => !moduleOn(state, t.locationId, m)))
    return {
      reply:
        mode === 'read'
          ? notFound()
          : err(409, 'module_off', 'This module is off in this location.'),
    };
  if (mode === 'write' && !access.canWrite(t.locationId)) {
    return { reply: err(403, 'forbidden', "You don't have permission.") };
  }
  return { thing: t };
}

export const moneyShown = (state: MockState, locationId: string) => showsMoney(state, locationId);

/** Whether a thing's type reaches the built-in Vehicle (Q2: `kept.is_vehicle_type`). */
export function isVehicle(state: MockState, t: StoredThing): boolean {
  const types = state.inventory.types;
  let cur = t.type ? types.find((x) => x.id === t.type?.id) : undefined;
  for (let depth = 0; cur && depth < 64; depth++) {
    if (cur.builtinKey === 'vehicle') return true;
    const next = cur.parentId ?? cur.copiedFromId;
    cur = next ? types.find((x) => x.id === next) : undefined;
  }
  return false;
}

/** The meter a vehicle's odometer is: its first distance meter, else its first meter. */
export function mainMeter(t: StoredThing) {
  return t.meters.find((m) => m.kind === 'distance') ?? t.meters[0] ?? null;
}

export function thingOfMeter(state: MockState, meterId: string): StoredThing | undefined {
  return state.inventory.things.find((t) => !t.deletedAt && t.meters.some((m) => m.id === meterId));
}

// ----- the estimate (Q8: the SQL's inputs, the web mock's twin) ---------------------------------

export function acceptedReadings(state: MockState, meterId: string): Reading[] {
  return (state.inventory.readings[meterId] ?? [])
    .filter((r) => r.state === 'accepted')
    .sort((a, b) => a.takenAt.localeCompare(b.takenAt));
}

/** `kept.meter_estimate()`: the rise over the 90 days before the latest reading. */
export function estimateOf(state: MockState, meterId: string, now = Date.now()): Estimate {
  const rows = acceptedReadings(state, meterId);
  const last = rows.at(-1);
  if (!last) return { perDay: null, basisDays: null, ageDays: null, advice: 'none' };
  const lastAt = Date.parse(last.takenAt);
  const ageDays = Math.max(0, Math.floor((now - lastAt) / DAY_MS));
  const advice = readingAdvice(ageDays);
  const windowed = rows.filter((r) => Date.parse(r.takenAt) >= lastAt - 90 * DAY_MS);
  const first = windowed[0];
  const spanDays = first ? (lastAt - Date.parse(first.takenAt)) / DAY_MS : 0;
  if (!first || windowed.length < 2 || spanDays < 7 || advice === 'unknown')
    return { perDay: null, basisDays: null, ageDays, advice };
  const rise = Number(milli(last.value) - milli(first.value)) / 1000;
  return {
    perDay: (rise / spanDays).toFixed(1).replace(/\.0$/, ''),
    basisDays: Math.round(spanDays),
    ageDays,
    advice,
  };
}

/** `kept.meter_eta()`: the local date the meter reaches `value` at its rate; null without one. */
export function etaOf(state: MockState, meterId: string, value: string): string | null {
  const est = estimateOf(state, meterId);
  const last = acceptedReadings(state, meterId).at(-1);
  if (!est.perDay || !last || Number(est.perDay) <= 0) return null;
  const rest = Number(milli(value) - milli(last.value)) / 1000 / Number(est.perDay);
  if (rest <= 0) return null;
  const t = thingOfMeter(state, meterId);
  const tz = (t && locOf(state, t.locationId)?.timezone) || 'Africa/Cairo';
  return localDate(tz, new Date(Date.parse(last.takenAt) + Math.ceil(rest) * DAY_MS));
}

/** A thing's local "today" (§7.13). */
export const todayOf = (state: MockState, t: StoredThing) => todayIn(state, t.locationId);
