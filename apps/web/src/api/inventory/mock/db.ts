/**
 * The inventory half of the mock server's state, and the helpers every area handler shares:
 * serialising a stored thing into a `ThingRow`/`ThingView` (paths and derived states computed
 * the way the server does), pagination over `next_cursor`, If-Match checks with the D156 412
 * body, and a small Arabic-aware fold for search. Test and demo data only.
 */
import type { LocationDetail } from '../../types';
import type {
  AccountSummary,
  AttachmentView,
  Brand,
  Currency,
  DerivedState,
  FileView,
  Hint,
  HistoryEvent,
  Page,
  PathStep,
  Person,
  PlaceKindNode,
  PlaceNode,
  PlaceView,
  PurchaseView,
  Reading,
  SavedView,
  SavedViewPrefs,
  Tag,
  ThingRow,
  ThingView,
  TypeDetail,
  Vendor,
} from '../types';

export type StoredPlace = Omit<PlaceView, 'path' | 'counts' | 'attachments'> & {
  sort: number;
  deletedAt: string | null;
  trashBatchId: string | null;
  deletedBy: string | null;
};

/** A thing as the mock stores it: the view's own fields; `path` and counts are computed. */
export type StoredThing = Omit<ThingView, 'path' | 'derivedState' | 'contentsCount' | 'links'> & {
  links: { id: string; kind: ThingView['links'][number]['kind']; toThingId: string }[];
  deletedAt: string | null;
  trashBatchId: string | null;
  deletedBy: string | null;
  /** Merged into another thing (D36, T15's `things.merged_into_id`): its history is that one's too. */
  mergedIntoId?: string | null;
};

export type InventoryState = {
  accounts: AccountSummary[];
  /** Which owner account each location belongs to. */
  accountOf: Record<string, string>;
  types: TypeDetail[];
  placeKinds: Record<string, PlaceKindNode[]>;
  brands: Brand[];
  vendors: Vendor[];
  people: Person[];
  tags: Tag[];
  currencies: Currency[];
  places: StoredPlace[];
  things: StoredThing[];
  purchases: PurchaseView[];
  readings: Record<string, Reading[]>;
  files: Record<string, FileView>;
  attachments: (AttachmentView & { locationId: string })[];
  /** A file's text (a PDF's text layer, or a receipt's), by file id: document search (T21). */
  fileText?: Record<string, string>;
  savedViews: SavedView[];
  /** Your default and pinned views, per list (D205). */
  savedViewPrefs: Record<string, SavedViewPrefs>;
  events: HistoryEvent[];
  hints: Hint[];
  checklistDismissed: boolean;
  secrets: Record<string, string>;
  /**
   * Step 4's part of a thing and of an attachment, installed by api/household/mock when the mock
   * server is built (absent in a bare inventory state): the derived states lent, borrowed and in
   * repair, the view's loan line, repair vendor and current value, and the attachment subjects a
   * warranty, a claim and a loan add (T20).
   */
  step4?: Step4Hooks;
};

export type Step4Hooks = {
  derived: (t: StoredThing) => DerivedState[];
  view: (t: StoredThing) => Pick<ThingView, 'currentValue' | 'repairAt' | 'loanLine'>;
  /** Files an attachment on a warranty, claim or loan; false when its subject isn't one. */
  attach: (a: AttachmentView) => boolean;
  /** Takes an attachment off its warranty, claim or loan; false when it wasn't on one. */
  detach: (a: AttachmentView) => boolean;
};

// ----- ids and time ----------------------------------------------------------------------------

let seq = 0;
/** A fresh UUIDv7-shaped id for rows the mock creates. */
export function newId(): string {
  seq += 1;
  return `01926f00-0000-7000-8000-${(0x9000000000 + seq).toString(16).padStart(12, '0')}`;
}
export const now = () => new Date().toISOString();

// ----- paths and rows --------------------------------------------------------------------------

export function livePlace(inv: InventoryState, id: string | null): StoredPlace | undefined {
  return inv.places.find((p) => p.id === id && !p.deletedAt);
}
export function liveThing(inv: InventoryState, id: string | null): StoredThing | undefined {
  return inv.things.find((t) => t.id === id && !t.deletedAt);
}

/** The place chain from the root down to (and including) `placeId`. */
export function placePath(inv: InventoryState, placeId: string | null): PathStep[] {
  const out: PathStep[] = [];
  let cur = inv.places.find((p) => p.id === placeId);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift({
      id: cur.id,
      name: cur.name,
      kind: 'place',
      isUnplaced: cur.isUnplaced,
      shortCode: cur.shortCode,
    });
    cur = inv.places.find((p) => p.id === cur?.parentId);
  }
  return out;
}

/** Where a thing is: its place chain, then any containers, outermost first (not the thing). */
export function thingPath(inv: InventoryState, t: StoredThing): PathStep[] {
  const containers: PathStep[] = [];
  let cur: StoredThing | undefined = t;
  const seen = new Set<string>();
  while (cur?.containerId && !seen.has(cur.id)) {
    seen.add(cur.id);
    const box = inv.things.find((x) => x.id === cur?.containerId);
    if (!box) break;
    containers.unshift({ id: box.id, name: box.name ?? '', kind: 'container', isUnplaced: false });
    cur = box;
  }
  return [...placePath(inv, cur?.placeId ?? null), ...containers];
}

/** Step 2's states, then step 4's (lent, borrowed, in repair) when the household mock is in. */
export function derivedStateOf(t: StoredThing, inv?: InventoryState): DerivedState[] {
  const out: DerivedState[] = [];
  if (t.locationUncertain) out.push('uncertain');
  if (t.reviewState === 'draft') out.push('draft');
  if (t.lifecycle !== 'in_use') out.push('ended');
  if (inv?.step4) out.push(...inv.step4.derived(t));
  return out;
}

export function contentsOf(inv: InventoryState, id: string): StoredThing[] {
  return inv.things.filter((t) => t.containerId === id && !t.deletedAt);
}

export function rowOf(inv: InventoryState, t: StoredThing): ThingRow {
  const box = t.containerId ? inv.things.find((x) => x.id === t.containerId) : undefined;
  return {
    id: t.id,
    locationId: t.locationId,
    shortCode: t.shortCode,
    name: t.name,
    type: t.type,
    quantity: t.quantity,
    lifecycle: t.lifecycle,
    derivedState: derivedStateOf(t, inv),
    path: thingPath(inv, t),
    containerThumbUrl: box?.thumbUrl ?? null,
    thumbUrl: t.thumbUrl,
    lastSeenAt: t.lastSeenAt,
    isContainer: t.isContainer || contentsOf(inv, t.id).length > 0,
  };
}

export function viewOf(inv: InventoryState, t: StoredThing): ThingView {
  const { deletedAt: _d, trashBatchId: _b, deletedBy: _by, links, ...own } = t;
  const contents = contentsOf(inv, t.id);
  return {
    ...own,
    ...rowOf(inv, t),
    isContainer: t.isContainer || contents.length > 0,
    contentsCount: contents.length,
    links: links.flatMap((l) => {
      const other = inv.things.find((x) => x.id === l.toThingId);
      return other
        ? [{ id: l.id, kind: l.kind, direction: 'from' as const, thing: rowOf(inv, other) }]
        : [];
    }),
    ...inv.step4?.view(t),
  };
}

export function placeNodeOf(inv: InventoryState, p: StoredPlace): PlaceNode {
  return {
    id: p.id,
    parentId: p.parentId,
    name: p.name,
    kindKey: p.kindKey,
    icon: p.icon,
    sort: p.sort,
    isUnplaced: p.isUnplaced,
    shortCode: p.shortCode,
    thingCount: inv.things.filter((t) => t.placeId === p.id && !t.deletedAt).length,
    childCount: inv.places.filter((c) => c.parentId === p.id && !c.deletedAt).length,
  };
}

export function placeViewOf(inv: InventoryState, p: StoredPlace): PlaceView {
  const { deletedAt: _d, trashBatchId: _b, deletedBy: _by, sort: _s, ...own } = p;
  const node = placeNodeOf(inv, p);
  return {
    ...own,
    path: placePath(inv, p.id),
    counts: { places: node.childCount, things: node.thingCount },
    attachments: inv.attachments.filter(
      (a) => 'placeId' in a.subject && a.subject.placeId === p.id,
    ),
  };
}

// ----- lists -----------------------------------------------------------------------------------

/** `{items, next_cursor}` over an in-memory list. The cursor is an opaque offset. */
export function paginate<T>(items: T[], query: URLSearchParams, defaultLimit = 50): Page<T> {
  const limit = Math.min(Number(query.get('limit') ?? defaultLimit) || defaultLimit, 200);
  const start = Number(query.get('cursor') ?? 0) || 0;
  const slice = items.slice(start, start + limit);
  const more = start + limit < items.length;
  return { items: slice, next_cursor: more ? String(start + limit) : null };
}

/** A smaller stand-in for `kept.normalize` + the prefix stripping of screens §8 (D42, Q20). */
export function fold(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .replace(/ـ/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .split(/\s+/)
    .map((w) => w.replace(/^[وبفك]?ال(\S{2,})$/u, '$1').replace(/^لل(\S{2,})$/u, '$1'))
    .join(' ')
    .trim();
}

/** Every word of `q` is a prefix of some word of `text` (after folding). */
export function matches(text: string, q: string): boolean {
  const words = fold(text).split(' ');
  return fold(q)
    .split(' ')
    .filter(Boolean)
    .every((w) => words.some((x) => x.startsWith(w)));
}

// ----- history summaries (the server's history/summary.ts) ----------------------------------

const SENTENCES: Record<string, (name: string) => string> = {
  'thing.create': (n) => `Added ${n}`,
  'thing.update': (n) => `Edited ${n}`,
  'thing.retype': (n) => `Changed the type of ${n}`,
  'thing.move': (n) => `Moved ${n}`,
  'thing.move.in': () => 'Moved in from another location',
  'thing.trash': (n) => `Trashed ${n}`,
  'thing.restore': (n) => `Restored ${n}`,
  'place.create': (n) => `Added ${n}`,
  'place.update': (n) => `Edited ${n}`,
  'place.move': (n) => `Moved ${n}`,
  'place.trash': (n) => `Trashed ${n}`,
  undo: (n) => `Undid a change to ${n}`,
};

/**
 * `summaryKey`, `summaryParams` and the English `summary` of an event, as the server builds them
 * (`thing.lifecycle` also carries `lifecycle`; anything without a sentence is `event`).
 */
export function summaryOf(
  action: string,
  name: string,
  extra: Record<string, string> = {},
): { summaryKey: string; summaryParams: Record<string, string>; summary: string } {
  if (action === 'thing.lifecycle') {
    // The stored code, left out when the row shows no lifecycle change.
    const lifecycle = extra.lifecycle;
    return lifecycle
      ? {
          summaryKey: action,
          summaryParams: { name, lifecycle },
          summary: `Marked ${name} as ${lifecycle.replaceAll('_', ' ')}`,
        }
      : { summaryKey: action, summaryParams: { name }, summary: `Changed the status of ${name}` };
  }
  const sentence = SENTENCES[action];
  if (!sentence)
    return { summaryKey: 'event', summaryParams: { action }, summary: action.replace('.', ' ') };
  return {
    summaryKey: action,
    summaryParams: action === 'thing.move.in' ? {} : { name },
    summary: sentence(name),
  };
}

// ----- events written by the mock's own writes, and their undo (D150) --------------------------

const UNDO = new WeakMap<InventoryState, Map<string, () => void>>();

/**
 * Appends a history event for a write the mock just made. With `undo`, the event is undoable for
 * 7 days (the server's window) and `POST /audit/:eventId/undo` runs it once.
 */
export function recordEvent(
  inv: InventoryState,
  actor: { id: string; displayName: string },
  e: {
    action: string;
    entity: { type: 'thing' | 'place'; id: string };
    locationId: string;
    name: string;
    diff?: HistoryEvent['diff'];
    undo?: () => void;
  },
): HistoryEvent {
  const event: HistoryEvent = {
    id: newId(),
    at: now(),
    location_id: e.locationId,
    action: e.action,
    actor: { type: 'user', id: actor.id, displayName: actor.displayName },
    entity: e.entity,
    root_thing_id: e.entity.type === 'thing' ? e.entity.id : null,
    diff: e.diff ?? null,
    undo_of: null,
    undoable_until: e.undo ? new Date(Date.now() + 7 * 86_400_000).toISOString() : null,
    ...summaryOf(e.action, e.name),
  };
  inv.events.push(event);
  if (e.undo) {
    const map = UNDO.get(inv) ?? new Map<string, () => void>();
    map.set(event.id, e.undo);
    UNDO.set(inv, map);
  }
  return event;
}

/** Runs an event's undo once; false when it has none, or it already ran. */
export function runUndo(inv: InventoryState, eventId: string): boolean {
  const fn = UNDO.get(inv)?.get(eventId);
  if (!fn) return false;
  UNDO.get(inv)?.delete(eventId);
  fn();
  return true;
}

// ----- versions (D156) -------------------------------------------------------------------------

/**
 * The server's If-Match rule: missing → 428-style precondition_failed; stale → 412 with the
 * fields that changed and who changed them. Returns the error body, or null when it matches.
 */
export function versionError(
  headers: Record<string, string>,
  row: { rowVersion: number },
  changed: string[] = [],
  changedBy = 'Alfred',
): { status: number; body: Record<string, unknown> } | null {
  const raw = headers['if-match'];
  if (raw === undefined)
    return {
      status: 428,
      body: {
        error: 'This changed since you opened it.',
        code: 'precondition_failed',
        hint: 'Send If-Match with the row_version you started from.',
      },
    };
  if (Number(raw) === row.rowVersion) return null;
  return {
    status: 412,
    body: {
      error: 'This changed since you opened it.',
      code: 'precondition_failed',
      hint: 'Reload to see the latest version.',
      conflicts: changed,
      row_version: row.rowVersion,
      changedBy: { displayName: changedBy },
    },
  };
}

/** The caller's role in a location, from the step-1 location list. */
export function roleIn(locations: LocationDetail[], locationId: string) {
  return locations.find((l) => l.id === locationId)?.role ?? null;
}

// ----- access (the server's RLS + can(), approximated from the step-1 location list) -----------

export type Access = {
  visible: (locationId: string) => boolean;
  /** Member and above (things.edit and friends). */
  canWrite: (locationId: string) => boolean;
  /** Owner or admin (registries, delete permanently, merge). */
  isAdmin: (locationId: string) => boolean;
  visibleIds: () => Set<string>;
};

export function accessOf(state: { locations: LocationDetail[] }): Access {
  const role = (id: string) => roleIn(state.locations, id);
  return {
    visible: (id) => role(id) !== null,
    canWrite: (id) => {
      const r = role(id);
      return r !== null && r !== 'viewer';
    },
    isAdmin: (id) => {
      const r = role(id);
      return r === 'owner' || r === 'admin';
    },
    visibleIds: () => new Set(state.locations.map((l) => l.id)),
  };
}
