/**
 * The location map (1.x, D237): the third layout of a location's page beside List and Grid
 * (M11). Loaded on demand with three.js and its models (vite.config.ts), never precached: the map
 * needs a connection (M10 stays out).
 *
 * The scene is MapEngine's (engine/engine.ts, the approved spike's engine); this component draws
 * the controls around it (the breadcrumb, 3D or plan, Arrange, the pin chips, the floor buttons
 * like a lift, zoom, turn and home), the card, "Places on this level" for screen readers (M9), and
 * "What's in …" below. Arrange edits a copy of the plan; Done saves the session in one PUT (and
 * moves anything dragged into another room there in Kept first), Cancel throws it away.
 */
import {
  canHost,
  guessModel,
  type MapModelKey,
  type MapRoomKind,
  type MapSurface,
  ROOM_KIND_SURFACE,
} from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { isApiError } from '@/api/client';
import { inventoryApi, inventoryKeys } from '@/api/inventory/queries';
import { mapApi, mapKeys, useLocationMap } from '@/api/map/queries';
import type { MapAttentionKind, MapView as MapData, MapThingView } from '@/api/map/types';
import { useOfferUndo } from '@/components/history/undo';
import { ErrorState, LoadingRows, useErrorText } from '@/components/page';
import { useConfirm } from '@/components/ui/confirm';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { useFormat } from '@/lib/format';
import { type CardSel, MapCard } from './card';
import {
  type EngineState,
  type EngineStats,
  MapEngine,
  type Quality,
  type Tool,
} from './engine/engine';
import { modelStats } from './engine/models';
import {
  bodyOf,
  clampIn,
  contentsOf,
  countIn,
  flagsOf,
  type Item,
  type Plan,
  planOf,
  type Room,
} from './layout';
import { type ListQuery, type ListShow, whereOf } from './list';
import { WhatsIn } from './whats-in';
import './map.css';

const QUALITY_KEY = 'kept.map.quality';

function storedQuality(): Quality {
  try {
    return localStorage.getItem(QUALITY_KEY) === 'simple' ? 'simple' : 'detailed';
  } catch {
    return 'detailed';
  }
}

const clone = (p: Plan): Plan => ({
  levels: p.levels.map((l) => ({ ...l })),
  rooms: p.rooms.map((r) => ({ ...r })),
  items: p.items.map((i) => ({ ...i })),
});

export default function LocationMap({ locationId, name }: { locationId: string; name: string }) {
  const map = useLocationMap(locationId);
  if (map.isPending) return <LoadingRows />;
  if (map.error) return <ErrorState error={map.error} onRetry={() => void map.refetch()} />;
  return <MapBody key={locationId} data={map.data} locationId={locationId} name={name} />;
}

function MapBody({ data, locationId, name }: { data: MapData; locationId: string; name: string }) {
  const { t } = useLingui();
  const f = useFormat();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const offerUndo = useOfferUndo();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const debug = search.debug === 'map';

  const names = useMemo(() => ({ noFloor: t`Not on a floor`, location: name }), [t, name]);
  const serverPlan = useMemo(() => planOf(data, names), [data, names]);
  const contents = useMemo(() => contentsOf(data), [data]);
  const contentsRef = useRef(contents);
  contentsRef.current = contents;

  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<MapEngine | null>(null);
  const selKey = useRef('');
  const [plan, setPlanState] = useState<Plan>(serverPlan);
  const [es, setEs] = useState<EngineState>({
    levelKey: serverPlan.levels[0]?.key ?? '_',
    allFloors: false,
    focused: null,
    selected: null,
    planView: false,
    arranging: false,
    tool: 'move',
  });
  const [hint, setHint] = useState<Tool | 'overlap'>('move');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [quality, setQualityState] = useState<Quality>(storedQuality);
  const [shadows, setShadows] = useState(true);
  const [pins, setPins] = useState<Record<MapAttentionKind, boolean>>({
    low: true,
    lent: true,
    due: true,
  });
  const [stats, setStats] = useState<EngineStats | null>(null);
  const [detail, setDetail] = useState(false);
  const [inner, setInner] = useState<string | null>(null);
  const [glError, setGlError] = useState(false);
  const [version, setVersion] = useState(data.version);

  const words = useMemo(
    () => ({
      onIt: (x: string) => t`on it: ${x}`,
      more: (n: number) => t`+${n} more`,
      inside: (n: number) => t`${n} inside`,
      openFloor: t`click to open`,
      changeFloor: t`click to change floor`,
    }),
    [t],
  );

  // The map fills the screen below where it starts, down to the tab bar (and its raised Capture
  // button) on a phone: the whole map and its controls without scrolling. Before the engine is made,
  // so its first fit already frames the floor in that box.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const size = () => {
      const view = window.visualViewport?.height ?? window.innerHeight;
      const top = stage.getBoundingClientRect().top + window.scrollY;
      const bar = document.querySelector<HTMLElement>('[data-tab-bar]');
      const below = bar && bar.getClientRects().length > 0 ? bar.offsetHeight + 24 : 0;
      stage.style.height = `${Math.max(320, Math.round(view - top - below - 12))}px`;
    };
    size();
    window.addEventListener('resize', size);
    window.visualViewport?.addEventListener('resize', size);
    return () => {
      window.removeEventListener('resize', size);
      window.visualViewport?.removeEventListener('resize', size);
    };
  }, []);

  // The engine: made once, fed new plans after a save or a reload; it reads its other inputs
  // through refs and setters.
  // biome-ignore lint/correctness/useExhaustiveDependencies: made once per mount
  useEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    const labels = labelsRef.current;
    const tip = tipRef.current;
    if (!stage || !canvas || !labels || !tip) return;
    let engine: MapEngine;
    try {
      engine = new MapEngine({
        stage,
        canvas,
        labels,
        tip,
        plan: clone(serverPlan),
        quality,
        levelKey: serverPlan.levels[0]?.key ?? '_',
        info: {
          countIn: (it) => countIn(contentsRef.current, it),
          flags: (id) => flagsOf(contentsRef.current, id),
          preview: (it) =>
            (contentsRef.current.under.get(it.id) ?? []).slice(0, 2).map((x) => ({
              name: x.name,
              quantity: x.quantity,
            })),
          insideCount: (it) => (contentsRef.current.under.get(it.id) ?? []).length,
          text: words,
        },
        events: {
          onState: (s) => {
            // A new selection starts as the strip.
            const key = s.selected ? `${s.selected.type}:${s.selected.id}` : '';
            if (key !== selKey.current) {
              selKey.current = key;
              setDetail(false);
              setInner(null);
            }
            setEs(s);
          },
          onChange: () => {
            setDirty(true);
            setPlanState(clone(engine.plan));
          },
          onDrawRoom: (rect, levelKey) => void drawRoom(rect, levelKey),
          onHint: setHint,
          ...(debug ? { onStats: setStats } : {}),
        },
      });
    } catch (e) {
      console.warn(e);
      setGlError(true);
      return;
    }
    engineRef.current = engine;
    setEs(engine.state);
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  // A new map from the server (a save, an undo elsewhere, a refetch): not while arranging.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the server's map changes
  useEffect(() => {
    setVersion(data.version);
    if (es.arranging) return;
    const next = clone(serverPlan);
    setPlanState(next);
    engineRef.current?.setPlan(clone(serverPlan));
  }, [serverPlan, data.version]);

  useEffect(() => {
    engineRef.current?.setPins(pins);
  }, [pins]);

  const engine = engineRef.current;
  const levelName = plan.levels.find((l) => l.key === es.levelKey)?.name ?? '';
  const focusedRoom = es.focused ? plan.rooms.find((r) => r.id === es.focused) : undefined;
  const sel: CardSel | null = es.selected;

  const refresh = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: mapKeys.map(locationId) });
    await qc.invalidateQueries({ queryKey: inventoryKeys.places.all });
  }, [qc, locationId]);

  // ---- Arranging -----------------------------------------------------------------------------

  const mutate = (fn: (p: Plan) => void) => {
    const e = engineRef.current;
    if (!e) return;
    fn(e.plan);
    e.changed();
  };

  async function drawRoom(rect: { x: number; z: number; w: number; d: number }, levelKey: string) {
    const e = engineRef.current;
    if (!e) return;
    const level = e.plan.levels.find((l) => l.key === levelKey);
    const n = e.plan.rooms.filter((r) => r.levelKey === levelKey).length + 1;
    try {
      const created = await inventoryApi.createPlace(locationId, {
        name: t`Room ${n}`,
        kindKey: 'room',
        parentId: level?.id ?? null,
      });
      const room: Room = {
        id: created.id,
        levelKey,
        name: created.name,
        shortCode: created.shortCode,
        kindKey: 'room',
        ...rect,
        kind: 'room',
        surface: ROOM_KIND_SURFACE.room,
      };
      e.plan.rooms.push(room);
      e.changed();
      e.setTool('move');
      e.selectRoom(room.id);
      void qc.invalidateQueries({ queryKey: inventoryKeys.places.all });
    } catch (err) {
      toast({ title: t`Couldn’t add the room`, description: errorText(err), tone: 'danger' });
    }
  }

  async function addFloor() {
    const e = engineRef.current;
    if (!e) return;
    const n = e.plan.levels.filter((l) => l.id !== null).length + 1;
    try {
      const floor = await inventoryApi.createPlace(locationId, {
        name: t`Floor ${n}`,
        kindKey: 'floor',
        parentId: null,
      });
      const room = await inventoryApi.createPlace(locationId, {
        name: t`Room 1`,
        kindKey: 'room',
        parentId: floor.id,
      });
      const key = floor.id;
      e.plan.levels.push({ key, id: floor.id, name: floor.name, short: String(n) });
      e.plan.rooms.push({
        id: room.id,
        levelKey: key,
        name: room.name,
        shortCode: room.shortCode,
        kindKey: 'room',
        x: 0,
        z: 0,
        w: 4,
        d: 4,
        kind: 'room',
        surface: 'wood',
      });
      e.changed();
      e.setLevel(key);
      void qc.invalidateQueries({ queryKey: inventoryKeys.places.all });
    } catch (err) {
      toast({ title: t`Couldn’t add the floor`, description: errorText(err), tone: 'danger' });
    }
  }

  function addThing(roomId: string, x: MapThingView) {
    mutate((p) => {
      const room = p.rooms.find((r) => r.id === roomId);
      if (!room) return;
      const model = guessModel({ name: x.name, subject: 'thing' });
      const it: Item = {
        id: x.id,
        subject: 'thing',
        roomId,
        name: x.name,
        shortCode: x.shortCode,
        model,
        x: room.w / 2 - 0.3,
        z: room.d / 2 - 0.3,
        rot: 0,
        on: null,
        parentId: x.parentId,
        isContainer: false,
        quantity: x.quantity,
        auto: false,
      };
      clampIn(it, room);
      p.items.push(it);
    });
    engineRef.current?.select({ type: 'item', id: x.id });
  }

  function setShape(id: string, model: MapModelKey) {
    mutate((p) => {
      const it = p.items.find((i) => i.id === id);
      const room = p.rooms.find((r) => r.id === it?.roomId);
      if (!it || !room) return;
      it.model = model;
      if (!it.on) clampIn(it, room);
      if (!canHost(model)) for (const c of p.items) if (c.on === id) c.on = null;
    });
    engineRef.current?.select({ type: 'item', id });
  }

  function removeItem(id: string) {
    mutate((p) => {
      p.items = p.items.filter((i) => i.id !== id);
      for (const c of p.items) if (c.on === id) c.on = null;
    });
    engineRef.current?.select(null);
  }

  function setRoom(id: string, change: { kind?: MapRoomKind; surface?: MapSurface }) {
    mutate((p) => {
      const r = p.rooms.find((x) => x.id === id);
      if (!r) return;
      if (change.kind) {
        r.kind = change.kind;
        r.surface = ROOM_KIND_SURFACE[change.kind];
      }
      if (change.surface) r.surface = change.surface;
    });
    engineRef.current?.select({ type: 'room', id });
  }

  async function startArranging() {
    if (!engineRef.current) return;
    setDirty(false);
    engineRef.current.setArranging(true);
  }

  async function cancelArranging() {
    if (
      dirty &&
      !(await confirm({
        title: t`Throw away these changes?`,
        body: t`The map goes back to how it was. Rooms and floors you added stay in Kept.`,
        confirmLabel: t`Throw away`,
        destructive: true,
      }))
    )
      return;
    const e = engineRef.current;
    if (!e) return;
    e.setArranging(false);
    e.setPlan(clone(serverPlan));
    setPlanState(clone(serverPlan));
    setDirty(false);
    void refresh();
  }

  async function done() {
    const e = engineRef.current;
    if (!e) return;
    if (!dirty) {
      e.setArranging(false);
      return;
    }
    setSaving(true);
    const events: string[] = [];
    try {
      // Anything dragged into another room moves there in Kept too.
      // Where Kept has each node now: its room on the server's map, or for a thing put on the map
      // in this session, the room it is in.
      const was = new Map(serverPlan.items.map((i) => [i.id, i.roomId]));
      for (const it of e.plan.items) {
        if (!was.has(it.id)) was.set(it.id, whereOf(serverPlan, data, it.id).roomId ?? it.roomId);
      }
      const byRoom = new Map<string, string[]>();
      for (const it of e.plan.items) {
        const before = was.get(it.id);
        if (!before || before === it.roomId) continue;
        if (it.subject === 'thing')
          byRoom.set(it.roomId, [...(byRoom.get(it.roomId) ?? []), it.id]);
        else {
          const place = await inventoryApi.place(it.id);
          const moved = await inventoryApi.updatePlace(
            it.id,
            { parentId: it.roomId },
            place.rowVersion,
          );
          events.push(...moved.auditEvents);
        }
      }
      for (const [roomId, thingIds] of byRoom) {
        const moved = await inventoryApi.move({ thingIds, to: { placeId: roomId } });
        events.push(...moved.auditEvents);
      }
      const saved = await mapApi.saveLayout(locationId, bodyOf(e.plan, version));
      events.push(...saved.auditEvents);
      setVersion(saved.body.version);
      e.setArranging(false);
      setDirty(false);
      offerUndo({ title: t`Map arranged` }, events, { onUndone: () => void refresh() });
      await refresh();
    } catch (err) {
      const reason = isApiError(err)
        ? (err.details as { reason?: string } | undefined)?.reason
        : undefined;
      toast({
        title:
          reason === 'arranged_since'
            ? t`Someone arranged this map since you opened it`
            : t`Couldn’t save the map`,
        description: errorText(err),
        tone: 'danger',
      });
      if (reason === 'arranged_since') {
        e.setArranging(false);
        setDirty(false);
        await refresh();
      }
    } finally {
      setSaving(false);
    }
  }

  function setQuality(q: Quality) {
    setQualityState(q);
    try {
      localStorage.setItem(QUALITY_KEY, q);
    } catch {
      // Remembering the choice is a convenience: the map works without it.
    }
    engineRef.current?.setQuality(q);
  }

  // ---- The list's state, in the address -------------------------------------------------------

  const query: ListQuery = {
    q: typeof search.find === 'string' ? search.find : '',
    floor: typeof search.floor === 'string' ? search.floor : 'all',
    show: search.show === 'attention' ? 'attention' : 'room',
  };
  const setQuery = (next: Partial<ListQuery>, replace = false) => {
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        ...(next.q !== undefined ? { find: next.q || undefined } : {}),
        ...(next.floor !== undefined
          ? { floor: next.floor === 'all' ? undefined : next.floor }
          : {}),
        ...(next.show !== undefined
          ? { show: next.show === 'room' ? undefined : (next.show satisfies ListShow) }
          : {}),
      }),
      replace,
    });
  };

  const showOnMap = (target: CardSel, innerId: string | null = null) => {
    const e = engineRef.current;
    if (!e) return;
    const roomId =
      target.type === 'room' ? target.id : plan.items.find((i) => i.id === target.id)?.roomId;
    const room = plan.rooms.find((r) => r.id === roomId);
    if (room && (es.allFloors || room.levelKey !== es.levelKey)) e.setLevel(room.levelKey);
    else if (es.focused && es.focused !== roomId) e.up();
    e.select(target);
    setInner(innerId);
    if (innerId) setDetail(true);
    stageRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  /** A list row: a node shows itself; a thing shows the node or room it is in, with its card. */
  const pickThing = (id: string) => {
    if (plan.items.some((i) => i.id === id)) return showOnMap({ type: 'item', id });
    const thing = data.things.find((x) => x.id === id);
    if (!thing) return;
    const parent = thing.parentId;
    if (plan.items.some((i) => i.id === parent)) showOnMap({ type: 'item', id: parent }, id);
    else showOnMap({ type: 'room', id: parent }, id);
  };

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if ((ev.target as HTMLElement | null)?.closest?.('input, textarea')) return;
      if (ev.key !== 'Escape') return;
      const e = engineRef.current;
      if (inner) setInner(null);
      else if (detail) setDetail(false);
      else if (es.selected) e?.select(null);
      else if (es.focused) e?.up();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [inner, detail, es.selected, es.focused]);

  const levels = plan.levels;
  const placesHere = plan.rooms.filter((r) => r.levelKey === es.levelKey);
  const pinWords: Record<MapAttentionKind, { long: string; short: string }> = {
    low: { long: t`Low stock`, short: t`Low` },
    lent: { long: t`Lent out`, short: t`Lent` },
    due: { long: t`Due soon`, short: t`Due` },
  };
  const hints: Record<Tool | 'overlap', string> = {
    move: t`Drag anything to move it. Drop small things on a counter, desk, shelf or box. Drag a room’s amber corner to resize it.`,
    room: t`Drag on empty ground to draw a new room on this floor.`,
    overlap: t`Rooms can’t overlap. Draw on empty ground.`,
  };

  return (
    <div className="kmap grid gap-6">
      <section
        className="kmap-stage"
        ref={stageRef}
        data-card={sel ? 'true' : 'false'}
        aria-label={t`Map of ${name}`}
      >
        <canvas ref={canvasRef} />
        <div ref={labelsRef} className="kmap-labels" aria-hidden="true" />
        <div ref={tipRef} className="kmap-tip" hidden />
        {glError ? (
          <div className="absolute inset-0 grid place-items-center p-6 text-center text-ink-2">
            <Trans>This browser can’t draw the map. The list below has everything on it.</Trans>
          </div>
        ) : null}
        <div className="kmap-bar" data-map-reserve="top">
          <nav data-map-obstacle className="kmap-crumb" aria-label={t`Where you are on the map`}>
            <button type="button" onClick={() => engine?.showAll()}>
              {name}
            </button>
            {!es.allFloors && levels.length > 1 ? (
              <>
                <span aria-hidden="true">›</span>
                <button type="button" onClick={() => engine?.up()}>
                  {levelName}
                </button>
              </>
            ) : null}
            {focusedRoom ? (
              <>
                <span aria-hidden="true">›</span>
                <span>{focusedRoom.name}</span>
              </>
            ) : null}
          </nav>
          <fieldset data-map-obstacle className="kmap-seg" aria-label={t`View`}>
            <button
              type="button"
              aria-pressed={!es.planView}
              onClick={() => engine?.setPlanView(false)}
            >
              <Trans>3D</Trans>
            </button>
            <button
              type="button"
              aria-pressed={es.planView}
              onClick={() => engine?.setPlanView(true)}
            >
              <Trans>Plan</Trans>
            </button>
          </fieldset>
          {data.canArrange ? (
            es.arranging ? (
              <button
                type="button"
                className="kmap-btn primary"
                disabled={saving}
                onClick={() => void done()}
              >
                {saving ? <Trans>Saving…</Trans> : <Trans>Done</Trans>}
              </button>
            ) : (
              <button
                type="button"
                data-map-obstacle
                className="kmap-btn"
                onClick={() => void startArranging()}
              >
                <Trans>Arrange</Trans>
              </button>
            )
          ) : null}
          <fieldset data-map-obstacle className="kmap-chips" aria-label={t`Pins`}>
            {(['low', 'lent', 'due'] as const).map((k) => (
              <button
                key={k}
                type="button"
                className="kmap-chip"
                aria-pressed={pins[k]}
                onClick={() => setPins((p) => ({ ...p, [k]: !p[k] }))}
              >
                <span className={`kmap-dot ${k}`} aria-hidden="true" />
                <span className="kmap-long">{pinWords[k].long}</span>
                <span className="kmap-short">{pinWords[k].short}</span>
              </button>
            ))}
          </fieldset>
        </div>
        {es.arranging ? (
          <div className="kmap-tools" data-map-obstacle data-map-reserve="top">
            <fieldset className="kmap-seg" aria-label={t`Arrange tool`}>
              <button
                type="button"
                aria-pressed={es.tool === 'move'}
                onClick={() => engine?.setTool('move')}
              >
                <Trans>Move</Trans>
              </button>
              <button
                type="button"
                aria-pressed={es.tool === 'room'}
                onClick={() => engine?.setTool('room')}
              >
                <Trans>Draw a room</Trans>
              </button>
            </fieldset>
            <button type="button" className="kmap-btn" onClick={() => void addFloor()}>
              <Trans>Add a floor</Trans>
            </button>
            <button type="button" className="kmap-btn" onClick={() => void cancelArranging()}>
              <Trans>Cancel</Trans>
            </button>
            <div className="kmap-hint">{hints[hint]}</div>
          </div>
        ) : null}
        <div className="kmap-ctl" data-map-obstacle data-map-reserve="bottom">
          {levels.length > 1 ? (
            <fieldset className="kmap-floors" aria-label={t`Floor`}>
              {[...levels].reverse().map((l) => (
                <button
                  key={l.key}
                  type="button"
                  style={{ ['--o' as string]: String(levels.indexOf(l)) }}
                  aria-label={l.name}
                  title={l.name}
                  aria-pressed={!es.allFloors && l.key === es.levelKey}
                  onClick={() => engine?.setLevel(l.key)}
                >
                  {l.short}
                </button>
              ))}
              <button
                type="button"
                className="all"
                style={{ ['--o' as string]: '99' }}
                aria-label={t`All floors`}
                title={t`All floors`}
                aria-pressed={es.allFloors}
                onClick={() => engine?.showAll()}
              >
                <Trans>All</Trans>
              </button>
            </fieldset>
          ) : null}
          <button type="button" aria-label={t`Zoom in`} onClick={() => engine?.zoomBy(1.4)}>
            +
          </button>
          <button type="button" aria-label={t`Zoom out`} onClick={() => engine?.zoomBy(1 / 1.4)}>
            −
          </button>
          {es.planView ? null : (
            <>
              <button type="button" aria-label={t`Turn left`} onClick={() => engine?.turnBy(1)}>
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M4 12a8 8 0 1 0 2.4-5.7" />
                  <path d="M4 4v4h4" />
                </svg>
              </button>
              <button
                type="button"
                className="kmap-turn-end"
                aria-label={t`Turn right`}
                onClick={() => engine?.turnBy(-1)}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M20 12a8 8 0 1 1-2.4-5.7" />
                  <path d="M20 4v4h-4" />
                </svg>
              </button>
            </>
          )}
          <button type="button" aria-label={t`Show the whole floor`} onClick={() => engine?.home()}>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M4 11l8-7 8 7v9H4z" />
            </svg>
          </button>
        </div>
        <div className="kmap-readout" data-map-obstacle data-map-reserve="bottom">
          {debug && stats ? (
            <div>
              <b>{stats.fps ?? '–'}</b> fps · worst{' '}
              <b>{stats.worst ? stats.worst.toFixed(0) : '–'}</b> ms · <b>{stats.calls}</b> draw
              calls · {(stats.triangles / 1000).toFixed(0)}k tris
              <br />
              {quality === 'detailed'
                ? `${stats.models} models · ${(stats.bytes / 1024).toFixed(0)} KB${stats.loading ? ` · loading ${stats.loading}` : ''}${stats.failed ? ` · ${stats.failed} failed` : ''}`
                : 'simple: nothing downloaded'}{' '}
              · first draw <b>{stats.firstDraw ? stats.firstDraw.toFixed(0) : '–'}</b> ms
            </div>
          ) : null}
          <div className="kmap-toggles">
            <Switch
              className="min-h-8 gap-2 text-[12.5px]"
              isSelected={quality === 'detailed'}
              onChange={(on) => setQuality(on ? 'detailed' : 'simple')}
            >
              <Trans>Detailed models</Trans>
            </Switch>
            {debug ? (
              <Switch
                className="min-h-8 gap-2 text-[12.5px]"
                isSelected={shadows}
                onChange={(on) => {
                  setShadows(on);
                  engine?.setShadows(on);
                }}
              >
                shadows
              </Switch>
            ) : null}
          </div>
        </div>
        {sel ? (
          <MapCard
            sel={sel}
            plan={plan}
            view={data}
            contents={contents}
            level={plan.levels.find((l) => l.key === es.levelKey)}
            focused={es.focused}
            arranging={es.arranging}
            inner={inner}
            setInner={(id) => {
              setInner(id);
              if (id) setDetail(true);
            }}
            detail={detail}
            setDetail={setDetail}
            onClose={() => engine?.select(null)}
            onSelect={(s) => engine?.select(s)}
            onOpenRoom={(id) => engine?.drill(id)}
            onGoLevel={(key) => engine?.setLevel(key)}
            onTurn={(id) => engine?.turnItem(id)}
            onShape={setShape}
            onRemove={removeItem}
            onRoomKind={(id, kind) => setRoom(id, { kind })}
            onSurface={(id, surface) => setRoom(id, { surface })}
            onAdd={addThing}
          />
        ) : null}
      </section>

      {/* M9: the map for screen readers and keyboards, as a list beside it. */}
      <section className="sr-only focus-within:not-sr-only" aria-label={t`Places on this level`}>
        <h2 className="m-0 font-semibold text-[16px]">
          <Trans>Places on this level</Trans>
        </h2>
        <ul className="m-0 grid list-none gap-1 p-0">
          {placesHere.map((r) => {
            const inRoom = plan.items.filter((i) => i.roomId === r.id && !i.on);
            return (
              <li key={r.id}>
                <button
                  type="button"
                  className="kmap-nm"
                  onClick={() => showOnMap({ type: 'room', id: r.id })}
                >
                  {r.name}
                </button>
                {inRoom.length ? (
                  <ul className="kmap-crows">
                    {inRoom.map((i) => (
                      <li key={i.id}>
                        <button type="button" onClick={() => showOnMap({ type: 'item', id: i.id })}>
                          {i.name}
                          {countIn(contents, i) !== null
                            ? ` · ${f.num(countIn(contents, i) ?? 0)}`
                            : ''}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>

      <WhatsIn
        name={name}
        plan={plan}
        view={data}
        contents={contents}
        query={query}
        setQuery={setQuery}
        onRoom={(id) => showOnMap({ type: 'room', id })}
        onThing={pickThing}
      />
      <p className="text-small text-ink-3">
        <Trans>
          Furniture, plants and the AC units are free models from Poly Haven (CC0), shrunk for
          phones. Turn off Detailed models to download none.
        </Trans>
      </p>
      {debug ? <p className="text-small text-ink-3">{JSON.stringify(modelStats())}</p> : null}
    </div>
  );
}
