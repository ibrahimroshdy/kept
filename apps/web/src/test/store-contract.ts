/**
 * The `OfflineStore` contract (plan T3): one suite that every implementation passes.
 * offline/store.test.ts runs it on `MemoryStore`; T24 runs it on the Dexie store with
 * fake-indexeddb. Only the interface is used here, never an implementation's helpers.
 */
import {
  legacyCodeKey,
  type SnapLocation,
  type SnapPlace,
  type SnapshotPage,
  type SnapThing,
} from '@kept/shared';
import { describe, expect, it } from 'vitest';
import type { OfflineStore } from '@/offline/store';

const LOC = '01926f00-0000-7000-8000-00000000b002';
const FAMILY = '01926f00-0000-7000-8000-00000000b005';
const GARAGE = '01926f00-0000-7000-8000-0000000c0011';
const SHELF = '01926f00-0000-7000-8000-0000000c0012';
const KITCHEN = '01926f00-0000-7000-8000-0000000c0032';
const DRILL = '01926f00-0000-7000-8000-0000000d0005';
const BOX = '01926f00-0000-7000-8000-0000000d0008';
const CABLE = '01926f00-0000-7000-8000-0000000d0030';
const BATCH = '01926f00-0000-7000-8000-000000100001';

const location = (id: string, name: string, languages: string[]): SnapLocation => ({
  id,
  name,
  kind: 'apartment',
  timezone: 'Africa/Cairo',
  languages,
  role: 'owner',
  effectiveModules: ['labels'],
  unplacedPlaceId: `${id.slice(0, -4)}ffff`,
  suggestRadiusM: 150,
});
const place = (id: string, locationId: string, name: string): SnapPlace => ({
  id,
  locationId,
  parentId: null,
  name,
  kindKey: 'room',
  icon: null,
  isUnplaced: false,
  sort: 0,
  deleted: false,
});
/** A snapshot thing with every field, for tests that need one of their own. */
export const snapThing = (
  id: string,
  locationId: string,
  name: string,
  over: Partial<SnapThing> = {},
): SnapThing => ({
  id,
  locationId,
  shortCode: null,
  name,
  typeId: '',
  placeId: null,
  containerId: null,
  quantity: '1',
  aliases: {},
  lifecycle: 'in_use',
  reviewState: 'confirmed',
  locationUncertain: false,
  lastSeenAt: null,
  coverFileId: null,
  isContainer: false,
  deleted: false,
  ...over,
});

/** A complete first snapshot: Home (English) and بيت العائلة (Arabic). */
export function firstPage(over: Partial<SnapshotPage> = {}): SnapshotPage {
  return {
    asOf: '2026-09-27T11:02:00.000Z',
    payloadVersion: 1,
    minPayloadVersion: 1,
    locations: [location(LOC, 'Home', ['en']), location(FAMILY, 'بيت العائلة', ['ar'])],
    types: { hash: 'h1', items: [] },
    changes: {
      places: [
        place(GARAGE, LOC, 'Garage'),
        place(SHELF, LOC, 'Shelf A'),
        place(KITCHEN, FAMILY, 'المطبخ'),
      ],
      things: [
        snapThing(DRILL, LOC, 'Bosch drill', { placeId: GARAGE, shortCode: '7KQ4MZ' }),
        snapThing(BOX, LOC, 'Box 3', { placeId: GARAGE, shortCode: 'B0X3QF', isContainer: true }),
        snapThing(CABLE, FAMILY, 'الكابل', {
          placeId: KITCHEN,
          aliases: { ar: ['وصلة HDMI'], en: ['display cable'] },
        }),
      ],
      codes: [
        {
          code: '7KQ4MZ',
          locationId: LOC,
          thingId: DRILL,
          placeId: null,
          state: 'assigned',
          isPrimary: true,
        },
        {
          code: 'B7NK4X',
          locationId: LOC,
          thingId: null,
          placeId: null,
          state: 'blank',
          isPrimary: false,
        },
      ],
      legacyCodes: [
        {
          locationId: LOC,
          source: 'homebox',
          sourceCollection: 'main',
          code: '000-001',
          thingId: DRILL,
          placeId: null,
        },
      ],
    },
    removed: [],
    revokedLocationIds: [],
    nextCursor: 'cursor-1',
    complete: true,
    ...over,
  };
}

const capture = (id: string, name?: string) => ({
  clientId: id,
  idempotencyKey: `cap:${id}`,
  op: 'create_thing' as const,
  takenAt: '2026-09-27T11:05:00.000Z',
  locationId: LOC,
  payload: {
    id,
    target: { placeId: SHELF },
    mode: 'thing',
    batchId: BATCH,
    files: [],
    ...(name ? { name } : {}),
  },
});

export function storeContract(name: string, makeStore: () => OfflineStore | Promise<OfflineStore>) {
  describe(`OfflineStore contract: ${name}`, () => {
    it('starts empty, with no cursor', async () => {
      const s = await makeStore();
      expect(await s.cursor()).toBeNull();
      expect(await s.asOf()).toBeNull();
      expect(await s.locations()).toEqual([]);
      expect(await s.counts()).toEqual({ waiting: 0, uploading: 0, needsAttention: 0 });
    });

    it('applies a snapshot page and keeps its cursor and time', async () => {
      const s = await makeStore();
      await s.applySnapshot(firstPage());
      expect(await s.cursor()).toBe('cursor-1');
      expect(await s.asOf()).toBe('2026-09-27T11:02:00.000Z');
      expect((await s.locations()).map((l) => l.name).sort()).toEqual(['Home', 'بيت العائلة']);
      expect((await s.placesOf(LOC)).map((p) => p.name).sort()).toEqual(['Garage', 'Shelf A']);
      expect((await s.contentsOf({ placeId: GARAGE })).map((t) => t.id).sort()).toEqual(
        [DRILL, BOX].sort(),
      );
      expect((await s.thing(DRILL))?.name).toBe('Bosch drill');
    });

    it('resolves codes: assigned, blank, and unknown', async () => {
      const s = await makeStore();
      await s.applySnapshot(firstPage());
      expect(await s.byCode('7KQ4MZ')).toEqual({ kind: 'thing', id: DRILL, locationId: LOC });
      expect(await s.byCode('B7NK4X')).toEqual({ kind: 'blank', locationId: LOC });
      expect(await s.byCode('ZZZZZZ')).toBeUndefined();
      expect(await s.byLegacy('homebox', '000-001')).toEqual([{ locationId: LOC, thingId: DRILL }]);
      expect(await s.byLegacy('csv', '000-001')).toEqual([]);
    });

    it('keeps own codes (D208) and drops one removed by its key', async () => {
      const s = await makeStore();
      const own = {
        locationId: LOC,
        source: 'own',
        sourceCollection: '',
        code: 'GAR-0042',
        thingId: DRILL,
        placeId: null,
      };
      await s.applySnapshot(
        firstPage({
          changes: {
            ...firstPage().changes,
            legacyCodes: [...firstPage().changes.legacyCodes, own],
          },
        }),
      );
      expect(await s.byLegacy('own', 'GAR-0042')).toEqual([{ locationId: LOC, thingId: DRILL }]);
      expect(await s.byLegacy('homebox', 'GAR-0042')).toEqual([]);
      await s.applySnapshot(
        firstPage({
          changes: { places: [], things: [], codes: [], legacyCodes: [] },
          removed: [{ locationId: LOC, entityType: 'legacy_code', entityId: legacyCodeKey(own) }],
          nextCursor: 'cursor-2',
        }),
      );
      expect(await s.byLegacy('own', 'GAR-0042')).toEqual([]);
      expect(await s.byLegacy('homebox', '000-001')).toEqual([{ locationId: LOC, thingId: DRILL }]);
    });

    it('opens a label a Kept import re-issued by its old code, after the short IDs (step-7 T20)', async () => {
      const s = await makeStore();
      const reissued = {
        locationId: LOC,
        source: 'kept',
        sourceCollection: '',
        code: 'QQ7R2M',
        thingId: DRILL,
        placeId: null,
      };
      await s.applySnapshot(
        firstPage({
          changes: {
            ...firstPage().changes,
            legacyCodes: [...firstPage().changes.legacyCodes, reissued],
          },
        }),
      );
      expect(await s.byCode('QQ7R2M')).toEqual({ kind: 'thing', id: DRILL, locationId: LOC });
      // A live short ID wins over an old code.
      expect(await s.byCode('7KQ4MZ')).toEqual({ kind: 'thing', id: DRILL, locationId: LOC });
      expect(await s.byCode('ZZZZZZ')).toBeUndefined();
    });

    it('searches a thing by its legacy and own codes, as online search does (D146, D208)', async () => {
      const s = await makeStore();
      await s.applySnapshot(firstPage());
      const found = async (q: string) => (await s.search(q, 10)).map((t) => t.id);
      // The Homebox label the first page brought.
      expect(await found('000-001')).toEqual([DRILL]);
      // An own code added since: only its code row is sent, never the thing's row again.
      const own = {
        locationId: FAMILY,
        source: 'own',
        sourceCollection: '',
        code: 'FAM-0042',
        thingId: CABLE,
        placeId: null,
      };
      const codesOnly = { places: [], things: [], codes: [], legacyCodes: [] };
      await s.applySnapshot(
        firstPage({ changes: { ...codesOnly, legacyCodes: [own] }, nextCursor: 'cursor-2' }),
      );
      expect(await found('FAM-0042')).toEqual([CABLE]);
      expect(await found('fam-00')).toEqual([CABLE]);
      expect(await found('fam كابل')).toEqual([CABLE]);
      // The thing sent again (renamed) keeps its codes' terms.
      const drill = (await s.thing(DRILL)) as SnapThing;
      await s.applySnapshot(
        firstPage({
          changes: { ...codesOnly, things: [{ ...drill, name: 'Bosch drill 18V' }] },
          nextCursor: 'cursor-3',
        }),
      );
      expect(await found('000-001')).toEqual([DRILL]);
      // A removed code no longer finds it.
      await s.applySnapshot(
        firstPage({
          changes: codesOnly,
          removed: [
            { locationId: FAMILY, entityType: 'legacy_code', entityId: legacyCodeKey(own) },
          ],
          nextCursor: 'cursor-4',
        }),
      );
      expect(await found('FAM-0042')).toEqual([]);
      expect(await found('الكابل')).toEqual([CABLE]);
    });

    it('searches Arabic by its bare form and by an alias (the normalize twin)', async () => {
      const s = await makeStore();
      await s.applySnapshot(firstPage());
      expect((await s.search('كابل', 10)).map((t) => t.id)).toEqual([CABLE]);
      expect((await s.search('display', 10)).map((t) => t.id)).toEqual([CABLE]);
      expect((await s.search('7kq4', 10)).map((t) => t.id)).toEqual([DRILL]);
      expect(await s.search('   ', 10)).toEqual([]);
    });

    it('drops deleted rows, tombstones and revoked locations', async () => {
      const s = await makeStore();
      await s.applySnapshot(firstPage());
      const drill = (await s.thing(DRILL)) as SnapThing;
      await s.applySnapshot(
        firstPage({
          changes: {
            places: [],
            things: [{ ...drill, deleted: true }],
            codes: [],
            legacyCodes: [],
          },
          removed: [{ locationId: LOC, entityType: 'place', entityId: SHELF }],
          revokedLocationIds: [FAMILY],
          locations: [location(LOC, 'Home', ['en'])],
          nextCursor: 'cursor-2',
        }),
      );
      expect(await s.thing(DRILL)).toBeUndefined();
      expect((await s.placesOf(LOC)).map((p) => p.name)).toEqual(['Garage']);
      expect(await s.thing(CABLE)).toBeUndefined();
      expect((await s.locations()).map((l) => l.id)).toEqual([LOC]);
      expect(await s.cursor()).toBe('cursor-2');
    });

    it('a code claimed after the thing was synced shows on the thing, and finds it', async () => {
      const s = await makeStore();
      await s.applySnapshot(firstPage());
      expect((await s.thing(CABLE))?.shortCode).toBeNull();
      // Claiming moves only the codes rows: the things' rows aren't sent again.
      const code = (c: string, thingId: string, locationId: string, isPrimary: boolean) => ({
        code: c,
        locationId,
        thingId,
        placeId: null,
        state: 'assigned' as const,
        isPrimary,
      });
      await s.applySnapshot(
        firstPage({
          changes: {
            places: [],
            things: [],
            codes: [
              code('C4BL3K', CABLE, FAMILY, true),
              code('7KQ4MZ', DRILL, LOC, false),
              code('9RT2WD', DRILL, LOC, true),
            ],
            legacyCodes: [],
          },
          nextCursor: 'cursor-2',
        }),
      );
      expect((await s.thing(CABLE))?.shortCode).toBe('C4BL3K');
      expect((await s.contentsOf({ placeId: KITCHEN })).map((t) => t.shortCode)).toEqual([
        'C4BL3K',
      ]);
      expect((await s.search('c4bl', 10)).map((t) => t.id)).toEqual([CABLE]);
      expect(await s.byCode('C4BL3K')).toEqual({ kind: 'thing', id: CABLE, locationId: FAMILY });
      // A new primary replaces the one the drill's row was sent with.
      expect((await s.thing(DRILL))?.shortCode).toBe('9RT2WD');
      expect((await s.search('9rt2', 10)).map((t) => t.id)).toEqual([DRILL]);
      // Without a code row, the row's own short code stands.
      expect((await s.thing(BOX))?.shortCode).toBe('B0X3QF');
    });

    it("removes a tombstoned row only where it holds it, and that location's codes with it", async () => {
      const s = await makeStore();
      await s.applySnapshot(firstPage());
      const drill = (await s.thing(DRILL)) as SnapThing;
      // The drill moved to بيت العائلة: it arrives there, its code and legacy code with it, and
      // Home's tombstone (the same pass, a later page) must not delete it.
      const legacy = {
        locationId: FAMILY,
        source: 'homebox',
        sourceCollection: 'main',
        code: '000-001',
        thingId: DRILL,
        placeId: null,
      };
      await s.applySnapshot(
        firstPage({
          changes: {
            places: [],
            things: [{ ...drill, locationId: FAMILY, placeId: KITCHEN }],
            codes: [
              {
                code: '7KQ4MZ',
                locationId: FAMILY,
                thingId: DRILL,
                placeId: null,
                state: 'assigned',
                isPrimary: true,
              },
            ],
            legacyCodes: [legacy],
          },
          nextCursor: 'cursor-2',
          complete: false,
        }),
      );
      await s.applySnapshot(
        firstPage({
          changes: { places: [], things: [], codes: [], legacyCodes: [] },
          removed: [{ locationId: LOC, entityType: 'thing', entityId: DRILL }],
          nextCursor: 'cursor-3',
        }),
      );
      expect((await s.thing(DRILL))?.locationId).toBe(FAMILY);
      expect(await s.byCode('7KQ4MZ')).toEqual({ kind: 'thing', id: DRILL, locationId: FAMILY });
      // Home's legacy code for it left with it; the one in بيت العائلة stays.
      expect(await s.byLegacy('homebox', '000-001')).toEqual([
        { locationId: FAMILY, thingId: DRILL },
      ]);

      // Purged from Home: the box goes; so does a legacy code removed by its key.
      await s.applySnapshot(
        firstPage({
          changes: { places: [], things: [], codes: [], legacyCodes: [] },
          removed: [
            { locationId: LOC, entityType: 'thing', entityId: BOX },
            { locationId: FAMILY, entityType: 'legacy_code', entityId: legacyCodeKey(legacy) },
            // A tombstone for a location the row isn't in changes nothing.
            { locationId: LOC, entityType: 'place', entityId: KITCHEN },
          ],
          nextCursor: 'cursor-4',
        }),
      );
      expect(await s.thing(BOX)).toBeUndefined();
      expect(await s.byCode('B0X3QF')).toBeUndefined();
      expect(await s.byLegacy('homebox', '000-001')).toEqual([]);
      expect((await s.placesOf(FAMILY)).map((p) => p.id)).toEqual([KITCHEN]);
    });

    it('queues a capture in order, stamps the versions, and shows it at once as "ID pending"', async () => {
      const s = await makeStore();
      await s.applySnapshot(firstPage());
      const a = '01926f00-0000-7000-8000-00000020000a';
      const b = '01926f00-0000-7000-8000-00000020000b';
      await s.enqueue(capture(a), []);
      await s.enqueue(capture(b, 'Tape measure'), [
        { id: 'f1', kind: 'original', blob: new Blob(['x']), sha256: 'ab' },
      ]);
      const pending = await s.pending();
      expect(pending.map((e) => e.clientId)).toEqual([a, b]);
      expect(pending[0]?.payloadVersion).toBe(1);
      expect(pending[0]?.clientVersion).toBeTruthy();
      expect(pending.every((e) => e.state === 'pending')).toBe(true);
      expect(await s.counts()).toEqual({ waiting: 2, uploading: 0, needsAttention: 0 });

      const shelf = await s.contentsOf({ placeId: SHELF });
      expect(shelf.map((t) => [t.id, t.shortCode, t.reviewState])).toEqual([
        [a, null, 'draft'],
        [b, null, 'confirmed'],
      ]);
      expect((await s.search('tape', 5)).map((t) => t.id)).toEqual([b]);
    });

    it('shows no new thing for "+ photo", a receipt, or a reading capture', async () => {
      const s = await makeStore();
      await s.applySnapshot(firstPage());
      const base = capture('01926f00-0000-7000-8000-00000020001a');
      const variants = [
        { mode: 'thing', attachToThingId: DRILL },
        { mode: 'receipt' },
        { mode: 'receipt', pageOf: '01926f00-0000-7000-8000-00000020001b' },
        { mode: 'reading' },
      ];
      for (const [i, v] of variants.entries()) {
        const id = `01926f00-0000-7000-8000-0000002001${String(i).padStart(2, '0')}`;
        await s.enqueue(
          {
            ...base,
            clientId: id,
            idempotencyKey: `cap:${id}`,
            payload: { ...base.payload, id, ...v },
          },
          [],
        );
      }
      expect(await s.pending()).toHaveLength(4);
      expect(await s.contentsOf({ placeId: SHELF })).toEqual([]);
    });

    it('takes back ops the server has never seen, with their files ("Undo this batch")', async () => {
      const s = await makeStore();
      const a = '01926f00-0000-7000-8000-00000020002a';
      const b = '01926f00-0000-7000-8000-00000020002b';
      await s.enqueue(capture(a), [
        { id: 'fa', kind: 'original', blob: new Blob(['a']), sha256: 'aa' },
      ]);
      await s.enqueue(capture(b), []);
      expect(await s.unqueue([`cap:${a}`, 'cap:unknown'])).toEqual([`cap:${a}`]);
      expect((await s.pending()).map((e) => e.clientId)).toEqual([b]);
      expect(await s.counts()).toEqual({ waiting: 1, uploading: 0, needsAttention: 0 });
      expect(await s.unqueue([`cap:${a}`])).toEqual([]);
    });

    it('queues an op once per idempotency key', async () => {
      const s = await makeStore();
      const a = '01926f00-0000-7000-8000-00000020000c';
      await s.enqueue(capture(a), []);
      await s.enqueue(capture(a), []);
      expect(await s.pending()).toHaveLength(1);
    });

    it('lists the live things with a meter in the locations asked, with their meters', async () => {
      const s = await makeStore();
      const odometer = { id: 'm-1', kind: 'distance', unit: 'km', label: null };
      const hours = { id: 'm-2', kind: 'hours', unit: 'h', label: 'Motor' };
      const page = firstPage();
      await s.applySnapshot({
        ...page,
        changes: {
          ...page.changes,
          things: [
            ...page.changes.things.map((t) => (t.id === DRILL ? { ...t, meters: [hours] } : t)),
            snapThing('01926f00-0000-7000-8000-0000000d0041', FAMILY, 'السيارة', {
              meters: [odometer],
            }),
            snapThing('01926f00-0000-7000-8000-0000000d0042', LOC, 'Old mower', {
              meters: [hours],
              deleted: true,
            }),
          ],
        },
      });
      const here = await s.metered([LOC]);
      expect(here.map((t) => [t.id, t.meters])).toEqual([[DRILL, [hours]]]);
      expect((await s.metered([LOC, FAMILY])).map((t) => t.name).sort()).toEqual([
        'Bosch drill',
        'السيارة',
      ]);
      expect(await s.metered([])).toEqual([]);
    });

    it('shows a queued move in the new place before it syncs', async () => {
      const s = await makeStore();
      await s.applySnapshot(firstPage());
      await s.enqueue(
        {
          clientId: '01926f00-0000-7000-8000-00000020000d',
          idempotencyKey: 'move:1',
          op: 'move',
          takenAt: '2026-09-27T11:06:00.000Z',
          locationId: LOC,
          payload: { thingIds: [DRILL], to: { containerId: BOX } },
        },
        [],
      );
      expect((await s.contentsOf({ containerId: BOX })).map((t) => t.id)).toEqual([DRILL]);
      expect((await s.contentsOf({ placeId: GARAGE })).map((t) => t.id)).toEqual([BOX]);
    });

    it('keeps the carrying tray, without duplicates', async () => {
      const s = await makeStore();
      await s.setTray([DRILL, BOX, DRILL]);
      expect(await s.tray()).toEqual([DRILL, BOX]);
      await s.setTray([]);
      expect(await s.tray()).toEqual([]);
    });

    it('keeps a share until it is dropped, blobs intact (D140)', async () => {
      const s = await makeStore();
      const share = {
        id: 'share-1',
        at: '2026-09-27T11:07:00.000Z',
        title: 'Receipt',
        text: null,
        files: [
          { name: 'receipt.pdf', type: 'application/pdf', blob: new Blob(['%PDF-1.7']) },
          { name: 'photo.jpg', type: 'image/jpeg', blob: new Blob(['jpeg']) },
        ],
      };
      await s.putShared(share);
      const got = await s.shared('share-1');
      expect(got?.title).toBe('Receipt');
      expect(got?.files.map((f) => [f.name, f.type])).toEqual([
        ['receipt.pdf', 'application/pdf'],
        ['photo.jpg', 'image/jpeg'],
      ]);
      expect(await got?.files[0]?.blob.text()).toBe('%PDF-1.7');
      expect(await s.shared('share-2')).toBeUndefined();
      await s.dropShared('share-1');
      expect(await s.shared('share-1')).toBeUndefined();
    });

    it('wipes everything', async () => {
      const s = await makeStore();
      await s.applySnapshot(firstPage());
      await s.enqueue(capture('01926f00-0000-7000-8000-00000020000e'), []);
      await s.setTray([DRILL]);
      await s.putShared({
        id: 'share-w',
        at: '2026-09-27T11:08:00.000Z',
        title: null,
        text: null,
        files: [],
      });
      await s.wipe();
      expect(await s.cursor()).toBeNull();
      expect(await s.locations()).toEqual([]);
      expect(await s.pending()).toEqual([]);
      expect(await s.tray()).toEqual([]);
      expect(await s.notices()).toEqual([]);
      expect(await s.byCode('7KQ4MZ')).toBeUndefined();
      expect(await s.shared('share-w')).toBeUndefined();
    });
  });
}
