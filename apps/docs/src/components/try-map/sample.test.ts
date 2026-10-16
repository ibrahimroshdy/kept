import { canCarry, footprintOf, isMapModel, type MapModelKey, rectsOverlap } from '@kept/shared';
import { describe, expect, it } from 'vitest';
import {
  addableOn,
  centreOf,
  holdersFor,
  planOf,
  putOn,
  takeOff,
} from '../../../../web/src/map/layout';
import { sampleHome } from './sample';
import { MODEL_NAMES } from './strings';

const TODAY = new Date(2026, 9, 15);

describe('the Try the map sample home (D241)', () => {
  const en = sampleHome('en', TODAY);
  const ar = sampleHome('ar', TODAY);

  it('is the same home in English and Arabic, with every name translated', () => {
    const shape = (s: typeof en) => ({
      rooms: s.view.rooms.map((r) => [r.id, r.levelId, r.layout]),
      nodes: s.view.nodes.map((n) => [n.id, n.subject, n.parentId, n.layout]),
      things: s.view.things.map((t) => [t.id, t.parentId, t.quantity, t.shortCode]),
      attention: s.view.attention.map((a) => [a.subjectId, a.kind, a.dueOn]),
    });
    expect(shape(ar)).toEqual(shape(en));
    const names = (s: typeof en) => [
      ...s.view.levels.map((l) => l.name),
      ...s.view.rooms.map((r) => r.name),
    ];
    for (const [a, b] of names(en).map((n, i) => [n, names(ar)[i]])) expect(b).not.toBe(a);
    expect(en.view.levels).toHaveLength(3);
    expect(en.view.rooms).toHaveLength(13);
  });

  it('has a short ID on every room and thing, each one different', () => {
    const codes = [
      ...en.view.rooms.map((r) => r.shortCode),
      ...en.view.nodes.map((n) => n.shortCode),
      ...en.view.things.map((t) => t.shortCode),
    ];
    for (const c of codes) expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
    expect(new Set(codes).size).toBe(
      new Set([...en.view.nodes, ...en.view.things].map((x) => x.id)).size + en.view.rooms.length,
    );
  });

  it('keeps rooms apart and everything inside its room, on something that can hold it', () => {
    const rooms = new Map(en.view.rooms.map((r) => [r.id, r]));
    const nodes = new Map(en.view.nodes.map((n) => [n.id, n]));
    for (const level of en.view.levels) {
      const here = en.view.rooms.filter((r) => r.levelId === level.id);
      for (const a of here)
        for (const b of here)
          if (a !== b && a.layout && b.layout) expect(rectsOverlap(a.layout, b.layout)).toBe(false);
    }
    for (const n of en.view.nodes) {
      const room = rooms.get(n.roomId);
      const layout = n.layout;
      expect(room?.layout && layout && isMapModel(layout.model)).toBe(true);
      if (!room?.layout || !layout) continue;
      const model = layout.model as MapModelKey;
      expect(MODEL_NAMES[model]).toBeDefined();
      const f = footprintOf(model, layout.rot);
      expect(layout.x).toBeGreaterThanOrEqual(0);
      expect(layout.z).toBeGreaterThanOrEqual(0);
      expect(layout.x + f.w * 100, n.name).toBeLessThanOrEqual(room.layout.w);
      expect(layout.z + f.d * 100, n.name).toBeLessThanOrEqual(room.layout.d);
      if (layout.hostId) {
        const host = nodes.get(layout.hostId);
        expect(host?.roomId).toBe(n.roomId);
        expect(canCarry(host?.layout?.model as MapModelKey, model)).toBe(true);
      }
    }
  });

  it('is drawn where it was arranged: the map lays nothing out on its own', () => {
    const plan = planOf(en.view, { noFloor: 'Not on a floor', location: en.location });
    expect(plan.levels.map((l) => l.short)).toEqual(['G', 'F', 'R']);
    expect(plan.items).toHaveLength(en.view.nodes.length);
    for (const it of plan.items) {
      const n = en.view.nodes.find((x) => x.id === it.id);
      expect(it.on).toBe(n?.layout?.hostId ?? null);
      expect(Math.round(it.x * 100)).toBe(n?.layout?.x);
    }
    const arPlan = planOf(ar.view, { noFloor: 'ليست على طابق', location: ar.location });
    expect(arPlan.levels.map((l) => l.short)).toEqual(['أ', '1', 'س']);
  });

  it('has a webcam on the monitor’s edge that Put on… and Take off work with (#137)', () => {
    const plan = planOf(en.view, { noFloor: 'Not on a floor', location: en.location });
    const monitor = plan.items.find((i) => i.name === 'Dell monitor');
    const webcam = plan.items.find((i) => i.name === 'HD webcam');
    const desk = plan.items.find((i) => i.id === monitor?.on);
    if (!monitor || !webcam || !desk) throw new Error('no office');
    expect(webcam.on).toBe(monitor.id);
    // On the edge's line: 3 cm in front of the monitor's middle.
    expect(centreOf(webcam).z - centreOf(monitor).z).toBeCloseTo(0.03, 2);
    takeOff(plan.items, plan.rooms, webcam);
    expect(webcam.on).toBeNull();
    expect(holdersFor(plan.items, webcam).map((h) => h.name)).toEqual(
      expect.arrayContaining(['Dell monitor', desk.name]),
    );
    expect(addableOn(plan.items, monitor).map((c) => c.id)).toContain(webcam.id);
    expect(putOn(plan.items, webcam, monitor)).toBe(true);
    expect(webcam.on).toBe(monitor.id);
  });

  it('pins what is low, lent out and due, on things that exist, with dates from today', () => {
    const ids = new Set([...en.view.nodes, ...en.view.things].map((x) => x.id));
    const parents = new Set([...en.view.nodes.map((n) => n.id), ...en.view.rooms.map((r) => r.id)]);
    for (const t of en.view.things) expect(parents.has(t.parentId)).toBe(true);
    for (const a of en.view.attention) {
      expect(ids.has(a.subjectId)).toBe(true);
      if (a.kind === 'low') expect(a.quantity ?? 0).toBeLessThan(a.min ?? 0);
      if (a.dueOn) expect(a.dueOn >= '2026-10-15').toBe(true);
    }
    const kinds = new Set(en.view.attention.map((a) => a.kind));
    expect([...kinds].sort()).toEqual(['due', 'lent', 'low']);
  });
});
