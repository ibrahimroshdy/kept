/**
 * The capture screen (plan T25's test list): the mode strip's keyboard and radio semantics, Name
 * as the primary input with AI off, the room grid on a new home, one queue entry per shutter
 * press, "+ photo" → attachToThingId, RTL, a refused camera → the file picker, and the location
 * suggestion made on the device without a request. The camera, the frame grab and the position
 * are fakes; the queue is the real `MemoryStore`.
 */
import type { SnapLocation, SnapPlace, SnapshotPage } from '@kept/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INV_IDS } from '@/api/inventory/mock/fixtures';
import type { Geo } from '@/camera/geo';
import { hasFrame } from '@/camera/grab';
import type { CameraEnv } from '@/camera/session';
import { toastQueue } from '@/components/ui/toast';
import { MemoryStore } from '@/offline/store';
import { renderApp } from '@/test/app';
import { expectLogicalOnly, renderUI } from '@/test/render';
import { firstPage, snapThing } from '@/test/store-contract';
import { CaptureScreen, type CaptureScreenProps } from './capture-screen';

vi.mock('@/camera/grab', () => ({
  hasFrame: vi.fn(() => true),
  grabFrame: vi.fn(async () => ({
    original: new Blob(['jpeg'], { type: 'image/jpeg' }),
    display: null,
    previewUnavailable: false,
  })),
}));

const HOME = '01926f00-0000-7000-8000-00000000b002';
const CABIN = '01926f00-0000-7000-8000-00000000b009';
const KITCHEN = '01926f00-0000-7000-8000-0000000c0091';
const PORCH = '01926f00-0000-7000-8000-0000000c0092';

const cabin: SnapLocation = {
  id: CABIN,
  name: 'Cabin',
  kind: 'house',
  timezone: 'Africa/Cairo',
  languages: ['en'],
  role: 'owner',
  effectiveModules: [],
  unplacedPlaceId: '01926f00-0000-7000-8000-0000000c0090',
  latitude: 31.2001,
  longitude: 29.9187,
  suggestRadiusM: 150,
};
const room = (id: string, name: string, sort: number): SnapPlace => ({
  id,
  locationId: CABIN,
  parentId: null,
  name,
  kindKey: 'room',
  icon: null,
  isUnplaced: false,
  sort,
  deleted: false,
});

async function world(over: (p: SnapshotPage) => SnapshotPage = (p) => p) {
  const store = new MemoryStore();
  const page = firstPage();
  await store.applySnapshot(
    over({
      ...page,
      locations: [...page.locations, cabin],
      changes: {
        ...page.changes,
        places: [
          ...page.changes.places,
          room(KITCHEN, 'Kitchen', 1),
          room(PORCH, 'Porch', 2),
          { ...room(cabin.unplacedPlaceId, '', 0), isUnplaced: true },
        ],
      },
    }),
  );
  return store;
}

const liveCamera: CameraEnv = {
  secure: true,
  media: { getUserMedia: vi.fn(async () => ({ getTracks: () => [] }) as unknown as MediaStream) },
};

async function renderCapture(
  props: Partial<CaptureScreenProps> = {},
  locale: 'en' | 'ar' = 'en',
  seed?: (qc: QueryClient) => void,
) {
  const store = props.store ?? (await world());
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed?.(qc);
  const onExit = vi.fn();
  const r = await renderUI(
    <QueryClientProvider client={qc}>
      <CaptureScreen
        store={store}
        personalLocationId={HOME}
        onExit={onExit}
        onOpen={vi.fn()}
        camera={liveCamera}
        geo={null}
        detect={null}
        {...props}
      />
    </QueryClientProvider>,
    { locale },
  );
  return { ...r, store, onExit };
}

const fetchSpy = vi.fn(async () => new Response('{}', { status: 404 }));

beforeEach(() => {
  vi.stubGlobal('fetch', fetchSpy);
  HTMLMediaElement.prototype.play = vi.fn(async () => {});
  fetchSpy.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const shutter = () => screen.findByRole('button', { name: /^Take photo/ });

describe('the capture screen', () => {
  it('keeps the shutter off until the video shows its first frame, so no press is lost', async () => {
    vi.mocked(hasFrame).mockReturnValue(false);
    try {
      await renderCapture();
      const button = await shutter();
      expect(button).toBeDisabled();
      vi.mocked(hasFrame).mockReturnValue(true);
      document.querySelector('video')?.dispatchEvent(new Event('loadeddata'));
      await waitFor(() => expect(button).toBeEnabled());
    } finally {
      vi.mocked(hasFrame).mockReturnValue(true);
    }
  });

  it('has a mode strip: a labelled radio group, arrow keys, remembered, and the shutter says the mode', async () => {
    const { user } = await renderCapture();
    const strip = await screen.findByRole('radiogroup', { name: 'Capture mode' });
    const radios = within(strip).getAllByRole('radio');
    expect(
      radios.map((r) => r.getAttribute('aria-label') ?? r.closest('label')?.textContent),
    ).toEqual(['Thing', 'Receipt', 'Label', 'Reading']);
    expect(radios[0]).toBeChecked();
    expect(await shutter()).toHaveAccessibleName('Take photo: new thing');
    await user.click(radios[0] as HTMLElement);
    await user.keyboard('{ArrowRight}');
    expect(radios[1]).toBeChecked();
    expect(await shutter()).toHaveAccessibleName('Take photo: receipt');
    expect(screen.getByText('Hold steady · fill the frame · original kept')).toBeInTheDocument();
    expect(screen.queryByText(/Edges found/)).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Note (optional)' })).toBeInTheDocument();
    expect(localStorage.getItem('kept.capture.mode')).toBe('receipt');
  });

  it('with AI off, Name is the primary input and a capture with no photo needs one (D194)', async () => {
    const { user, store } = await renderCapture();
    const name = await screen.findByRole('textbox', { name: 'Name' });
    expect(name).toBeRequired();
    await user.click(name);
    await user.keyboard('{Enter}');
    expect(await screen.findByText('Type a name, or take a photo.')).toBeInTheDocument();
    expect(await store.pending()).toHaveLength(0);
    await user.type(name, 'Step ladder{Enter}');
    await waitFor(async () => expect(await store.pending()).toHaveLength(1));
    const [entry] = await store.pending();
    expect(entry?.payload).toMatchObject({ name: 'Step ladder', files: [], mode: 'thing' });
  });

  it('with AI on, the name is optional', async () => {
    const store = await world((p) => ({
      ...p,
      locations: p.locations.map((l) =>
        l.id === HOME ? { ...l, effectiveModules: ['ai_capture'] } : l,
      ),
    }));
    await renderCapture({ store });
    expect(await screen.findByRole('textbox', { name: 'Name (optional)' })).not.toBeRequired();
  });

  it('writes one queue entry per shutter press, into the place on the chip', async () => {
    const { user, store } = await renderCapture();
    await screen.findByRole('button', { name: /Capturing into Home › Unplaced/ });
    await user.click(await shutter());
    await user.click(await shutter());
    await waitFor(async () => expect(await store.pending()).toHaveLength(2));
    const entries = await store.pending();
    expect(new Set(entries.map((e) => (e.payload as { batchId: string }).batchId)).size).toBe(1);
    expect(entries.every((e) => e.idempotencyKey === `cap:${e.clientId}`)).toBe(true);
    expect(entries[0]?.payload).toMatchObject({
      mode: 'thing',
      target: { placeId: expect.any(String) },
      files: [{ role: 'photo' }],
    });
    expect(await screen.findByText('2 captured')).toBeInTheDocument();
    expect(screen.getByText('2 waiting to sync')).toBeInTheDocument();
  });

  it('"+ photo to this thing" attaches the next shot to the draft just taken (D175)', async () => {
    const { user, store } = await renderCapture();
    const plus = await screen.findByRole('button', { name: /\+ photo to this thing/ });
    expect(plus).toBeDisabled();
    await user.click(await shutter());
    await waitFor(() => expect(plus).toBeEnabled());
    await user.click(plus);
    expect(await shutter()).toHaveAccessibleName('Take photo: add to this thing');
    await user.click(await shutter());
    await waitFor(async () => expect(await store.pending()).toHaveLength(2));
    const [first, second] = await store.pending();
    expect(second?.payload).toMatchObject({ attachToThingId: first?.clientId });
    expect(second?.dependsOn).toEqual([first?.idempotencyKey]);
    expect(plus).not.toHaveAttribute('aria-pressed', 'true');
  });

  it('Gallery follows the mode strip: in Receipt a picked photo is a receipt, in Thing a thing (D140, V9)', async () => {
    // Before, Gallery always made THING drafts, so a saved receipt picked in Receipt mode (the
    // iPhone's way in, with no share target) arrived as a Thing draft.
    const decode = vi.fn().mockRejectedValue(new Error('no canvas in jsdom'));
    const { user, store } = await renderCapture({ decode });
    const strip = await screen.findByRole('radiogroup', { name: 'Capture mode' });
    const [thingMode, receiptMode] = within(strip).getAllByRole('radio');
    const gallery = () => {
      const input = [...document.querySelectorAll<HTMLInputElement>('input[type=file]')].find(
        (i) => i.multiple && !i.hasAttribute('capture'),
      );
      if (!input) throw new Error('no Gallery input');
      return input;
    };
    const photo = (name: string) => new File(['jpeg'], name, { type: 'image/jpeg' });

    await user.click(receiptMode as HTMLElement);
    await user.upload(gallery(), [photo('receipt.jpg')]);
    await waitFor(async () => expect(await store.pending()).toHaveLength(1));
    expect((await store.pending())[0]?.payload).toMatchObject({
      mode: 'receipt',
      files: [{ role: 'receipt' }],
    });

    await user.click(thingMode as HTMLElement);
    await user.upload(gallery(), [photo('a.jpg'), photo('b.jpg')]);
    await waitFor(async () => expect(await store.pending()).toHaveLength(3));
    const modes = (await store.pending()).map((e) => (e.payload as { mode: string }).mode);
    expect(modes).toEqual(['receipt', 'thing', 'thing']);
  });

  it('opens the room grid on the first capture into a new home (D194)', async () => {
    const { user } = await renderCapture({ personalLocationId: CABIN });
    const grid = await screen.findByRole('region', { name: 'Which room are you in?' });
    const rooms = within(grid)
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(rooms).toEqual(['Kitchen', 'Porch', 'Another place', 'Unplaced for now']);
    await user.click(within(grid).getByRole('button', { name: 'Porch' }));
    expect(screen.queryByRole('region', { name: 'Which room are you in?' })).toBeNull();
    expect(
      screen.getByRole('button', { name: /Capturing into Cabin › Porch/ }),
    ).toBeInTheDocument();
  });

  it('a refused camera shows the file picker, and how to allow it', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException('no', 'NotAllowedError'));
    await renderCapture({ camera: { secure: true, media: { getUserMedia } } });
    expect(
      await screen.findByRole('heading', { name: "Kept can't use the camera" }),
    ).toBeInTheDocument();
    expect(screen.getByText('Camera access is off for Kept.')).toBeInTheDocument();
    expect(screen.getByText('How to allow it')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Take a photo/ }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Choose photos' })).toBeInTheDocument();
    const inputs = [...document.querySelectorAll<HTMLInputElement>('input[type=file]')];
    expect(inputs.some((i) => i.getAttribute('capture') === 'environment')).toBe(true);
    expect(inputs.some((i) => i.multiple)).toBe(true);
  });

  it('over plain HTTP, says why and still takes photos from a file', async () => {
    await renderCapture({ camera: { secure: false, media: null } });
    expect(await screen.findByText(/needs a secure \(HTTPS\) address/)).toBeInTheDocument();
  });

  it('suggests the nearest location from a position read on the phone, never sent (D153)', async () => {
    localStorage.setItem('kept.capture.suggestWhere', '1');
    const geo: Geo = {
      getCurrentPosition: vi.fn((ok: PositionCallback) =>
        ok({ coords: { latitude: 31.2002, longitude: 29.9188 } } as GeolocationPosition),
      ),
    };
    await renderCapture({ geo });
    expect(
      await screen.findByRole('button', { name: /Capturing into Cabin › Unplaced/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('Nearby · tap to change')).toBeInTheDocument();
    expect(geo.getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("follows the person's own choice from /me: off there turns this phone's copy off (T19)", async () => {
    localStorage.setItem('kept.capture.suggestWhere', '1');
    const geo: Geo = { getCurrentPosition: vi.fn() };
    await renderCapture({ geo }, 'en', (qc) =>
      qc.setQueryData(['me'], { profile: { suggestLocation: false } }),
    );
    await shutter();
    await waitFor(() => expect(localStorage.getItem('kept.capture.suggestWhere')).toBeNull());
    expect(geo.getCurrentPosition).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('Done with nothing captured goes back; with captures it shows the summary', async () => {
    const { user, onExit } = await renderCapture();
    await user.click(await screen.findByRole('button', { name: 'Done' }));
    expect(onExit).toHaveBeenCalledTimes(1);
    await user.click(await shutter());
    await screen.findByText('1 captured');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByRole('heading', { name: 'Capture done' })).toBeInTheDocument();
    expect(screen.getByText('1 captured into Home › Unplaced')).toBeInTheDocument();
    expect(screen.getByText('1 waiting to sync')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo this batch' })).toBeInTheDocument();
  });

  it('Done on the summary offers Undo for 10 s; captures still queued leave the phone (D150)', async () => {
    const store = await world();
    const serverUndo = vi.fn(async () => ({ trashed: [] }));
    const { user, onExit } = await renderCapture({ store, serverUndo });
    await user.click(await shutter());
    await screen.findByText('1 captured');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await screen.findByRole('heading', { name: 'Capture done' });
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onExit).toHaveBeenCalledTimes(1);
    const region = () => screen.getByRole('region', { name: 'Notifications' });
    expect(within(region()).getByText('1 captured')).toBeInTheDocument();
    expect(toastQueue.visibleToasts[0]?.timeout).toBe(10_000);
    expect((await store.pending()).length).toBe(1);
    await user.click(within(region()).getByRole('button', { name: 'Undo' }));
    expect(await within(region()).findByText('Batch undone')).toBeInTheDocument();
    expect(await store.pending()).toEqual([]);
    // Nothing had reached the server, so nothing was asked of it.
    expect(serverUndo).not.toHaveBeenCalled();
  });

  it('reads right to left in Arabic, with logical CSS only', async () => {
    const { user } = await renderCapture({}, 'ar');
    const strip = await screen.findByRole('radiogroup');
    const radios = within(strip).getAllByRole('radio');
    expect(document.documentElement.dir).toBe('rtl');
    await user.click(radios[0] as HTMLElement);
    // Arrow keys follow the reading direction: in Arabic the next mode is to the left.
    await user.keyboard('{ArrowLeft}');
    expect(radios[1]).toBeChecked();
    expectLogicalOnly();
  });
});

describe('the /capture route', () => {
  it('where AI is paused, the paused banner sits under the place chip: photos still save (D206)', async () => {
    const until = new Date(Date.UTC(2031, 9, 1)).toISOString();
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) =>
      String(input).includes('/api/v1/ai/status')
        ? Response.json({
            resolved: true,
            source: 'account',
            providerKind: 'groq',
            model: 'qwen/qwen3.8-27b',
            pausedUntil: until,
            reason: 'cap_money',
            pausedBy: { scope: 'location', label: 'Home' },
            waitingProvider: null,
            capPercent: 100,
            canResume: false,
            canManage: false,
            manager: { displayName: 'Ibrahim' },
            modelMissing: false,
          })
        : new Response('{}', { status: 404 }),
    );
    const store = await world((p) => ({
      ...p,
      locations: p.locations.map((l) =>
        l.id === HOME ? { ...l, effectiveModules: ['ai_capture'] } : l,
      ),
    }));
    await renderCapture({ store });
    const note = await screen.findByText('Photos still save; naming waits.');
    expect(screen.getByText(/Home's monthly cap reached/)).toBeInTheDocument();
    expect(document.body.textContent).toMatch(/Ask Ibrahim to resume/);
    // Under the place chip, above the counter.
    const chip = screen.getByRole('button', { name: /Capturing into/ });
    expect(chip.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  /** The Garage, with the Corolla and its odometer, from the phone's copy. */
  const garage: SnapLocation = { ...cabin, id: INV_IDS.loc.garage, name: 'Garage' };
  const withCar = (p: SnapshotPage): SnapshotPage => ({
    ...p,
    locations: [...p.locations, garage],
    changes: {
      ...p.changes,
      things: [
        ...p.changes.things,
        snapThing(INV_IDS.thing.car, garage.id, 'Toyota Corolla', {
          placeId: garage.unplacedPlaceId,
          meters: [{ id: INV_IDS.meter.carOdometer, kind: 'distance', unit: 'km', label: null }],
        }),
      ],
    },
  });

  it('READING reads a meter: the chip offers only things with one, and the photo goes on it (T13)', async () => {
    const store = await world(withCar);
    const { user } = await renderCapture({ store });
    await user.click(await screen.findByRole('radio', { name: 'Reading' }));
    const chip = await screen.findByRole('button', { name: 'Choose what was read' });
    expect(await shutter()).toBeDisabled();
    await user.click(chip);
    const sheet = await screen.findByRole('dialog', { name: 'What was read?' });
    const meter = await within(sheet).findByRole('radio', { name: /Toyota Corolla · Odometer/ });
    // Things without a meter aren't offered.
    expect(within(sheet).queryByRole('radio', { name: /drill/i })).toBeNull();
    await user.click(meter);
    expect(
      await screen.findByRole('button', { name: 'Reading Odometer of Toyota Corolla. Change' }),
    ).toBeInTheDocument();
    await user.click(await shutter());
    await waitFor(async () => expect(await store.pending()).toHaveLength(1));
    const [entry] = await store.pending();
    expect(entry?.locationId).toBe(INV_IDS.loc.garage);
    expect(entry?.payload).toMatchObject({
      mode: 'reading',
      attachToThingId: INV_IDS.thing.car,
      meterId: INV_IDS.meter.carOdometer,
      target: { containerId: INV_IDS.thing.car },
      files: [{ role: 'proof' }],
    });
  });

  it('READING with a typed value queues log_reading, the photo its proof, not create_thing (T19)', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const store = await world(withCar);
    const { user } = await renderCapture({ store });
    await user.click(await screen.findByRole('radio', { name: 'Reading' }));
    await user.click(await screen.findByRole('button', { name: 'Choose what was read' }));
    const sheet = await screen.findByRole('dialog', { name: 'What was read?' });
    await user.click(
      await within(sheet).findByRole('radio', { name: /Toyota Corolla · Odometer/ }),
    );
    // Eastern digits are read as the number they are.
    await user.type(
      await screen.findByRole('textbox', { name: 'Reading (km), optional' }),
      '٥٣٠٠٠',
    );
    await user.click(await shutter());
    await waitFor(async () => expect(await store.pending()).toHaveLength(1));
    const [entry] = await store.pending();
    expect(entry?.op).toBe('log_reading');
    expect(entry?.idempotencyKey).toBe(`read:${entry?.clientId}`);
    const payload = entry?.payload as { proofFileId?: string };
    expect(entry?.payload).toMatchObject({ meterId: INV_IDS.meter.carOdometer, value: '53000' });
    expect(payload.proofFileId).toBeTruthy();
    expect((await store.pending()).some((e) => e.op === 'create_thing')).toBe(false);
    // The field is cleared for the next shot.
    expect(screen.getByRole('textbox', { name: 'Reading (km), optional' })).toHaveValue('');
    vi.restoreAllMocks();
  });

  it('?label=: starts in LABEL and every label shot goes on that thing, in its location', async () => {
    const store = await world(withCar);
    const { user } = await renderCapture({ store, labelFor: INV_IDS.thing.car });
    expect(await screen.findByRole('radio', { name: 'Label' })).toBeChecked();
    expect(await screen.findByText(/Label photos go on/)).toHaveTextContent('Toyota Corolla');
    await user.click(await shutter());
    await waitFor(async () => expect(await store.pending()).toHaveLength(1));
    const [entry] = await store.pending();
    expect(entry?.op).toBe('create_thing');
    expect(entry?.locationId).toBe(INV_IDS.loc.garage);
    expect(entry?.payload).toMatchObject({ mode: 'label', attachToThingId: INV_IDS.thing.car });
  });

  it('READING offers every meter offline, one added by hand to a plain thing too', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const store = await world((p) => {
      const q = withCar(p);
      const [first, ...rest] = q.changes.things;
      if (!first) throw new Error('fixture');
      // A thing of no metered type, given a meter by hand on its page.
      const kettle = {
        ...first,
        meters: [{ id: 'm-kettle', kind: 'custom', unit: 'L', label: 'Litres boiled' }],
      };
      return { ...q, changes: { ...q.changes, things: [kettle, ...rest] } };
    });
    const { user } = await renderCapture({ store });
    await user.click(await screen.findByRole('radio', { name: 'Reading' }));
    await user.click(await screen.findByRole('button', { name: 'Choose what was read' }));
    const sheet = await screen.findByRole('dialog', { name: 'What was read?' });
    expect(
      await within(sheet).findByRole('radio', { name: /Toyota Corolla · Odometer/ }),
    ).toBeInTheDocument();
    expect(within(sheet).getByRole('radio', { name: /Litres boiled/ })).toBeInTheDocument();
    expect(within(sheet).queryByText('Needs a connection')).toBeNull();
    vi.restoreAllMocks();
  });

  it('READING with no metered thing says why, and offers nothing to pick', async () => {
    const { user } = await renderCapture();
    await user.click(await screen.findByRole('radio', { name: 'Reading' }));
    await user.click(await screen.findByRole('button', { name: 'Choose what was read' }));
    const sheet = await screen.findByRole('dialog', { name: 'What was read?' });
    expect(await within(sheet).findByText('Nothing here has a meter yet')).toBeInTheDocument();
    expect(within(sheet).queryByRole('radio')).toBeNull();
    await user.keyboard('{Escape}');
    expect(await shutter()).toBeDisabled();
  });

  it('is a focused task: its own chrome over the tab bar, and Done', async () => {
    await renderApp('/capture');
    expect(await screen.findByRole('heading', { name: 'Capture' })).toBeInTheDocument();
    expect(document.querySelector('[data-focused-task="capture"]')).toHaveClass('fixed', 'z-40');
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Capture mode' })).toBeInTheDocument();
  });
});
