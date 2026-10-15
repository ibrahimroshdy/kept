/**
 * Try Kept (D246) walks the demo household's every link: each short code is one the server could
 * issue (the scan resolver refuses any other, so a link to it opened "This isn't here any more"),
 * and what Insights names is in the inventory.
 */
import { SHORT_CODE } from '@kept/shared';
import { describe, expect, it } from 'vitest';
import { ensureSeeded } from '@/api/household/mock/db';
import { insightsOf } from '@/api/insights/mock';
import { ownerScenario } from '@/api/mock/fixtures';
import { ensureVehiclesSeeded } from '@/api/vehicles/mock/state';

function household() {
  const state = ownerScenario();
  ensureSeeded(state);
  ensureVehiclesSeeded(state);
  return state;
}

describe('the demo household', () => {
  it('has only short codes the server could issue', () => {
    const state = household();
    const codes = [
      ...state.inventory.things.map((t) => t.shortCode),
      ...state.inventory.places.map((p) => p.shortCode),
    ].filter((c): c is string => !!c);
    expect(codes.length).toBeGreaterThan(10);
    expect(codes.filter((c) => !SHORT_CODE.test(c))).toEqual([]);
  });

  it('links Insights to things and places that exist', () => {
    const state = household();
    const insights = insightsOf(state, []);
    const things = new Map(state.inventory.things.map((t) => [t.id, t]));
    const places = new Map(state.inventory.places.map((p) => [p.id, p]));
    const named = [
      ...(insights.vehicles?.items ?? []),
      ...(insights.warranties?.expiringSoon ?? []),
    ];
    expect(named.length).toBeGreaterThan(0);
    for (const item of named) {
      expect(things.has(item.id), item.name ?? item.id).toBe(true);
      expect(item.shortCode ?? null).toBe(things.get(item.id)?.shortCode ?? null);
    }
    const valued = insights.value.locations.flatMap((l) => l.places ?? []);
    expect(valued.length).toBeGreaterThan(0);
    for (const place of valued) {
      const id = place.id ?? '';
      expect(places.has(id), place.name ?? id).toBe(true);
      expect(place.shortCode ?? null).toBe(places.get(id)?.shortCode ?? null);
    }
  });
});
