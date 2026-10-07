/**
 * Mock handlers for trash, restore, delete permanently, history and activity (task 21), as task
 * 27's screens use them:
 *
 * - history and activity rows are rendered for the caller the way the server's `renderAudit` does
 *   (D110): money is `{changed, class:'money', hidden}` unless the Money module is on in the
 *   event's location and the caller's role may see money; a secret is only ever `changed`;
 * - activity filters by location, person (`actorId`), kind (`entityType`) and `from`/`to`;
 * - a few older events (a money edit, a secret change, a move in from another location, a price
 *   in a location without Money) are added once, so the timeline has every row kind to show.
 */
import type { MockState } from '../../mock/fixtures';
import {
  err,
  forbidden,
  type MockRoute,
  notFound,
  reply,
  route,
  sessionGate,
} from '../../mock/kit';
import { inventoryPaths as p } from '../paths';
import type { HistoryEvent, RenderedChange, TrashBody, TrashItem } from '../types';
import {
  accessOf,
  contentsOf,
  liveThing,
  matches,
  newId,
  now,
  paginate,
  placePath,
  recordEvent,
  runUndo,
  summaryOf,
  thingPath,
} from './db';
import { narrow } from './filters';
import { INV_IDS } from './fixtures';

const PURGE_MS = 30 * 86_400_000;
const DAY_MS = 86_400_000;

/** Step-1 fixture user ids by display name, so events can be filtered by person. */
const ACTOR_IDS: Record<string, string> = {
  Ibrahim: '01926f00-0000-7000-8000-00000000a001',
  Bruce: 'u-bruce',
  بروس: 'u-bruce',
  Alfred: 'u-alfred',
  Louis: 'u-louis',
  Peter: 'u-peter',
  Talia: 'u-talia',
};

type Diff = Record<string, RenderedChange>;

function historyEvent(
  n: number,
  daysAgo: number,
  e: Pick<HistoryEvent, 'action' | 'location_id'> & {
    /** What the summary names. */
    name: string;
    lifecycle?: string;
    actor: string;
    entity: HistoryEvent['entity'];
    diff?: Diff | null;
    movedInFromElsewhere?: boolean;
  },
): HistoryEvent {
  return {
    id: `01926f00-0000-7000-8000-0000000ef${String(n).padStart(3, '0')}`,
    at: new Date(Date.now() - daysAgo * DAY_MS).toISOString(),
    location_id: e.location_id,
    action: e.action,
    actor: { type: 'user', id: ACTOR_IDS[e.actor] ?? null, displayName: e.actor },
    entity: e.entity,
    root_thing_id: e.entity.type === 'thing' ? e.entity.id : null,
    diff: e.diff ?? null,
    undo_of: null,
    undoable_until: null,
    ...summaryOf(
      e.movedInFromElsewhere ? 'thing.move.in' : e.action,
      e.name,
      e.lifecycle ? { lifecycle: e.lifecycle } : {},
    ),
    ...(e.movedInFromElsewhere ? { movedInFromElsewhere: true } : {}),
  };
}

/**
 * Older events, added once per mock state: every kind of row the timeline draws. All are more
 * than 10 days old, so Home's recent activity (the newest 3 or 5) is unchanged.
 */
export function extraHistory(): HistoryEvent[] {
  const T = INV_IDS.thing;
  const L = INV_IDS.loc;
  const thing = (id: string) => ({ type: 'thing', id });
  return [
    historyEvent(1, 11, {
      action: 'thing.update',
      location_id: L.home,
      actor: 'Alfred',
      entity: thing(T.tv),
      name: 'Samsung TV, 55″',
      diff: {
        notes: { before: null, after: 'Wall-mounted in the living room', class: 'plain' },
        'custom.insured_value': { before: '12000', after: '14500', class: 'money' },
      },
    }),
    historyEvent(2, 12, {
      action: 'thing.update',
      location_id: L.home,
      actor: 'Ibrahim',
      entity: thing(T.safe),
      name: 'Wall safe',
      diff: { combination: { changed: true, class: 'secret' } },
    }),
    historyEvent(3, 13, {
      action: 'thing.move',
      location_id: L.home,
      actor: 'Bruce',
      entity: thing(T.hdmiCable),
      name: 'HDMI cable, 2 m',
      movedInFromElsewhere: true,
    }),
    historyEvent(4, 14, {
      action: 'thing.lifecycle',
      location_id: L.garage,
      actor: 'Ibrahim',
      entity: thing(T.pump),
      name: 'Tyre pump',
      lifecycle: 'sold',
      diff: {
        lifecycle: { before: 'in_use', after: 'sold', class: 'plain' },
        ended_price: { before: null, after: '350', class: 'money' },
      },
    }),
    historyEvent(5, 15, {
      action: 'thing.update',
      location_id: L.home,
      actor: 'Ibrahim',
      entity: thing(T.tv),
      name: 'Samsung TV, 55″',
      diff: {
        name: { before: 'Samsung TV', after: 'Samsung TV, 55″', class: 'plain' },
        quantity: { before: 2, after: 1, class: 'plain' },
      },
    }),
  ];
}

/**
 * The server's `renderAudit(event, viewer)` for the mock (D110): money is hidden unless Money is
 * on in the event's location and the role may see it; secrets are only ever "changed".
 */
export function renderFor(state: MockState, e: HistoryEvent): HistoryEvent {
  if (!e.diff) return e;
  const loc = state.locations.find((l) => l.id === e.location_id);
  const modules = loc ? (loc.effectiveModules ?? loc.modules) : [];
  const showMoney = !!loc && modules.includes('money') && loc.role !== 'viewer';
  const diff: Diff = {};
  for (const [key, change] of Object.entries(e.diff)) {
    if (change.class === 'secret') diff[key] = { changed: true, class: 'secret' };
    else if (change.class === 'money' && !showMoney)
      diff[key] = { changed: true, class: 'money', hidden: true };
    else diff[key] = change;
  }
  return { ...e, diff };
}

export function trashRoutes(state: MockState): MockRoute[] {
  const inv = () => state.inventory;
  const access = () => accessOf(state);
  // Once per state: person ids on the fixture events, and the older events above.
  for (const e of inv().events)
    if (!e.actor.id) e.actor.id = ACTOR_IDS[e.actor.displayName ?? ''] ?? null;
  const known = new Set(inv().events.map((e) => e.id));
  if (inv().events.length > 0)
    for (const e of extraHistory()) if (!known.has(e.id)) inv().events.push(e);
  // The entity's current short ID, as the server adds it when it renders a row (D208).
  const codeOf = (entity: HistoryEvent['entity']) => {
    const rows =
      entity.type === 'thing' ? inv().things : entity.type === 'place' ? inv().places : [];
    return rows.find((r) => r.id === entity.id)?.shortCode ?? null;
  };
  const rendered = (items: HistoryEvent[]) =>
    items.map((e) => {
      const out = renderFor(state, e);
      return { ...out, entity: { ...out.entity, shortCode: codeOf(out.entity) } };
    });
  const newestFirst = (a: HistoryEvent, b: HistoryEvent) => b.at.localeCompare(a.at);
  const batchSize = (batch: string | null) =>
    batch ? [...inv().things, ...inv().places].filter((r) => r.trashBatchId === batch).length : 1;

  return [
    route('POST', p.thingTrash(':id'), ({ params, body }) => {
      const t = liveThing(inv(), params.id ?? null);
      if (!t || !access().visible(t.locationId)) return notFound();
      if (!access().canWrite(t.locationId)) return forbidden();
      const b = (body ?? {}) as TrashBody;
      const inside = contentsOf(inv(), t.id);
      if (inside.length && !b.contents)
        return err(
          409,
          'contents_choice_required',
          'Choose what happens to what is inside.',
          undefined,
          {
            counts: { places: 0, things: inside.length },
          },
        );
      const batch = newId();
      const stamp = { deletedAt: now(), trashBatchId: batch, deletedBy: state.me.user.displayName };
      // Undoable, as on the server (D150): the batch comes back, and what was moved out of the
      // container goes back into it.
      const wasInside = inside.map((c) => ({ c, placeId: c.placeId, containerId: c.containerId }));
      recordEvent(inv(), state.me.user, {
        action: 'thing.trash',
        entity: { type: 'thing', id: t.id },
        locationId: t.locationId,
        name: t.name ?? '',
        undo: () => {
          for (const row of inv().things)
            if (row.trashBatchId === batch)
              Object.assign(row, { deletedAt: null, trashBatchId: null, deletedBy: null });
          for (const w of wasInside)
            Object.assign(w.c, { placeId: w.placeId, containerId: w.containerId });
        },
      });
      Object.assign(t, stamp);
      const trashed = [t.id];
      const moved: string[] = [];
      for (const c of inside) {
        if (b.contents === 'trash') {
          Object.assign(c, stamp);
          trashed.push(c.id);
        } else if (b.moveTo) {
          if ('placeId' in b.moveTo) {
            c.placeId = b.moveTo.placeId;
            c.containerId = null;
          } else {
            c.containerId = b.moveTo.containerId;
          }
          moved.push(c.id);
        }
      }
      return { trashed, moved, trashBatchId: batch };
    }),

    route('POST', p.thingRestore(':id'), ({ params }) => {
      const t = inv().things.find((x) => x.id === params.id && x.deletedAt);
      if (!t || !access().visible(t.locationId)) return notFound();
      if (!access().canWrite(t.locationId)) return forbidden();
      const batch = t.trashBatchId;
      const restored: string[] = [];
      for (const row of inv().things) {
        if (row.id === t.id || (batch && row.trashBatchId === batch)) {
          row.deletedAt = null;
          row.trashBatchId = null;
          row.deletedBy = null;
          restored.push(row.id);
        }
      }
      return { restored };
    }),

    route('DELETE', p.thing(':id'), ({ params }) => {
      const t = inv().things.find((x) => x.id === params.id);
      if (!t || !access().visible(t.locationId)) return notFound();
      if (!access().isAdmin(t.locationId)) return forbidden();
      if (!t.deletedAt) return err(409, 'conflict', 'Only a trashed thing can be deleted.');
      inv().things = inv().things.filter((x) => x.id !== t.id);
      return reply(204);
    }),

    route('GET', p.trash, ({ query }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const visible = access().visibleIds();
      const q = query.get('q') ?? '';
      const from = query.get('from');
      const to = query.get('to');
      // Trash rows name who trashed them; the mock knows people's ids from their events.
      const idOf = new Map(
        inv().events.flatMap((e) => (e.actor.id ? [[e.actor.displayName, e.actor.id]] : [])),
      );
      idOf.set(state.me.user.displayName, state.me.user.id);
      const byOf = (displayName: string) => ({
        id: idOf.get(displayName) ?? `u-${displayName.toLowerCase()}`,
        displayName,
      });
      const all: TrashItem[] = [
        ...inv()
          .things.filter((t) => t.deletedAt)
          .map((t) => ({
            kind: 'thing' as const,
            id: t.id,
            locationId: t.locationId,
            name: t.name,
            path: thingPath(inv(), t),
            deletedAt: t.deletedAt ?? '',
            deletedBy: t.deletedBy ? byOf(t.deletedBy) : null,
            purgeAfter: new Date(Date.parse(t.deletedAt ?? '') + PURGE_MS).toISOString(),
            batchSize: batchSize(t.trashBatchId),
          })),
        ...inv()
          .places.filter((pl) => pl.deletedAt)
          .map((pl) => ({
            kind: 'place' as const,
            id: pl.id,
            locationId: pl.locationId,
            name: pl.name,
            path: placePath(inv(), pl.parentId),
            deletedAt: pl.deletedAt ?? '',
            deletedBy: pl.deletedBy ? byOf(pl.deletedBy) : null,
            purgeAfter: new Date(Date.parse(pl.deletedAt ?? '') + PURGE_MS).toISOString(),
            batchSize: batchSize(pl.trashBatchId),
          })),
      ]
        .filter((x) => visible.has(x.locationId))
        .filter((x) => !q || matches(x.name ?? '', q))
        .filter((x) => (!from || x.deletedAt >= from) && (!to || x.deletedAt < to))
        .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
      let items = narrow(all, query, 'locationId', (x, v) => x.locationId === v);
      items = narrow(items, query, 'kind', (x, v) => x.kind === v);
      items = narrow(items, query, 'deletedById', (x, v) => x.deletedBy?.id === v);
      return paginate(items, query);
    }),

    route('GET', p.thingHistory(':id'), ({ params, query }) => {
      const t = inv().things.find((x) => x.id === params.id);
      if (!t || !access().visible(t.locationId)) return notFound();
      // Things merged into this one, however many times over (T15): their events are its history
      // too, each labelled with the merged thing ("merged from <name>"); its own events aren't.
      const merged = new Map<string, string | null>();
      for (let grew = true; grew; ) {
        grew = false;
        for (const x of inv().things) {
          const into = x.mergedIntoId;
          if (into && (into === t.id || merged.has(into)) && !merged.has(x.id)) {
            merged.set(x.id, x.name);
            grew = true;
          }
        }
      }
      const about = (e: HistoryEvent) => [e.entity.id, e.root_thing_id];
      const items = inv()
        .events.filter((e) => about(e).some((id) => id === t.id || (!!id && merged.has(id))))
        .filter((e) => !e.location_id || access().visible(e.location_id))
        .map((e) => {
          if (about(e).includes(t.id)) return e;
          const from = about(e).find((id): id is string => !!id && merged.has(id));
          return from ? { ...e, mergedFrom: { id: from, name: merged.get(from) ?? null } } : e;
        });
      // The AI calls that touched it (D206, §7.15): ledger rows with its id, cost per the gate.
      const loc = state.locations.find((l) => l.id === t.locationId);
      const moneyHidden = loc?.role === 'viewer' && !(loc.moneyVisibleToViewers ?? false);
      const calls: HistoryEvent[] = state.capture.calls
        .filter((c) => c.links.thingId === t.id)
        .map((c) => ({
          id: `ai:${c.id}`,
          at: c.at,
          location_id: t.locationId,
          action: 'ai.call',
          actor: {
            type: c.person === 'background' ? 'system' : 'user',
            id: c.person && c.person !== 'background' ? c.person.id : null,
            displayName: c.person && c.person !== 'background' ? c.person.name : null,
          },
          entity: { type: 'thing', id: t.id, shortCode: t.shortCode },
          root_thing_id: t.id,
          diff: null,
          undo_of: null,
          undoable_until: null,
          summary: 'AI call',
          summaryKey: 'ai.call',
          summaryParams: {},
          aiCall: {
            id: c.id,
            task: c.task,
            model: c.model,
            providerKind: c.providerKind,
            tokens: (c.tokens.input ?? 0) + (c.tokens.output ?? 0),
            images: c.images.count,
            ...(c.cost && !moneyHidden
              ? { cost: { amount: c.cost.amount, currency: c.cost.currency } }
              : {}),
            costSource: c.cost ? c.cost.source : c.sent ? 'unknown' : 'not_sent',
            paidBy: { scope: c.paidBy.scope, label: c.paidBy.label },
            outcome: c.outcome,
            errorCode: c.errorCode,
          },
        }));
      return paginate([...rendered(items), ...calls].sort(newestFirst), query);
    }),

    route('GET', p.placeHistory(':id'), ({ params, query }) => {
      const pl = inv().places.find((x) => x.id === params.id);
      if (!pl || !access().visible(pl.locationId)) return notFound();
      return paginate(
        rendered(
          inv()
            .events.filter((e) => e.entity.id === pl.id)
            .sort(newestFirst),
        ),
        query,
      );
    }),

    route('GET', p.activity, ({ query }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const visible = access().visibleIds();
      const from = query.get('from');
      const to = query.get('to');
      const q = query.get('q')?.trim() ?? '';
      const items = inv()
        .events.filter((e) => e.location_id && visible.has(e.location_id))
        .filter(
          (e) =>
            !q ||
            matches(e.summary, q) ||
            matches(e.summaryParams.name ?? '', q) ||
            matches(e.actor.displayName ?? '', q),
        )
        .filter((e) => !from || e.at >= from)
        .filter((e) => !to || e.at < to)
        .sort(newestFirst);
      let narrowed = narrow(items, query, 'locationId', (e, v) => e.location_id === v);
      narrowed = narrow(narrowed, query, 'entityType', (e, v) => e.entity.type === v);
      narrowed = narrow(narrowed, query, 'actorId', (e, v) => e.actor.id === v);
      return paginate(rendered(narrowed), query);
    }),

    route('GET', p.locationActors(':id'), ({ params }) => {
      if (!access().visible(params.id ?? '')) return notFound();
      const seen = new Map<string, string>();
      for (const e of inv().events)
        if (e.location_id === params.id && e.actor.id && e.actor.displayName)
          seen.set(e.actor.id, e.actor.displayName);
      return {
        items: [...seen.entries()]
          .map(([id, displayName]) => ({ id, displayName }))
          .sort((a, b) => a.displayName.localeCompare(b.displayName)),
      };
    }),

    // Undo (D150): the events the mock's own writes made undoable; anything else is refused.
    route('POST', p.undo(':id'), ({ params }) => {
      const e = inv().events.find((x) => x.id === params.id);
      if (!e?.location_id || !access().visible(e.location_id)) return notFound();
      if (!access().canWrite(e.location_id)) return forbidden();
      // The server's refusals (T20): 409 `undo_refused` with a `reason`.
      const refuse = (reason: string, hint: string) =>
        err(409, 'undo_refused', "That can't be undone any more.", hint, { reason });
      if (inv().events.some((x) => x.undo_of === e.id))
        return refuse('already_undone', 'That was already undone.');
      if (e.undoable_until && Date.parse(e.undoable_until) <= Date.now())
        return refuse('expired', "Can't undo: it's more than 7 days old.");
      if (!runUndo(inv(), e.id)) return refuse('not_undoable', "This change can't be undone.");
      const entity = e.entity as { type: 'thing' | 'place'; id: string };
      const done = recordEvent(
        inv(),
        { id: state.me.user.id, displayName: state.me.user.displayName },
        {
          action: e.action,
          entity,
          locationId: e.location_id,
          name: e.summaryParams.name ?? '',
        },
      );
      done.undo_of = e.id;
      Object.assign(done, summaryOf('undo', e.summaryParams.name ?? ''));
      return { undoOf: e.id, eventId: done.id };
    }),
  ];
}
