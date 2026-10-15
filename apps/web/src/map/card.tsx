/**
 * The map's card (1.x, D237; the spike's compact card): a short strip first (name, where, short
 * ID, anything due), Details for the label and the facts, Inside for what's in it. A thing picked
 * from Inside shows its own card. Everything links to Kept's real place and thing pages. While
 * arranging, the card also turns a thing, changes its shape, takes it off the map, and sets a
 * room's kind and floor, or puts a thing of the room on the map.
 */
import {
  MAP_ROOM_KINDS,
  MAP_SURFACES,
  type MapModelKey,
  type MapRoomKind,
  type MapSurface,
  STAIR_MODELS,
} from '@kept/shared';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useMemo, useState } from 'react';
import { usePlace, useThing } from '@/api/inventory/queries';
import type { MapAttention, MapAttentionKind, MapThingView, MapView } from '@/api/map/types';
import { ThingCount } from '@/components/counts';
import { useValueWords } from '@/components/history/labels';
import { CameraIcon } from '@/components/icons';
import { IdChip, printedCode } from '@/components/id-chip';
import { useTypeName } from '@/components/things/names';
import { QrCode } from '@/components/ui/qr-code';
import { useFormat } from '@/lib/format';
import { useModelNames, useRoomKindNames, useSurfaceNames } from './labels';
import {
  allUnder,
  type Contents,
  countIn,
  flagsOf,
  type Item,
  type Level,
  type Plan,
  type Room,
} from './layout';
import { matches, whereOf } from './list';
import { ShapeField, shapeInputOf } from './shapes';

export type CardSel = { type: 'room' | 'item'; id: string };

export type CardProps = {
  sel: CardSel;
  plan: Plan;
  view: MapView;
  contents: Contents;
  level: Level | undefined;
  focused: string | null;
  arranging: boolean;
  /** A thing picked from an Inside list, shown as its own card. */
  inner: string | null;
  setInner: (id: string | null) => void;
  detail: boolean;
  setDetail: (on: boolean) => void;
  onClose: () => void;
  onSelect: (sel: CardSel) => void;
  onOpenRoom: (roomId: string) => void;
  onGoLevel: (key: string) => void;
  onTurn: (id: string) => void;
  onShape: (id: string, model: MapModelKey) => void;
  onRemove: (id: string) => void;
  onRoomKind: (id: string, kind: MapRoomKind) => void;
  onSurface: (id: string, surface: MapSurface) => void;
  onAdd: (roomId: string, thing: MapThingView) => void;
};

function Dots({ flags }: { flags: MapAttentionKind[] }) {
  return flags.map((k) => <span key={k} className={`kmap-dot ${k}`} aria-hidden="true" />);
}

/** "Lent to Bruce, back by 20 Oct", "2 left, keep at least 6", "Descale: due 21 Oct". */
export function useAttentionWords() {
  const { t } = useLingui();
  const f = useFormat();
  return (a: MapAttention): string => {
    if (a.kind === 'low') {
      const left = f.num(a.quantity ?? 0);
      const min = f.num(a.min ?? 0);
      return t`${left} left, keep at least ${min}`;
    }
    if (a.kind === 'lent') {
      const who = a.person ?? t`someone`;
      if (!a.dueOn) return t`Lent to ${who}`;
      const back = f.day(a.dueOn);
      return t`Lent to ${who}, back by ${back}`;
    }
    const what =
      a.title ??
      (a.sourceType === 'warranty'
        ? t`Warranty`
        : a.sourceType === 'thing_expiry'
          ? t`Expires`
          : a.sourceType === 'reading_stale'
            ? t`Reading`
            : t`Due`);
    if (!a.dueOn) return what;
    const when = f.day(a.dueOn);
    return a.state === 'overdue' ? t`${what}: overdue since ${when}` : t`${what}: due ${when}`;
  };
}

function StatusRows({ rows }: { rows: MapAttention[] }) {
  const words = useAttentionWords();
  if (!rows.length) return null;
  return (
    <div className="kmap-status">
      {rows.map((a) => (
        <div key={`${a.kind}:${a.sourceType ?? ''}:${a.dueOn ?? ''}:${a.title ?? ''}`}>
          <span className={`kmap-dot ${a.kind}`} aria-hidden="true" />
          <span>{words(a)}</span>
        </div>
      ))}
    </div>
  );
}

/** The label: Kept's own QR (the address a printed label carries, D120) and the short ID. */
function IdBlock({ code, place }: { code: string | null; place: boolean }) {
  const { t } = useLingui();
  if (!code) return null;
  const url = `${window.location.origin}/l/${code}`;
  const printed = printedCode(code);
  return (
    <div className="kmap-idrow">
      <div className="kmap-qr">
        <QrCode value={url} label={t`QR label for ${printed}`} size={72} />
      </div>
      <div className="grid min-w-0 gap-1">
        <span className="kmap-sub">
          {place ? <Trans>Label of this place</Trans> : <Trans>Label of this thing</Trans>}
        </span>
        <span className="kmap-code">{printed}</span>
        <small className="text-ink-3 [overflow-wrap:anywhere]" dir="ltr">
          {url.replace(/^https?:\/\//, '')}
        </small>
      </div>
    </div>
  );
}

function Head({
  title,
  meta,
  onClose,
}: {
  title: ReactNode;
  meta: ReactNode;
  onClose: () => void;
}) {
  const { t } = useLingui();
  return (
    <div className="kmap-peek">
      <div className="grid min-w-0 gap-1">
        <h2>{title}</h2>
        <div className="kmap-meta">{meta}</div>
      </div>
      <button type="button" className="kmap-x" onClick={onClose} aria-label={t`Close`}>
        ×
      </button>
    </div>
  );
}

/** A thing's facts, read from Kept when its card's details open. */
function ThingFacts({ id }: { id: string }) {
  const thing = useThing(id);
  const words = useValueWords();
  const typeName = useTypeName();
  const f = useFormat();
  const d = thing.data;
  if (!d) return null;
  const facts: [ReactNode, ReactNode][] = [];
  facts.push([<Trans key="t">Type</Trans>, typeName(d.type)]);
  if (d.quantity !== 1) facts.push([<Trans key="q">Quantity</Trans>, f.num(d.quantity)]);
  if (d.brand) facts.push([<Trans key="b">Brand</Trans>, d.brand.name]);
  if (d.model) facts.push([<Trans key="m">Model</Trans>, d.model]);
  if (d.serial)
    facts.push([
      <Trans key="s">Serial</Trans>,
      <span key="sv" className="font-mono" dir="ltr">
        {d.serial}
      </span>,
    ]);
  if (d.condition) facts.push([<Trans key="c">Condition</Trans>, words('condition', d.condition)]);
  return (
    <dl className="kmap-facts">
      {facts.map(([a, b], i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list rebuilt each render
        <div key={i} className="contents">
          <dt>{a}</dt>
          <dd>{b}</dd>
        </div>
      ))}
    </dl>
  );
}

function ThingPhoto({ id }: { id: string }) {
  const thing = useThing(id);
  return <Photo url={thing.data?.thumbUrl ?? null} />;
}

function Photo({ url }: { url: string | null }) {
  const { t } = useLingui();
  return (
    <div className="kmap-photo" title={url ? undefined : t`No photo yet`}>
      {url ? <img src={url} alt="" /> : <CameraIcon aria-hidden="true" />}
    </div>
  );
}

function PlaceKind({ id }: { id: string }) {
  const place = usePlace(id);
  const n = place.data?.counts.places ?? 0;
  if (!place.data || n === 0) return null;
  return <Plural value={n} one="# place in it" other="# places in it" />;
}

function OpenLink({ id, subject }: { id: string; subject: 'place' | 'thing' }) {
  return subject === 'thing' ? (
    <Link to="/t/$id" params={{ id }} className="kmap-btn">
      <Trans>Open the thing</Trans>
    </Link>
  ) : (
    <Link to="/p/$id" params={{ id }} className="kmap-btn">
      <Trans>Open the place</Trans>
    </Link>
  );
}

function InsideList({
  things,
  contents,
  onPick,
  filter,
}: {
  things: MapThingView[];
  contents: Contents;
  onPick: (id: string) => void;
  filter: string;
}) {
  const f = useFormat();
  const rows = things.filter((x) => matches(filter, x.name, x.shortCode));
  if (!rows.length)
    return (
      <p className="kmap-empty">
        <Trans>Nothing matches.</Trans>
      </p>
    );
  return (
    <ul className="kmap-inv">
      {rows.map((x) => (
        <li key={x.id}>
          <button type="button" onClick={() => onPick(x.id)}>
            <span>
              {x.name}
              <Dots flags={flagsOf(contents, x.id)} />
            </span>
            <small>{x.shortCode ? printedCode(x.shortCode) : ' '}</small>
            <span className="q">×{f.num(x.quantity)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function MapCard(p: CardProps) {
  const { t } = useLingui();
  const f = useFormat();
  const models = useModelNames();
  const kinds = useRoomKindNames();
  const surfaces = useSurfaceNames();
  const [filter, setFilter] = useState('');
  const [adding, setAdding] = useState('');
  const { plan, view, contents } = p;
  const rooms = useMemo(() => new Map(plan.rooms.map((r) => [r.id, r])), [plan.rooms]);

  // A thing picked from an Inside list.
  if (p.inner) {
    const thing = view.things.find((x) => x.id === p.inner);
    const node = plan.items.find((x) => x.id === p.inner);
    const name = node?.name ?? thing?.name ?? '';
    const code = node?.shortCode ?? thing?.shortCode ?? null;
    const where = whereOf(plan, view, p.inner).path;
    const back =
      p.sel.type === 'item'
        ? plan.items.find((x) => x.id === p.sel.id)?.name
        : rooms.get(p.sel.id)?.name;
    return (
      <aside data-map-obstacle className="kmap-panel full" aria-live="polite">
        <div className="kmap-row">
          <button type="button" className="kmap-btn ghost" onClick={() => p.setInner(null)}>
            <span className="rtl:-scale-x-100" aria-hidden="true">
              ‹
            </span>{' '}
            {back}
          </button>
        </div>
        <Head
          title={name}
          meta={
            <>
              <span>{where.join(' › ')}</span>
              {code ? <IdChip code={code} /> : null}
            </>
          }
          onClose={p.onClose}
        />
        <StatusRows rows={contents.rows.get(p.inner) ?? []} />
        <IdBlock code={code} place={false} />
        <ThingFacts id={p.inner} />
        <div className="kmap-row">
          <OpenLink id={p.inner} subject="thing" />
        </div>
      </aside>
    );
  }

  if (p.sel.type === 'room') {
    const r = rooms.get(p.sel.id) as Room | undefined;
    if (!r) return null;
    const inside = plan.items.filter((i) => i.roomId === r.id);
    const things = allUnder(contents, r.id).length;
    const full = p.detail || p.arranging;
    const nodeIds = new Set(plan.items.map((i) => i.id));
    const addable = view.things
      .filter((x) => !nodeIds.has(x.id) && whereOf(plan, view, x.id).roomId === r.id)
      .filter((x) => matches(adding, x.name, x.shortCode))
      .slice(0, 30);
    const w = f.num(Math.round(r.w * 10) / 10);
    const d = f.num(Math.round(r.d * 10) / 10);
    return (
      <aside data-map-obstacle className={`kmap-panel${full ? ' full' : ''}`} aria-live="polite">
        <Head
          title={r.name}
          meta={
            <>
              <span>{kinds[r.kind]}</span>
              {p.level ? <span>{p.level.name}</span> : null}
              <span>
                <Trans>
                  {w} × {d} m
                </Trans>
              </span>
              <span>
                <ThingCount n={things} />
              </span>
            </>
          }
          onClose={p.onClose}
        />
        <div className="kmap-row">
          {p.focused === r.id ? null : (
            <button type="button" className="kmap-btn primary" onClick={() => p.onOpenRoom(r.id)}>
              <Trans context="map: go into the room">Open</Trans>
            </button>
          )}
          {full ? null : (
            <button type="button" className="kmap-btn" onClick={() => p.setDetail(true)}>
              <Trans>What’s here · {inside.length}</Trans>
            </button>
          )}
          <Link to="/p/$id" params={{ id: r.id }} className="kmap-btn">
            <Trans>Open the place</Trans>
          </Link>
        </div>
        {p.arranging ? (
          <>
            <div className="kmap-sub">
              <Trans>Kind</Trans>
            </div>
            <fieldset className="kmap-seg" aria-label={t`Kind`}>
              {MAP_ROOM_KINDS.map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={r.kind === k}
                  onClick={() => p.onRoomKind(r.id, k)}
                >
                  {kinds[k]}
                </button>
              ))}
            </fieldset>
            <div className="kmap-sub">
              <Trans>Floor</Trans>
            </div>
            <fieldset className="kmap-seg" aria-label={t`Floor`}>
              {MAP_SURFACES.map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={r.surface === k}
                  onClick={() => p.onSurface(r.id, k)}
                >
                  {surfaces[k]}
                </button>
              ))}
            </fieldset>
            <div className="kmap-sub">
              <Trans>Put on the map</Trans>
            </div>
            <input
              type="search"
              className="kmap-input"
              value={adding}
              onChange={(e) => setAdding(e.target.value)}
              placeholder={t`Find a thing in ${r.name}`}
              aria-label={t`Find a thing to put on the map`}
            />
            {addable.length ? (
              <ul className="kmap-inv">
                {addable.map((x) => (
                  <li key={x.id}>
                    <button type="button" onClick={() => p.onAdd(r.id, x)}>
                      <span>{x.name}</span>
                      <small>{x.shortCode ? printedCode(x.shortCode) : ' '}</small>
                      <span className="q">+</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="kmap-empty">
                <Trans>Everything here is on the map.</Trans>
              </p>
            )}
          </>
        ) : null}
        {full && !p.arranging ? (
          <ul className="kmap-inv">
            {inside.map((i) => {
              const n = countIn(contents, i);
              const host = i.on ? plan.items.find((x) => x.id === i.on)?.name : null;
              return (
                <li key={i.id}>
                  <button type="button" onClick={() => p.onSelect({ type: 'item', id: i.id })}>
                    <span>
                      {i.name}
                      <Dots flags={flagsOf(contents, i.id)} />
                    </span>
                    <small>
                      {i.shortCode ? printedCode(i.shortCode) : ''}
                      {host ? (
                        <>
                          {' '}
                          · <Trans>on {host}</Trans>
                        </>
                      ) : null}
                    </small>
                    <span className="q">{n !== null ? f.num(n) : ''}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </aside>
    );
  }

  const it = plan.items.find((x) => x.id === p.sel.id) as Item | undefined;
  if (!it) return null;
  const room = rooms.get(it.roomId);
  const n = countIn(contents, it);
  const under = contents.under.get(it.id) ?? [];
  const onIt = plan.items.filter((x) => x.on === it.id);
  const path = whereOf(plan, view, it.id).path;
  const hosts: string[] = [];
  for (
    let h = it.on ? plan.items.find((x) => x.id === it.on) : undefined, i = 0;
    h && i < 10;
    i++
  ) {
    hosts.unshift(h.name);
    h = h.on ? plan.items.find((x) => x.id === h?.on) : undefined;
  }
  const meta = [...(path.length ? path : room ? [room.name] : []), ...hosts].join(' › ');
  const levels = plan.levels;
  const li = levels.findIndex((l) => l.key === room?.levelKey);
  const stairs = STAIR_MODELS.has(it.model)
    ? [levels[li + 1], levels[li - 1]].filter((l): l is Level => !!l)
    : [];
  const within = (['low', 'lent', 'due'] as const)
    .map(
      (k) =>
        [
          k,
          allUnder(contents, it.id).filter((x) => contents.own.get(x.id)?.has(k)).length,
        ] as const,
    )
    .filter(([, c]) => c > 0);
  const own = contents.rows.get(it.id) ?? [];
  const insideWords: Record<MapAttentionKind, (c: number) => string> = {
    low: (c) => t`${c} running low inside`,
    lent: (c) => t`${c} lent out inside`,
    due: (c) => t`${c} due inside`,
  };
  const buttons = (
    <div className="kmap-row">
      {stairs.map((l) => (
        <button
          key={l.key}
          type="button"
          className="kmap-btn primary"
          onClick={() => p.onGoLevel(l.key)}
        >
          {levels.indexOf(l) > li ? (
            <Trans context="map: go up a floor">Up to {l.name}</Trans>
          ) : (
            <Trans>Down to {l.name}</Trans>
          )}
        </button>
      ))}
      {n !== null && !p.detail ? (
        <button
          type="button"
          className={`kmap-btn${stairs.length ? '' : ' primary'}`}
          onClick={() => p.setDetail(true)}
        >
          <Trans>Inside · {n}</Trans>
        </button>
      ) : null}
      {p.detail ? null : (
        <button type="button" className="kmap-btn" onClick={() => p.setDetail(true)}>
          <Trans>Details</Trans>
        </button>
      )}
      {p.arranging ? (
        <button type="button" className="kmap-btn" onClick={() => p.onTurn(it.id)}>
          <Trans>Turn</Trans>
        </button>
      ) : null}
      {p.arranging && !it.auto ? (
        <button type="button" className="kmap-btn" onClick={() => p.onRemove(it.id)}>
          <Trans>Take off the map</Trans>
        </button>
      ) : null}
      {p.detail ? (
        <button type="button" className="kmap-btn ghost" onClick={() => p.setDetail(false)}>
          <Trans>Less</Trans>
        </button>
      ) : null}
    </div>
  );
  const headEl = (
    <Head
      title={it.name}
      meta={
        <>
          <span>{meta}</span>
          {it.shortCode ? <IdChip code={it.shortCode} /> : null}
        </>
      }
      onClose={p.onClose}
    />
  );
  const insideLine = within.length ? (
    <div className="kmap-status">
      <div>
        {within.map(([k, c]) => (
          <span key={k} className="inline-flex items-baseline gap-1.5">
            <span className={`kmap-dot ${k}`} aria-hidden="true" />
            <span>{insideWords[k](c)}</span>
          </span>
        ))}
      </div>
    </div>
  ) : null;
  const shape = p.arranging ? (
    <ShapeField item={it} input={shapeInputOf(view, it)} onShape={p.onShape} />
  ) : null;
  if (!p.detail) {
    return (
      <aside data-map-obstacle className="kmap-panel" aria-live="polite">
        {headEl}
        <StatusRows rows={own} />
        {insideLine}
        {buttons}
        {shape}
      </aside>
    );
  }
  return (
    <aside data-map-obstacle className="kmap-panel full" aria-live="polite">
      {headEl}
      <div className="kmap-card-head">
        {it.subject === 'thing' ? <ThingPhoto id={it.id} /> : <Photo url={null} />}
        <div className="grid min-w-0 gap-1 text-[13px] text-ink-2">
          <span>
            {models[it.model]}
            {n !== null ? (
              <>
                {' · '}
                <Plural value={n} one="# thing inside" other="# things inside" />
              </>
            ) : null}
          </span>
          <span className="[overflow-wrap:anywhere]">{meta}</span>
          {it.subject === 'place' ? <PlaceKind id={it.id} /> : null}
        </div>
      </div>
      <StatusRows rows={own} />
      {buttons}
      {shape}
      <IdBlock code={it.shortCode} place={it.subject === 'place' || it.isContainer} />
      {it.subject === 'thing' ? <ThingFacts id={it.id} /> : null}
      <div className="kmap-row">
        <OpenLink id={it.id} subject={it.subject} />
      </div>
      {onIt.length ? (
        <>
          <div className="kmap-sub">
            <Trans>On it</Trans>
          </div>
          <ul className="kmap-inv">
            {onIt.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => p.onSelect({ type: 'item', id: c.id })}>
                  <span>
                    {c.name}
                    <Dots flags={flagsOf(contents, c.id)} />
                  </span>
                  <small>{c.shortCode ? printedCode(c.shortCode) : ' '}</small>
                  <span className="q">{countIn(contents, c) ?? ''}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {n !== null ? (
        <>
          <div className="kmap-sub">
            <Trans>Inside · {n}</Trans>
          </div>
          {under.length > 5 ? (
            <input
              type="search"
              className="kmap-input"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t`Find inside ${it.name}`}
              aria-label={t`Find inside`}
            />
          ) : null}
          {under.length ? (
            <InsideList
              things={under}
              contents={contents}
              onPick={(id) => p.setInner(id)}
              filter={filter}
            />
          ) : (
            <p className="kmap-empty">
              <Trans>Nothing in it yet.</Trans>
            </p>
          )}
        </>
      ) : null}
    </aside>
  );
}
