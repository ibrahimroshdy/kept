/**
 * The step-2 mock answers the contract's main routes through the real fetchers (queries.ts), so
 * the parallel web tasks start from something that behaves like the server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ApiError, isApiError } from '../../client';
import { memberScenario, ownerScenario } from '../../mock/fixtures';
import { createMockApi, type MockApi } from '../../mock/server';
import { inventoryApi as api } from '../queries';
import type { ConflictDetails, ContentsChoiceDetails } from '../types';
import { INV_IDS } from './fixtures';

let mock: MockApi;
const use = (state = ownerScenario()) => {
  mock = createMockApi(state);
  vi.stubGlobal('fetch', mock.fetch);
};
beforeEach(() => use());
afterEach(() => vi.unstubAllGlobals());

const fail = async (p: Promise<unknown>) => {
  const e = await p.catch((x: unknown) => x);
  if (!isApiError(e)) throw new Error('expected an ApiError');
  return e as ApiError;
};

describe('the inventory mock', () => {
  it('lists things globally across visible locations, with paths, 50 a page', async () => {
    const page = await api.things({ limit: 5 });
    expect(page.items).toHaveLength(5);
    expect(page.next_cursor).not.toBeNull();
    const cable = (await api.things({ q: 'hdmi' })).items.find(
      (t) => t.id === INV_IDS.thing.hdmiCable,
    );
    expect(cable?.path.map((s) => s.name)).toEqual(['Office', 'Desk drawer', 'Cable box']);
    expect(cable?.shortCode).toBe('7KQ4MZ');
  });

  it('search folds Arabic: ال, harakat and ة↔ه (D42)', async () => {
    const names = async (q: string) => (await api.search({ q })).things.items.map((t) => t.name);
    expect(await names('الكابل')).toContain('كابل HDMI');
    expect(await names('hdmi')).toEqual(expect.arrayContaining(['HDMI cable, 2 m', 'كابل HDMI']));
    expect(await names('مكواه')).toContain('مِكْواة البُخار');
    expect(await names('display')).toContain('HDMI cable, 2 m');
    const alias = (await api.search({ q: 'display' })).things.items[0];
    expect(alias?.matchedAlias).toBe('display cable');
    expect((await api.search({ q: 'hmdi' })).didYouMean).toEqual(['HDMI cable, 2 m']);
  });

  it('a member of Home only does not see the Arabic household', async () => {
    use(memberScenario());
    const res = await api.search({ q: 'كابل' });
    expect(res.things.items).toEqual([]);
  });

  it('a short code finds its thing; an unknown one is a plain 404 (D137)', async () => {
    expect(await api.code('7kq4mz')).toEqual({ kind: 'thing', id: INV_IDS.thing.hdmiCable });
    expect((await fail(api.code('ZZZZZZ'))).status).toBe(404);
  });

  it('trashing a container with contents needs a choice (D45)', async () => {
    const e = await fail(api.trashThing(INV_IDS.thing.box3));
    expect(e.status).toBe(409);
    expect((e.details as ContentsChoiceDetails).counts.things).toBe(2);
    const done = await api.trashThing(INV_IDS.thing.box3, { contents: 'trash' });
    expect(done.trashed).toHaveLength(3);
    const trash = await api.trash();
    expect(trash.items.find((i) => i.id === INV_IDS.thing.box3)?.batchSize).toBe(3);
    await api.restoreThing(INV_IDS.thing.box3);
    expect((await api.thing(INV_IDS.thing.scarves)).name).toBe('Winter scarves');
  });

  it('a stale If-Match is a 412 with the conflicting fields and who changed it (D156)', async () => {
    const thing = await api.thing(INV_IDS.thing.tv);
    await api.updateThing(thing.id, { model: 'A' }, thing.rowVersion);
    const e = await fail(api.updateThing(thing.id, { model: 'B' }, thing.rowVersion));
    expect(e.status).toBe(412);
    expect(e.details as ConflictDetails).toMatchObject({
      conflicts: ['model'],
      row_version: thing.rowVersion + 1,
      changedBy: { displayName: 'Alfred' },
    });
  });

  it('place contents: places first, then a page of things', async () => {
    const res = await api.placeContents(INV_IDS.place.office);
    expect(res.places.map((pl) => pl.name)).toEqual(['Desk drawer']);
    expect(res.things.items).toEqual([]);
    const tree = await api.places(INV_IDS.loc.home);
    expect(tree.places[0]?.isUnplaced).toBe(true);
  });

  it('Home counts the attention rows from the data', async () => {
    const home = await api.home();
    // Step 3 (T22): "to review" is the one reading plus the inbox's open items.
    expect(home.counts.inbox).toBeGreaterThan(0);
    expect(home.attention).toMatchObject({
      toReview: 1 + home.counts.inbox,
      uncertain: 1,
      unplaced: 6,
    });
    expect(home.checklist.items.map((i) => i.key)).toContain('invited');
  });
});
