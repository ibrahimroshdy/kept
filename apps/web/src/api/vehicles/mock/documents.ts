/**
 * Vehicle documents (plan T12; Q5), on step 4's expiring documents: each gains its issue date and
 * cost (the cost through the money gate), `GET /documents` gains `thingId` (a vehicle's Documents
 * tab, where a vehicle's documents count with Paperwork **or** Vehicles on), and the create, edit
 * and renew bodies gain `issuedOn`, `cost` and `currency`. Step 4's handlers answer first; this
 * keeps the issue date and cost beside them and adds them to what they return.
 */
import { documentView, ensureSeeded, hh, moduleOn } from '../../household/mock/db';
import { paperworkRoutes } from '../../household/mock/paperwork';
import { householdPaths as hp } from '../../household/paths';
import type { ExpiringDocument } from '../../household/types';
import { accessOf, liveThing, paginate } from '../../inventory/mock/db';
import type { MockState } from '../../mock/fixtures';
import {
  MockReply,
  type MockRequest,
  type MockRoute,
  notFound,
  reply,
  route,
} from '../../mock/kit';
import type { DocumentCostFields, ExpiringDocumentV5 } from '../types';
import { ensureVehiclesSeeded, isVehicle, moneyShown, vehiclesOf } from './state';
import { original } from './vehicles';

/** An expiring document as step 5 answers it: its issue date, and its cost behind the gate. */
export function documentV5(state: MockState, d: ExpiringDocument): ExpiringDocumentV5 {
  const c = vehiclesOf(state).documentCosts.get(d.id);
  const money = moneyShown(state, d.locationId);
  return {
    ...d,
    issuedOn: c?.issuedOn ?? null,
    ...(money
      ? c?.cost && c.currency
        ? { cost: c.cost, currency: c.currency }
        : {}
      : { moneyHidden: true as const }),
  };
}

export function documentRoutes(state: MockState): MockRoute[] {
  const step4 = paperworkRoutes(state);
  const handlers = {
    list: original(step4, 'GET', hp.documents),
    one: original(step4, 'GET', hp.document(':id')),
    create: original(step4, 'POST', hp.documents),
    update: original(step4, 'PATCH', hp.document(':id')),
    renew: original(step4, 'POST', hp.documentRenew(':id')),
  };

  /** Keeps a write's issue date and cost for the document it wrote, and decorates the answer. */
  const keep = (id: string | undefined, b: DocumentCostFields, fallback?: string) => {
    if (!id) return;
    const costs = vehiclesOf(state).documentCosts;
    const prev = costs.get(id) ?? { issuedOn: null, cost: null, currency: null };
    const doc = hh(state).documents.find((d) => d.id === id);
    const currency =
      b.currency !== undefined
        ? b.currency
        : b.cost !== undefined && b.cost !== null
          ? (fallback ?? state.locations.find((l) => l.id === doc?.locationId)?.currency ?? null)
          : prev.currency;
    costs.set(id, {
      issuedOn: b.issuedOn !== undefined ? b.issuedOn : prev.issuedOn,
      cost: b.cost !== undefined ? b.cost : prev.cost,
      currency: b.cost === null ? null : currency,
    });
  };
  const decorated = async (
    req: MockRequest,
    run: (req: MockRequest) => unknown,
    write: (out: unknown) => void,
  ) => {
    const out = await run(req);
    if (!vehiclesOf(state).seeded) return out;
    const status = out instanceof MockReply ? out.status : 200;
    const body = out instanceof MockReply ? out.body : out;
    if (status >= 300 || !body) return out;
    write(body);
    const b = body as Record<string, unknown>;
    const decorate = (x: unknown) => documentV5(state, x as ExpiringDocument);
    const next =
      'renewed' in b
        ? { renewed: decorate(b.renewed), previous: decorate(b.previous) }
        : 'items' in b
          ? { ...b, items: (b.items as ExpiringDocument[]).map(decorate) }
          : decorate(b);
    return out instanceof MockReply ? reply(out.status, next) : next;
  };

  return [
    route('GET', hp.documents, (req) => {
      const thingId = req.query.get('thingId');
      if (!thingId) return decorated(req, handlers.list, () => {});
      ensureSeeded(state);
      ensureVehiclesSeeded(state);
      const t = liveThing(state.inventory, thingId);
      if (!t || !accessOf(state).visible(t.locationId)) return notFound();
      // A vehicle's documents with Paperwork or Vehicles on (step 4's Q5); anything else, Paperwork.
      const on =
        moduleOn(state, t.locationId, 'paperwork') ||
        (isVehicle(state, t) && moduleOn(state, t.locationId, 'vehicles'));
      if (!on) return notFound();
      const superseded = req.query.get('includeSuperseded') === '1';
      const want = req.query.get('state');
      const items = hh(state)
        .documents.filter(
          (d) =>
            'thingId' in d.subject &&
            d.subject.thingId === thingId &&
            (superseded || !d.supersededById),
        )
        .map((d) => documentView(state, d))
        .filter((d): d is ExpiringDocument => d !== null && (!want || d.state === want))
        .sort((a, b) => a.expiresOn.localeCompare(b.expiresOn))
        .map((d) => documentV5(state, d));
      return paginate(items, req.query, 20);
    }),
    route('GET', hp.document(':id'), (req) => decorated(req, handlers.one, () => {})),
    route('POST', hp.documents, (req) =>
      decorated(req, handlers.create, (out) =>
        keep((out as ExpiringDocument).id, req.body as DocumentCostFields),
      ),
    ),
    route('PATCH', hp.document(':id'), (req) =>
      decorated(req, handlers.update, () => keep(req.params.id, req.body as DocumentCostFields)),
    ),
    route('POST', hp.documentRenew(':id'), (req) =>
      decorated(req, handlers.renew, (out) =>
        keep((out as { renewed: ExpiringDocument }).renewed.id, req.body as DocumentCostFields),
      ),
    ),
  ];
}
