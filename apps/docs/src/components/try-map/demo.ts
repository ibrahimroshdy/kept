/**
 * "Try the map" (D241): Kept's shipped location map on the docs site, with a sample home.
 *
 * The scene is the app's own: MapEngine, the plan, the label declutter and map.css come straight
 * from apps/web/src/map (1.6.0, D237), and so do the 21 Poly Haven models, bundled from the same
 * files. What the app wraps around the engine is a React component tied to its router, queries,
 * auth and Lingui catalogues; this is that component's controls and card again in plain DOM, fed
 * by the sample instead of the server, so the page needs no framework and no app code beyond the
 * map's. Arrange works in memory: Done keeps the changes while the page is open, Cancel throws the
 * session away, and Reset puts the sample back. Nothing is saved or sent; only the Detailed models
 * choice is remembered, as the app remembers it.
 */
import {
  canHost,
  levelShort,
  MAP_MODEL_KEYS,
  MAP_ROOM_KINDS,
  MAP_SURFACES,
  type MapModelKey,
  type MapRoomKind,
  type MapSurface,
  printedCode,
  ROOM_KIND_SURFACE,
  SHAPE_GROUP,
  SHAPE_GROUPS,
  type ShapeInput,
  STAIR_MODELS,
  searchShapes,
  shapeOnAdd,
  suggestShapes,
} from '@kept/shared';
import type {
  MapAttention,
  MapAttentionKind,
  MapThingView,
} from '../../../../web/src/api/map/types';
import {
  type EngineState,
  type EngineStats,
  MapEngine,
  type Quality,
  type Tool,
} from '../../../../web/src/map/engine/engine';
import { modelStats } from '../../../../web/src/map/engine/models';
import {
  allUnder,
  clampIn,
  contentsOf,
  countIn,
  flagsOf,
  type Item,
  type Level,
  type Plan,
  planOf,
  type Room,
} from '../../../../web/src/map/layout';
import { matches, whereOf } from '../../../../web/src/map/list';
// Inline, not imported as stylesheets: Astro would link those from every page of the site.
import mapCss from '../../../../web/src/map/map.css?inline';
// D249: the shape picker's pictures, the app's own sprite (fetched when the picker first opens).
import spriteUrl from '../../../../web/src/map/thumbs/shapes.webp?url';
import { THUMB_CELLS, THUMB_COLS } from '../../../../web/src/map/thumbs/sprite';
import demoCss from './demo.css?inline';
import { sampleHome } from './sample';
import {
  formatter,
  GROUP_NAMES,
  type Lang,
  MODEL_NAMES,
  ROOM_KIND_NAMES,
  SURFACE_NAMES,
  WORDS,
} from './strings';

const QUALITY_KEY = 'kept.map.quality';
const KINDS = ['low', 'lent', 'due'] as const;

const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

const clone = (p: Plan): Plan => ({
  levels: p.levels.map((l) => ({ ...l })),
  rooms: p.rooms.map((r) => ({ ...r })),
  items: p.items.map((i) => ({ ...i })),
});

function storedQuality(): Quality {
  try {
    return localStorage.getItem(QUALITY_KEY) === 'simple' ? 'simple' : 'detailed';
  } catch {
    return 'detailed';
  }
}

const ICON = {
  turnLeft:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4h4"/></svg>',
  turnRight:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4h-4"/></svg>',
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M4 11l8-7 8 7v9H4z"/></svg>',
  camera:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 7h3l2-3h4l2 3h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z"/><circle cx="12" cy="13" r="3.5"/></svg>',
};

export type MountOptions = {
  lang: Lang;
  /** Where "Install Kept" goes (the site's install page, with its base path). */
  installHref: string;
};

export function mount(root: HTMLElement, { lang, installHref }: MountOptions): () => void {
  const w = WORDS[lang];
  const f = formatter(lang);
  const pick = (two: readonly [string, string]) => (lang === 'ar' ? two[1] : two[0]);
  const debug = new URLSearchParams(location.search).get('debug') === 'map';

  const sample = sampleHome(lang);
  const view = sample.view;
  const name = sample.location;
  const contents = contentsOf(view);
  const samplePlan = planOf(view, { noFloor: w.noFloor, location: name });

  // ---- The page ------------------------------------------------------------------------------

  const host = root.querySelector<HTMLElement>('[data-try-map]');
  if (!host) throw new Error('try-map: no [data-try-map] element');
  const style = document.createElement('style');
  style.textContent = `${mapCss}\n${demoCss}`;
  document.head.append(style);
  host.innerHTML = `
    <div class="kmap kd-map">
      <section class="kmap-stage" data-card="false" aria-label="${esc(w.mapOf(name))}">
        <canvas></canvas>
        <div class="kmap-labels" aria-hidden="true"></div>
        <div class="kmap-tip" hidden></div>
        <div class="kd-overlay" data-slot="overlay"></div>
      </section>
      <section class="kd-sr" data-slot="places" aria-label="${esc(w.placesHere)}"></section>
    </div>`;
  const stage = host.querySelector<HTMLElement>('.kmap-stage') as HTMLElement;
  const canvas = host.querySelector<HTMLCanvasElement>('canvas') as HTMLCanvasElement;
  const labels = host.querySelector<HTMLElement>('.kmap-labels') as HTMLElement;
  const tip = host.querySelector<HTMLElement>('.kmap-tip') as HTMLElement;
  const overlay = host.querySelector<HTMLElement>('[data-slot="overlay"]') as HTMLElement;
  const places = host.querySelector<HTMLElement>('[data-slot="places"]') as HTMLElement;

  // ---- State, as the app's MapBody keeps it ---------------------------------------------------

  let saved = clone(samplePlan);
  let plan = clone(saved);
  let es: EngineState = {
    levelKey: plan.levels[0]?.key ?? '_',
    allFloors: false,
    focused: null,
    selected: null,
    planView: false,
    arranging: false,
    tool: 'move',
  };
  let hint: Tool | 'overlap' = 'move';
  let dirty = false;
  let quality = storedQuality();
  let pins: Record<MapAttentionKind, boolean> = { low: true, lent: true, due: true };
  let detail = false;
  let inner: string | null = null;
  let filter = '';
  let adding = '';
  let glError = false;
  let selKey = '';
  let seq = 0;
  let engine: MapEngine | null = null;

  // ---- Words for a thing ---------------------------------------------------------------------

  const attentionWords = (a: MapAttention): string => {
    if (a.kind === 'low') return w.low(f.num(a.quantity ?? 0), f.num(a.min ?? 0));
    if (a.kind === 'lent') {
      const who = a.person ?? w.someone;
      return a.dueOn ? w.lentBack(who, f.day(a.dueOn)) : w.lentTo(who);
    }
    const what = a.title ?? w.dueWord;
    if (!a.dueOn) return what;
    return a.state === 'overdue' ? w.overdue(what, f.day(a.dueOn)) : w.dueOn(what, f.day(a.dueOn));
  };
  const dots = (flags: MapAttentionKind[]) =>
    flags.map((k) => `<span class="kmap-dot ${k}" aria-hidden="true"></span>`).join('');
  const chip = (code: string | null) =>
    code
      ? `<bdi dir="ltr" role="img" aria-label="${esc(code)}" class="kd-id"><span aria-hidden="true">${esc(printedCode(code))}</span></bdi>`
      : '';
  const statusRows = (rows: MapAttention[]) =>
    rows.length
      ? `<div class="kmap-status">${rows
          .map(
            (a) =>
              `<div><span class="kmap-dot ${a.kind}" aria-hidden="true"></span><span>${esc(attentionWords(a))}</span></div>`,
          )
          .join('')}</div>`
      : '';
  const idBlock = (code: string | null, place: boolean) =>
    code
      ? `<div class="kmap-idrow kd-idrow"><div class="kd-idtext"><span class="kmap-sub">${esc(place ? w.labelPlace : w.labelThing)}</span><span class="kmap-code" dir="ltr">${esc(printedCode(code))}</span></div></div>`
      : '';
  const factsOf = (id: string) => {
    const x = sample.facts.get(id);
    if (!x) return '';
    // [label, value as HTML]
    const rows: [string, string][] = [];
    if (x.quantity !== undefined && x.quantity !== 1)
      rows.push([w.facts.quantity, esc(f.num(x.quantity))]);
    if (x.brand) rows.push([w.facts.brand, esc(x.brand)]);
    if (x.model) rows.push([w.facts.model, esc(x.model)]);
    if (x.serial)
      rows.push([w.facts.serial, `<span dir="ltr" class="kd-mono">${esc(x.serial)}</span>`]);
    if (x.condition) rows.push([w.facts.condition, esc(x.condition)]);
    if (!rows.length) return '';
    return `<dl class="kmap-facts">${rows.map(([a, b]) => `<dt>${esc(a)}</dt><dd>${b}</dd>`).join('')}</dl>`;
  };
  const install = `<a class="kmap-btn" href="${esc(installHref)}">${esc(w.install)}</a>`;
  const head = (title: string, meta: string) =>
    `<div class="kmap-peek"><div class="kd-col"><h2>${esc(title)}</h2><div class="kmap-meta">${meta}</div></div><button type="button" class="kmap-x" data-act="close" data-k="close" aria-label="${esc(w.close)}">×</button></div>`;
  const btn = (act: string, label: string, cls = '', arg = '') =>
    `<button type="button" class="kmap-btn${cls ? ` ${cls}` : ''}" data-act="${act}"${arg ? ` data-arg="${esc(arg)}"` : ''} data-k="${esc(`${act}:${arg}`)}">${esc(label)}</button>`;

  // ---- The card (apps/web/src/map/card.tsx) ---------------------------------------------------

  function insideList(things: MapThingView[]) {
    const rows = things.filter((x) => matches(filter, x.name, x.shortCode));
    if (!rows.length) return `<p class="kmap-empty">${esc(w.nothingMatches)}</p>`;
    return `<ul class="kmap-inv">${rows
      .map(
        (x) =>
          `<li><button type="button" data-act="inner" data-arg="${esc(x.id)}" data-k="inner:${esc(x.id)}"><span>${esc(x.name)}${dots(flagsOf(contents, x.id))}</span><small>${x.shortCode ? esc(printedCode(x.shortCode)) : ' '}</small><span class="q">×${esc(f.num(x.quantity))}</span></button></li>`,
      )
      .join('')}</ul>`;
  }

  function card(): string {
    const sel = es.selected;
    if (!sel) return '';
    const rooms = new Map(plan.rooms.map((r) => [r.id, r]));

    if (inner) {
      const thing = view.things.find((x) => x.id === inner);
      const node = plan.items.find((x) => x.id === inner);
      const title = node?.name ?? thing?.name ?? '';
      const code = node?.shortCode ?? thing?.shortCode ?? null;
      const where = whereOf(plan, view, inner).path;
      const back =
        sel.type === 'item'
          ? plan.items.find((x) => x.id === sel.id)?.name
          : rooms.get(sel.id)?.name;
      return `<aside data-map-obstacle class="kmap-panel full" aria-live="polite">
        <div class="kmap-row"><button type="button" class="kmap-btn ghost" data-act="back" data-k="back"><span class="kd-flip" aria-hidden="true">‹</span> ${esc(back ?? '')}</button></div>
        ${head(title, `<span>${esc(where.join(' › '))}</span>${chip(code)}`)}
        ${statusRows(contents.rows.get(inner) ?? [])}
        ${idBlock(code, false)}
        ${factsOf(inner)}
        <div class="kmap-row">${install}</div>
      </aside>`;
    }

    if (sel.type === 'room') {
      const r = rooms.get(sel.id);
      if (!r) return '';
      const inside = plan.items.filter((i) => i.roomId === r.id);
      const total = allUnder(contents, r.id).length;
      const full = detail || es.arranging;
      const level = plan.levels.find((l) => l.key === es.levelKey);
      const meta = [
        `<span>${esc(pick(ROOM_KIND_NAMES[r.kind]))}</span>`,
        level ? `<span>${esc(level.name)}</span>` : '',
        `<span>${esc(w.size(f.num(Math.round(r.w * 10) / 10), f.num(Math.round(r.d * 10) / 10)))}</span>`,
        `<span>${esc(w.things(total, f.num(total)))}</span>`,
      ].join('');
      let body = `<div class="kmap-row">${es.focused === r.id ? '' : btn('drill', w.open, 'primary', r.id)}${full ? '' : btn('detail', w.whatsHere(f.num(inside.length)))}</div>`;
      if (es.arranging) {
        const nodeIds = new Set(plan.items.map((i) => i.id));
        const addable = view.things
          .filter((x) => !nodeIds.has(x.id) && whereOf(plan, view, x.id).roomId === r.id)
          .filter((x) => matches(adding, x.name, x.shortCode))
          .slice(0, 30);
        body += `<div class="kmap-sub">${esc(w.kind)}</div>
          <fieldset class="kmap-seg" aria-label="${esc(w.kind)}">${MAP_ROOM_KINDS.map(
            (k) =>
              `<button type="button" aria-pressed="${r.kind === k}" data-act="kind" data-arg="${k}" data-k="kind:${k}">${esc(pick(ROOM_KIND_NAMES[k]))}</button>`,
          ).join('')}</fieldset>
          <div class="kmap-sub">${esc(w.surface)}</div>
          <fieldset class="kmap-seg" aria-label="${esc(w.surface)}">${MAP_SURFACES.map(
            (k) =>
              `<button type="button" aria-pressed="${r.surface === k}" data-act="surface" data-arg="${k}" data-k="surface:${k}">${esc(pick(SURFACE_NAMES[k]))}</button>`,
          ).join('')}</fieldset>
          <div class="kmap-sub">${esc(w.putOnMap)}</div>
          <input type="search" class="kmap-input" data-input="adding" data-k="adding" value="${esc(adding)}" placeholder="${esc(w.findThingIn(r.name))}" aria-label="${esc(w.findThingLabel)}">
          ${
            addable.length
              ? `<ul class="kmap-inv">${addable
                  .map(
                    (x) =>
                      `<li><button type="button" data-act="add" data-arg="${esc(x.id)}" data-k="add:${esc(x.id)}"><span>${esc(x.name)}</span><small>${x.shortCode ? esc(printedCode(x.shortCode)) : ' '}</small><span class="q">+</span></button></li>`,
                  )
                  .join('')}</ul>`
              : `<p class="kmap-empty">${esc(w.everythingOnMap)}</p>`
          }`;
      }
      if (full && !es.arranging) {
        body += `<ul class="kmap-inv">${inside
          .map((i) => {
            const n = countIn(contents, i);
            const on = i.on ? plan.items.find((x) => x.id === i.on)?.name : null;
            return `<li><button type="button" data-act="select" data-arg="${esc(i.id)}" data-k="select:${esc(i.id)}"><span>${esc(i.name)}${dots(flagsOf(contents, i.id))}</span><small>${i.shortCode ? esc(printedCode(i.shortCode)) : ''}${on ? ` · ${esc(w.onHost(on))}` : ''}</small><span class="q">${n !== null ? esc(f.num(n)) : ''}</span></button></li>`;
          })
          .join('')}</ul>`;
      }
      return `<aside data-map-obstacle class="kmap-panel${full ? ' full' : ''}" aria-live="polite">${head(r.name, meta)}${body}</aside>`;
    }

    const it = plan.items.find((x) => x.id === sel.id);
    if (!it) return '';
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
      const next: string | null = h.on;
      h = next ? plan.items.find((x) => x.id === next) : undefined;
    }
    const meta = [...(path.length ? path : room ? [room.name] : []), ...hosts].join(' › ');
    const levels = plan.levels;
    const li = levels.findIndex((l) => l.key === room?.levelKey);
    const stairs = STAIR_MODELS.has(it.model)
      ? [levels[li + 1], levels[li - 1]].filter((l): l is Level => !!l)
      : [];
    const within = KINDS.map(
      (k) =>
        [
          k,
          allUnder(contents, it.id).filter((x) => contents.own.get(x.id)?.has(k)).length,
        ] as const,
    ).filter(([, c]) => c > 0);
    const own = contents.rows.get(it.id) ?? [];
    const buttons = `<div class="kmap-row">
      ${stairs
        .map((l) =>
          btn(
            'level',
            levels.indexOf(l) > li ? w.upTo(l.name) : w.downTo(l.name),
            'primary',
            l.key,
          ),
        )
        .join('')}
      ${n !== null && !detail ? btn('detail', w.insideN(f.num(n)), stairs.length ? '' : 'primary') : ''}
      ${detail ? '' : btn('detail', w.details)}
      ${es.arranging ? btn('turn', w.turn, '', it.id) : ''}
      ${es.arranging && !it.auto ? btn('remove', w.takeOff, '', it.id) : ''}
      ${detail ? btn('less', w.less, 'ghost') : ''}
    </div>`;
    const headEl = head(it.name, `<span>${esc(meta)}</span>${chip(it.shortCode)}`);
    const insideLine = within.length
      ? `<div class="kmap-status"><div>${within
          .map(
            ([k, c]) =>
              `<span class="kd-within"><span class="kmap-dot ${k}" aria-hidden="true"></span><span>${esc(w.within[k](f.num(c)))}</span></span>`,
          )
          .join('')}</div></div>`
      : '';
    const shape = es.arranging
      ? `<div class="kmap-shape"><span>${esc(w.shapeLine(pick(MODEL_NAMES[it.model]), it.shapeFrom))}</span>${btn(
          'shapes',
          it.shapeFrom === 'guess' ? w.pickShape : w.change,
          it.shapeFrom === 'guess' ? 'primary' : '',
          it.id,
        ).replace('<button ', '<button aria-haspopup="dialog" ')}</div>`
      : '';
    if (!detail) {
      return `<aside data-map-obstacle class="kmap-panel" aria-live="polite">${headEl}${statusRows(own)}${insideLine}${buttons}${shape}</aside>`;
    }
    const insideSection =
      n !== null
        ? `<div class="kmap-sub">${esc(w.insideN(f.num(n)))}</div>
          ${under.length > 5 ? `<input type="search" class="kmap-input" data-input="filter" data-k="filter" value="${esc(filter)}" placeholder="${esc(w.findInside(it.name))}" aria-label="${esc(w.findInsideLabel)}">` : ''}
          ${under.length ? insideList(under) : `<p class="kmap-empty">${esc(w.nothingYet)}</p>`}`
        : '';
    const onItSection = onIt.length
      ? `<div class="kmap-sub">${esc(w.onIt)}</div><ul class="kmap-inv">${onIt
          .map(
            (c) =>
              `<li><button type="button" data-act="select" data-arg="${esc(c.id)}" data-k="select:${esc(c.id)}"><span>${esc(c.name)}${dots(flagsOf(contents, c.id))}</span><small>${c.shortCode ? esc(printedCode(c.shortCode)) : ' '}</small><span class="q">${esc(countIn(contents, c) ?? '')}</span></button></li>`,
          )
          .join('')}</ul>`
      : '';
    return `<aside data-map-obstacle class="kmap-panel full" aria-live="polite">
      ${headEl}
      <div class="kmap-card-head">
        <div class="kmap-photo" title="${esc(w.noPhoto)}">${ICON.camera}</div>
        <div class="kd-col kd-small">
          <span>${esc(pick(MODEL_NAMES[it.model]))}${n !== null ? ` · ${esc(w.thingsInside(n, f.num(n)))}` : ''}</span>
          <span class="kd-wrap">${esc(meta)}</span>
        </div>
      </div>
      ${statusRows(own)}
      ${buttons}
      ${shape}
      ${idBlock(it.shortCode, it.subject === 'place' || it.isContainer)}
      ${it.subject === 'thing' ? factsOf(it.id) : ''}
      <div class="kmap-row">${install}</div>
      ${onItSection}
      ${insideSection}
    </aside>`;
  }

  // ---- The controls (apps/web/src/map/map-view.tsx) ------------------------------------------

  function controls(): string {
    const levels = plan.levels;
    const levelName = levels.find((l) => l.key === es.levelKey)?.name ?? '';
    const focusedRoom = es.focused ? plan.rooms.find((r) => r.id === es.focused) : undefined;
    const crumb = `<nav data-map-obstacle class="kmap-crumb" aria-label="${esc(w.where)}">
        <button type="button" data-act="all" data-k="crumb-all">${esc(name)}</button>
        ${!es.allFloors && levels.length > 1 ? `<span aria-hidden="true">›</span><button type="button" data-act="up" data-k="crumb-up">${esc(levelName)}</button>` : ''}
        ${focusedRoom ? `<span aria-hidden="true">›</span><span>${esc(focusedRoom.name)}</span>` : ''}
      </nav>`;
    const seg = `<fieldset data-map-obstacle class="kmap-seg" aria-label="${esc(w.view)}">
        <button type="button" aria-pressed="${!es.planView}" data-act="view3d" data-k="view3d">${esc(w.threeD)}</button>
        <button type="button" aria-pressed="${es.planView}" data-act="viewplan" data-k="viewplan">${esc(w.plan)}</button>
      </fieldset>`;
    const arrange = es.arranging
      ? `<button type="button" class="kmap-btn primary" data-act="done" data-k="done">${esc(w.done)}</button>`
      : `<button type="button" data-map-obstacle class="kmap-btn" data-act="arrange" data-k="arrange">${esc(w.arrange)}</button>`;
    const chips = `<fieldset data-map-obstacle class="kmap-chips" aria-label="${esc(w.pins)}">${KINDS.map(
      (k) =>
        `<button type="button" class="kmap-chip" aria-pressed="${pins[k]}" data-act="pin" data-arg="${k}" data-k="pin:${k}"><span class="kmap-dot ${k}" aria-hidden="true"></span><span class="kmap-long">${esc(w.pin[k].long)}</span><span class="kmap-short">${esc(w.pin[k].short)}</span></button>`,
    ).join('')}</fieldset>`;
    const tools = es.arranging
      ? `<div class="kmap-tools" data-map-obstacle data-map-reserve="top">
          <fieldset class="kmap-seg" aria-label="${esc(w.arrangeTool)}">
            <button type="button" aria-pressed="${es.tool === 'move'}" data-act="tool" data-arg="move" data-k="tool:move">${esc(w.move)}</button>
            <button type="button" aria-pressed="${es.tool === 'room'}" data-act="tool" data-arg="room" data-k="tool:room">${esc(w.drawRoom)}</button>
          </fieldset>
          ${btn('floor', w.addFloor)}
          ${btn('cancel', w.cancel)}
          <div class="kmap-hint">${esc(w.hints[hint])}</div>
        </div>`
      : '';
    const floors =
      levels.length > 1
        ? `<fieldset class="kmap-floors" aria-label="${esc(w.floor)}">${[...levels]
            .reverse()
            .map(
              (l) =>
                `<button type="button" style="--o:${levels.indexOf(l)}" aria-label="${esc(l.name)}" title="${esc(l.name)}" aria-pressed="${!es.allFloors && l.key === es.levelKey}" data-act="level" data-arg="${esc(l.key)}" data-k="level:${esc(l.key)}">${esc(l.short)}</button>`,
            )
            .join(
              '',
            )}<button type="button" class="all" style="--o:99" aria-label="${esc(w.allFloors)}" title="${esc(w.allFloors)}" aria-pressed="${es.allFloors}" data-act="all" data-k="all">${esc(w.all)}</button></fieldset>`
        : '';
    const ctl = `<div class="kmap-ctl" data-map-obstacle data-map-reserve="bottom">
        ${floors}
        <button type="button" aria-label="${esc(w.zoomIn)}" data-act="zoomin" data-k="zoomin">+</button>
        <button type="button" aria-label="${esc(w.zoomOut)}" data-act="zoomout" data-k="zoomout">−</button>
        ${
          es.planView
            ? ''
            : `<button type="button" aria-label="${esc(w.turnLeft)}" data-act="turnleft" data-k="turnleft">${ICON.turnLeft}</button>
               <button type="button" class="kmap-turn-end" aria-label="${esc(w.turnRight)}" data-act="turnright" data-k="turnright">${ICON.turnRight}</button>`
        }
        <button type="button" aria-label="${esc(w.home)}" data-act="home" data-k="home">${ICON.home}</button>
      </div>`;
    const readout = `<div class="kmap-readout" data-map-obstacle data-map-reserve="bottom">
        ${debug ? '<div data-slot="stats"></div>' : ''}
        <div class="kmap-toggles">
          <button type="button" role="switch" class="kd-switch" aria-checked="${quality === 'detailed'}" data-act="quality" data-k="quality"><span class="kd-track" aria-hidden="true"><span class="kd-thumb"></span></span>${esc(w.detailed)}</button>
        </div>
      </div>`;
    const gl = glError ? `<div class="kd-glerror">${esc(w.glError)}</div>` : '';
    return `${gl}<div class="kmap-bar" data-map-reserve="top">${crumb}${seg}${arrange}${chips}</div>${tools}${ctl}${readout}${card()}`;
  }

  /** M9: the floor's rooms and what stands in them, for screen readers and keyboards. */
  function placesList(): string {
    const here = plan.rooms.filter((r) => r.levelKey === es.levelKey);
    return `<h2>${esc(w.placesHere)}</h2><ul>${here
      .map((r) => {
        const inRoom = plan.items.filter((i) => i.roomId === r.id && !i.on);
        return `<li><button type="button" class="kmap-nm" data-act="show-room" data-arg="${esc(r.id)}">${esc(r.name)}</button>${
          inRoom.length
            ? `<ul class="kmap-crows">${inRoom
                .map((i) => {
                  const n = countIn(contents, i);
                  return `<li><button type="button" data-act="show-item" data-arg="${esc(i.id)}">${esc(i.name)}${n !== null ? ` · ${esc(f.num(n))}` : ''}</button></li>`;
                })
                .join('')}</ul>`
            : ''
        }</li>`;
      })
      .join('')}</ul>`;
  }

  /** Redraws the controls and the card, keeping the focus (and a search's caret) where it was. */
  function render(): void {
    const active = document.activeElement as HTMLElement | null;
    const key = active && overlay.contains(active) ? active.dataset.k : undefined;
    const caret = active instanceof HTMLInputElement ? active.selectionStart : null;
    stage.dataset.card = es.selected ? 'true' : 'false';
    overlay.innerHTML = controls();
    places.innerHTML = placesList();
    if (key) {
      const el = overlay.querySelector<HTMLElement>(`[data-k="${CSS.escape(key)}"]`);
      el?.focus({ preventScroll: true });
      if (el instanceof HTMLInputElement && caret !== null) el.setSelectionRange(caret, caret);
    }
    resetButton.hidden = !changed();
  }

  const resetButton = root.querySelector<HTMLButtonElement>(
    '[data-act="reset"]',
  ) as HTMLButtonElement;
  const sampleJson = JSON.stringify(samplePlan);
  const changed = () => dirty || JSON.stringify(saved) !== sampleJson;

  // ---- Arranging, in memory ------------------------------------------------------------------

  const mutate = (fn: (p: Plan) => void) => {
    if (!engine) return;
    fn(engine.plan);
    engine.changed();
  };

  function drawRoom(rect: { x: number; z: number; w: number; d: number }, levelKey: string) {
    if (!engine) return;
    const n = engine.plan.rooms.filter((r) => r.levelKey === levelKey).length + 1;
    const room: Room = {
      id: `new-room-${++seq}`,
      levelKey,
      name: w.roomN(String(n)),
      shortCode: null,
      kindKey: 'room',
      ...rect,
      kind: 'room',
      surface: ROOM_KIND_SURFACE.room,
    };
    engine.plan.rooms.push(room);
    engine.changed();
    engine.setTool('move');
    engine.selectRoom(room.id);
  }

  function addFloor() {
    if (!engine) return;
    const n = engine.plan.levels.length + 1;
    const key = `new-floor-${++seq}`;
    const floorName = w.floorN(String(n));
    engine.plan.levels.push({ key, id: key, name: floorName, short: levelShort(floorName, n - 1) });
    engine.plan.rooms.push({
      id: `new-room-${++seq}`,
      levelKey: key,
      name: w.roomN('1'),
      shortCode: null,
      kindKey: 'room',
      x: 0,
      z: 0,
      w: 4,
      d: 4,
      kind: 'room',
      surface: 'wood',
    });
    engine.changed();
    engine.setLevel(key);
  }

  /** Shapes picked in this session, kept if the thing goes off the map and back on (D249). */
  const chosen = new Map<string, MapModelKey>();

  function addThing(roomId: string, id: string) {
    const x = view.things.find((t) => t.id === id);
    if (!x) return;
    mutate((p) => {
      const room = p.rooms.find((r) => r.id === roomId);
      if (!room) return;
      const { model, from } = shapeOnAdd(
        { name: x.name, typeKey: x.typeKey, typeName: x.typeName, isContainer: x.isContainer },
        chosen.get(x.id) ?? null,
      );
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
        isContainer: x.isContainer,
        quantity: x.quantity,
        auto: false,
        ...(from === 'chosen' ? {} : { shapeFrom: from }),
      };
      clampIn(it, room);
      p.items.push(it);
    });
    engine?.select({ type: 'item', id: x.id });
  }

  function setShape(id: string, model: MapModelKey) {
    mutate((p) => {
      const it = p.items.find((i) => i.id === id);
      const room = p.rooms.find((r) => r.id === it?.roomId);
      if (!it || !room) return;
      it.model = model;
      delete it.shapeFrom;
      chosen.set(id, model);
      if (!it.on) clampIn(it, room);
      if (!canHost(model)) for (const c of p.items) if (c.on === id) c.on = null;
    });
    engine?.select({ type: 'item', id });
  }

  function removeItem(id: string) {
    mutate((p) => {
      p.items = p.items.filter((i) => i.id !== id);
      for (const c of p.items) if (c.on === id) c.on = null;
    });
    engine?.select(null);
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
    engine?.select({ type: 'room', id });
  }

  function endArranging(keep: boolean) {
    if (!engine) return;
    if (keep) saved = clone(engine.plan);
    engine.setArranging(false);
    if (!keep) engine.setPlan(clone(saved));
    plan = clone(saved);
    dirty = false;
    render();
  }

  function reset() {
    saved = clone(samplePlan);
    plan = clone(saved);
    dirty = false;
    seq = 0;
    if (engine) {
      if (engine.state.arranging) engine.setArranging(false);
      engine.select(null, false);
      engine.setPlan(clone(saved));
      engine.setLevel(saved.levels[0]?.key ?? '_');
    }
    render();
  }

  function setQuality(q: Quality) {
    quality = q;
    try {
      localStorage.setItem(QUALITY_KEY, q);
    } catch {
      // Remembering the choice is a convenience: the map works without it.
    }
    engine?.setQuality(q);
    render();
  }

  const showOnMap = (target: { type: 'room' | 'item'; id: string }) => {
    if (!engine) return;
    const roomId =
      target.type === 'room' ? target.id : plan.items.find((i) => i.id === target.id)?.roomId;
    const room = plan.rooms.find((r) => r.id === roomId);
    if (room && (es.allFloors || room.levelKey !== es.levelKey)) engine.setLevel(room.levelKey);
    else if (es.focused && es.focused !== roomId) engine.up();
    engine.select(target);
    stage.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  // ---- The shape picker (apps/web/src/map/shapes.tsx), as a native modal dialog ---------------

  const names = Object.fromEntries(MAP_MODEL_KEYS.map((k) => [k, pick(MODEL_NAMES[k])])) as Record<
    MapModelKey,
    string
  >;
  const thumb = (m: MapModelKey, size = 52) => {
    const i = THUMB_CELLS[m];
    const x = -(i % THUMB_COLS) * size;
    const y = -Math.floor(i / THUMB_COLS) * size;
    return `<span class="kshape-thumb" aria-hidden="true" style="width:${size}px;height:${size}px;background-image:url(${spriteUrl});background-size:${THUMB_COLS * size}px auto;background-position:${x}px ${y}px"></span>`;
  };
  const shapeInputOf = (it: Item): ShapeInput => {
    const t = view.things.find((x) => x.id === it.id);
    return {
      name: it.name,
      typeKey: t?.typeKey ?? null,
      typeName: t?.typeName ?? null,
      isContainer: it.subject === 'place' || it.isContainer,
    };
  };

  function openShapes(id: string) {
    const it = plan.items.find((x) => x.id === id);
    if (!it) return;
    const input = shapeInputOf(it);
    const dlg = document.createElement('dialog');
    dlg.className = 'kd-shapes';
    dlg.dir = lang === 'ar' ? 'rtl' : 'ltr';
    dlg.setAttribute('aria-labelledby', 'kd-shapes-title');
    dlg.innerHTML = `<div class="kd-shapes-head"><h2 id="kd-shapes-title">${esc(w.shapeFor(it.name))}</h2><button type="button" class="kmap-x" data-shapes="close" aria-label="${esc(w.close)}">×</button></div>
      <input type="search" class="kmap-input" enterkeyhint="search" aria-label="${esc(w.findShape)}" placeholder="${esc(w.findShapeHint)}">
      <div class="kshape-list" role="listbox" aria-label="${esc(w.shapes)}"></div>`;
    const search = dlg.querySelector('input') as HTMLInputElement;
    const list = dlg.querySelector<HTMLElement>('[role="listbox"]') as HTMLElement;
    const option = (m: MapModelKey) =>
      `<div role="option" class="kshape-option" tabindex="-1" data-model="${m}" aria-selected="${m === it.model}"${m === it.model ? ' data-selected' : ''}>${thumb(m)}<span>${esc(names[m])}</span></div>`;
    const fill = () => {
      const q = search.value.trim();
      const sections: [string, MapModelKey[]][] = q
        ? [[w.shapesThatMatch, searchShapes(q, names)]]
        : [
            [w.suggested, suggestShapes(input).shapes.map((x) => x.model)],
            ...SHAPE_GROUPS.map(
              (g) =>
                [pick(GROUP_NAMES[g]), MAP_MODEL_KEYS.filter((m) => SHAPE_GROUP[m] === g)] as [
                  string,
                  MapModelKey[],
                ],
            ),
          ];
      const shown = sections.filter(([, ms]) => ms.length);
      list.innerHTML = shown.length
        ? shown
            .map(
              ([title, ms], i) =>
                `<div role="group" class="kshape-section" aria-labelledby="kd-sh-${i}"><div class="kshape-head" id="kd-sh-${i}" role="presentation">${esc(title)}</div>${ms.map(option).join('')}</div>`,
            )
            .join('')
        : `<p class="kd-shapes-empty">${esc(w.noShape(q))}</p>`;
      const opts = [...list.querySelectorAll<HTMLElement>('[role="option"]')];
      const first = opts.find((o) => o.dataset.model === it.model) ?? opts[0];
      if (first) first.tabIndex = 0;
    };
    const choose = (m: MapModelKey) => {
      dlg.close();
      if (m !== it.model || it.shapeFrom) setShape(it.id, m);
    };
    const focusOption = (to: HTMLElement | undefined) => {
      if (!to) return;
      for (const o of list.querySelectorAll<HTMLElement>('[role="option"]')) o.tabIndex = -1;
      to.tabIndex = 0;
      to.focus();
    };
    list.addEventListener('click', (ev) => {
      const o = (ev.target as HTMLElement).closest<HTMLElement>('[role="option"]');
      if (o?.dataset.model) choose(o.dataset.model as MapModelKey);
    });
    list.addEventListener('keydown', (ev) => {
      const cur = (ev.target as HTMLElement).closest<HTMLElement>('[role="option"]');
      if (!cur) return;
      const opts = [...list.querySelectorAll<HTMLElement>('[role="option"]')];
      const i = opts.indexOf(cur);
      const rtl = dlg.dir === 'rtl';
      const vertical = (down: boolean) => {
        const r = cur.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const rows = opts.filter((o) => {
          const top = o.getBoundingClientRect().top;
          return down ? top > r.top + 4 : top < r.top - 4;
        });
        if (!rows.length) return undefined;
        const tops = rows.map((o) => o.getBoundingClientRect().top);
        const row = down ? Math.min(...tops) : Math.max(...tops);
        return rows
          .filter((o) => Math.abs(o.getBoundingClientRect().top - row) < 4)
          .sort((a, b) => {
            const da = Math.abs(a.getBoundingClientRect().left + a.offsetWidth / 2 - cx);
            const db = Math.abs(b.getBoundingClientRect().left + b.offsetWidth / 2 - cx);
            return da - db;
          })[0];
      };
      const next: Record<string, () => HTMLElement | undefined> = {
        ArrowRight: () => opts[rtl ? i - 1 : i + 1],
        ArrowLeft: () => opts[rtl ? i + 1 : i - 1],
        ArrowDown: () => vertical(true),
        ArrowUp: () => vertical(false),
        Home: () => opts[0],
        End: () => opts[opts.length - 1],
      };
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        if (cur.dataset.model) choose(cur.dataset.model as MapModelKey);
      } else if (next[ev.key]) {
        ev.preventDefault();
        focusOption(next[ev.key]?.());
      }
    });
    search.addEventListener('input', fill);
    search.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowDown') return;
      ev.preventDefault();
      focusOption(list.querySelector<HTMLElement>('[role="option"][tabindex="0"]') ?? undefined);
    });
    dlg.querySelector('[data-shapes="close"]')?.addEventListener('click', () => dlg.close());
    dlg.addEventListener('click', (ev) => {
      if (ev.target === dlg) dlg.close();
    });
    dlg.addEventListener('close', () => {
      dlg.remove();
      overlay.querySelector<HTMLElement>(`[data-k="${CSS.escape(`shapes:${id}`)}"]`)?.focus();
    });
    fill();
    root.append(dlg);
    dlg.showModal();
  }

  // ---- Events --------------------------------------------------------------------------------

  const onClick = (ev: MouseEvent) => {
    const el = (ev.target as HTMLElement | null)?.closest<HTMLElement>('[data-act]');
    if (!el || !root.contains(el)) return;
    const arg = el.dataset.arg ?? '';
    const e = engine;
    const sel = es.selected;
    switch (el.dataset.act) {
      case 'reset':
        return reset();
      case 'quality':
        return setQuality(quality === 'detailed' ? 'simple' : 'detailed');
      case 'pin':
        pins = { ...pins, [arg]: !pins[arg as MapAttentionKind] };
        e?.setPins(pins);
        return render();
    }
    if (!e) return;
    switch (el.dataset.act) {
      case 'all':
        return e.showAll();
      case 'up':
        return e.up();
      case 'view3d':
        return e.setPlanView(false);
      case 'viewplan':
        return e.setPlanView(true);
      case 'arrange':
        dirty = false;
        return e.setArranging(true);
      case 'done':
        return endArranging(true);
      case 'cancel':
        return endArranging(false);
      case 'tool':
        return e.setTool(arg as Tool);
      case 'floor':
        return addFloor();
      case 'level':
        return e.setLevel(arg);
      case 'zoomin':
        return e.zoomBy(1.4);
      case 'zoomout':
        return e.zoomBy(1 / 1.4);
      case 'turnleft':
        return e.turnBy(1);
      case 'turnright':
        return e.turnBy(-1);
      case 'home':
        return e.home();
      case 'close':
        return e.select(null);
      case 'select':
        return e.select({ type: 'item', id: arg });
      case 'drill':
        return e.drill(arg);
      case 'detail':
        detail = true;
        return render();
      case 'less':
        detail = false;
        return render();
      case 'inner':
        inner = arg;
        detail = true;
        return render();
      case 'back':
        inner = null;
        return render();
      case 'turn':
        return e.turnItem(arg);
      case 'remove':
        return removeItem(arg);
      case 'shapes':
        return openShapes(arg);
      case 'kind':
        if (sel?.type === 'room') setRoom(sel.id, { kind: arg as MapRoomKind });
        return;
      case 'surface':
        if (sel?.type === 'room') setRoom(sel.id, { surface: arg as MapSurface });
        return;
      case 'add':
        if (sel?.type === 'room') addThing(sel.id, arg);
        return;
      case 'show-room':
        return showOnMap({ type: 'room', id: arg });
      case 'show-item':
        return showOnMap({ type: 'item', id: arg });
    }
  };
  const onInput = (ev: Event) => {
    const el = ev.target as HTMLInputElement;
    if (el.dataset.input === 'filter') filter = el.value;
    else if (el.dataset.input === 'adding') adding = el.value;
    else return;
    render();
  };
  const onKey = (ev: KeyboardEvent) => {
    if ((ev.target as HTMLElement | null)?.closest?.('input, textarea, dialog')) return;
    if (ev.key !== 'Escape' || !engine) return;
    if (inner) {
      inner = null;
      render();
    } else if (detail) {
      detail = false;
      render();
    } else if (es.selected) engine.select(null);
    else if (es.focused) engine.up();
  };
  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  addEventListener('keydown', onKey);

  // The controls are drawn before the engine is made, so its first fit leaves them clear.
  render();
  try {
    engine = new MapEngine({
      stage,
      canvas,
      labels,
      tip,
      plan: clone(saved),
      quality,
      levelKey: saved.levels[0]?.key ?? '_',
      info: {
        countIn: (it) => countIn(contents, it),
        flags: (id) => flagsOf(contents, id),
        preview: (it) =>
          (contents.under.get(it.id) ?? []).slice(0, 2).map((x) => ({
            name: x.name,
            quantity: x.quantity,
          })),
        insideCount: (it) => (contents.under.get(it.id) ?? []).length,
        text: w.engine,
      },
      events: {
        onState: (s) => {
          // A new selection starts as the strip.
          const k = s.selected ? `${s.selected.type}:${s.selected.id}` : '';
          if (k !== selKey) {
            selKey = k;
            detail = false;
            inner = null;
            filter = '';
            adding = '';
          }
          es = s;
          render();
        },
        onChange: () => {
          dirty = true;
          if (engine) plan = clone(engine.plan);
          render();
        },
        onDrawRoom: drawRoom,
        onHint: (h) => {
          if (h === hint) return;
          hint = h;
          render();
        },
        ...(debug
          ? {
              onStats: (s: EngineStats) => {
                const el = overlay.querySelector<HTMLElement>('[data-slot="stats"]');
                if (!el) return;
                const m = modelStats();
                el.textContent = `${s.fps ?? '–'} fps · worst ${s.worst ? s.worst.toFixed(0) : '–'} ms · ${s.calls} draw calls · ${(s.triangles / 1000).toFixed(0)}k tris · ${quality === 'detailed' ? `${m.count} models · ${(m.bytes / 1024).toFixed(0)} KB${m.loading ? ` · loading ${m.loading}` : ''}${m.failed ? ` · ${m.failed} failed` : ''}` : 'simple: nothing downloaded'} · first draw ${s.firstDraw ? s.firstDraw.toFixed(0) : '–'} ms`;
              },
            }
          : {}),
      },
    });
    es = engine.state;
    engine.setPins(pins);
  } catch (err) {
    console.warn(err);
    glError = true;
  }
  render();
  root.dataset.ready = 'true';

  return () => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('input', onInput);
    removeEventListener('keydown', onKey);
    engine?.dispose();
    style.remove();
  };
}
