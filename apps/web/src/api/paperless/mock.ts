/**
 * Mock handlers for Paperless-ngx (1.x, D248): a location's connection (owners and admins), its
 * status and search, and a thing's or place's links. A URL with `fail.example` in it refuses the
 * token, as Paperless would; the token is never answered. Thumbnails aren't mocked: the page
 * shows its icon in their place, as it does when Paperless can't be reached.
 */
import type { MockState } from '../mock/fixtures';
import { err, forbidden, type MockRoute, notFound, reply, route } from '../mock/kit';
import { paperlessPaths as p } from './paths';
import type {
  PaperlessConnection,
  PaperlessConnectionBody,
  PaperlessHit,
  PaperlessKind,
  PaperlessLink,
  PaperlessLinkBody,
} from './types';

type Doc = Omit<PaperlessHit, 'linked' | 'openUrl'>;

/** A small Paperless library: what a household's scans look like. */
export const MOCK_DOCUMENTS: readonly Doc[] = [
  {
    documentId: 12,
    title: 'Bosch drill receipt',
    kind: 'receipt',
    typeName: 'Receipt',
    correspondent: 'Hardware Store',
    createdOn: '2026-03-14',
    tags: ['tools'],
  },
  {
    documentId: 13,
    title: 'Bosch GSB 18V manual',
    kind: 'manual',
    typeName: 'Manual',
    correspondent: 'Bosch',
    createdOn: '2025-11-02',
    tags: ['tools'],
  },
  {
    documentId: 14,
    title: 'Drill warranty card',
    kind: 'warranty_doc',
    typeName: null,
    correspondent: 'Bosch',
    createdOn: '2026-03-14',
    tags: ['warranty'],
  },
  {
    documentId: 21,
    title: 'Fridge invoice',
    kind: 'invoice',
    typeName: 'Invoice',
    correspondent: 'Kitchen World',
    createdOn: '2025-08-30',
    tags: [],
  },
  {
    documentId: 22,
    title: 'Home insurance policy 2026',
    kind: 'document',
    typeName: 'Policy',
    correspondent: 'Insurer',
    createdOn: '2026-01-01',
    tags: ['home'],
  },
];

type Store = {
  connections: Map<string, { connection: PaperlessConnection; token: string }>;
  links: PaperlessLink[];
  seq: number;
};
const stores = new WeakMap<MockState, Store>();
const storeOf = (state: MockState): Store => {
  let s = stores.get(state);
  if (!s) {
    s = { connections: new Map(), links: [], seq: 0 };
    stores.set(state, s);
  }
  return s;
};

const nextId = (s: Store, tag: string) => {
  s.seq += 1;
  return `01926f00-0000-7000-8000-0${tag}${String(s.seq).padStart(8, '0')}`;
};

/** For tests and the demo: a location's connection, and links to the mock documents. */
export function seedPaperless(
  state: MockState,
  locationId: string,
  opts: {
    url?: string;
    links?: { subject: PaperlessLink['subject']; documentIds: number[] }[];
  } = {},
): void {
  const s = storeOf(state);
  const url = opts.url ?? 'https://paperless.example.com';
  s.connections.set(locationId, {
    connection: {
      id: nextId(s, 'pc'),
      url,
      version: '3.3.1',
      createdBy: { id: state.me.user.id, displayName: state.me.user.displayName },
      updatedAt: new Date().toISOString(),
      links: 0,
    },
    token: 'mock-token',
  });
  for (const l of opts.links ?? []) {
    for (const documentId of l.documentIds)
      s.links.push(linkOf(s, state, url, l.subject, documentId));
  }
}

function linkOf(
  s: Store,
  state: MockState,
  url: string,
  subject: PaperlessLink['subject'],
  documentId: number,
): PaperlessLink {
  const d = MOCK_DOCUMENTS.find((x) => x.documentId === documentId) as Doc;
  return {
    id: nextId(s, 'pl'),
    documentId,
    subject,
    title: d.title,
    kind: d.kind as PaperlessKind,
    typeName: d.typeName,
    correspondent: d.correspondent,
    createdOn: d.createdOn,
    copiedAttachmentId: null,
    openUrl: `${url}/documents/${documentId}`,
    createdBy: { id: state.me.user.id, displayName: state.me.user.displayName },
    createdAt: new Date().toISOString(),
  };
}

const subjectId = (x: PaperlessLink['subject']) => ('thingId' in x ? x.thingId : x.placeId);

export function paperlessMockRoutes(state: MockState): MockRoute[] {
  const roleIn = (id: string) => state.locations.find((l) => l.id === id)?.role;
  const admin = (id: string) => {
    const role = roleIn(id);
    if (!role) return notFound();
    if (role !== 'owner' && role !== 'admin') return forbidden();
    return null;
  };
  const writer = (id: string) => {
    const role = roleIn(id);
    if (!role) return notFound();
    if (role === 'viewer') return forbidden();
    return null;
  };
  /** The location a thing or place is in, from the inventory mock. */
  const locationOf = (q: { thingId?: string | null; placeId?: string | null }) => {
    const inv = state.inventory;
    if (q.thingId) return inv.things.find((t) => t.id === q.thingId && !t.deletedAt)?.locationId;
    if (q.placeId) return inv.places.find((pl) => pl.id === q.placeId && !pl.deletedAt)?.locationId;
    return undefined;
  };
  const counted = (locationId: string, c: PaperlessConnection): PaperlessConnection => ({
    ...c,
    links: storeOf(state).links.filter((l) => locationOf({ ...l.subject }) === locationId).length,
  });
  return [
    route('GET', p.connection(':id'), ({ params }) => {
      const id = params.id as string;
      const refused = admin(id);
      if (refused) return refused;
      const c = storeOf(state).connections.get(id);
      return { connection: c ? counted(id, c.connection) : null };
    }),
    route('PUT', p.connection(':id'), ({ params, body }) => {
      const id = params.id as string;
      const refused = admin(id);
      if (refused) return refused;
      const b = body as PaperlessConnectionBody;
      const s = storeOf(state);
      const saved = s.connections.get(id);
      const token = b?.token ?? saved?.token;
      if (!b?.url || !token) return err(400, 'validation', 'The request is not valid.');
      if (b.url.includes('fail.example'))
        return reply(400, {
          error: 'The request is not valid.',
          code: 'validation',
          hint: 'Paperless refused the token, or its user may not see this document.',
          paperlessError: 'auth_failed',
        });
      const connection: PaperlessConnection = {
        id: saved?.connection.id ?? nextId(s, 'pc'),
        url: b.url.trim().replace(/\/+$/, ''),
        version: '3.3.1',
        createdBy: saved?.connection.createdBy ?? {
          id: state.me.user.id,
          displayName: state.me.user.displayName,
        },
        updatedAt: new Date().toISOString(),
        links: 0,
      };
      s.connections.set(id, { connection, token });
      return counted(id, connection);
    }),
    route('POST', p.check(':id'), ({ params }) => {
      const id = params.id as string;
      const refused = admin(id);
      if (refused) return refused;
      return storeOf(state).connections.get(id)
        ? { ok: true, version: '3.3.1', error: null }
        : notFound();
    }),
    route('DELETE', p.connection(':id'), ({ params }) => {
      const id = params.id as string;
      const refused = admin(id);
      if (refused) return refused;
      const s = storeOf(state);
      if (!s.connections.delete(id)) return notFound();
      s.links = s.links.filter((l) => locationOf({ ...l.subject }) !== id);
      return reply(204);
    }),
    route('GET', p.status(':id'), ({ params }) => {
      const id = params.id as string;
      if (!roleIn(id)) return notFound();
      const c = storeOf(state).connections.get(id);
      return c
        ? { connected: true, reachable: true, version: '3.3.1', error: null, url: c.connection.url }
        : { connected: false, reachable: null, version: null, error: null, url: null };
    }),
    route('GET', p.documents(':id'), ({ params, query }) => {
      const id = params.id as string;
      const refused = writer(id);
      if (refused) return refused;
      const c = storeOf(state).connections.get(id);
      if (!c) return notFound();
      const q = (query.get('q') ?? '').toLowerCase();
      const subject = query.get('thingId') ?? query.get('placeId');
      const items = MOCK_DOCUMENTS.filter(
        (d) =>
          !q ||
          [d.title, d.correspondent ?? '', d.typeName ?? '', ...d.tags].some((w) =>
            w.toLowerCase().includes(q),
          ),
      ).map((d) => ({
        ...d,
        linked: storeOf(state).links.some(
          (l) => subjectId(l.subject) === subject && l.documentId === d.documentId,
        ),
        openUrl: `${c.connection.url}/documents/${d.documentId}`,
      }));
      return { count: items.length, page: 1, pageSize: 24, items };
    }),
    route('GET', p.links(), ({ query }) => {
      const thingId = query.get('thingId');
      const placeId = query.get('placeId');
      const loc = locationOf({ thingId, placeId });
      if (!loc || !roleIn(loc)) return notFound();
      const c = storeOf(state).connections.get(loc);
      const sid = thingId ?? placeId;
      return {
        connected: Boolean(c),
        url: c?.connection.url ?? null,
        items: storeOf(state).links.filter((l) => subjectId(l.subject) === sid),
      };
    }),
    route('POST', p.links(), ({ body }) => {
      const b = body as PaperlessLinkBody;
      const subject = ('thingId' in b ? { thingId: b.thingId } : { placeId: b.placeId }) as
        | { thingId: string }
        | { placeId: string };
      const loc = locationOf({ ...subject });
      if (!loc) return notFound();
      const refused = writer(loc);
      if (refused) return refused;
      const s = storeOf(state);
      const c = s.connections.get(loc);
      if (!c) return notFound();
      const items: PaperlessLink[] = [];
      for (const documentId of b.documentIds) {
        if (!MOCK_DOCUMENTS.some((d) => d.documentId === documentId)) return notFound();
        const existing = s.links.find(
          (l) => subjectId(l.subject) === subjectId(subject) && l.documentId === documentId,
        );
        if (existing) {
          items.push(existing);
          continue;
        }
        const link = linkOf(s, state, c.connection.url, subject, documentId);
        s.links.push(link);
        items.push(link);
      }
      return reply(201, { items });
    }),
    route('DELETE', p.link(':id'), ({ params }) => {
      const s = storeOf(state);
      const at = s.links.findIndex((l) => l.id === params.id);
      if (at < 0) return notFound();
      s.links.splice(at, 1);
      return reply(204);
    }),
    route('POST', p.linkCopy(':id'), ({ params }) => {
      const s = storeOf(state);
      const link = s.links.find((l) => l.id === params.id);
      if (!link) return notFound();
      if (link.copiedAttachmentId)
        return err(409, 'conflict', 'That conflicts with the current state.');
      link.copiedAttachmentId = nextId(s, 'at');
      return reply(201, { link, attachmentId: link.copiedAttachmentId });
    }),
  ];
}
