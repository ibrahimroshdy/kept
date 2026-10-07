/**
 * The helpers every step-4 mock area shares: seeding, access and module gates, the money gate,
 * subjects and people as the server serialises them, each record's view (computed state and all),
 * and the agenda every list and count reads (plan Q24: one agenda, computed, never stored).
 * Test and demo data only; the rules follow the step-4 plan's Phase B and the server's twins in
 * @kept/shared (warrantyEnds, coverage, scheduleNext, duePeriod).
 */
import {
  type ActiveSourceType,
  addDays,
  duePeriod,
  LEAD_DEFAULTS,
  type ModuleId,
  SOURCE_MODULE,
  scheduleNext,
  warrantyEnds,
} from '@kept/shared';
import {
  accessOf,
  livePlace,
  liveThing,
  newId,
  placePath,
  recordEvent,
  rowOf,
  type StoredThing,
  thingPath,
} from '../../inventory/mock/db';
import type {
  AttachmentView,
  DerivedState,
  Money,
  PathStep,
  ThingRow,
  ThingView,
} from '../../inventory/types';
import type { MockState } from '../../mock/fixtures';
import { err, type MockReply, notFound } from '../../mock/kit';
import type { LocationDetail } from '../../types';
import type {
  AgendaAction,
  AgendaItem,
  Claim,
  ExpiringDocument,
  GatedMoney,
  Loan,
  LoanRow,
  Notification,
  PersonRef,
  Schedule,
  ScheduleBasis,
  ServiceRecord,
  SubjectRef,
  Warranty,
} from '../types';
import {
  type HouseholdState,
  localDate,
  type ScheduleSubject,
  type StoredClaim,
  type StoredDocument,
  type StoredLoan,
  type StoredNotification,
  type StoredSchedule,
  type StoredServiceRecord,
  type StoredWarranty,
} from './state';

export { localDate, newId };

export const hh = (state: MockState): HouseholdState => state.household;

// ----- seeding ----------------------------------------------------------------------------------

/**
 * Adds Murdock, the service centre and the borrowed ladder to the inventory, once, on the first
 * step-4 request (as capture's `seedThings`), so step 2's fixtures keep their counts.
 */
export function ensureSeeded(state: MockState): void {
  const h = hh(state);
  if (h.seeded) return;
  h.seeded = true;
  const inv = state.inventory;
  for (const p of h.seedPeople) if (!inv.people.some((x) => x.id === p.id)) inv.people.push(p);
  for (const v of h.seedVendors) if (!inv.vendors.some((x) => x.id === v.id)) inv.vendors.push(v);
  for (const { template, ...seed } of h.seedThings) {
    const base = inv.things.find((t) => t.id === template);
    if (!base || inv.things.some((t) => t.id === seed.id)) continue;
    inv.things.push({
      ...structuredClone(base),
      serial: null,
      barcode: null,
      purchase: null,
      photos: [],
      meters: [],
      links: [],
      secrets: [],
      attachmentsCount: 0,
      ...seed,
    } as StoredThing);
  }
}

// ----- access and modules -----------------------------------------------------------------------

export const locOf = (state: MockState, id: string | null): LocationDetail | undefined =>
  state.locations.find((l) => l.id === id);

export function moduleOn(state: MockState, locationId: string, module: ModuleId): boolean {
  const loc = locOf(state, locationId);
  return !!loc && (loc.effectiveModules ?? loc.modules).includes(module);
}

/**
 * A module's gate on one location's record (screens §3): invisible → 404; module off → 404 on a
 * read (the record isn't there) and 409 `module_off` on a write; a viewer's write → 403.
 */
export function gateFor(
  state: MockState,
  locationId: string,
  module: ModuleId | null,
  mode: 'read' | 'write',
): MockReply | null {
  const access = accessOf(state);
  if (!access.visible(locationId)) return notFound();
  if (module && !moduleOn(state, locationId, module))
    return mode === 'read'
      ? notFound()
      : err(409, 'module_off', 'This module is off in this location.');
  if (mode === 'write' && !access.canWrite(locationId))
    return err(403, 'forbidden', "You don't have permission.");
  return null;
}

/** The locations a global list reads: visible, with the module on. */
export function listLocations(state: MockState, module: ModuleId | null): Set<string> {
  return new Set(
    state.locations
      .filter((l) => !module || (l.effectiveModules ?? l.modules).includes(module))
      .map((l) => l.id),
  );
}

// ----- dates ------------------------------------------------------------------------------------

/** "Today" in the location's zone: it decides due and overdue (§7.13, D122). */
export const todayIn = (state: MockState, locationId: string): string =>
  localDate(locOf(state, locationId)?.timezone ?? 'UTC');

// ----- money ------------------------------------------------------------------------------------

/** Money is shown with the Money module on and to members and above (viewers: per location, D13). */
export function showsMoney(state: MockState, locationId: string): boolean {
  const loc = locOf(state, locationId);
  if (!loc || !(loc.effectiveModules ?? loc.modules).includes('money')) return false;
  return loc.role !== 'viewer' || loc.moneyVisibleToViewers === true;
}

/** An amount through the gate (`serialize/gates.ts`): the pair, or `{moneyHidden: true}`. */
export function gate(state: MockState, locationId: string, m: Money | null): GatedMoney | null {
  if (!m) return null;
  return showsMoney(state, locationId)
    ? { amount: m.amount, currency: m.currency }
    : { moneyHidden: true };
}

// ----- subjects and people ----------------------------------------------------------------------

const SEP = ' › ';

function pathText(locationName: string, steps: PathStep[]): string {
  // The Unplaced area is left out, as the server does (UI step-4 review L2).
  return [locationName, ...steps.filter((s) => !s.isUnplaced).map((s) => s.name)].join(SEP);
}

export function thingSubject(state: MockState, t: StoredThing): SubjectRef {
  const loc = locOf(state, t.locationId);
  return {
    type: 'thing',
    id: t.id,
    name: t.name ?? '',
    path: pathText(loc?.name ?? '', thingPath(state.inventory, t)),
    shortCode: t.shortCode,
  };
}

/** A place names where it is: its location and the places above it. */
export function placeSubject(state: MockState, placeId: string): SubjectRef | null {
  const p = livePlace(state.inventory, placeId);
  if (!p) return null;
  const loc = locOf(state, p.locationId);
  return {
    type: 'place',
    id: p.id,
    name: p.name,
    path: pathText(loc?.name ?? '', placePath(state.inventory, p.parentId)),
    shortCode: p.shortCode,
  };
}

export function locationSubject(state: MockState, locationId: string): SubjectRef | null {
  const loc = locOf(state, locationId);
  return loc ? { type: 'location', id: loc.id, name: loc.name, path: '' } : null;
}

/** A subject input's live row and its location; null when it's gone or invisible. */
export function resolveSubject(
  state: MockState,
  input: { thingId: string } | { placeId: string } | { locationId: string },
): { ref: SubjectRef; locationId: string } | null {
  if ('thingId' in input) {
    const t = liveThing(state.inventory, input.thingId);
    return t ? { ref: thingSubject(state, t), locationId: t.locationId } : null;
  }
  if ('placeId' in input) {
    const p = livePlace(state.inventory, input.placeId);
    const ref = placeSubject(state, input.placeId);
    return p && ref ? { ref, locationId: p.locationId } : null;
  }
  const ref = locationSubject(state, input.locationId);
  return ref ? { ref, locationId: input.locationId } : null;
}

/** A registry person as a `PersonRef`: a name and whether they use Kept, nothing else (D57). */
export function personRef(state: MockState, personId: string): PersonRef {
  const p = state.inventory.people.find((x) => x.id === personId);
  return { id: personId, name: p?.displayName ?? '', isMember: !!p?.userId };
}

// ----- derived states (D54, D57, D119) ----------------------------------------------------------

export const openLoanOf = (state: MockState, thingId: string): StoredLoan | undefined =>
  hh(state).loans.find((l) => l.thingId === thingId && !l.returnedAt);

export const repairOf = (state: MockState, thingId: string): StoredClaim | undefined =>
  hh(state).claims.find((c) => c.thingId === thingId && c.status === 'in_repair');

/** Step 4's derived states: lent, borrowed (an open loan out or in) and in repair (D119). */
export function step4DerivedOf(state: MockState, t: StoredThing): DerivedState[] {
  const out: DerivedState[] = [];
  const loan = openLoanOf(state, t.id);
  if (loan) out.push(loan.direction === 'out' ? 'lent' : 'borrowed');
  if (repairOf(state, t.id)) out.push('in_repair');
  return out;
}

/** A person or vendor by id, including the ones `ensureSeeded` hasn't added yet. */
const personName = (state: MockState, id: string) =>
  (state.inventory.people.find((p) => p.id === id) ?? hh(state).seedPeople.find((p) => p.id === id))
    ?.displayName ?? '';
const vendorName = (state: MockState, id: string | null) =>
  id
    ? ((
        state.inventory.vendors.find((v) => v.id === id) ??
        hh(state).seedVendors.find((v) => v.id === id)
      )?.name ?? null)
    : null;

/** The thing view's step-4 fields (T8 `currentValue`, T9 `repairAt`, T10 `loanLine`). */
export function step4ViewOf(
  state: MockState,
  t: StoredThing,
): Pick<ThingView, 'currentValue' | 'repairAt' | 'loanLine'> {
  const loan = openLoanOf(state, t.id);
  const repair = repairOf(state, t.id);
  const out: Pick<ThingView, 'currentValue' | 'repairAt' | 'loanLine'> = {
    loanLine: loan
      ? {
          direction: loan.direction,
          personName: personName(state, loan.personId),
          startedAt: loan.startedAt,
          dueOn: loan.dueOn,
          overdue: !!loan.dueOn && todayIn(state, loan.locationId) > loan.dueOn,
        }
      : null,
    repairAt: repair ? { vendorName: vendorName(state, repair.vendorId) } : null,
  };
  if (moduleOn(state, t.locationId, 'money')) {
    const latest = hh(state)
      .valuations.filter((v) => v.thingId === t.id)
      .sort(
        (a, b) => b.valuedOn.localeCompare(a.valuedOn) || b.createdAt.localeCompare(a.createdAt),
      )[0];
    out.currentValue = !latest
      ? null
      : showsMoney(state, t.locationId)
        ? {
            amount: latest.amount,
            currency: latest.currency,
            valuedOn: latest.valuedOn,
            source: latest.source,
          }
        : { moneyHidden: true };
  }
  return out;
}

/** An attachment on a warranty, a claim or a loan (the §7.13 subjects), filed on its record. */
function attachStep4(state: MockState, a: AttachmentView): boolean {
  const { locationId: _l, ...plain } = a as AttachmentView & { locationId?: string };
  const subject = plain.subject;
  if ('warrantyId' in subject) {
    const w = hh(state).warranties.find((x) => x.id === subject.warrantyId);
    w?.documents.push(plain);
    return !!w;
  }
  if ('claimId' in subject) {
    const c = hh(state).claims.find((x) => x.id === subject.claimId);
    c?.documents.push(plain);
    return !!c;
  }
  if ('loanId' in subject) {
    const l = hh(state).loans.find((x) => x.id === subject.loanId);
    (plain.role === 'condition_in' ? l?.conditionIn : l?.conditionOut)?.push(plain);
    return !!l;
  }
  // An expiring document's file (T12): the lease's PDF, the policy's scan.
  if ('expiringDocumentId' in subject) {
    const d = hh(state).documents.find((x) => x.id === subject.expiringDocumentId);
    d?.documents.push(plain);
    return !!d;
  }
  // An incident's document (T18): the police report, the insurer's letter.
  if ('incidentId' in subject) {
    const i = hh(state).incidents.find((x) => x.id === subject.incidentId);
    i?.documents.push(plain);
    return !!i;
  }
  return false;
}

function detachStep4(state: MockState, a: AttachmentView): boolean {
  const drop = (list: AttachmentView[]) => {
    const i = list.findIndex((x) => x.id === a.id);
    if (i >= 0) list.splice(i, 1);
    return i >= 0;
  };
  const h = hh(state);
  return (
    h.warranties.some((w) => drop(w.documents)) ||
    h.claims.some((c) => drop(c.documents)) ||
    h.loans.some((l) => drop(l.conditionOut) || drop(l.conditionIn)) ||
    h.documents.some((d) => drop(d.documents)) ||
    h.incidents.some((i) => drop(i.documents))
  );
}

/**
 * Puts step 4 into step 2's rows and views (`rowOf`, `viewOf`) and its attachment route, once per
 * mock state: from here on every thing everywhere carries lent, borrowed and in repair (T20).
 */
export function installStep4(state: MockState): void {
  if (state.inventory.step4) return;
  state.inventory.step4 = {
    derived: (t) => step4DerivedOf(state, t),
    view: (t) => step4ViewOf(state, t),
    attach: (a) => attachStep4(state, a),
    detach: (a) => detachStep4(state, a),
  };
}

/** A thing's row as the server sends it, with the step-4 derived states. */
export function householdRowOf(state: MockState, t: StoredThing): ThingRow {
  installStep4(state);
  return rowOf(state.inventory, t);
}

// ----- views -------------------------------------------------------------------------------------

export function warrantyView(state: MockState, w: StoredWarranty): Warranty {
  const t = liveThing(state.inventory, w.thingId);
  const today = todayIn(state, t?.locationId ?? '');
  const ends = warrantyEnds(w);
  const effectiveEndsOn = ends === 'lifetime' ? null : ends;
  const state_: Warranty['state'] =
    ends === 'lifetime' || ends === null
      ? 'active'
      : ends < today
        ? 'ended'
        : today >= addDays(ends, -w.leadDays)
          ? 'expiring'
          : 'active';
  return { ...w, effectiveEndsOn, state: state_ };
}

/** The longest cover first (D53): lifetime, then the latest end. */
export function byCover(a: Warranty, b: Warranty): number {
  const end = (w: Warranty) => (w.lifetime ? '9999-12-31' : (w.effectiveEndsOn ?? ''));
  return end(b).localeCompare(end(a));
}

export function claimView(state: MockState, c: StoredClaim): Claim {
  const locationId = liveThing(state.inventory, c.thingId)?.locationId ?? '';
  const w = c.warrantyId ? hh(state).warranties.find((x) => x.id === c.warrantyId) : undefined;
  const incident = c.incidentId
    ? hh(state).incidents.find((x) => x.id === c.incidentId)
    : undefined;
  const vendor = c.vendorId ? state.inventory.vendors.find((v) => v.id === c.vendorId) : undefined;
  const noCost = c.cost === null || Number(c.cost.amount) === 0;
  const savedYou = c.status === 'resolved' && noCost ? c.coveredAmount : null;
  const { warrantyId: _w, incidentId: _i, vendorId: _v, ...own } = c;
  return {
    ...own,
    warranty: w ? { id: w.id, kind: w.kind, provider: w.provider } : null,
    incident: incident
      ? { id: incident.id, kind: incident.kind, occurredOn: incident.occurredOn }
      : null,
    vendor: vendor ? { id: vendor.id, name: vendor.name, kind: vendor.kind } : null,
    cost: gate(state, locationId, c.cost),
    coveredAmount: gate(state, locationId, c.coveredAmount),
    savedYou: gate(state, locationId, savedYou),
  };
}

export function loanView(state: MockState, l: StoredLoan): Loan {
  const today = todayIn(state, l.locationId);
  const { locationId: _l, personId, createdById: _c, ...own } = l;
  return {
    ...own,
    person: personRef(state, personId),
    overdue: !l.returnedAt && !!l.dueOn && today > l.dueOn,
  };
}

export function loanRowView(state: MockState, l: StoredLoan): LoanRow | null {
  const t = state.inventory.things.find((x) => x.id === l.thingId && !x.deletedAt);
  return t ? { ...loanView(state, l), thing: householdRowOf(state, t) } : null;
}

function scheduleSubjectRef(state: MockState, s: ScheduleSubject): SubjectRef | null {
  return resolveSubject(state, s)?.ref ?? null;
}

function basisOf(s: StoredSchedule): ScheduleBasis {
  if (s.everyMonths != null && s.everyUnits != null) return 'both';
  if (s.everyMonths != null) return 'months';
  if (s.everyUnits != null) return 'units';
  return 'once';
}

function meterOf(state: MockState, s: StoredSchedule) {
  if (!s.meterId) return null;
  for (const t of state.inventory.things) {
    const m = t.meters.find((x) => x.id === s.meterId);
    if (m) return m;
  }
  return null;
}

/** A schedule's next due point, as the agenda computes it (T11 reads it from agenda_items). */
export function scheduleNextOf(state: MockState, s: StoredSchedule): Schedule['next'] {
  const next = scheduleNext(s, {
    today: todayIn(state, s.locationId),
    latestValue: meterOf(state, s)?.latest?.value ?? null,
  });
  return { dueOn: next.dueOn, dueValue: next.dueValue, state: next.state, basis: basisOf(s) };
}

export function scheduleView(state: MockState, s: StoredSchedule): Schedule | null {
  const subject = scheduleSubjectRef(state, s.subject);
  if (!subject) return null;
  const meter = meterOf(state, s);
  const last = hh(state)
    .serviceRecords.filter((r) => r.completes.some((c) => c.scheduleId === s.id))
    .sort((a, b) => b.servicedOn.localeCompare(a.servicedOn))[0];
  const { subject: _s, meterId: _m, ...own } = s;
  return {
    ...own,
    subject,
    meter: meter ? { id: meter.id, label: meter.label ?? meter.kind, unit: meter.unit } : null,
    next: scheduleNextOf(state, s),
    lastService: last ? { id: last.id, servicedOn: last.servicedOn } : null,
  };
}

export function serviceRecordView(state: MockState, r: StoredServiceRecord): ServiceRecord | null {
  const subject = scheduleSubjectRef(state, r.subject);
  if (!subject) return null;
  const { locationId, loggedById: _l, ...own } = r;
  return {
    ...own,
    subject,
    total: gate(state, locationId, r.total),
    lines: r.lines.map((line) => ({ ...line, unitCost: gate(state, locationId, line.unitCost) })),
  };
}

export function documentView(state: MockState, d: StoredDocument): ExpiringDocument | null {
  const subject = resolveSubject(state, d.subject);
  if (!subject) return null;
  const today = todayIn(state, d.locationId);
  const docState: ExpiringDocument['state'] =
    today > d.expiresOn
      ? 'expired'
      : today >= addDays(d.expiresOn, -d.leadDays)
        ? 'expiring'
        : 'ok';
  // Earlier terms: the rows this one superseded, back through the chain, newest first.
  const history: ExpiringDocument['history'] = [];
  let cur = d;
  const seen = new Set<string>([d.id]);
  for (;;) {
    const prev = hh(state).documents.find((x) => x.supersededById === cur.id && !seen.has(x.id));
    if (!prev) break;
    seen.add(prev.id);
    history.push({ id: prev.id, expiresOn: prev.expiresOn });
    cur = prev;
  }
  const { subject: _s, createdAt: _c, ...own } = d;
  return { ...own, subject: subject.ref, state: docState, history };
}

// ----- the agenda (T13; plan Q7, Q24) ------------------------------------------------------------

type Draft = Omit<AgendaItem, 'key' | 'actions'> & { actions: AgendaAction[] };

function keyed(d: Draft): AgendaItem {
  const period =
    d.dueOn !== null ? duePeriod({ dueOn: d.dueOn }) : duePeriod({ dueValue: d.dueValue ?? '0' });
  return { ...d, key: `${d.sourceType}:${d.sourceId}:${d.kind}:${period}` };
}

/**
 * Every reminder source as agenda rows (screens §5, Q7): schedules due and overdue; warranties
 * expiring (an ended one isn't actionable); a registration deadline due; documents and thing
 * expiries expiring and overdue; loans overdue. Paused sources (module off, trashed subject,
 * ended thing) are left out, as the view's WHERE does (§7.6, D162). Upcoming rows are included:
 * the lists show them; the scan reads only due, overdue and expiring.
 */
export function agendaItems(state: MockState): AgendaItem[] {
  const h = hh(state);
  const access = accessOf(state);
  const on = (locationId: string, source: ActiveSourceType) => {
    const module = SOURCE_MODULE[source];
    return access.visible(locationId) && (!module || moduleOn(state, locationId, module));
  };
  const act = (locationId: string, actions: AgendaAction[]): AgendaAction[] =>
    access.canWrite(locationId) ? actions : ['open'];
  const out: AgendaItem[] = [];

  for (const s of h.schedules) {
    if (!s.active || !on(s.locationId, 'schedule')) continue;
    const subject = scheduleSubjectRef(state, s.subject);
    if (!subject) continue;
    const next = scheduleNextOf(state, s);
    const unit = meterOf(state, s)?.unit ?? null;
    out.push(
      keyed({
        sourceType: 'schedule',
        sourceId: s.id,
        kind: next.state === 'overdue' ? 'overdue' : 'due',
        state: next.state,
        locationId: s.locationId,
        subject,
        title: s.name,
        dueOn: next.dueOn,
        dueValue: next.dueValue,
        unit,
        actions: act(s.locationId, ['complete', 'snooze', 'open']),
      }),
    );
  }

  for (const w of h.warranties) {
    const t = liveThing(state.inventory, w.thingId);
    if (t?.lifecycle !== 'in_use') continue;
    const view = warrantyView(state, w);
    const subject = thingSubject(state, t);
    if (on(t.locationId, 'warranty') && view.effectiveEndsOn && view.state !== 'ended') {
      out.push(
        keyed({
          sourceType: 'warranty',
          sourceId: w.id,
          kind: 'expiring',
          state: view.state === 'expiring' ? 'expiring' : 'upcoming',
          locationId: t.locationId,
          subject,
          title: w.provider ?? w.kind,
          dueOn: view.effectiveEndsOn,
          dueValue: null,
          unit: null,
          actions: ['open'],
        }),
      );
    }
    if (on(t.locationId, 'registration') && !w.registered && w.registrationDeadline) {
      const today = todayIn(state, t.locationId);
      const due = today >= addDays(w.registrationDeadline, -LEAD_DEFAULTS.registration);
      out.push(
        keyed({
          sourceType: 'registration',
          sourceId: w.id,
          kind: 'due',
          state: due ? 'due' : 'upcoming',
          locationId: t.locationId,
          subject,
          title: w.provider ?? w.kind,
          dueOn: w.registrationDeadline,
          dueValue: null,
          unit: null,
          actions: ['open'],
        }),
      );
    }
  }

  for (const d of h.documents) {
    if (d.supersededById || !on(d.locationId, 'document')) continue;
    const view = documentView(state, d);
    if (!view) continue;
    const overdue = view.state === 'expired';
    out.push(
      keyed({
        sourceType: 'document',
        sourceId: d.id,
        kind: overdue ? 'overdue' : 'expiring',
        state: overdue ? 'overdue' : view.state === 'expiring' ? 'expiring' : 'upcoming',
        locationId: d.locationId,
        subject: view.subject,
        title: d.title ?? d.kind,
        dueOn: d.expiresOn,
        dueValue: null,
        unit: null,
        actions: act(d.locationId, ['renew', 'open']),
      }),
    );
  }

  for (const l of h.loans) {
    if (l.returnedAt || !l.dueOn || !on(l.locationId, 'loan')) continue;
    const t = liveThing(state.inventory, l.thingId);
    if (!t) continue;
    const overdue = todayIn(state, l.locationId) > l.dueOn;
    out.push(
      keyed({
        sourceType: 'loan',
        sourceId: l.id,
        kind: 'overdue',
        state: overdue ? 'overdue' : 'upcoming',
        locationId: l.locationId,
        subject: thingSubject(state, t),
        title: t.name ?? '',
        dueOn: l.dueOn,
        dueValue: null,
        unit: null,
        actions: act(l.locationId, ['mark_returned', 'open']),
      }),
    );
  }

  for (const t of state.inventory.things) {
    if (t.deletedAt || t.lifecycle !== 'in_use' || !t.expiresOn) continue;
    if (!on(t.locationId, 'thing_expiry')) continue;
    const today = todayIn(state, t.locationId);
    const lead = t.expiryLeadDays ?? LEAD_DEFAULTS.thing_expiry;
    const overdue = today > t.expiresOn;
    out.push(
      keyed({
        sourceType: 'thing_expiry',
        sourceId: t.id,
        kind: overdue ? 'overdue' : 'expiring',
        state: overdue ? 'overdue' : today >= addDays(t.expiresOn, -lead) ? 'expiring' : 'upcoming',
        locationId: t.locationId,
        subject: thingSubject(state, t),
        title: t.name ?? '',
        dueOn: t.expiresOn,
        dueValue: null,
        unit: null,
        actions: ['open'],
      }),
    );
  }

  const SEVERITY: Record<string, number> = { overdue: 0, due: 1, expiring: 2, upcoming: 3 };
  return out.sort(
    (a, b) =>
      (SEVERITY[a.state] ?? 4) - (SEVERITY[b.state] ?? 4) ||
      (a.dueOn ?? '9999').localeCompare(b.dueOn ?? '9999') ||
      a.key.localeCompare(b.key),
  );
}

// ----- notifications -----------------------------------------------------------------------------

/**
 * A notification as the centre shows it (T16): a reminder's state and actions come from its
 * source now (a returned loan is `done` with no actions; a renewed document `superseded`), and its
 * subject is re-read so a renamed thing shows its new name.
 */
export function notificationView(state: MockState, n: StoredNotification): Notification {
  const { userId: _u, reminder, ...own } = n;
  if (!reminder) return own;
  const items = agendaItems(state);
  const live = items.find(
    (i) => i.sourceType === reminder.sourceType && i.sourceId === reminder.sourceId,
  );
  let status: NonNullable<Notification['reminder']>['state'] = 'open';
  const h = hh(state);
  if (reminder.sourceType === 'loan') {
    const loan = h.loans.find((l) => l.id === reminder.sourceId);
    if (!loan) status = 'cancelled';
    else if (loan.returnedAt) status = 'done';
  } else if (reminder.sourceType === 'document') {
    const doc = h.documents.find((d) => d.id === reminder.sourceId);
    if (!doc) status = 'cancelled';
    else if (doc.supersededById) status = 'superseded';
  } else if (reminder.sourceType === 'schedule') {
    const done = h.serviceRecords.some(
      (r) =>
        r.completes.some((c) => c.scheduleId === reminder.sourceId) &&
        r.servicedOn >= n.createdAt.slice(0, 10),
    );
    if (done) status = 'done';
    else if (live && live.dueOn !== reminder.dueOn) status = 'superseded';
  }
  if (status === 'open' && !live) status = 'cancelled';
  return {
    ...own,
    reminder: {
      ...reminder,
      subject: live?.subject ?? reminder.subject,
      state: status,
      actions: status === 'open' ? (live?.actions ?? []) : [],
    },
  };
}

// ----- history and undo (D150) ------------------------------------------------------------------

/**
 * Records a step-4 write in the history, undoable when `undo` is given, as step 2's writes are:
 * the event's entity is the record (`warranty`, `loan`, …) and its root the thing it's on, so the
 * thing's history and its "Undo" list show it. Returns the event id.
 */
export function recordHouseholdEvent(
  state: MockState,
  e: {
    action: string;
    entity: { type: string; id: string };
    locationId: string;
    rootThingId?: string | null;
    name: string;
    undo?: () => void;
  },
): string {
  const me = state.me.user;
  const event = recordEvent(
    state.inventory,
    { id: me.id, displayName: me.displayName },
    {
      action: e.action,
      entity: { type: 'thing', id: e.rootThingId ?? e.entity.id },
      locationId: e.locationId,
      name: e.name,
      ...(e.undo ? { undo: e.undo } : {}),
    },
  );
  event.entity = { type: e.entity.type, id: e.entity.id };
  event.root_thing_id = e.rootThingId ?? null;
  return event.id;
}

/** The rows of a list that the caller's locations and the module allow. */
export function inLocations<T extends { locationId: string }>(rows: T[], ids: Set<string>): T[] {
  return rows.filter((r) => ids.has(r.locationId));
}

/** The query's `locationId` filter, when given. */
export function byLocationParam<T extends { locationId: string }>(
  rows: T[],
  query: URLSearchParams,
): T[] {
  const loc = query.get('locationId');
  return loc ? rows.filter((r) => r.locationId === loc) : rows;
}
