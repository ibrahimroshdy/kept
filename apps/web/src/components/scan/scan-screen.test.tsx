/**
 * Scan, the carrying tray and the box check (plan T26's test list): every outcome online and its
 * offline variant, the same "Not in your Kept" for a server miss and for an offline miss checked
 * once online, the claim race naming the other box, the tray surviving a reload, the box check's
 * "found 2 of 3" split preview, "Type the code" by keyboard, and the code left to right in Arabic.
 *
 * The camera is a fake stream and the decode loop is replaced: the test feeds what "the scanner
 * read" (scanner.decode.test.ts runs the real wasm on images). The server is the step-3 mock; the
 * phone's store is the real `MemoryStore`.
 */
import type { SnapLocation, SnapPlace, SnapshotPage, SnapThing } from '@kept/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BLANK_CODES, HOMEBOX_ASSET } from '@/api/capture/mock/state';
import { INV_IDS } from '@/api/inventory/mock/fixtures';
import { type MockState, ownerScenario } from '@/api/mock/fixtures';
import { createMockApi, type MockApi } from '@/api/mock/server';
import type { Detected } from '@/camera/label-recogniser';
import type { CameraEnv } from '@/camera/session';
import { BoxCheckScreen } from '@/components/boxcheck/box-check-screen';
import { pickUp } from '@/components/tray/use-tray';
import { toastQueue } from '@/components/ui/toast';
import { MemoryStore } from '@/offline/store';
import { expectLogicalOnly, renderUI } from '@/test/render';
import { ScanScreen, type ScanScreenProps } from './scan-screen';

const feed = vi.hoisted(() => ({ current: null as ((found: Detected[]) => void) | null }));
vi.mock('@/camera/scanner', () => ({
  appDetect: () => async () => [],
  buzz: () => {},
  startScanLoop: (_video: unknown, _detect: unknown, onRead: (found: Detected[]) => void) => {
    feed.current = onRead;
    return () => {
      if (feed.current === onRead) feed.current = null;
    };
  },
}));

const L = INV_IDS.loc;
const T = INV_IDS.thing;
const P = INV_IDS.place;

// The phone's own snapshot, for the offline tests (ids of its own; the server never sees them).
const HOME = '01926f00-0000-7000-8000-00000000e001';
const UNPLACED = '01926f00-0000-7000-8000-00000000e0ff';
const SHELF = '01926f00-0000-7000-8000-00000000e011';
const DRILL = '01926f00-0000-7000-8000-00000000e021';
const BOX = '01926f00-0000-7000-8000-00000000e022';
const CABLE = '01926f00-0000-7000-8000-00000000e023';
const CHARGER = '01926f00-0000-7000-8000-00000000e024';
const POUCH = '01926f00-0000-7000-8000-00000000e025';
const ADAPTER = '01926f00-0000-7000-8000-00000000e026';

const loc = (id: string, name: string, unplacedPlaceId: string): SnapLocation => ({
  id,
  name,
  kind: 'apartment',
  timezone: 'Africa/Cairo',
  languages: ['en'],
  role: 'owner',
  effectiveModules: ['labels'],
  unplacedPlaceId,
  suggestRadiusM: 150,
});
const place = (id: string, locationId: string, name: string, isUnplaced = false): SnapPlace => ({
  id,
  locationId,
  parentId: null,
  name,
  kindKey: isUnplaced ? 'unplaced' : 'zone',
  icon: null,
  isUnplaced,
  sort: isUnplaced ? 0 : 1,
  deleted: false,
});
const thing = (id: string, name: string, over: Partial<SnapThing> = {}): SnapThing => ({
  id,
  locationId: HOME,
  shortCode: null,
  name,
  typeId: '',
  placeId: SHELF,
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
const code = (c: string, over: { thingId?: string; placeId?: string; blank?: boolean }) => ({
  code: c,
  locationId: HOME,
  thingId: over.thingId ?? null,
  placeId: over.placeId ?? null,
  state: over.blank ? ('blank' as const) : ('assigned' as const),
  isPrimary: !over.blank,
});

/** The phone's copy: Home with Shelf A, a drill, a box of cables, and a blank label. */
async function phone(role: SnapLocation['role'] = 'owner') {
  const store = new MemoryStore();
  const page: SnapshotPage = {
    asOf: '2026-09-27T11:02:00.000Z',
    payloadVersion: 1,
    minPayloadVersion: 1,
    locations: [{ ...loc(HOME, 'Home', UNPLACED), role }],
    types: { hash: 'h', items: [] },
    changes: {
      places: [place(UNPLACED, HOME, '', true), place(SHELF, HOME, 'Shelf A')],
      things: [
        thing(DRILL, 'Bosch drill', { shortCode: '7KQ4MZ' }),
        thing(BOX, 'Cable box', { shortCode: 'B0X3QF', isContainer: true }),
        thing(CABLE, 'HDMI cable', {
          shortCode: '7KQ4MA',
          containerId: BOX,
          placeId: null,
          quantity: '3',
        }),
        thing(CHARGER, 'USB-C charger', { shortCode: '3YC8MP', containerId: BOX, placeId: null }),
        thing(POUCH, 'Adapter pouch', { containerId: BOX, placeId: null, isContainer: true }),
        thing(ADAPTER, 'Travel adapter', { containerId: POUCH, placeId: null }),
      ],
      codes: [
        code('7KQ4MZ', { thingId: DRILL }),
        code('5HE1FA', { placeId: SHELF }),
        code('B7NK4X', { blank: true }),
      ],
      legacyCodes: [],
    },
    removed: [],
    revokedLocationIds: [],
    nextCursor: 'c1',
    complete: true,
  };
  await store.applySnapshot(page);
  return store;
}

/** The server's Home, on the phone: its Unplaced area, for "New box here" and "Add". */
async function serverHomeOnPhone() {
  const store = new MemoryStore();
  await store.applySnapshot({
    asOf: '2026-09-27T11:02:00.000Z',
    payloadVersion: 1,
    minPayloadVersion: 1,
    locations: [loc(L.home, 'Home', P.homeUnplaced)],
    types: { hash: 'h', items: [] },
    changes: {
      places: [
        place(P.homeUnplaced, L.home, '', true),
        place(P.hallwayCloset, L.home, 'Hallway closet'),
      ],
      things: [],
      codes: [],
      legacyCodes: [],
    },
    removed: [],
    revokedLocationIds: [],
    nextCursor: 'c1',
    complete: true,
  });
  return store;
}

const liveCamera: CameraEnv = {
  secure: true,
  media: { getUserMedia: vi.fn(async () => ({ getTracks: () => [] }) as unknown as MediaStream) },
};

let mock: MockApi;
function server(state: MockState = ownerScenario()) {
  mock = createMockApi(state);
  vi.stubGlobal('fetch', mock.fetch);
  return mock;
}

beforeEach(() => {
  HTMLMediaElement.prototype.play = vi.fn(async () => {});
  server();
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  feed.current = null;
  for (const t of toastQueue.visibleToasts) toastQueue.close(t.key);
});

async function render(ui: ReactElement, locale: 'en' | 'ar' = 'en') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderUI(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>, { locale });
}

async function renderScan(props: Partial<ScanScreenProps> = {}, locale: 'en' | 'ar' = 'en') {
  const store = props.store ?? new MemoryStore();
  const onOpen = vi.fn();
  const onExit = vi.fn();
  const r = await render(
    <ScanScreen
      store={store}
      onOpen={onOpen}
      onExit={onExit}
      online
      camera={liveCamera}
      {...props}
    />,
    locale,
  );
  return { ...r, store, onOpen, onExit };
}

/** What the scanner "read". */
async function scan(rawValue: string, format = 'qr_code') {
  await waitFor(() => expect(feed.current).not.toBeNull());
  await act(async () => feed.current?.([{ rawValue, format }]));
}

const pendingOps = async (store: MemoryStore) => (await store.pending()).map((e) => e.op);

describe('scan outcomes, online', () => {
  it('a Kept label you can see opens at once, from any host, and is marked seen (D40, D120)', async () => {
    const { onOpen } = await renderScan();
    await scan('https://old.example/l/B0X3QF');
    await waitFor(() =>
      expect(onOpen).toHaveBeenCalledWith({ kind: 'thing', id: T.cableBox, locationId: L.home }),
    );
    await waitFor(() =>
      expect(mock.lastCall('POST', `/api/v1/things/${T.cableBox}/seen`)).toBeTruthy(),
    );
  });

  it('Type the code keeps the sheet open until the lookup answers: closing first lets its history entry pop mid-navigation and derail it', async () => {
    const { user, onOpen } = await renderScan();
    // A slow server resolve, so the lookup is still in flight after Find.
    const realFetch = mock.fetch;
    vi.stubGlobal('fetch', (async (...args: [RequestInfo | URL, RequestInit?]) => {
      const raw = args[0];
      const url = new URL(
        typeof raw === 'string' ? raw : raw instanceof URL ? raw.href : raw.url,
        'http://kept.test',
      );
      if (url.pathname === '/api/v1/scan/resolve') await new Promise((r) => setTimeout(r, 250));
      return (realFetch as typeof fetch)(...args);
    }) as typeof fetch);
    await user.click(screen.getByRole('button', { name: 'Type the code' }));
    await user.type(screen.getByRole('textbox', { name: 'Code on the label' }), 'B0X3QF');
    await user.click(screen.getByRole('button', { name: 'Find' }));
    // Still looking: the sheet stays open.
    expect(screen.getByRole('textbox', { name: 'Code on the label' })).toBeInTheDocument();
    await waitFor(() =>
      expect(onOpen).toHaveBeenCalledWith({ kind: 'thing', id: T.cableBox, locationId: L.home }),
    );
    // Answered: the sheet is gone.
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: 'Code on the label' })).toBeNull(),
    );
  });

  it('"Not in your Kept" answers a code the server will not show, and never says why', async () => {
    const { user, onExit } = await renderScan();
    await scan('https://kept.example/l/ZZZZZZ');
    const sheet = await screen.findByRole('region', { name: 'Scan result' });
    expect(within(sheet).getByRole('heading', { name: 'Not in your Kept' })).toBeInTheDocument();
    expect(
      within(sheet).getByText('Nothing in the locations you belong to has this label.'),
    ).toBeInTheDocument();
    expect(within(sheet).getByRole('img', { name: 'ZZZZZZ' })).toBeInTheDocument();
    await user.click(within(sheet).getByRole('button', { name: 'Done' }));
    expect(onExit).toHaveBeenCalled();
  });

  it('a blank label is claimed as a new box here, and opens it', async () => {
    const store = await serverHomeOnPhone();
    const { user, onOpen } = await renderScan({ store });
    await scan(BLANK_CODES[0]);
    expect(await screen.findByRole('heading', { name: 'Claim this label' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /New box here/ }));
    await user.type(await screen.findByRole('textbox', { name: 'Name' }), 'Camping box');
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Unplaced' })).toBeChecked());
    await user.click(screen.getByRole('radio', { name: 'Hallway closet' }));
    await user.click(screen.getByRole('button', { name: 'Claim' }));
    await waitFor(() => expect(onOpen).toHaveBeenCalled());
    const [target] = onOpen.mock.calls[0] as [{ id: string }];
    expect(mock.state.inventory.things.find((t) => t.id === target.id)).toMatchObject({
      name: 'Camping box',
      placeId: P.hallwayCloset,
      shortCode: BLANK_CODES[0],
      isContainer: true,
    });
  });

  it('a claim another phone won first names the other box (D112)', async () => {
    const store = await serverHomeOnPhone();
    const { user, onOpen } = await renderScan({ store });
    await scan(BLANK_CODES[1]);
    await user.click(await screen.findByRole('button', { name: /New box here/ }));
    await user.type(await screen.findByRole('textbox', { name: 'Name' }), 'Tools');
    // Meanwhile, on another phone:
    const c = mock.state.capture.codes.find((x) => x.code === BLANK_CODES[1]);
    if (!c) throw new Error('fixture');
    c.state = 'assigned';
    c.target = { kind: 'thing', id: T.box3, name: 'Camping box' };
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Unplaced' })).toBeChecked());
    await user.click(screen.getByRole('button', { name: 'Claim' }));
    expect(
      await screen.findByText(
        (_, el) =>
          el?.tagName === 'P' &&
          el.textContent === 'This label was claimed on another phone for “Camping box”.',
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open that box' }));
    expect(onOpen).toHaveBeenCalledWith({ kind: 'thing', id: T.box3, locationId: L.home });
  });

  it('an old Homebox label says what it was (and marks it seen); a shared asset ID asks which (D146)', async () => {
    const { user, onOpen } = await renderScan();
    await scan(`http://homebox.lan/a/${HOMEBOX_ASSET.unique}`);
    expect(await screen.findByText('Old Homebox label')).toBeInTheDocument();
    expect(await screen.findByText('Seen just now')).toBeInTheDocument();
    expect(mock.lastCall('POST', `/api/v1/things/${T.drill}/seen`)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Scan again' }));

    await scan(`http://homebox.lan/a/${HOMEBOX_ASSET.ambiguous}`);
    expect(await screen.findByRole('heading', { name: 'Which one is it?' })).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Things with this label' });
    expect(within(list).getAllByRole('button')).toHaveLength(2);
    await user.click(within(list).getByRole('button', { name: /Box 3/ }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ kind: 'thing', id: T.box3 }));
  });

  it('a product barcode is added as a new thing, named by the lookup when it is on (D126)', async () => {
    const state = ownerScenario();
    state.capture.barcodeLookup = true;
    server(state);
    const store = await serverHomeOnPhone();
    const { user } = await renderScan({ store });
    await scan('4006381333931', 'ean_13');
    expect(await screen.findByRole('heading', { name: 'Stabilo Textmarker' })).toBeInTheDocument();
    expect(screen.getByText('From Open Food Facts (ODbL)')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add as a new thing' }));
    expect(await screen.findByRole('textbox', { name: /Name/ })).toHaveValue('Stabilo Textmarker');
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Unplaced' })).toBeChecked());
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(async () => expect(await pendingOps(store)).toEqual(['create_thing']));
    const [op] = await store.pending();
    expect(op?.payload).toMatchObject({
      name: 'Stabilo Textmarker',
      barcode: '4006381333931',
      mode: 'thing',
      target: { placeId: P.homeUnplaced },
      files: [],
    });
  });

  it('with the lookup off, a barcode is simply "Add as a new thing"', async () => {
    await renderScan();
    await scan('4006381333931', 'ean_13');
    expect(await screen.findByRole('heading', { name: 'A product barcode' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add as a new thing' })).toBeInTheDocument();
    expect(mock.calls.some((c) => c.path.startsWith('/api/v1/barcodes/'))).toBe(false);
  });

  it('any other code is "Not a Kept label", its text shown and never a link (D137 case 5)', async () => {
    await renderScan();
    await scan('https://example.com/promo?x=1');
    expect(await screen.findByRole('heading', { name: 'Not a Kept label' })).toBeInTheDocument();
    expect(screen.getByText('https://example.com/promo?x=1')).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('scan outcomes, offline', () => {
  it('a label on this phone opens and queues "mark seen"', async () => {
    const store = await phone();
    const { onOpen } = await renderScan({ store, online: false });
    await scan('7KQ4MZ');
    await waitFor(() =>
      expect(onOpen).toHaveBeenCalledWith({ kind: 'thing', id: DRILL, locationId: HOME }),
    );
    await waitFor(async () => expect(await pendingOps(store)).toEqual(['mark_seen']));
    expect((await store.pending())[0]?.payload).toEqual({ thingId: DRILL });
    expect(mock.calls).toHaveLength(0);
  });

  it("a viewer's scan opens the thing and marks nothing seen, online or off", async () => {
    for (const online of [false, true]) {
      const store = await phone('viewer');
      const view = await renderScan({ store, online });
      await scan('7KQ4MZ');
      await waitFor(() =>
        expect(view.onOpen).toHaveBeenCalledWith({ kind: 'thing', id: DRILL, locationId: HOME }),
      );
      expect(await pendingOps(store)).toEqual([]);
      expect(mock.calls.filter((c) => c.path.endsWith('/seen'))).toEqual([]);
      view.unmount();
    }
  });

  it('a blank label on this phone is claimed offline, pending until it syncs', async () => {
    const store = await phone();
    const { user } = await renderScan({ store, online: false });
    await scan('B7NK4X');
    await user.click(await screen.findByRole('button', { name: /Attach to an existing thing/ }));
    await user.type(await screen.findByRole('searchbox', { name: 'Search' }), 'drill');
    await user.click(await screen.findByRole('button', { name: /Bosch drill/ }));
    await waitFor(async () => expect(await pendingOps(store)).toEqual(['claim_label']));
    expect((await store.pending())[0]?.payload).toEqual({
      code: 'B7NK4X',
      target: { thingId: DRILL },
    });
    expect(mock.calls).toHaveLength(0);
  });

  it('a code not on this phone waits, then gets the same "Not in your Kept" once online', async () => {
    const store = await phone();
    const first = await renderScan({ store, online: false });
    await scan('ZZZZZZ');
    expect(await screen.findByRole('heading', { name: 'Not on this phone' })).toBeInTheDocument();
    expect(screen.getByText("It will check when you're online.")).toBeInTheDocument();
    expect((await store.notices()).map((n) => [n.kind, n.code])).toEqual([
      ['scan_pending', 'ZZZZZZ'],
    ]);
    first.unmount();

    const { user } = await renderScan({ store, online: true });
    expect(await screen.findByText('1 scan from while you were offline')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByRole('heading', { name: 'Not in your Kept' })).toBeInTheDocument();
    expect(
      screen.getByText('Nothing in the locations you belong to has this label.'),
    ).toBeInTheDocument();
    expect(await store.notices()).toEqual([]);
  });
});

describe('the carrying tray', () => {
  it('picks up by scanning, and the tray survives a reload (MemoryStore)', async () => {
    const store = await phone();
    const first = await renderScan({ store, online: false, tray: true });
    expect(await screen.findByRole('heading', { name: 'Scan to pick up' })).toBeInTheDocument();
    await scan('7KQ4MZ');
    const { user } = first;
    await user.click(await screen.findByRole('button', { name: 'Pick it up' }));
    expect(await screen.findByRole('button', { name: 'Carrying 1' })).toBeInTheDocument();
    first.unmount();

    await renderScan({ store, online: false, tray: true });
    expect(await screen.findByRole('heading', { name: 'Scan destination' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Carrying 1' })).toBeInTheDocument();
    expect(await store.tray()).toEqual([DRILL]);
  });

  it('scanning the destination moves everything in one queued op offline, then lands there', async () => {
    const store = await phone();
    await pickUp(store, [DRILL, CHARGER]);
    const { user, onOpen } = await renderScan({ store, online: false, tray: true });
    await scan('5HE1FA');
    expect(await screen.findByText("Put the 2 things you're carrying here?")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Move 2 here' }));
    await waitFor(async () => expect(await pendingOps(store)).toEqual(['move']));
    expect((await store.pending())[0]?.payload).toEqual({
      thingIds: [DRILL, CHARGER],
      to: { placeId: SHELF },
    });
    expect(await store.tray()).toEqual([]);
    expect(onOpen).toHaveBeenCalledWith({ kind: 'place', id: SHELF, locationId: HOME });
    expect(await screen.findByText('Moved 2 things to Shelf A')).toBeInTheDocument();
  });
});

describe('the box check', () => {
  it('previews "found 2 of 3" and saves the check as one queued op offline', async () => {
    const store = await phone();
    const { user } = await render(
      <BoxCheckScreen
        containerId={BOX}
        store={store}
        online={false}
        onExit={vi.fn()}
        detect={null}
      />,
    );
    expect(await screen.findByRole('heading', { name: 'Cable box' })).toBeInTheDocument();
    expect(screen.getByText('0 of 3 ticked')).toBeInTheDocument();
    expect(screen.getByText('Box inside · 1 thing, not opened')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'HDMI cable' }));
    await user.click(screen.getByRole('checkbox', { name: 'Adapter pouch' }));
    expect(screen.getByText('2 of 3 ticked')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'One fewer' }));
    expect(screen.getByRole('textbox', { name: /HDMI cable: how many you found/ })).toHaveValue(
      '2',
    );
    expect(screen.getByText('1 will be marked not here')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Finish check' }));
    expect(await screen.findByRole('heading', { name: 'Box check done' })).toBeInTheDocument();
    expect(screen.getByText('1 partly here: the rest is marked not here')).toBeInTheDocument();
    expect(screen.getByText('1 not here')).toBeInTheDocument();
    const [op] = await store.pending();
    expect(op?.op).toBe('box_check');
    expect(op?.payload).toMatchObject({
      containerId: BOX,
      lines: [
        { thingId: CABLE, expectedQty: '3', foundQty: '2' },
        { thingId: CHARGER, expectedQty: '1', foundQty: '0' },
        { thingId: POUCH, expectedQty: '1', foundQty: '1' },
      ],
      foundElsewhereIds: [],
    });
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await store.pending()).toEqual([]));
  });

  it('online, the check is one server call that answers with Undo', async () => {
    const { user } = await render(
      <BoxCheckScreen
        containerId={T.cableBox}
        store={new MemoryStore()}
        online
        onExit={vi.fn()}
        detect={null}
      />,
    );
    await user.click(await screen.findByRole('checkbox', { name: 'HDMI cable, 2 m' }));
    await user.click(screen.getByRole('button', { name: 'Finish check' }));
    expect(await screen.findByRole('heading', { name: 'Box check done' })).toBeInTheDocument();
    expect(mock.lastCall('POST', `/api/v1/things/${T.cableBox}/box-check`)?.body).toMatchObject({
      lines: [{ thingId: T.hdmiCable, expectedQty: '3', foundQty: '3' }],
    });
  });
});

describe('"Type the code"', () => {
  it('works from the keyboard alone, folded like the server folds it', async () => {
    const store = await phone();
    const { user, onOpen } = await renderScan({ store, online: false });
    await user.click(await screen.findByRole('button', { name: 'Type the code' }));
    const field = await screen.findByRole('textbox', { name: 'Code on the label' });
    expect(field).toHaveFocus();
    await user.keyboard('7kq-4mz');
    expect(await screen.findByRole('img', { name: '7KQ4MZ' })).toBeInTheDocument();
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(onOpen).toHaveBeenCalledWith({ kind: 'thing', id: DRILL, locationId: HOME }),
    );
  });

  it('says what a code looks like when it is not one', async () => {
    const { user } = await renderScan();
    await user.click(await screen.findByRole('button', { name: 'Type the code' }));
    await user.type(
      await screen.findByRole('textbox', { name: 'Code on the label' }),
      'hello{Enter}',
    );
    expect(
      await screen.findByText('A Kept code is 6 letters and digits, like 7KQ‑4MZ.'),
    ).toBeInTheDocument();
  });

  it('leads when the camera cannot be used', async () => {
    await renderScan({ camera: { secure: false, media: null } });
    expect(await screen.findByText("Kept can't scan here")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Type the code' })).toBeInTheDocument();
  });
});

describe('in Arabic', () => {
  it('keeps the code left to right, and uses logical sides only', async () => {
    const store = await phone();
    const { user } = await renderScan({ store, online: false }, 'ar');
    await user.click(await screen.findByRole('button', { name: 'اكتب الرمز' }));
    const field = await screen.findByRole('textbox');
    expect(field).toHaveAttribute('dir', 'ltr');
    await user.keyboard('7KQ4MZ');
    expect(await screen.findByRole('img', { name: '7KQ4MZ' })).toHaveAttribute('dir', 'ltr');
    expectLogicalOnly();
  });
});
