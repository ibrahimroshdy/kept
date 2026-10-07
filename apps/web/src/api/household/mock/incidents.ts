/**
 * Mock handlers for incidents, the insurance report and claim packs (T18; D158, D169, D201;
 * Q19–Q21). An incident groups things and can end them (stolen, destroyed, lost); the insurance
 * report is queued like the inventory report (its run is step 2's `GET /reports/:id`); a report
 * currency needs a rate for every pair or it's refused with the missing pairs (never estimated);
 * a claim pack needs the "this includes prices and documents" acknowledgement, and its download
 * link is shown once and can be revoked.
 */
import { can, convert } from '@kept/shared';
import { liveThing, paginate, versionError } from '../../inventory/mock/db';
import { queueReportRun } from '../../inventory/mock/reports';
import type { MockState } from '../../mock/fixtures';
import { err, type MockRoute, notFound, reply, route } from '../../mock/kit';
import { householdPaths as p } from '../paths';
import type {
  CreateClaimPackBody,
  CreateIncidentBody,
  Incident,
  IncidentRow,
  IncidentThingsBody,
  InsuranceReportBody,
  UpdateIncidentBody,
} from '../types';
import {
  ensureSeeded,
  gateFor,
  hh,
  householdRowOf,
  locOf,
  newId,
  recordHouseholdEvent,
} from './db';
import type { StoredIncident } from './state';

const invalid = (hint: string) => err(400, 'validation', 'The request is not valid.', hint);

export function incidentsRoutes(state: MockState): MockRoute[] {
  const h = () => hh(state);
  const inv = () => state.inventory;

  /** incidents.manage: owner and admin. */
  const manages = (locationId: string) => {
    const role = locOf(state, locationId)?.role;
    return !!role && can(role, 'incidents.manage');
  };

  const rowOf = (i: StoredIncident): IncidentRow => ({
    id: i.id,
    locationId: i.locationId,
    kind: i.kind,
    occurredOn: i.occurredOn,
    policeReference: i.policeReference,
    insurerReference: i.insurerReference,
    thingCount: i.thingIds.length,
    claimCount: h().claims.filter((c) => c.incidentId === i.id).length,
    rowVersion: i.rowVersion,
  });
  const viewOf = (i: StoredIncident): Incident => ({
    ...rowOf(i),
    notes: i.notes,
    documents: i.documents,
    createdBy: i.createdBy,
    things: i.thingIds.flatMap((id) => {
      const t = inv().things.find((x) => x.id === id && !x.deletedAt);
      return t ? [householdRowOf(state, t)] : [];
    }),
    claims: h()
      .claims.filter((c) => c.incidentId === i.id)
      .map((c) => ({ id: c.id, thingId: c.thingId, status: c.status, reference: c.reference })),
  });

  /** Ends the listed things with the incident's lifecycle (D158); returns their undo. */
  const endThings = (ids: string[], lifecycle: 'stolen' | 'destroyed' | 'lost', on: string) => {
    const befores = ids.flatMap((id) => {
      const t = liveThing(inv(), id);
      if (!t) return [];
      const before = structuredClone(t);
      t.lifecycle = lifecycle;
      t.ended = { on, to: null, notes: null };
      t.rowVersion += 1;
      return [[t, before] as const];
    });
    return () => {
      for (const [t, before] of befores) Object.assign(t, before, { rowVersion: t.rowVersion + 1 });
    };
  };

  const withIncident = (
    id: string | undefined,
    headers: Record<string, string>,
    fn: (i: StoredIncident) => unknown,
  ) => {
    const i = h().incidents.find((x) => x.id === id);
    if (!i || !locOf(state, i.locationId)) return notFound();
    if (!manages(i.locationId)) return err(403, 'forbidden', "You don't have permission.");
    const stale = versionError(headers, i);
    if (stale) return reply(stale.status, stale.body);
    return fn(i);
  };

  return [
    route('GET', p.incidents, ({ query }) => {
      ensureSeeded(state);
      const loc = query.get('locationId');
      const kind = query.get('kind');
      const items = h()
        .incidents.filter(
          (i) =>
            !!locOf(state, i.locationId) &&
            (!loc || i.locationId === loc) &&
            (!kind || i.kind === kind),
        )
        .sort((a, b) => b.occurredOn.localeCompare(a.occurredOn))
        .map(rowOf);
      return paginate(items, query, 20);
    }),
    route('GET', p.incident(':id'), ({ params }) => {
      const i = h().incidents.find((x) => x.id === params.id);
      return i && locOf(state, i.locationId) ? viewOf(i) : notFound();
    }),
    route('POST', p.locationIncidents(':id'), ({ params, body }) => {
      ensureSeeded(state);
      const locationId = params.id ?? '';
      const gated = gateFor(state, locationId, null, 'read');
      if (gated) return gated;
      if (!manages(locationId)) return err(403, 'forbidden', "You don't have permission.");
      const b = body as CreateIncidentBody;
      if ((b.thingIds?.length ?? 0) > 200) return invalid('thingIds: at most 200');
      const thingIds = (b.thingIds ?? []).filter(
        (id) => liveThing(inv(), id)?.locationId === locationId,
      );
      const row: StoredIncident = {
        id: b.id ?? newId(),
        locationId,
        kind: b.kind,
        occurredOn: b.occurredOn,
        policeReference: b.policeReference ?? null,
        insurerReference: b.insurerReference ?? null,
        notes: b.notes ?? null,
        documents: [],
        createdBy: { displayName: state.me.user.displayName },
        rowVersion: 1,
        thingIds,
      };
      h().incidents.push(row);
      if (b.lifecycle) endThings(thingIds, b.lifecycle, b.occurredOn);
      recordHouseholdEvent(state, {
        action: 'incident.create',
        entity: { type: 'incident', id: row.id },
        locationId,
        name: row.kind,
      });
      return reply(201, viewOf(row));
    }),
    route('PATCH', p.incident(':id'), ({ params, body, headers }) =>
      withIncident(params.id, headers, (i) => {
        const before = { ...i };
        Object.assign(i, body as UpdateIncidentBody);
        i.rowVersion += 1;
        recordHouseholdEvent(state, {
          action: 'incident.update',
          entity: { type: 'incident', id: i.id },
          locationId: i.locationId,
          name: i.kind,
          undo: () => Object.assign(i, before, { rowVersion: i.rowVersion + 1 }),
        });
        return viewOf(i);
      }),
    ),
    route('DELETE', p.incident(':id'), ({ params, headers }) =>
      withIncident(params.id, headers, (i) => {
        h().incidents = h().incidents.filter((x) => x !== i);
        recordHouseholdEvent(state, {
          action: 'incident.delete',
          entity: { type: 'incident', id: i.id },
          locationId: i.locationId,
          name: i.kind,
          undo: () => {
            h().incidents.push(i);
          },
        });
        return reply(204);
      }),
    ),
    route('POST', p.incidentThings(':id'), ({ params, body, headers }) =>
      withIncident(params.id, headers, (i) => {
        const b = body as IncidentThingsBody;
        const before = [...i.thingIds];
        const add = (b.add ?? []).filter(
          (id) => liveThing(inv(), id)?.locationId === i.locationId && !i.thingIds.includes(id),
        );
        i.thingIds = [...i.thingIds.filter((id) => !b.remove?.includes(id)), ...add];
        const undoEnd = b.lifecycle ? endThings(add, b.lifecycle, i.occurredOn) : () => {};
        i.rowVersion += 1;
        recordHouseholdEvent(state, {
          action: 'incident.things',
          entity: { type: 'incident', id: i.id },
          locationId: i.locationId,
          name: i.kind,
          undo: () => {
            i.thingIds = before;
            undoEnd();
            i.rowVersion += 1;
          },
        });
        return viewOf(i);
      }),
    ),

    // ----- the insurance report -----
    route('POST', p.reportsInsurance, ({ body }) => {
      ensureSeeded(state);
      const b = body as InsuranceReportBody;
      const locationId =
        'locationId' in b.scope
          ? b.scope.locationId
          : h().incidents.find((x) => x.id === (b.scope as { incidentId: string }).incidentId)
              ?.locationId;
      if (!locationId || !locOf(state, locationId)) return notFound();
      const gated = gateFor(state, locationId, 'money', 'read');
      if (gated) return err(409, 'module_off', 'This module is off in this location.');
      if ('incidentId' in b.scope && !manages(locationId))
        return err(403, 'forbidden', "You don't have permission.");
      if (b.reportCurrency) {
        // Every currency the scope's prices use needs a rate on or before asOf (Q21).
        const accountId = locOf(state, locationId)?.ownerAccountId;
        const rates = h().fxRates.filter((r) => r.accountId === accountId);
        const asOf = b.asOf ?? new Date().toISOString().slice(0, 10);
        const currencies = new Set(
          inv()
            .things.filter((t) => t.locationId === locationId && !t.deletedAt)
            .flatMap((t) => (t.purchase?.currency ? [t.purchase.currency] : [])),
        );
        const missing = [...currencies]
          .filter((c) => c !== b.reportCurrency)
          .filter((c) => 'missing' in convert('1', c, b.reportCurrency as string, asOf, rates))
          .map((c) => ({ from: c, to: b.reportCurrency as string }));
        if (missing.length > 0)
          return err(409, 'rate_missing', 'A rate is missing for this currency.', undefined, {
            missing,
          });
      }
      // Read back through step 2's GET /reports/:id, as the server's run is (T18).
      const incident =
        'incidentId' in b.scope
          ? h().incidents.find((x) => x.id === (b.scope as { incidentId: string }).incidentId)
          : undefined;
      const count = incident
        ? incident.thingIds.length
        : inv().things.filter((t) => t.locationId === locationId && !t.deletedAt).length;
      return reply(202, queueReportRun(state, { locationId }, count));
    }),
    route('GET', p.reportsInsuranceCsv, ({ query }) => {
      // A location's things, or an incident's (whatever their lifecycle now, Q20).
      const incident = h().incidents.find((x) => x.id === query.get('incidentId'));
      const locationId = incident?.locationId ?? query.get('locationId');
      if (!locationId || !locOf(state, locationId)) return notFound();
      const rows = inv()
        .things.filter(
          (t) =>
            t.locationId === locationId &&
            !t.deletedAt &&
            (!incident || incident.thingIds.includes(t.id)),
        )
        .map((t) => `"${(t.name ?? '').replaceAll('"', '""')}"`);
      return new Response(['name', ...rows].join('\r\n'), {
        status: 200,
        headers: { 'content-type': 'text/csv; charset=utf-8' },
      });
    }),

    // ----- claim packs -----
    route('POST', p.claimPacks, ({ body }) => {
      ensureSeeded(state);
      const b = body as CreateClaimPackBody;
      if (b.acknowledged !== true)
        return invalid('acknowledged: the "this includes prices and documents" warning');
      const locationId =
        'locationId' in b.scope
          ? b.scope.locationId
          : h().incidents.find((x) => x.id === (b.scope as { incidentId: string }).incidentId)
              ?.locationId;
      if (!locationId || !locOf(state, locationId)) return notFound();
      if (!manages(locationId)) return err(403, 'forbidden', "You don't have permission.");
      const id = newId();
      h().claimPacks.push({
        id,
        createdById: state.me.user.id,
        scope: b.scope,
        status: 'queued',
        progress: { done: 0, total: 0 },
        link: null,
        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      });
      return reply(202, { id, status: 'queued' });
    }),
    route('GET', p.claimPack(':id'), ({ params }) => {
      const pack = h().claimPacks.find(
        (x) => x.id === params.id && x.createdById === state.me.user.id,
      );
      if (!pack) return notFound();
      // A queued pack finishes on the next read, so a poll sees it through.
      if (pack.status === 'queued') {
        pack.status = 'done';
        pack.progress = { done: 3, total: 3 };
        pack.bytes = 1_204_551;
      }
      const { createdById: _c, scope: _s, ...out } = pack;
      return out;
    }),
    route('POST', p.claimPackLink(':id'), ({ params, body }) => {
      const pack = h().claimPacks.find(
        (x) => x.id === params.id && x.createdById === state.me.user.id,
      );
      if (!pack) return notFound();
      if (pack.status !== 'done') return err(409, 'conflict', 'The pack is not ready yet.');
      const days = (body as { days?: number } | undefined)?.days ?? 7;
      if (!Number.isInteger(days) || days < 1 || days > 7) return invalid('days: 1 to 7');
      const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
      pack.link = { expiresAt, downloads: 0, lastDownloadedAt: null };
      const origin = typeof location === 'undefined' ? 'http://kept.test' : location.origin;
      recordHouseholdEvent(state, {
        action: 'claim_pack.link',
        entity: { type: 'export_run', id: pack.id },
        locationId: 'locationId' in pack.scope ? pack.scope.locationId : '',
        name: 'claim pack',
      });
      return { url: `${origin}/x/mock-${newId().slice(-12)}`, expiresAt };
    }),
    route('DELETE', p.claimPackLink(':id'), ({ params }) => {
      const pack = h().claimPacks.find(
        (x) => x.id === params.id && x.createdById === state.me.user.id,
      );
      if (!pack?.link) return notFound();
      pack.link = null;
      return reply(204);
    }),
  ];
}
