/**
 * The capture session (D18, D34, D140, D153, D175, D194–D196; screens §5 "Capture", §8; plan
 * T25). A focused task: on the phone it covers the tab bar with its own chrome (screens §8), dark
 * in every theme (board frames 1–3).
 *
 * - The camera stays open; the counter reads "12 captured"; the place chip is pinned at the top,
 *   with the paused banner under it where AI is paused ("Photos still save; naming waits", D206).
 * - READING mode reads a meter, so its chip names one (./reading-target.tsx): only things with a
 *   meter, since the server refuses a READING into a plain place (T13).
 * - The mode strip picks the photo policy (camera/image.ts) and the shutter's name.
 * - Every capture, from any source, is one queued `create_thing` (./enqueue.ts), shown at once
 *   in its place as "ID pending"; the sync engine sends it when online.
 * - A Kept label in view offers "Open" · "Capture into" (D137).
 * - Done → the summary, then back.
 * - No camera (HTTP, denied, none) → the file picker, always reachable.
 *
 * Dependencies that touch the device are props, so tests pass fakes (a rejecting
 * `getUserMedia`, a fixed position) and the route passes the real ones.
 */
import type { CaptureMode, SnapLocation, SnapPlace, SnapThing } from '@kept/shared';
import { newId } from '@kept/shared';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, useLocale } from 'react-aria-components';
import { getMe, setSuggestLocation } from '@/api/account';
import { captureApi, captureKeys } from '@/api/capture/queries';
import { keys as appKeys } from '@/api/queries';
import type { Me } from '@/api/types';
import {
  currentPosition,
  deviceGeo,
  type Geo,
  nearestLocation,
  setSuggestWhere,
  suggestWhereOn,
} from '@/camera/geo';
import { grabFrame, hasFrame } from '@/camera/grab';
import {
  type CapturedImage,
  type Decode,
  decodeWithBitmap,
  fromFile,
  toLocalBlobs,
} from '@/camera/image';
import { type Detect, nativeDetect, watchForLabels } from '@/camera/label-recogniser';
import { type CameraEnv, type CameraProblem, cameraEnv, openCamera } from '@/camera/session';
import { PausedBanner } from '@/components/ai/paused-banner';
import { UNDO_TOAST_MS } from '@/components/history/undo';
import { CameraIcon, GalleryIcon } from '@/components/icons';
import { usePlaceName } from '@/components/places/labels';
import { enqueueReading } from '@/components/readings/enqueue-reading';
import { readingValueOf } from '@/components/readings/reading-field';
import { FromTemplate, prefillOf } from '@/components/templates/quick-add';
import { useConfirm } from '@/components/ui/confirm';
import { toast } from '@/components/ui/toast';
import { useFormat } from '@/lib/format';
import type { OfflineStore, SharedInto } from '@/offline/store';
import { useHoldUpdates } from '@/pwa/register';
import { Counter } from './counter';
import { enqueueCapture, enqueueFiles, modeForFile, type Queued, undoBatch } from './enqueue';
import { FileFallback } from './file-fallback';
import { FilePick, GalleryImport, SideButton } from './gallery-import';
import { ModeStrip, rememberMode, storedMode, swipeMode } from './mode-strip';
import { NameField } from './name-field';
import { PhotoToThis } from './photo-to-this';
import { PlaceChip, PlaceSheet, type SuggestState, useTargetPath } from './place-chip';
import { ReadingChip, ReadingSheet, type ReadingTarget, ReadingValueField } from './reading-target';
import { type Recognised, RecognisedLabel } from './recognised';
import { RoomGrid } from './room-grid';
import type { SharedMode } from './shared-sheet';
import { Shutter, useShutterLabel } from './shutter';
import { CaptureSummary } from './summary';
import {
  type ChipTarget,
  defaultTarget,
  isNewHome,
  rememberTarget,
  roomsOf,
  writable,
} from './target';

export type OpenTarget = { kind: 'thing' | 'place'; id: string } | { kind: 'code'; code: string };

export type CaptureScreenProps = {
  store: OfflineStore;
  personalLocationId: string | null;
  /** A box to capture into (`?into=`). */
  into?: string;
  /** A place to capture into (`?place=`, "Capture here"). */
  placeId?: string;
  /**
   * `?label=<thing id>` (step 5, T22's "read its registration card"): start in LABEL mode, and
   * every LABEL shot goes on that thing (`attachToThingId`), in its location, where the server
   * reads it (a vehicle's registration card becomes a suggested document).
   */
  labelFor?: string;
  onExit: () => void;
  onOpen: (target: OpenTarget) => void;
  /** After each enqueue: the sync engine's kick (T24). */
  onQueued?: () => void;
  /** Re-read the snapshot when this fires (the sync engine's status). */
  subscribe?: (fn: () => void) => () => void;
  /** The server's batch undo; `captures/batches/:id/undo` by default. */
  serverUndo?: (batchId: string) => Promise<unknown>;
  // ----- the device, injectable -----
  camera?: CameraEnv;
  geo?: Geo | null;
  detect?: Detect | null;
  decode?: Decode;
  iphone?: boolean;
  /** The capture screen's share slot: `onKeep` for "Shared into Kept" (T23). */
  renderShare?: (onKeep: (share: SharedInto, mode: SharedMode) => Promise<void>) => ReactNode;
};

type Shot = Queued & {
  thumb: string | null;
  name: string | null;
  /** Added to another capture by "+ photo": not a draft of its own. */
  added: boolean;
  pageOf?: string;
  target: ChipTarget;
};

type Cam =
  | { state: 'opening' }
  | { state: 'live'; stream: MediaStream; stop: () => void }
  | { state: 'problem'; problem: CameraProblem };

function useOnline() {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

const imageThumb = (q: Queued, image: CapturedImage | null): string | null => {
  const b = q.display?.blob ?? (image && !image.previewUnavailable ? q.original?.blob : null);
  if (!b?.type.startsWith('image/') || typeof URL.createObjectURL !== 'function') return null;
  try {
    return URL.createObjectURL(b);
  } catch {
    // A thumbnail is a nicety (D195); the capture is already queued.
    return null;
  }
};

export function CaptureScreen({
  store,
  personalLocationId,
  into,
  placeId,
  labelFor,
  onExit,
  onOpen,
  onQueued,
  subscribe,
  serverUndo = captureApi.undoBatch,
  camera,
  geo = deviceGeo(),
  detect = nativeDetect(),
  decode = decodeWithBitmap,
  iphone = false,
  renderShare,
}: CaptureScreenProps) {
  const { t } = useLingui();
  const fmt = useFormat();
  const confirm = useConfirm();
  const { direction } = useLocale();
  const online = useOnline();
  const shutterLabel = useShutterLabel();
  const targetPath = useTargetPath();
  const placeName = usePlaceName();

  // ----- the snapshot ---------------------------------------------------------------------
  const [world, setWorld] = useState<{
    locations: SnapLocation[];
    places: Record<string, SnapPlace[]>;
    asOf: string | null;
  } | null>(null);
  const load = useCallback(async () => {
    const all = writable(await store.locations());
    const places: Record<string, SnapPlace[]> = {};
    for (const l of all) places[l.id] = (await store.placesOf(l.id)).filter((p) => !p.deleted);
    setWorld({ locations: all, places, asOf: await store.asOf() });
  }, [store]);
  useEffect(() => {
    void load();
    return subscribe?.(() => void load());
  }, [load, subscribe]);
  const placesOf = useCallback((id: string) => world?.places[id] ?? [], [world]);

  // ----- where captures land ----------------------------------------------------------------
  const [target, setTarget] = useState<ChipTarget | null>(null);
  const [roomGrid, setRoomGrid] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [suggest, setSuggest] = useState<SuggestState>(() =>
    !geo ? 'unavailable' : suggestWhereOn() ? 'finding' : 'off',
  );
  // "Suggest where I am" is the person's (/me, T19): this device's copy follows the server's, so
  // turning it off on one phone turns it off on the others.
  const qc = useQueryClient();
  // Read from the signed-in frame's copy, never fetched here: capture sends nothing it needn't.
  const serverSuggest = useQuery({ queryKey: appKeys.me, queryFn: getMe, enabled: false }).data
    ?.profile.suggestLocation;
  useEffect(() => {
    if (serverSuggest === undefined || serverSuggest === suggestWhereOn()) return;
    setSuggestWhere(serverSuggest);
    if (!serverSuggest) setSuggest((s) => (s === 'unavailable' ? s : 'off'));
  }, [serverSuggest]);
  const saveSuggest = (on: boolean) => {
    setSuggestWhere(on);
    qc.setQueryData<Me>(appKeys.me, (m) =>
      m ? { ...m, profile: { ...m.profile, suggestLocation: on } } : m,
    );
    // Offline, this phone keeps the choice and the server hears it next time it's changed.
    void setSuggestLocation(on).catch(() => undefined);
  };
  const decided = useRef(false);

  const locate = useCallback(
    async (locations: SnapLocation[]) => {
      const r = await currentPosition(geo);
      if (!r.ok) {
        setSuggest(r.reason === 'denied' ? 'denied' : 'unavailable');
        return null;
      }
      const near = nearestLocation(r.position, locations);
      setSuggest(near ? 'found' : 'none');
      return near;
    },
    [geo],
  );

  // The first target, once the snapshot is here; the room grid on a new home (D194).
  useEffect(() => {
    // Wait for a snapshot with somewhere to capture into (a fresh phone syncs first).
    if (!world || world.locations.length === 0 || decided.current) return;
    decided.current = true;
    void (async () => {
      const box: SnapThing | null = into ? ((await store.thing(into)) ?? null) : null;
      const labelled: SnapThing | null = labelFor ? ((await store.thing(labelFor)) ?? null) : null;
      if (labelled) {
        // LABEL for a thing: its photos go where the thing is.
        setLabelThing(labelled);
        setTarget({
          locationId: labelled.locationId,
          placeId: labelled.placeId,
          containerId: labelled.containerId,
          why: 'chosen',
        });
        return;
      }
      const first = defaultTarget({
        locations: world.locations,
        placesOf,
        personalLocationId,
        into: box,
        placeId: placeId ?? null,
      });
      setTarget(first);
      let next = first;
      if (first && first.why !== 'scanned' && first.why !== 'chosen' && suggestWhereOn() && geo) {
        const near = await locate(world.locations);
        if (near && near.id !== first.locationId) {
          next = defaultTarget({
            locations: world.locations,
            placesOf,
            personalLocationId,
            nearby: near,
          });
          setTarget((cur) => (cur?.why === 'chosen' ? cur : next));
        }
      }
      if (next && (next.why === 'default' || next.why === 'nearby')) {
        const loc = world.locations.find((l) => l.id === next?.locationId);
        const places = placesOf(next.locationId);
        if (loc && loc.kind !== 'personal' && roomsOf(places).length > 0) {
          if (await isNewHome(store, places)) setRoomGrid(true);
        }
      }
    })();
  }, [world, into, placeId, labelFor, personalLocationId, placesOf, store, geo, locate]);

  const pick = (t2: ChipTarget) => {
    setTarget(t2);
    setRoomGrid(false);
    rememberTarget(t2);
  };

  // ----- the camera ---------------------------------------------------------------------------
  const video = useRef<HTMLVideoElement>(null);
  const [cam, setCam] = useState<Cam>({ state: 'opening' });
  const [phase, setPhase] = useState<'camera' | 'summary'>('camera');
  useHoldUpdates(true);
  useEffect(() => {
    if (phase !== 'camera') return;
    let live = true;
    let stop: (() => void) | null = null;
    void openCamera(camera ?? cameraEnv()).then((r) => {
      if (!live) {
        if (r.ok) r.stop();
        return;
      }
      if (r.ok) {
        stop = r.stop;
        setCam({ state: 'live', stream: r.stream, stop: r.stop });
      } else setCam({ state: 'problem', problem: r.problem });
    });
    return () => {
      live = false;
      stop?.();
    };
  }, [camera, phase]);
  // The shutter waits for the first frame: a press between the stream opening and its first
  // frame would grab nothing, and the capture would be lost without a word (found by the e2e's
  // keyboard walk under load, T32).
  const [frameReady, setFrameReady] = useState(false);
  useEffect(() => {
    const v = video.current;
    if (!v || cam.state !== 'live') {
      setFrameReady(false);
      return;
    }
    v.srcObject = cam.stream;
    void v.play?.()?.catch(() => {});
    const check = () => setFrameReady(hasFrame(v));
    check();
    v.addEventListener('loadeddata', check);
    v.addEventListener('resize', check);
    return () => {
      v.removeEventListener('loadeddata', check);
      v.removeEventListener('resize', check);
    };
  }, [cam]);

  // ----- label recognition (D137) ------------------------------------------------------------
  const [code, setCode] = useState<string | null>(null);
  const [label, setLabel] = useState<Recognised | null>(null);
  const dismissed = useRef(new Set<string>());
  useEffect(() => {
    const v = video.current;
    if (!v || cam.state !== 'live' || !detect || phase !== 'camera') return;
    return watchForLabels(v, detect, setCode);
  }, [cam, detect, phase]);
  useEffect(() => {
    if (!code || dismissed.current.has(code)) {
      setLabel(null);
      return;
    }
    let live = true;
    void (async () => {
      const hit = await store.byCode(code);
      let r: Recognised = { code, kind: 'unknown', name: null };
      if (hit?.kind === 'blank')
        r = { code, kind: 'blank', locationId: hit.locationId, name: null };
      else if (hit?.kind === 'thing' && hit.id) {
        const th = await store.thing(hit.id);
        const places = placesOf(hit.locationId);
        r = {
          code,
          kind: th?.isContainer ? 'container' : 'thing',
          id: hit.id,
          locationId: hit.locationId,
          name: th?.name ?? null,
          where: th
            ? targetPath(
                {
                  locationId: hit.locationId,
                  placeId: th.placeId,
                  containerId: null,
                  why: 'default',
                },
                world?.locations ?? [],
                places,
              )
            : undefined,
        };
      } else if (hit?.kind === 'place' && hit.id) {
        const pl = placesOf(hit.locationId).find((p) => p.id === hit.id);
        r = {
          code,
          kind: 'place',
          id: hit.id,
          locationId: hit.locationId,
          name: pl ? placeName(pl) : null,
        };
      }
      if (live) setLabel(r);
    })();
    return () => {
      live = false;
    };
  }, [code, store, placesOf, targetPath, world, placeName]);

  // ----- the session ---------------------------------------------------------------------------
  const [mode, setModeState] = useState<CaptureMode>(() => (labelFor ? 'label' : storedMode()));
  /** `?label=`: the thing LABEL shots go on, once read from the phone's copy. */
  const [labelThing, setLabelThing] = useState<SnapThing | null>(null);
  /** READING's meter: chosen in its sheet, kept for the session (offline too). */
  const [reading, setReading] = useState<ReadingTarget | null>(null);
  const [readingSheet, setReadingSheet] = useState(false);
  /** READING's typed value (T19): with one, the shot is a `log_reading` with its photo as proof. */
  const [readingValue, setReadingValue] = useState('');
  const [readingError, setReadingError] = useState<string | null>(null);
  const setMode = (m: CaptureMode) => {
    setModeState(m);
    rememberMode(m);
  };
  const [batchId, setBatchId] = useState(newId);
  const [shots, setShots] = useState<Shot[]>([]);
  const [armed, setArmed] = useState(false);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  /** Quick add (plan T30): the template the next capture starts from. */
  const picked = useRef<string | null>(null);
  const [announce, setAnnounce] = useState(0);
  const [waiting, setWaiting] = useState(0);
  const chain = useRef<Promise<void>>(Promise.resolve());

  const thumbs = useRef<string[]>([]);
  useEffect(
    () => () => {
      for (const u of thumbs.current) URL.revokeObjectURL?.(u);
    },
    [],
  );

  const refreshCounts = useCallback(async () => {
    const c = await store.counts();
    setWaiting(c.waiting + c.uploading);
  }, [store]);
  useEffect(() => {
    void refreshCounts();
    const id = setInterval(() => void refreshCounts(), 2000);
    return () => clearInterval(id);
  }, [refreshCounts]);

  const loc = world?.locations.find((l) => l.id === target?.locationId);
  // A reading lands in its meter's location, whatever the place chip says.
  const aiLoc =
    mode === 'reading' && reading ? world?.locations.find((l) => l.id === reading.locationId) : loc;
  const aiOn = aiLoc?.effectiveModules.includes('ai_capture') ?? false;
  // Only asked online, where AI capture is on: the paused banner (D206). Never on this phone's
  // position or anything else.
  const aiLocation = online && aiOn ? (aiLoc?.id ?? null) : null;
  const ai = useQuery({
    queryKey: captureKeys.ai.status(aiLocation),
    queryFn: () => captureApi.aiStatus(aiLocation),
    enabled: aiLocation !== null,
  });
  const kind: 'name' | 'note' = mode === 'receipt' || mode === 'reading' ? 'note' : 'name';

  /** The draft "+ photo" adds to: the last thing (or the first page of the last receipt). */
  const addTo = useMemo(() => {
    if (mode === 'receipt') {
      const r = [...shots].reverse().find((s) => s.mode === 'receipt');
      return r ? { id: r.pageOf ?? r.id, name: null, receipt: true } : null;
    }
    const th = [...shots]
      .reverse()
      .find((s) => (s.mode === 'thing' || s.mode === 'label') && !s.added);
    return th ? { id: th.id, name: th.name, receipt: false } : null;
  }, [shots, mode]);

  const record = async (m: CaptureMode, image: CapturedImage | null, typed: string, value = '') => {
    if (m === 'reading') return recordReading(image, typed, value);
    if (!target) return;
    // The capture's own mode decides what the typed text is, not the strip's (a PDF from the
    // gallery is a receipt in any mode).
    const text: 'name' | 'note' = m === 'receipt' ? 'note' : 'name';
    const add = armed ? addTo : null;
    const parent = add ? shots.find((s) => s.id === add.id) : undefined;
    // `?label=`: a LABEL shot goes on that thing, in its location.
    const onThing = m === 'label' && !add && labelThing ? labelThing : null;
    const templateId = text === 'name' && !add ? picked.current : null;
    picked.current = null;
    const q = await enqueueCapture(store, {
      ...(templateId ? { templateId } : {}),
      target,
      batchId,
      mode: m,
      image,
      ...(text === 'name' && typed ? { name: typed } : {}),
      ...(text === 'note' && typed ? { note: typed } : {}),
      ...(add && !add.receipt ? { attachToThingId: add.id } : {}),
      ...(onThing ? { attachToThingId: onThing.id } : {}),
      ...(add?.receipt ? { pageOf: add.id } : {}),
      ...(parent ? { dependsOn: [parent.idempotencyKey] } : {}),
    });
    const thumb = imageThumb(q, image);
    if (thumb) thumbs.current.push(thumb);
    setShots((s) => [
      ...s,
      {
        ...q,
        thumb,
        name: text === 'name' && typed ? typed : null,
        added: add !== null || onThing !== null,
        ...(add?.receipt ? { pageOf: add.id } : {}),
        target,
      },
    ]);
    setAnnounce((n) => n + 1);
    rememberTarget(target);
    onQueued?.();
    void refreshCounts();
  };

  /** READING: the photo is proof on the metered thing, with the meter named (T13). With a typed
   * value (T19) it's a `log_reading` instead, the photo its proof, online or offline. */
  const recordReading = async (image: CapturedImage | null, typed: string, value = '') => {
    if (!reading) return;
    if (value) {
      const blobs = image ? await toLocalBlobs(image) : null;
      const r = await enqueueReading(store, {
        locationId: reading.locationId,
        meterId: reading.meterId,
        value,
        takenAt: new Date().toISOString(),
        ...(typed ? { note: typed } : {}),
        ...(blobs ? { proof: blobs.original } : {}),
      });
      const q: Queued = {
        id: r.id,
        idempotencyKey: r.idempotencyKey,
        mode: 'reading',
        original: blobs?.original ?? null,
        display: blobs?.display ?? null,
      };
      const thumb = imageThumb(q, image);
      if (thumb) thumbs.current.push(thumb);
      const where: ChipTarget = {
        locationId: reading.locationId,
        placeId: null,
        containerId: reading.thingId,
        containerName: reading.thingName,
        why: 'chosen',
      };
      setShots((s) => [...s, { ...q, thumb, name: null, added: true, target: where }]);
      setAnnounce((n) => n + 1);
      onQueued?.();
      void refreshCounts();
      return;
    }
    const where: ChipTarget = {
      locationId: reading.locationId,
      placeId: null,
      containerId: reading.thingId,
      containerName: reading.thingName,
      why: 'chosen',
    };
    const q = await enqueueCapture(store, {
      target: where,
      batchId,
      mode: 'reading',
      image,
      ...(typed ? { note: typed } : {}),
      attachToThingId: reading.thingId,
      meterId: reading.meterId,
    });
    const thumb = imageThumb(q, image);
    if (thumb) thumbs.current.push(thumb);
    setShots((s) => [...s, { ...q, thumb, name: null, added: true, target: where }]);
    setAnnounce((n) => n + 1);
    onQueued?.();
    void refreshCounts();
  };

  /** Runs capture steps one after another, so the queue keeps shutter order; a failure (the
   * phone's storage full) is said, and never stops the next shot. */
  const later = (step: () => Promise<void>) => {
    chain.current = chain.current.then(step).catch(() => {
      toast({
        title: t`Couldn't save that capture`,
        description: t`This phone may be out of space.`,
        tone: 'danger',
      });
    });
  };

  const shoot = () => {
    const v = video.current;
    if (!v || !target) return;
    if (mode === 'reading' && !reading) {
      setReadingSheet(true);
      return;
    }
    const value = mode === 'reading' ? takeReadingValue() : '';
    if (value === null) return;
    const m = mode;
    const typed = name.trim();
    setName('');
    setNameError(null);
    later(async () => {
      const image = await grabFrame(v, m).catch(() => null);
      if (image) await record(m, image, typed, value);
    });
    setArmed(false);
  };

  /** The typed READING value, cleared for the next shot: `''` for none, null when it isn't a
   * number (said under the field; nothing is taken). */
  const takeReadingValue = (): string | null => {
    const v = readingValueOf(readingValue);
    if (v === null) {
      setReadingError(t`Enter the number on the meter, like 53000, or leave it empty.`);
      return null;
    }
    setReadingValue('');
    setReadingError(null);
    return v;
  };

  const submitName = () => {
    const typed = name.trim();
    if (!typed) {
      setNameError(t`Type a name, or take a photo.`);
      return;
    }
    setName('');
    setNameError(null);
    const m = mode === 'label' ? 'label' : 'thing';
    later(() => record(m, null, typed));
    setArmed(false);
  };

  /**
   * Files from the system camera or the gallery, in the mode the strip shows when they are
   * picked: Gallery in THING makes a THING draft per photo (D140), in RECEIPT a receipt per file
   * (iPhone's way in for a saved receipt, V9). A PDF is a receipt whatever the mode.
   */
  const takeFiles = (files: File[], fromCamera: boolean) => {
    if (!target) return;
    const m: CaptureMode = mode;
    if (m === 'reading' && !reading) {
      setReadingSheet(true);
      return;
    }
    const value = m === 'reading' && fromCamera ? takeReadingValue() : '';
    if (value === null) return;
    const typed = fromCamera ? name.trim() : '';
    if (fromCamera) setName('');
    later(async () => {
      if (fromCamera && files[0]) {
        await record(m, await fromFile(files[0], m, decode), typed, value);
        return;
      }
      for (const f of files) {
        const fm = modeForFile(f.type, m);
        await record(fm, await fromFile(f, fm, decode), '');
      }
    });
    setArmed(false);
  };

  /** "Shared into Kept" (T23's sheet): one capture per file, into the chip's place. */
  const keepShare = useCallback(
    async (share: SharedInto, m: SharedMode) => {
      if (!target) return;
      const queued = await enqueueFiles(
        store,
        share.files.map((f) => ({ blob: f.blob, type: f.type || f.blob.type })),
        { target, batchId, mode: m, decode },
      );
      setShots((s) => [
        ...s,
        ...queued.map((q) => ({ ...q, thumb: null, name: null, added: false, target })),
      ]);
      onQueued?.();
      toast({
        title: plural(queued.length, { one: 'Kept # file', other: 'Kept # files' }),
        tone: 'ok',
      });
    },
    [store, target, batchId, decode, onQueued],
  );

  const toSummary = () => (shots.length ? setPhase('summary') : onExit());

  /**
   * Done: the batch stays undoable from a 10-second toast (D150, plan T31), the same undo as the
   * summary's "Undo this batch": captures still queued leave the phone, synced drafts go to the
   * trash (`undoBatch`). Offline, the synced part says it needs a connection.
   */
  const finish = () => {
    const keys = shots.map((s) => s.idempotencyKey);
    const id = batchId;
    const n = keys.length;
    if (n > 0)
      toast(
        {
          title: plural(n, { one: '# captured', other: '# captured' }),
          tone: 'ok',
          action: {
            label: t`Undo`,
            onAction: () =>
              void undoBatch(store, id, keys, serverUndo).then(
                () => toast({ title: t`Batch undone`, tone: 'ok' }),
                () =>
                  toast({
                    title: t`Couldn't undo the synced ones`,
                    description: t`Needs a connection. The rest were taken back.`,
                    tone: 'danger',
                  }),
              ),
          },
        },
        { timeout: UNDO_TOAST_MS },
      );
    onExit();
  };

  // ----- render --------------------------------------------------------------------------------
  const path =
    target && world ? targetPath(target, world.locations, placesOf(target.locationId)) : '';
  const last = shots.at(-1);
  const lastName = last?.name ? last.name : aiOn ? t`Naming…` : t`Unnamed`;

  if (phase === 'summary') {
    const where = new Set(
      shots.map((s) => `${s.target.locationId}:${s.target.placeId}:${s.target.containerId}`),
    );
    return (
      <SummaryPhase
        store={store}
        shots={shots}
        where={
          where.size === 1 && world
            ? targetPath(
                shots[0]?.target as ChipTarget,
                world.locations,
                placesOf(shots[0]?.target.locationId ?? ''),
              )
            : null
        }
        iphone={iphone}
        asOf={world?.asOf ? fmt.dateTime(world.asOf) : null}
        aiOn={aiOn}
        onKeepCapturing={() => setPhase('camera')}
        onDone={finish}
        onUndo={async () => {
          const ok = await confirm({
            title: t`Undo this batch?`,
            body: t`Captures that haven't synced are deleted from this phone. Synced drafts from this batch go to the trash.`,
            confirmLabel: t`Undo`,
            destructive: true,
          });
          if (!ok) return;
          try {
            await undoBatch(
              store,
              batchId,
              shots.map((s) => s.idempotencyKey),
              serverUndo,
            );
            toast({ title: t`Batch undone`, tone: 'ok' });
            setShots([]);
            setBatchId(newId());
            onExit();
          } catch {
            toast({
              title: t`Couldn't undo the synced ones`,
              description: t`Needs a connection. The rest were taken back.`,
              tone: 'danger',
            });
          }
        }}
      />
    );
  }

  const noPlace = world && world.locations.length === 0;
  return (
    <div
      data-focused-task="capture"
      className="fixed inset-0 z-40 flex flex-col bg-[#0F0E0D] pt-[env(safe-area-inset-top)] text-[#F2EFE9] md:relative md:inset-auto md:z-auto md:mx-auto md:my-4 md:min-h-[calc(100dvh-2rem)] md:max-w-[480px] md:rounded-2xl"
    >
      <h1 className="sr-only">
        <Trans>Capture</Trans>
      </h1>
      {renderShare?.(keepShare)}
      <div className="grid gap-2 px-3 pt-2 pb-2.5">
        <div className="flex items-center justify-between gap-2">
          {target && mode === 'reading' ? (
            <ReadingChip value={reading} onPress={() => setReadingSheet(true)} />
          ) : target ? (
            <PlaceChip
              path={path}
              why={target.why}
              thumbs={shots.map((s) => s.thumb).filter((x): x is string => !!x)}
              onPress={() => setSheet(true)}
            />
          ) : (
            <div className="min-h-12 flex-1" />
          )}
          <Button
            onPress={toSummary}
            className="min-h-12 cursor-pointer rounded-xl border border-[#4A463F] bg-transparent px-4 font-semibold text-[#F2EFE9] text-[14px] outline-none data-focus-visible:outline-2 data-focus-visible:outline-[#F2EFE9]"
          >
            <Trans>Done</Trans>
          </Button>
        </div>
        {ai.data?.pausedUntil ? (
          // The camera's chrome is dark in every theme; the banner keeps its own surface.
          <div className="rounded-[10px] bg-surface text-ink">
            <PausedBanner status={ai.data} note={t`Photos still save; naming waits.`} />
          </div>
        ) : null}
        <Counter captured={shots.length} waiting={waiting} online={online} announce={announce} />
        {mode === 'label' && labelThing ? (
          <p className="m-0 px-1 text-[#BDB7AC] text-[13px] [overflow-wrap:anywhere]">
            <Trans>
              Label photos go on{' '}
              <bdi className="font-semibold text-[#F2EFE9]">{labelThing.name}</bdi>
            </Trans>
          </p>
        ) : null}
      </div>

      <div
        className="relative mx-3 min-h-[220px] flex-1 overflow-hidden rounded-[14px] bg-[#1C1A17]"
        onPointerDown={(e) => {
          (e.currentTarget as HTMLElement).dataset.x = String(e.clientX);
        }}
        onPointerUp={(e) => {
          const x0 = Number((e.currentTarget as HTMLElement).dataset.x ?? Number.NaN);
          const dx = e.clientX - x0;
          if (Math.abs(dx) > 60) setMode(swipeMode(mode, dx, direction === 'rtl'));
        }}
      >
        {cam.state === 'problem' ? (
          <FileFallback problem={cam.problem} onFiles={takeFiles} />
        ) : (
          <>
            <video
              ref={video}
              playsInline
              muted
              autoPlay
              aria-label={t`Camera view`}
              className="absolute inset-0 size-full object-cover"
            />
            {mode === 'receipt' ? (
              <span className="absolute inset-x-2.5 bottom-2.5 w-fit rounded-full bg-[#0F0E0D]/80 px-2.5 py-[7px] font-medium text-[12.5px]">
                {t`Hold steady · fill the frame · original kept`}
              </span>
            ) : last ? (
              <span className="absolute start-2.5 top-2.5 rounded-full bg-[#0F0E0D]/80 px-2.5 py-[7px] font-medium text-[12.5px]">
                {t`Last saved: ${lastName} · ID pending`}
              </span>
            ) : null}
            {mode !== 'thing' ? (
              <FilePick
                camera
                onFiles={(f) => takeFiles(f, true)}
                className="absolute end-2.5 top-2.5 min-h-11 rounded-full bg-[#0F0E0D]/80 px-3 font-medium text-[12.5px]"
              >
                {t`Use the system camera`}
              </FilePick>
            ) : null}
          </>
        )}
        {label && phase === 'camera' ? (
          <RecognisedLabel
            label={label}
            asOf={world?.asOf ? fmt.dateTime(world.asOf) : null}
            onOpen={() =>
              onOpen(
                label.id &&
                  (label.kind === 'place' || label.kind === 'container' || label.kind === 'thing')
                  ? { kind: label.kind === 'place' ? 'place' : 'thing', id: label.id }
                  : { kind: 'code', code: label.code },
              )
            }
            onCaptureInto={
              label.id &&
              label.locationId &&
              (label.kind === 'container' || label.kind === 'place') &&
              world?.locations.some((l) => l.id === label.locationId)
                ? () => {
                    const lid = label.locationId as string;
                    pick(
                      label.kind === 'container'
                        ? {
                            locationId: lid,
                            placeId: null,
                            containerId: label.id as string,
                            containerName: label.name,
                            why: 'scanned',
                          }
                        : {
                            locationId: lid,
                            placeId: label.id as string,
                            containerId: null,
                            why: 'scanned',
                          },
                    );
                    dismissed.current.add(label.code);
                    setLabel(null);
                  }
                : null
            }
            onDismiss={() => {
              dismissed.current.add(label.code);
              setLabel(null);
            }}
          />
        ) : null}
        {roomGrid && target && loc ? (
          <RoomGrid
            home={loc.name}
            rooms={roomsOf(placesOf(loc.id))}
            onRoom={(id) =>
              pick({ locationId: loc.id, placeId: id, containerId: null, why: 'chosen' })
            }
            onUnplaced={() =>
              pick({
                locationId: loc.id,
                placeId:
                  placesOf(loc.id).find((p) => p.isUnplaced)?.id ?? (loc.unplacedPlaceId || null),
                containerId: null,
                why: 'chosen',
              })
            }
            onOther={() => {
              setRoomGrid(false);
              setSheet(true);
            }}
          />
        ) : null}
        {noPlace ? (
          <div className="absolute inset-0 grid place-items-center p-4 text-center text-[#BDB7AC] text-[14px]">
            <Trans>
              Nothing on this phone yet. Open Kept once while online to bring your places.
            </Trans>
          </div>
        ) : null}
      </div>

      {mode === 'reading' && reading ? (
        <ReadingValueField
          unit={reading.unit ?? null}
          value={readingValue}
          onChange={(v) => {
            setReadingValue(v);
            if (readingError) setReadingError(null);
          }}
          error={readingError}
        />
      ) : null}
      <NameField
        value={name}
        onChange={(v) => {
          setName(v);
          if (!v.trim()) picked.current = null;
          if (nameError) setNameError(null);
        }}
        onSubmit={submitName}
        kind={kind}
        aiOn={aiOn}
        error={nameError}
      />
      {kind === 'name' && online && target && !name.trim() ? (
        <FromTemplate
          tone="dark"
          className="mx-3 mt-2"
          locationId={target.locationId}
          onPick={(x) => {
            picked.current = x.id;
            setName(prefillOf(x).name);
          }}
        />
      ) : null}
      <ModeStrip value={mode} onChange={setMode} />
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 px-3.5 pt-3 pb-[max(1.125rem,env(safe-area-inset-bottom))]">
        <GalleryImport icon={<GalleryIcon />} onFiles={(f) => takeFiles(f, false)} />
        {cam.state === 'problem' ? (
          <FilePick
            camera
            label={shutterLabel(mode, armed ? addTo : null)}
            onFiles={(f) => takeFiles(f, true)}
            className="rounded-full"
          >
            <SideButton icon={<CameraIcon />} caption={t`Take a photo`} />
          </FilePick>
        ) : (
          <Shutter
            label={shutterLabel(mode, armed ? addTo : null)}
            onPress={shoot}
            isDisabled={
              cam.state !== 'live' || !frameReady || !target || (mode === 'reading' && !reading)
            }
          />
        )}
        <PhotoToThis
          armed={armed}
          onChange={setArmed}
          receipt={mode === 'receipt'}
          available={addTo !== null && mode !== 'reading'}
        />
      </div>

      {world && readingSheet ? (
        // Mounted only while open: it reads the phone's copy each time it opens.
        <ReadingSheet
          isOpen={readingSheet}
          onClose={() => setReadingSheet(false)}
          store={store}
          locations={world.locations}
          value={reading}
          onPick={(r) => {
            setReading(r);
            setReadingSheet(false);
          }}
        />
      ) : null}
      {target && world ? (
        <PlaceSheet
          isOpen={sheet}
          onClose={() => setSheet(false)}
          locations={world.locations}
          placesOf={placesOf}
          value={target}
          onPick={(locationId, pid) => {
            pick({ locationId, placeId: pid, containerId: null, why: 'chosen' });
            setSheet(false);
          }}
          suggest={suggest}
          onSuggest={(on) => {
            saveSuggest(on);
            if (!on) {
              setSuggest('off');
              return;
            }
            setSuggest('finding');
            void locate(world.locations).then((near) => {
              if (near) {
                const next = defaultTarget({
                  locations: world.locations,
                  placesOf,
                  personalLocationId,
                  nearby: near,
                });
                if (next) setTarget(next);
              }
            });
          }}
        />
      ) : null}
    </div>
  );
}

/** The summary, counting from the phone's queue while it is open. */
function SummaryPhase({
  store,
  shots,
  where,
  iphone,
  asOf,
  aiOn,
  onKeepCapturing,
  onDone,
  onUndo,
}: {
  store: OfflineStore;
  shots: readonly Shot[];
  where: string | null;
  iphone: boolean;
  asOf: string | null;
  aiOn: boolean;
  onKeepCapturing: () => void;
  onDone: () => void;
  onUndo: () => Promise<void>;
}) {
  const [pending, setPending] = useState<Set<string> | null>(null);
  const [undoing, setUndoing] = useState(false);
  useEffect(() => {
    let live = true;
    const read = async () => {
      const keys = new Set((await store.pending()).map((e) => e.idempotencyKey));
      if (live) setPending(keys);
    };
    void read();
    const id = setInterval(() => void read(), 2000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [store]);
  const waiting = pending
    ? shots.filter((s) => pending.has(s.idempotencyKey)).length
    : shots.length;
  return (
    <div className="fixed inset-0 z-40 overflow-y-auto md:relative md:inset-auto md:z-auto md:mx-auto md:my-4 md:max-w-[480px] md:overflow-hidden md:rounded-2xl md:border md:border-line">
      <CaptureSummary
        shots={shots.map((s) => ({
          key: s.idempotencyKey,
          thumb: s.thumb,
          waiting: pending ? pending.has(s.idempotencyKey) : true,
        }))}
        where={where}
        waiting={waiting}
        iphone={iphone}
        asOf={asOf}
        aiOn={aiOn}
        onKeepCapturing={onKeepCapturing}
        onDone={onDone}
        onUndo={
          shots.length
            ? () => {
                setUndoing(true);
                void onUndo().finally(() => setUndoing(false));
              }
            : null
        }
        undoing={undoing}
      />
    </div>
  );
}
