/**
 * Mock handlers for consumables (T17; D14, D183; Q19), module `consumables`. "Keep at least N" on
 * a thing whose type is consumable (inherited), the low-stock list (low first, then by name), and
 * Adjust by a delta or to a quantity, never below 0. A rule and an adjust are undoable (D150).
 * The fixtures turn the module on in Home (T23), where the AA batteries are low.
 */
import { isLow, STOCK_MIN_MAX } from '@kept/shared';
import { gateFor, householdRowOf } from '../../household/mock/db';
import {
  liveThing,
  now,
  paginate,
  recordEvent,
  type StoredThing,
  versionError,
} from '../../inventory/mock/db';
import type { MockState } from '../../mock/fixtures';
import { err, type MockRoute, notFound, reply, route } from '../../mock/kit';
import { portabilityPaths as p } from '../paths';
import type { AdjustBody, ConsumableRow, PutStockRuleBody, StockRule } from '../types';
import { pt } from './state';

const MODULE = 'consumables' as const;

export function consumableRoutes(state: MockState): MockRoute[] {
  const s = () => pt(state);
  const inv = () => state.inventory;
  const me = () => ({ id: state.me.user.id, displayName: state.me.user.displayName });
  const consumable = (t: StoredThing) =>
    !!t.type &&
    !!inv()
      .types.find((y) => y.id === t.type?.id)
      ?.resolvedCapabilities.includes('consumable');
  const ruleOf = (thingId: string) => s().stockRules.find((r) => r.thingId === thingId);

  return [
    route('GET', p.consumables, ({ query }) => {
      const locationId = query.get('locationId') ?? '';
      const gate = gateFor(state, locationId, MODULE, 'read');
      if (gate) return gate;
      const placeId = query.get('placeId');
      const lowOnly = query.get('state') === 'low';
      const rows: ConsumableRow[] = [];
      for (const rule of s().stockRules) {
        const t = liveThing(inv(), rule.thingId);
        if (!t || t.locationId !== locationId) continue;
        if (placeId && t.placeId !== placeId) continue;
        const low = isLow(t.quantity, rule.minQuantity);
        if (lowOnly && !low) continue;
        rows.push({ thing: householdRowOf(state, t), minQuantity: rule.minQuantity, low });
      }
      rows.sort(
        (a, b) =>
          Number(b.low) - Number(a.low) || (a.thing.name ?? '').localeCompare(b.thing.name ?? ''),
      );
      return paginate(rows, query);
    }),

    route('GET', p.thingStockRule(':id'), ({ params }) => {
      const t = liveThing(inv(), params.id ?? null);
      if (!t) return notFound();
      const gate = gateFor(state, t.locationId, MODULE, 'read');
      if (gate) return gate;
      return ruleOf(t.id) ?? notFound();
    }),

    route('PUT', p.thingStockRule(':id'), ({ params, body, headers }) => {
      const t = liveThing(inv(), params.id ?? null);
      if (!t) return notFound();
      const gate = gateFor(state, t.locationId, MODULE, 'write');
      if (gate) return gate;
      if (!consumable(t))
        return err(409, 'not_consumable', 'Only things you run out of can have a minimum.');
      const min = (body as PutStockRuleBody).minQuantity;
      if (!(typeof min === 'number' && min > 0 && min <= STOCK_MIN_MAX))
        return err(400, 'validation', 'Check body.minQuantity.');
      const rule = ruleOf(t.id);
      if (rule) {
        const stale = versionError(headers, rule);
        if (stale) return reply(stale.status, stale.body);
      }
      const before = rule ? { ...rule } : null;
      const next: StockRule = rule ?? {
        thingId: t.id,
        locationId: t.locationId,
        minQuantity: min,
        updatedAt: now(),
        rowVersion: 0,
      };
      next.minQuantity = min;
      next.updatedAt = now();
      next.rowVersion += 1;
      if (!rule) s().stockRules.push(next);
      recordEvent(inv(), me(), {
        action: 'thing.stock_rule',
        entity: { type: 'thing', id: t.id },
        locationId: t.locationId,
        name: t.name ?? '',
        diff: {
          minQuantity: { before: before?.minQuantity ?? null, after: min, class: 'plain' },
        },
        undo: () => {
          if (before) Object.assign(next, before, { rowVersion: next.rowVersion + 1 });
          else s().stockRules = s().stockRules.filter((r) => r !== next);
        },
      });
      return next;
    }),

    route('DELETE', p.thingStockRule(':id'), ({ params, headers }) => {
      const t = liveThing(inv(), params.id ?? null);
      if (!t) return notFound();
      const gate = gateFor(state, t.locationId, MODULE, 'write');
      if (gate) return gate;
      const rule = ruleOf(t.id);
      if (!rule) return notFound();
      const stale = versionError(headers, rule);
      if (stale) return reply(stale.status, stale.body);
      s().stockRules = s().stockRules.filter((r) => r !== rule);
      recordEvent(inv(), me(), {
        action: 'thing.stock_rule',
        entity: { type: 'thing', id: t.id },
        locationId: t.locationId,
        name: t.name ?? '',
        diff: { minQuantity: { before: rule.minQuantity, after: null, class: 'plain' } },
        undo: () => {
          s().stockRules.push({ ...rule, rowVersion: rule.rowVersion + 1 });
        },
      });
      return reply(204);
    }),

    route('POST', p.thingAdjust(':id'), ({ params, body, headers }) => {
      const t = liveThing(inv(), params.id ?? null);
      if (!t) return notFound();
      const gate = gateFor(state, t.locationId, MODULE, 'write');
      if (gate) return gate;
      const stale = versionError(headers, t, ['quantity']);
      if (stale) return reply(stale.status, stale.body);
      const b = body as AdjustBody;
      const quantity = 'delta' in b ? t.quantity + b.delta : b.quantity;
      if (!Number.isFinite(quantity) || quantity < 0)
        return err(400, 'validation', "The quantity can't go below 0.");
      const before = t.quantity;
      recordEvent(inv(), me(), {
        action: 'thing.update',
        entity: { type: 'thing', id: t.id },
        locationId: t.locationId,
        name: t.name ?? '',
        diff: { quantity: { before, after: quantity, class: 'plain' } },
        undo: () => {
          t.quantity = before;
          t.rowVersion += 1;
        },
      });
      t.quantity = quantity;
      t.rowVersion += 1;
      return householdRowOf(state, t);
    }),
  ];
}
