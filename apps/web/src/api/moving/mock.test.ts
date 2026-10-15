/**
 * The moving mock answers its contract through the real fetchers (./queries.ts): every path in
 * ./paths.ts has a handler, a box is numbered in its move, a viewer is refused a write, a done
 * move takes no box changes, and unpacking needs a room.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ApiError, isApiError } from '../client';
import { INV_IDS } from '../inventory/mock/fixtures';
import { IDS, type MockState, ownerScenario } from '../mock/fixtures';
import { createMockApi } from '../mock/server';
import { movingMockRoutes } from './mock';
import { MOVING_METHODS, movingPaths } from './paths';
import { movingApi as api } from './queries';

const use = (state: MockState) => {
  for (const l of state.locations) if (l.id === IDS.home) l.modules.push('moving');
  vi.stubGlobal('fetch', createMockApi(state).fetch);
  return state;
};
afterEach(() => vi.unstubAllGlobals());

const fail = async (p: Promise<unknown>) => {
  const e = await p.catch((x: unknown) => x);
  if (!isApiError(e)) throw new Error('expected an ApiError');
  return e as ApiError;
};

describe('the moving mock', () => {
  it('has a handler for every path and method the web calls', () => {
    const routes = movingMockRoutes(ownerScenario());
    const matches = (template: string, path: string) =>
      new RegExp(
        `^${template
          .split('/')
          .map((part) => (part.startsWith('%3A') ? '[^/]+' : part))
          .join('/')}$`,
      ).test(path);
    const missing: string[] = [];
    for (const [key, methods] of Object.entries(MOVING_METHODS)) {
      const v = movingPaths[key as keyof typeof movingPaths] as string | ((id: string) => string);
      const path = typeof v === 'string' ? v : v('a');
      for (const method of methods)
        if (!routes.some((r) => r.method === method && matches(r.template, path)))
          missing.push(`${method} ${path}`);
    }
    expect(missing).toEqual([]);
  });

  it('numbers the boxes, refuses a done move, and needs a room to unpack', async () => {
    use(ownerScenario());
    const move = await api.start(IDS.home, { name: 'Clear-out' });
    const one = await api.addBox(move.id, { new: { prefix: 'Box' } });
    const two = await api.addBox(move.id, {
      new: { prefix: 'Box' },
      destinationPlaceId: INV_IDS.place.kitchen,
    });
    expect([one.number, one.name, two.number, two.destination?.name]).toEqual([
      1,
      'Box 1',
      2,
      'Kitchen',
    ]);
    expect((await fail(api.unpack(move.id, one.containerId))).status).toBe(400);
    const done = await api.update(move.id, { status: 'done' }, move.rowVersion);
    expect(done.status).toBe('done');
    const refused = await fail(api.updateBox(move.id, two.containerId, { state: 'in_transit' }));
    expect(refused.status).toBe(409);
  });

  it('lets a viewer read a move and refuses their writes', async () => {
    const state = use(ownerScenario());
    const move = await api.start(IDS.home, { name: 'Shared' });
    // The same Home, now seen as a viewer.
    for (const l of state.locations) if (l.id === IDS.home) l.role = 'viewer';
    expect((await api.move(move.id)).name).toBe('Shared');
    expect((await fail(api.addBox(move.id, { new: {} }))).status).toBe(403);
  });
});
