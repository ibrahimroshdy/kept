/**
 * Mock handlers for money (T8): exchange rates per account, pair and date (D76), and dated
 * valuations with the thing's current value (D158). Rates are entered by hand and never
 * estimated (Q22); valuations are gated at serialisation, as purchases are.
 */
import { liveThing, now, versionError } from '../../inventory/mock/db';
import type { MockState } from '../../mock/fixtures';
import { err, type MockRoute, notFound, reply, route } from '../../mock/kit';
import { householdPaths as p } from '../paths';
import type { CreateValuationBody, PutFxRateBody, UpdateValuationBody, Valuation } from '../types';
import { ensureSeeded, gate, gateFor, hh, newId, recordHouseholdEvent, todayIn } from './db';
import type { StoredFxRate, StoredValuation } from './state';

const CCY = /^[A-Z]{3}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL = /^\d+(\.\d+)?$/;

const invalid = (hint: string) => err(400, 'validation', 'The request is not valid.', hint);

export function moneyRoutes(state: MockState): MockRoute[] {
  const h = () => hh(state);
  const me = () => ({ displayName: state.me.user.displayName });
  /** The accounts whose locations you belong to; admins of one of them manage its rates. */
  const accountRole = (accountId: string) => {
    const locs = state.locations.filter((l) => l.ownerAccountId === accountId);
    if (locs.length === 0) return null;
    return locs.some((l) => l.role === 'owner' || l.role === 'admin') ? 'admin' : 'member';
  };

  const valuationView = (v: StoredValuation, locationId: string): Valuation => {
    const { thingId: _t, amount, currency, createdAt: _c, ...own } = v;
    return {
      ...own,
      value: gate(state, locationId, { amount, currency }) ?? { moneyHidden: true },
    };
  };
  const newestFirst = (a: StoredValuation, b: StoredValuation) =>
    b.valuedOn.localeCompare(a.valuedOn) || b.createdAt.localeCompare(a.createdAt);

  return [
    // ----- exchange rates -----
    route('GET', p.fxRates(':accountId'), ({ params, query }) => {
      ensureSeeded(state);
      const accountId = params.accountId ?? '';
      if (!accountRole(accountId)) return notFound();
      const from = query.get('from');
      const to = query.get('to');
      const items = h()
        .fxRates.filter(
          (r) =>
            r.accountId === accountId && (!from || r.fromCcy === from) && (!to || r.toCcy === to),
        )
        .sort(
          (a, b) =>
            a.fromCcy.localeCompare(b.fromCcy) ||
            a.toCcy.localeCompare(b.toCcy) ||
            b.validFrom.localeCompare(a.validFrom),
        )
        .map(({ accountId: _a, ...r }) => r);
      return { items };
    }),
    route('PUT', p.fxRates(':accountId'), ({ params, body, headers }) => {
      const accountId = params.accountId ?? '';
      const role = accountRole(accountId);
      if (!role) return notFound();
      if (role !== 'admin') return err(403, 'forbidden', "You don't have permission.");
      const b = body as PutFxRateBody;
      if (!CCY.test(b.fromCcy) || !CCY.test(b.toCcy) || b.fromCcy === b.toCcy)
        return invalid('fromCcy, toCcy: two different currency codes');
      if (!DECIMAL.test(b.rate) || Number(b.rate) <= 0) return invalid('rate: a decimal above 0');
      if (!DAY.test(b.validFrom)) return invalid('validFrom: a date');
      const same = (r: StoredFxRate) =>
        r.accountId === accountId &&
        r.fromCcy === b.fromCcy &&
        r.toCcy === b.toCcy &&
        r.validFrom === b.validFrom;
      const existing = h().fxRates.find(same);
      if (existing) {
        const stale = versionError(headers, existing, ['rate']);
        if (stale) return reply(stale.status, stale.body);
      }
      const before = existing ? { ...existing } : null;
      const row: StoredFxRate = {
        accountId,
        fromCcy: b.fromCcy,
        toCcy: b.toCcy,
        rate: b.rate,
        validFrom: b.validFrom,
        rowVersion: (existing?.rowVersion ?? 0) + 1,
        updatedBy: me(),
        updatedAt: now(),
      };
      h().fxRates = [...h().fxRates.filter((r) => !same(r)), row];
      recordHouseholdEvent(state, {
        action: 'fx_rate.set',
        entity: { type: 'fx_rate', id: `${b.fromCcy}/${b.toCcy}/${b.validFrom}` },
        locationId: state.locations.find((l) => l.ownerAccountId === accountId)?.id ?? '',
        name: `${b.fromCcy}→${b.toCcy}`,
        undo: () => {
          h().fxRates = [...h().fxRates.filter((r) => !same(r)), ...(before ? [before] : [])];
        },
      });
      const { accountId: _a, ...out } = row;
      return out;
    }),
    route('DELETE', p.fxRate(':accountId', ':from', ':to', ':validFrom'), ({ params, headers }) => {
      const accountId = params.accountId ?? '';
      const role = accountRole(accountId);
      if (!role) return notFound();
      if (role !== 'admin') return err(403, 'forbidden', "You don't have permission.");
      const found = h().fxRates.find(
        (r) =>
          r.accountId === accountId &&
          r.fromCcy === params.from &&
          r.toCcy === params.to &&
          r.validFrom === params.validFrom,
      );
      if (!found) return notFound();
      const stale = versionError(headers, found);
      if (stale) return reply(stale.status, stale.body);
      h().fxRates = h().fxRates.filter((r) => r !== found);
      recordHouseholdEvent(state, {
        action: 'fx_rate.delete',
        entity: { type: 'fx_rate', id: `${found.fromCcy}/${found.toCcy}/${found.validFrom}` },
        locationId: state.locations.find((l) => l.ownerAccountId === accountId)?.id ?? '',
        name: `${found.fromCcy}→${found.toCcy}`,
        undo: () => {
          h().fxRates.push(found);
        },
      });
      return reply(204);
    }),

    // ----- valuations -----
    route('GET', p.thingValuations(':id'), ({ params }) => {
      ensureSeeded(state);
      const t = liveThing(state.inventory, params.id ?? null);
      if (!t) return notFound();
      const gated = gateFor(state, t.locationId, 'money', 'read');
      if (gated) return gated;
      const rows = h()
        .valuations.filter((v) => v.thingId === t.id)
        .sort(newestFirst);
      const items = rows.map((v) => valuationView(v, t.locationId));
      return { items, current: items[0] ?? null };
    }),
    route('POST', p.thingValuations(':id'), ({ params, body }) => {
      const t = liveThing(state.inventory, params.id ?? null);
      if (!t) return notFound();
      const gated = gateFor(state, t.locationId, 'money', 'write');
      if (gated) return gated;
      const b = body as CreateValuationBody;
      if (!DECIMAL.test(b.value)) return invalid('value: a decimal amount');
      if (!CCY.test(b.currency)) return invalid('currency: a currency code');
      if (!DAY.test(b.valuedOn) || b.valuedOn > todayIn(state, t.locationId))
        return invalid('valuedOn: a date, not in the future');
      const row: StoredValuation = {
        id: b.id ?? newId(),
        thingId: t.id,
        amount: b.value,
        currency: b.currency,
        valuedOn: b.valuedOn,
        source: b.source,
        notes: b.notes ?? null,
        documents: [],
        rowVersion: 1,
        createdBy: me(),
        createdAt: now(),
      };
      h().valuations.push(row);
      recordHouseholdEvent(state, {
        action: 'valuation.create',
        entity: { type: 'valuation', id: row.id },
        locationId: t.locationId,
        rootThingId: t.id,
        name: t.name ?? '',
      });
      return reply(201, valuationView(row, t.locationId));
    }),
    route('PATCH', p.valuation(':id'), ({ params, body, headers }) => {
      const v = h().valuations.find((x) => x.id === params.id);
      const t = v ? liveThing(state.inventory, v.thingId) : undefined;
      if (!v || !t) return notFound();
      const gated = gateFor(state, t.locationId, 'money', 'write');
      if (gated) return gated;
      const stale = versionError(headers, v);
      if (stale) return reply(stale.status, stale.body);
      const b = body as UpdateValuationBody;
      const before = { ...v };
      if (b.value !== undefined) v.amount = b.value;
      if (b.currency !== undefined) v.currency = b.currency;
      if (b.valuedOn !== undefined) v.valuedOn = b.valuedOn;
      if (b.source !== undefined) v.source = b.source;
      if (b.notes !== undefined) v.notes = b.notes;
      v.rowVersion += 1;
      recordHouseholdEvent(state, {
        action: 'valuation.update',
        entity: { type: 'valuation', id: v.id },
        locationId: t.locationId,
        rootThingId: t.id,
        name: t.name ?? '',
        undo: () => Object.assign(v, before, { rowVersion: v.rowVersion + 1 }),
      });
      return valuationView(v, t.locationId);
    }),
    route('DELETE', p.valuation(':id'), ({ params, headers }) => {
      const v = h().valuations.find((x) => x.id === params.id);
      const t = v ? liveThing(state.inventory, v.thingId) : undefined;
      if (!v || !t) return notFound();
      const gated = gateFor(state, t.locationId, 'money', 'write');
      if (gated) return gated;
      const stale = versionError(headers, v);
      if (stale) return reply(stale.status, stale.body);
      h().valuations = h().valuations.filter((x) => x !== v);
      recordHouseholdEvent(state, {
        action: 'valuation.delete',
        entity: { type: 'valuation', id: v.id },
        locationId: t.locationId,
        rootThingId: t.id,
        name: t.name ?? '',
        undo: () => {
          h().valuations.push(v);
        },
      });
      return reply(204);
    }),
  ];
}
