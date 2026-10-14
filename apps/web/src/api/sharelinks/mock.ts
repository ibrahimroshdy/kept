/**
 * Mock handlers for share links (1.5, D233): a location's links for its owners and admins, made,
 * listed and revoked; the public page by token and an admin's preview by id, built from the mock
 * inventory with the D116 whitelist only. A link's token is `tok` and its id's tail, so tests can
 * open a link they made.
 */
import {
  SHARE_LINK_MAX_ITEMS,
  SHARE_LINK_PAGE_SIZE,
  type ShareLinkScope,
  type ShareView,
} from '@kept/shared';
import type { StoredThing } from '../inventory/mock/db';
import { type InventoryState, liveThing, newId, placePath, thingPath } from '../inventory/mock/db';
import type { MockState } from '../mock/fixtures';
import { err, forbidden, type MockRoute, notFound, reply, route } from '../mock/kit';
import { sharelinkPaths as p } from './paths';
import type { CreateShareLinkBody, SharedPage, SharedThing, ShareLinkRow } from './types';

type Stored = { row: ShareLinkRow; token: string };
const stores = new WeakMap<MockState, Stored[]>();
const storeOf = (state: MockState) => {
  let s = stores.get(state);
  if (!s) {
    s = [];
    stores.set(state, s);
  }
  return s;
};

/** For tests: a link, live or not, and its token. */
export function seedShareLink(state: MockState, row: ShareLinkRow, token: string): void {
  storeOf(state).push({ row, token });
}

const tokenOf = (id: string) => `tok${id.replace(/-/g, '')}`.slice(0, 43).padEnd(43, 'x');

function sharedThing(inv: InventoryState, t: StoredThing): SharedThing {
  return {
    name: t.name,
    type: t.type ? { icon: t.type.icon, name: t.type.name, builtinKey: t.type.builtinKey } : null,
    path: thingPath(inv, t).map((s) => ({ name: s.name, kind: s.kind, isUnplaced: s.isUnplaced })),
    quantity: t.quantity,
    condition: t.condition,
    description: t.notes,
    photo: t.thumbUrl ? { thumbUrl: t.thumbUrl, url: t.thumbUrl } : null,
  };
}

/** Everything inside a box, however deep. */
function inside(inv: InventoryState, boxId: string): StoredThing[] {
  const out: StoredThing[] = [];
  const queue = [boxId];
  while (queue.length) {
    const id = queue.shift() as string;
    for (const t of inv.things.filter((x) => x.containerId === id && !x.deletedAt)) {
      out.push(t);
      queue.push(t.id);
    }
  }
  return out;
}

function underPlace(inv: InventoryState, placeId: string): StoredThing[] {
  const places = new Set([placeId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const pl of inv.places)
      if (pl.parentId && places.has(pl.parentId) && !places.has(pl.id) && !pl.deletedAt) {
        places.add(pl.id);
        grew = true;
      }
  }
  const direct = inv.things.filter((t) => t.placeId && places.has(t.placeId) && !t.deletedAt);
  return [...direct, ...direct.flatMap((t) => inside(inv, t.id))];
}

function pageOf(state: MockState, s: Stored, page: number): SharedPage | null {
  const inv = state.inventory;
  const { row } = s;
  let things: StoredThing[] = [];
  let thing: SharedThing | null = null;
  let place: SharedPage['place'] = null;
  if (row.scope === 'thing') {
    const box = row.subject ? liveThing(inv, row.subject.id) : undefined;
    if (!box) return null;
    thing = sharedThing(inv, box);
    things = inside(inv, box.id);
  } else if (row.scope === 'place') {
    const pl = inv.places.find((x) => x.id === row.subject?.id && !x.deletedAt);
    if (!pl) return null;
    place = {
      name: pl.name,
      isUnplaced: pl.isUnplaced,
      path: placePath(inv, pl.parentId).map((x) => ({
        name: x.name,
        kind: x.kind,
        isUnplaced: x.isUnplaced,
      })),
    };
    things = underPlace(inv, pl.id);
  } else {
    const q = row.view?.q?.toLocaleLowerCase() ?? '';
    things = inv.things.filter(
      (t) =>
        t.locationId === row.locationId &&
        !t.deletedAt &&
        (!q || (t.name ?? '').toLocaleLowerCase().includes(q)),
    );
  }
  const live = things
    .filter((t) => t.reviewState === 'confirmed' && t.lifecycle === 'in_use')
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  const capped = live.slice(0, SHARE_LINK_MAX_ITEMS);
  const items = capped.slice(page * SHARE_LINK_PAGE_SIZE, (page + 1) * SHARE_LINK_PAGE_SIZE);
  return {
    scope: row.scope,
    title: row.title,
    thing,
    place,
    total: live.length,
    cap: SHARE_LINK_MAX_ITEMS,
    page,
    nextPage: (page + 1) * SHARE_LINK_PAGE_SIZE < capped.length ? page + 1 : null,
    items: items.map((t) => sharedThing(inv, t)),
    expiresAt: row.expiresAt,
  };
}

export function sharelinksMockRoutes(state: MockState): MockRoute[] {
  const gate = (id: string) => {
    const loc = state.locations.find((l) => l.id === id);
    if (!loc) return notFound();
    if (loc.role !== 'owner' && loc.role !== 'admin') return forbidden();
    return null;
  };
  const pageNo = (q: URLSearchParams) => Number(q.get('page') ?? 0) || 0;
  return [
    route('GET', p.links(':id'), ({ params }) => {
      const id = params.id as string;
      const refused = gate(id);
      if (refused) return refused;
      return {
        items: storeOf(state)
          .filter((s) => s.row.locationId === id)
          .map((s) => s.row),
      };
    }),
    route('POST', p.links(':id'), ({ params, body }) => {
      const locationId = params.id as string;
      const refused = gate(locationId);
      if (refused) return refused;
      if (state.locations.find((l) => l.id === locationId)?.kind === 'personal')
        return err(
          400,
          'validation',
          'The request is not valid.',
          'A Personal location has no share links.',
        );
      const b = body as CreateShareLinkBody & {
        thingId?: string;
        placeId?: string;
        view?: ShareView;
        title?: string;
      };
      const inv = state.inventory;
      let scope: ShareLinkScope;
      let subject: ShareLinkRow['subject'] = null;
      if (b.thingId) {
        const t = liveThing(inv, b.thingId);
        if (!t || t.locationId !== locationId) return notFound();
        scope = 'thing';
        subject = { id: t.id, name: t.name, isUnplaced: false };
      } else if (b.placeId) {
        const pl = inv.places.find((x) => x.id === b.placeId && x.locationId === locationId);
        if (!pl) return notFound();
        scope = 'place';
        subject = { id: pl.id, name: pl.name, isUnplaced: pl.isUnplaced };
      } else if (b.view && b.title) {
        scope = 'view';
      } else return err(400, 'validation', 'The request is not valid.');
      const id = newId();
      const created = new Date();
      const row: ShareLinkRow = {
        id,
        locationId,
        scope,
        subject,
        title: scope === 'view' ? (b.title ?? null) : null,
        view: scope === 'view' ? (b.view ?? {}) : null,
        state: 'active',
        expiresAt: new Date(created.getTime() + b.expiresInDays * 86_400_000).toISOString(),
        revokedAt: null,
        createdAt: created.toISOString(),
        createdBy: { id: state.me.user.id, displayName: state.me.user.displayName },
        views: 0,
        lastViewedAt: null,
      };
      const token = tokenOf(id);
      storeOf(state).unshift({ row, token });
      return reply(201, { link: row, url: `http://kept.test/s/${token}` });
    }),
    route('DELETE', p.link(':id'), ({ params }) => {
      const s = storeOf(state).find((x) => x.row.id === params.id);
      if (!s) return notFound();
      const refused = gate(s.row.locationId);
      if (refused) return refused;
      if (s.row.revokedAt) return notFound();
      s.row = { ...s.row, revokedAt: new Date().toISOString(), state: 'revoked' };
      return reply(204);
    }),
    route('GET', p.preview(':id'), ({ params, query }) => {
      const s = storeOf(state).find((x) => x.row.id === params.id);
      if (!s) return notFound();
      const refused = gate(s.row.locationId);
      if (refused) return refused;
      return pageOf(state, s, pageNo(query)) ?? notFound();
    }),
    route('GET', p.shared(':token'), ({ params, query }) => {
      const s = storeOf(state).find((x) => x.token === params.token);
      if (s?.row.state !== 'active') return notFound();
      const page = pageNo(query);
      const out = pageOf(state, s, page);
      if (!out) return notFound();
      if (page === 0)
        s.row = { ...s.row, views: s.row.views + 1, lastViewedAt: new Date().toISOString() };
      return out;
    }),
  ];
}
