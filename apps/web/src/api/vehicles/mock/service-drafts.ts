/**
 * Service drafts from an invoice (plan T9, Q12), after the server's `services/`: attaching an
 * invoice makes a draft service record and, where AI resolves for the location, a read of it whose
 * vendor, date, total, currency and lines come back as suggestions (never applied). Confirm runs
 * step 4's create rules on the draft. Drafts count nowhere and list first on the Services tab.
 * A thing's service records (step 4's route) gain step 5's fields and filters here.
 */
import { normalize, reconcileTotal } from '@kept/shared';
import {
  ensureSeeded,
  hh,
  newId,
  recordHouseholdEvent,
  serviceRecordView,
  showsMoney,
  todayIn,
} from '../../household/mock/db';
import type { StoredServiceRecord } from '../../household/mock/state';
import { householdPaths } from '../../household/paths';
import { accessOf, liveThing, paginate, versionError } from '../../inventory/mock/db';
import type { MockState } from '../../mock/fixtures';
import { err, type MockRoute, notFound, reply, route } from '../../mock/kit';
import { vehiclePaths as p } from '../paths';
import type {
  ConfirmServiceBody,
  CreateServiceDraftBody,
  ServiceRecordV5,
  ServiceSuggestion,
} from '../types';
import { inWhen } from './series';
import { ensureVehiclesSeeded, mainMeter, readingList, touchMeter, vehiclesOf } from './state';

/**
 * How the next invoice read goes (T20's tests): `oil` (the default: three lines, total matches),
 * `dollar` (the same with a bare `$`, flagged `currency_unclear` and no currency suggested, D189)
 * or `reading` (the read is still running).
 */
export type InvoiceReadKind = 'oil' | 'dollar' | 'reading';
const nextRead = new WeakMap<MockState, InvoiceReadKind>();
export function setNextInvoiceRead(state: MockState, kind: InvoiceReadKind): void {
  nextRead.set(state, kind);
}
/** A draft's read flags (`currency_unclear`), by service record id. */
const readFlags = new WeakMap<MockState, Map<string, string[]>>();
function flagsOf(state: MockState): Map<string, string[]> {
  const m = readFlags.get(state) ?? new Map<string, string[]>();
  readFlags.set(state, m);
  return m;
}

/** The fixture invoice's read: an oil change at the service centre (three lines, total matches). */
function invoiceSuggestions(
  extractionId: string,
  attachmentId: string,
  currency: string | null,
): ServiceSuggestion[] {
  const source = { extractionId, attachmentId };
  const line = (description: string, kind: string, quantity: string, unitCost: string) => ({
    field: 'line' as const,
    value: { description, kind, quantity, unitCost },
    confidence: 0.86,
    source,
  });
  return [
    { field: 'vendor', value: { name: 'City Service Centre' }, confidence: 0.92, source },
    { field: 'servicedOn', value: new Date().toISOString().slice(0, 10), confidence: 0.9, source },
    { field: 'total', value: '2250', confidence: 0.94, source },
    ...(currency
      ? [{ field: 'currency' as const, value: currency, confidence: 0.88, source }]
      : []),
    line('Engine oil 5W-30', 'fluid', '4', '350'),
    line('Oil filter', 'part', '1', '450'),
    line('Labour', 'labour', '1', '400'),
  ];
}

/** A step-4 record with step 5's fields; money in suggestions withheld behind the gate. */
export function serviceRecordV5(state: MockState, r: StoredServiceRecord): ServiceRecordV5 | null {
  const view = serviceRecordView(state, r);
  if (!view) return null;
  const draft = vehiclesOf(state).drafts.get(r.id);
  const money = showsMoney(state, r.locationId);
  const check = reconcileTotal(
    r.total?.amount ?? null,
    r.lines.map((l) => ({ quantity: l.quantity, unitCost: l.unitCost?.amount ?? null })),
  );
  const moneyField = new Set(['total', 'currency']);
  const read = draft?.reviewState === 'draft' && money ? (flagsOf(state).get(r.id) ?? []) : [];
  return {
    ...view,
    reviewState: draft?.reviewState ?? 'confirmed',
    flags: [...read, ...(check.result === 'flag' ? ['total_mismatch'] : [])],
    ...(draft?.reviewState === 'draft'
      ? {
          suggestions: draft.suggestions
            .filter((s) => money || !moneyField.has(s.field))
            .map((s) => {
              if (money || s.field !== 'line') return s;
              const { unitCost: _u, ...line } = s.value as Record<string, unknown>;
              return { ...s, value: line };
            }),
          ...(draft.extraction ? { extraction: draft.extraction } : {}),
        }
      : {}),
  };
}

export function serviceDraftRoutes(state: MockState): MockRoute[] {
  const v = () => vehiclesOf(state);
  const records = () => hh(state).serviceRecords;
  const visible = (r: StoredServiceRecord | undefined) =>
    r && accessOf(state).visible(r.locationId) ? r : undefined;

  return [
    route('POST', p.serviceDrafts, ({ body, headers }) => {
      ensureVehiclesSeeded(state);
      const key = headers['idempotency-key'];
      if (!key)
        return err(400, 'validation', 'The request is not valid.', 'Send an Idempotency-Key.');
      const seen = v().idempotency.get(`draft:${key}`);
      if (seen) return reply(201, seen);
      const b = body as CreateServiceDraftBody;
      if (
        !Array.isArray(b.invoiceFileIds) ||
        b.invoiceFileIds.length < 1 ||
        b.invoiceFileIds.length > 10
      )
        return err(
          400,
          'validation',
          'The request is not valid.',
          'Check body.invoiceFileIds: 1 to 10.',
        );
      const thingId = 'thingId' in b.subject ? b.subject.thingId : null;
      const t = thingId ? liveThing(state.inventory, thingId) : null;
      const place =
        'placeId' in b.subject
          ? state.inventory.places.find((x) => x.id === (b.subject as { placeId: string }).placeId)
          : null;
      const locationId = t?.locationId ?? place?.locationId;
      if (!locationId || !accessOf(state).visible(locationId)) return notFound();
      if (!accessOf(state).canWrite(locationId))
        return err(403, 'forbidden', "You don't have permission.");
      const me = state.me.user;
      const row: StoredServiceRecord = {
        id: b.id ?? newId(),
        locationId,
        subject: thingId ? { thingId } : { placeId: place?.id ?? '' },
        servicedOn: todayIn(state, locationId),
        reading: null,
        vendor: null,
        total: null,
        lines: [],
        completes: [],
        notes: null,
        invoices: [],
        loggedBy: { displayName: me.displayName },
        loggedById: me.id,
        rowVersion: 1,
      };
      records().push(row);
      const loc = state.locations.find((l) => l.id === locationId);
      const ai = !!loc?.providerResolved;
      const kind = nextRead.get(state) ?? 'oil';
      nextRead.delete(state);
      const extraction = ai
        ? { id: newId(), status: kind === 'reading' ? 'running' : 'succeeded' }
        : null;
      v().drafts.set(row.id, {
        reviewState: 'draft',
        suggestions:
          extraction && kind !== 'reading'
            ? invoiceSuggestions(
                extraction.id,
                newId(),
                kind === 'dollar' ? null : (loc?.currency ?? 'EGP'),
              )
            : [],
        extraction,
        invoiceFileIds: b.invoiceFileIds,
      });
      if (extraction && kind === 'dollar') flagsOf(state).set(row.id, ['currency_unclear']);
      recordHouseholdEvent(state, {
        action: 'service_record.draft',
        entity: { type: 'service_record', id: row.id },
        locationId,
        rootThingId: thingId,
        name: '',
      });
      const result = {
        serviceRecord: serviceRecordV5(state, row),
        ...(extraction ? { extraction } : {}),
      };
      v().idempotency.set(`draft:${key}`, result);
      return reply(201, result);
    }),

    route('POST', p.serviceRecordConfirm(':id'), ({ params, body, headers }) => {
      const r = visible(records().find((x) => x.id === params.id));
      const draft = r && v().drafts.get(r.id);
      if (!r || !draft) return notFound();
      if (draft.reviewState !== 'draft')
        return err(409, 'conflict', 'That conflicts with the current state.');
      const mine = r.loggedById === state.me.user.id;
      if (!(mine ? accessOf(state).canWrite(r.locationId) : accessOf(state).isAdmin(r.locationId)))
        return err(403, 'forbidden', "You don't have permission.");
      const version = versionError(headers, r);
      if (version) return reply(version.status, version.body);
      const b = body as ConfirmServiceBody;
      const currency =
        b.currency ?? state.locations.find((l) => l.id === r.locationId)?.currency ?? 'EGP';
      if (b.reading && 'thingId' in r.subject) {
        const t = liveThing(state.inventory, r.subject.thingId);
        const meter = t ? mainMeter(t) : null;
        const list = meter ? readingList(state, meter.id) : null;
        if (!meter || !list) return notFound();
        const takenAt = `${b.servicedOn}T09:00:00.000Z`;
        const previous = list
          .filter((x) => x.state === 'accepted' && x.takenAt <= takenAt)
          .sort((a, c) => c.takenAt.localeCompare(a.takenAt))[0];
        if (previous && Number(b.reading.value) < Number(previous.value))
          return err(409, 'conflict', 'That conflicts with the current state.', undefined, {
            reason: 'lower_than_previous',
            previous: { value: previous.value, takenAt: previous.takenAt },
          });
        const id = newId();
        list.push({
          id,
          value: b.reading.value,
          takenAt,
          source: 'service',
          state: 'accepted',
          reviewReason: null,
          loggedBy: r.loggedBy,
          note: null,
          rowVersion: 1,
        });
        v().owners.set(id, { type: 'service', id: r.id });
        touchMeter(state, meter.id);
        r.reading = { id, value: b.reading.value, unit: meter.unit };
      }
      const vendor =
        b.vendor && 'id' in b.vendor
          ? state.inventory.vendors.find((x) => x.id === (b.vendor as { id: string }).id)
          : undefined;
      Object.assign(r, {
        servicedOn: b.servicedOn,
        vendor: vendor
          ? { id: vendor.id, name: vendor.name }
          : b.vendor && 'name' in b.vendor
            ? { id: newId(), name: b.vendor.name }
            : r.vendor,
        total: b.total !== undefined ? { amount: b.total, currency } : r.total,
        lines: (b.lines ?? []).map((l) => ({
          id: newId(),
          kind: l.kind,
          description: l.description,
          quantity: l.quantity ?? null,
          unitCost: l.unitCost !== undefined ? { amount: l.unitCost, currency } : null,
        })),
        completes: (b.completes ?? []).map((scheduleId) => ({
          scheduleId,
          name: hh(state).schedules.find((s) => s.id === scheduleId)?.name ?? '',
        })),
        notes: b.notes ?? null,
      });
      r.rowVersion += 1;
      draft.reviewState = 'confirmed';
      recordHouseholdEvent(state, {
        action: 'service_record.confirm',
        entity: { type: 'service_record', id: r.id },
        locationId: r.locationId,
        rootThingId: 'thingId' in r.subject ? r.subject.thingId : null,
        name: '',
        undo: () => {
          draft.reviewState = 'draft';
        },
      });
      return serviceRecordV5(state, r);
    }),

    route('GET', p.serviceRecord(':id'), ({ params }) => {
      const r = visible(records().find((x) => x.id === params.id));
      const out = r ? serviceRecordV5(state, r) : null;
      return out ?? notFound();
    }),

    // Step 4's list, with step 5's fields and the `services` surface's filters; drafts first.
    route('GET', householdPaths.thingServiceRecords(':id'), ({ params, query }) => {
      ensureSeeded(state);
      const t = liveThing(state.inventory, params.id ?? null);
      if (!t || !accessOf(state).visible(t.locationId)) return notFound();
      const q = normalize(query.get('q') ?? '');
      const when = query.get('f.when');
      const vendors = query.getAll('f.vendor');
      const kinds = query.getAll('f.kind');
      const draftOnly = query.get('f.draft');
      const sort = query.get('sort') ?? 'servicedOn';
      const asc = query.get('dir') === 'asc';
      const rows = records()
        .filter((r) => 'thingId' in r.subject && r.subject.thingId === t.id)
        .map((r) => serviceRecordV5(state, r))
        .filter((r): r is ServiceRecordV5 => r !== null)
        .filter((r) => inWhen(r.servicedOn, when))
        .filter((r) => vendors.length === 0 || (r.vendor !== null && vendors.includes(r.vendor.id)))
        .filter((r) => kinds.length === 0 || r.lines.some((l) => kinds.includes(l.kind)))
        .filter((r) => draftOnly === null || (r.reviewState === 'draft') === (draftOnly === '1'))
        .filter(
          (r) =>
            !q ||
            normalize(
              [r.vendor?.name, r.notes, ...r.lines.map((l) => l.description)].join(' '),
            ).includes(q),
        )
        .sort((a, b) => {
          if (a.reviewState !== b.reviewState) return a.reviewState === 'draft' ? -1 : 1;
          const amount = (r: ServiceRecordV5) =>
            r.total && 'amount' in r.total ? Number(r.total.amount) : 0;
          const d =
            sort === 'total' ? amount(a) - amount(b) : a.servicedOn.localeCompare(b.servicedOn);
          return asc ? d : -d;
        });
      return paginate(rows, query, 20);
    }),
  ];
}
