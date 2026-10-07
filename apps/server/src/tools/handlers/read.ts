import { pageSize, type ToolOutput } from '@kept/mcp';
import { DERIVED_STATES, type DerivedState, LIFECYCLES, type Lifecycle } from '@kept/shared';
import { z } from 'zod';
import { listAttachments } from '../../files/attachments.js';
import { thingHistory } from '../../history/service.js';
import { decodeCursor } from '../../http/conventions.js';
import { invalid } from '../../http/errors.js';
import { listPaperwork } from '../../paperwork/library.js';
import { SearchQuery } from '../../search/query.js';
import { search } from '../../search/service.js';
import { gateFor } from '../../serialize/gates.js';
import { listThings } from '../../things/service.js';
import { ListQuery } from '../../things/validate.js';
import { viewOf } from '../../things/view.js';
import { toolsIn } from '../context.js';
import {
  decodeToolCursor,
  encodeToolCursor,
  openLoansOf,
  placePath,
  placeRefOf,
  type RowLike,
  thingPath,
  thingRefOf,
  thingSummaryOf,
  typeNameOf,
} from '../output.js';
import { findRef, locationOfRef, targetIn, thingIn, typeNamed } from '../resolve.js';
import type { Handler, HandlerResult, Op } from '../types.js';

// The read tools (§2.5, D63): each one calls the operation its route calls (search, the thing
// view, the contents lists, history, attachments), as the caller, and shapes the answer.

const namesOf = (op: Op) => new Map(op.locations.map((l) => [l.id, l.name]));

/** Pages over an operation's keyset pages: `c` the operation's cursor, `o` how many of that page
 * were answered already (fit() shortened it). */
function paged<T>(
  cursor: string | undefined,
  run: (opCursor: string | undefined) => Promise<{ items: T[]; next: string | null }>,
) {
  const at = decodeToolCursor(cursor);
  return run(at.c ?? undefined).then(({ items, next }) => ({
    items: items.slice(at.o),
    nextCursor: next ? encodeToolCursor({ c: next, o: 0 }) : null,
    cursorAt: (kept: number) => encodeToolCursor({ c: at.c, o: at.o + kept }),
  }));
}

// ---------------------------------------------------------------------------------------------

export const capabilities: Handler<'capabilities'> = {
  action: 'content.view',
  global: true,
  run: async (op) => ({
    data: {
      scope: op.principal.scope,
      locations: op.locations.map((l) => ({
        id: l.id,
        role: l.role,
        time_zone: l.timeZone,
        untrusted: { name: l.name },
        modules: [...l.modules],
        tools: toolsIn(op.principal, op.via, l.role, l.modules),
      })),
    },
  }),
};

export const listLocations: Handler<'list_locations'> = {
  action: 'content.view',
  global: true,
  run: async (op) => ({
    data: {
      items: op.locations.map((l) => ({
        id: l.id,
        role: l.role,
        time_zone: l.timeZone,
        untrusted: { name: l.name },
      })),
    },
  }),
};

// ---------------------------------------------------------------------------------------------
// search_things and where_is: step 2's search (search/service.ts), with T14's semantic merge
// inside search() (reciprocal rank fusion, `matchedBy: 'meaning'`): each declares the text it
// searches by `meaning`, runTool embeds it before the transaction, and the vectors reach search()
// as `op.semantic`.
// ---------------------------------------------------------------------------------------------

/** How a row was found: keyword search today; T14's merged rows say `meaning`. */
const matchedByOf = (row: object): 'keyword' | 'meaning' =>
  (row as { matchedBy?: string }).matchedBy === 'meaning' ? 'meaning' : 'keyword';

const isDerived = (s: string): s is DerivedState =>
  (DERIVED_STATES as readonly string[]).includes(s);
const isLifecycle = (s: string): s is Lifecycle => (LIFECYCLES as readonly string[]).includes(s);

/** The ids of the tags of the locations' accounts with that name. */
async function tagIds(op: Op, name: string): Promise<string[]> {
  const { rows } = await op.client.query<{ id: string }>(
    `SELECT DISTINCT g.id FROM public.tags g
       JOIN public.locations l ON l.owner_account_id = g.owner_account_id
      WHERE l.id = ANY ($1::uuid[]) AND kept.normalize(g.name) = kept.normalize($2)`,
    [op.locations.map((l) => l.id), name],
  );
  return rows.map((r) => r.id);
}

/** The ids of the types with that name (built-in or the locations' accounts'). */
async function typeIds(op: Op, name: string): Promise<string[]> {
  const out = new Set<string>();
  for (const l of op.locations) {
    const id = await typeNamed(op.client, l.id, name);
    if (id) out.add(id);
  }
  return [...out];
}

async function summaries(op: Op, rows: RowLike[]) {
  const names = namesOf(op);
  const loans = await openLoansOf(
    op.client,
    rows
      .filter((r) => r.derivedState.includes('lent') || r.derivedState.includes('borrowed'))
      .map((r) => r.id),
  );
  return rows.map((r) => ({
    ...thingSummaryOf(r, names.get(r.locationId), loans),
    matched_by: matchedByOf(r),
  }));
}

export const searchThings: Handler<'search_things'> = {
  action: 'content.view',
  global: true,
  // Meaning fuses into the first page only: a later keyword page needs no query embedding.
  meaning: (input) => (decodeToolCursor(input.cursor).c ? undefined : input.query),
  run: async (op, input): Promise<HandlerResult<ToolOutput<'search_things'>>> => {
    const size = pageSize(input.limit);
    const locationIds = op.locations.map((l) => l.id);
    const f = input.filters ?? {};
    const empty = { data: { items: [] } };
    const typeId = f.type ? await typeIds(op, f.type) : undefined;
    if (typeId && typeId.length === 0) return empty;
    const tagId = f.tag ? await tagIds(op, f.tag) : undefined;
    if (tagId && tagId.length === 0) return empty;
    let placeId: string | undefined;
    if (f.place_id) {
      const found = await findRef(op.client, f.place_id);
      if (found?.kind !== 'place' || !locationIds.includes(found.locationId)) return empty;
      placeId = found.id;
    }
    const status = f.status;
    if (status && isLifecycle(status) && status !== 'in_use') {
      // An ended thing, by how it ended: the things list filters the stored lifecycle.
      const page = await paged(input.cursor, async (c) => {
        const q = ListQuery.parse({
          locationId: locationIds,
          lifecycle: status,
          ...(input.query ? { q: input.query } : {}),
          ...(placeId ? { placeId } : {}),
          ...(typeId ? { typeId } : {}),
          ...(tagId ? { tagId } : {}),
          limit: size,
          ...(c ? { cursor: c } : {}),
        });
        const res = await listThings(op.client, null, q);
        return { items: res.items, next: res.next_cursor };
      });
      return { ...page, data: { items: await summaries(op, page.items) } };
    }
    const state =
      status === 'in_use'
        ? { state: ['ended' as const], not: ['state' as const] }
        : status && isDerived(status)
          ? { state: [status] }
          : {};
    const page = await paged(input.cursor, async (c) => {
      const q = SearchQuery.parse({
        ...(input.query ? { q: input.query } : {}),
        locationId: locationIds,
        kind: 'things',
        limit: size,
        ...(placeId ? { placeId: [placeId] } : {}),
        ...(typeId ? { typeId } : {}),
        ...(tagId ? { tagId } : {}),
        ...state,
        ...(c ? { cursor: c } : {}),
      });
      const res = await search(op.tx, op.client, op.scope, null, q, op.semantic);
      return { items: res.things.items, next: res.things.next_cursor };
    });
    return { ...page, data: { items: await summaries(op, page.items) } };
  },
};

/** At most this many best matches (a question, not a list). */
export const WHERE_IS_LIMIT = 5;

export const whereIs: Handler<'where_is'> = {
  action: 'content.view',
  global: true,
  meaning: (input) => input.query,
  run: async (op, input) => {
    const q = SearchQuery.parse({
      q: input.query,
      locationId: op.locations.map((l) => l.id),
      kind: 'things',
      limit: WHERE_IS_LIMIT,
    });
    const res = await search(op.tx, op.client, op.scope, null, q, op.semantic);
    const items = await summaries(op, res.things.items);
    return {
      data: { items: items.map((t) => ({ ...t, uncertain: t.states.includes('uncertain') })) },
    };
  },
};

// ---------------------------------------------------------------------------------------------

export const getThing: Handler<'get_thing'> = {
  action: 'content.view',
  subjectLocation: (client, input) => locationOfRef(client, input.thing_id),
  run: async (op, input) => {
    const loc = op.location as NonNullable<Op['location']>;
    const id = await thingIn(op.client, loc.id, input.thing_id);
    // The route's own view: money gated, secret values never in it (they have their own route).
    const v = await viewOf(op.tx, op.client, op.scope, null, id);
    const ref = thingRefOf(v, loc.name);
    const aliases = Object.values(v.aliases ?? {}).flat();
    const custom = Object.fromEntries(
      Object.entries(v.custom ?? {}).filter(([k]) => !v.secrets.some((s) => s.fieldKey === k)),
    );
    const purchase = v.purchase
      ? {
          purchased_on: v.purchase.purchasedOn,
          ...(v.purchase.unitPrice !== undefined && v.purchase.currency
            ? { price: { amount: v.purchase.unitPrice, currency: v.purchase.currency } }
            : {}),
        }
      : undefined;
    const loans = await openLoansOf(op.client, [id]);
    const loan = loans.get(id);
    return {
      data: {
        thing: {
          ...ref,
          quantity: v.quantity,
          lifecycle: v.lifecycle as Lifecycle,
          states: v.derivedState,
          last_seen_at: v.lastSeenAt,
          ...(loan ? { loan } : {}),
          type_id: v.type?.id ?? null,
          condition: v.condition,
          container: v.isContainer,
          untrusted: {
            ...ref.untrusted,
            ...(aliases.length > 0 ? { aliases } : {}),
            type: typeNameOf(v.type),
            brand: v.brand?.name ?? null,
            model: v.model,
            notes: v.notes,
            ...(Object.keys(custom).length > 0 ? { fields: custom } : {}),
          },
          ...(purchase ? { purchase } : {}),
          ...(v.meters.length > 0
            ? {
                meters: v.meters.map((m) => ({
                  id: m.id,
                  unit: m.unit,
                  last_value: m.latest ? Number(m.latest.value) : null,
                  last_taken_at: m.latest?.takenAt ?? null,
                  untrusted: { name: m.label ?? m.kind },
                })),
              }
            : {}),
          url: op.link(thingPath(ref)),
        },
      },
    };
  },
};

// ---------------------------------------------------------------------------------------------
// list_contents: the contents operations (places/view.ts's tree, things/service.ts's list by
// place or container), walked 1–3 levels down. At most CONTENTS_CAP entries are walked; pages
// are cut from that walk.
// ---------------------------------------------------------------------------------------------

export const CONTENTS_CAP = 1000;

type Entry =
  | { depth: number; kind: 'place'; id: string }
  | { depth: number; kind: 'thing'; row: RowLike };

async function thingsIn(op: Op, filter: { placeId: string } | { containerId: string }) {
  const out: RowLike[] = [];
  let cursor: string | undefined;
  do {
    const q = ListQuery.parse({
      locationId: [(op.location as NonNullable<Op['location']>).id],
      ...filter,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    const page = await listThings(op.client, null, q);
    out.push(...page.items);
    cursor = page.next_cursor ?? undefined;
  } while (cursor && out.length < CONTENTS_CAP);
  return out;
}

async function childPlaces(op: Op, placeId: string): Promise<string[]> {
  const { rows } = await op.client.query<{ id: string }>(
    `SELECT id FROM public.places WHERE parent_id = $1 AND deleted_at IS NULL
      ORDER BY sort, lower(name), id`,
    [placeId],
  );
  return rows.map((r) => r.id);
}

export const listContents: Handler<'list_contents'> = {
  action: 'content.view',
  subjectLocation: (client, input) => locationOfRef(client, input.place_id ?? input.container_id),
  run: async (op, input) => {
    const loc = op.location as NonNullable<Op['location']>;
    const raw = input.place_id ?? input.container_id;
    if (!raw) throw invalid('Give place_id or container_id (search_things finds them).');
    const start = await targetIn(op.client, loc.id, raw);
    const depth = input.depth ?? 1;
    const entries: Entry[] = [];
    const walk = async (
      at: { placeId: string } | { containerId: string },
      level: number,
    ): Promise<void> => {
      if (level > depth || entries.length >= CONTENTS_CAP) return;
      if ('placeId' in at) {
        for (const id of await childPlaces(op, at.placeId)) {
          if (entries.length >= CONTENTS_CAP) return;
          entries.push({ depth: level, kind: 'place', id });
          await walk({ placeId: id }, level + 1);
        }
      }
      for (const row of await thingsIn(op, at)) {
        if (entries.length >= CONTENTS_CAP) return;
        entries.push({ depth: level, kind: 'thing', row });
        if ((row as { isContainer?: boolean }).isContainer)
          await walk({ containerId: row.id }, level + 1);
      }
    };
    await walk(start, 1);

    const at = decodeToolCursor(input.cursor);
    const size = pageSize(input.limit);
    const offset = at.o;
    const slice = entries.slice(offset, offset + size);
    const loans = await openLoansOf(
      op.client,
      slice.flatMap((e) => (e.kind === 'thing' ? [e.row.id] : [])),
    );
    const items = [];
    for (const e of slice) {
      if (e.kind === 'place')
        items.push({ depth: e.depth, place: await placeRefOf(op.client, e.id) });
      else items.push({ depth: e.depth, thing: thingSummaryOf(e.row, loc.name, loans) });
    }
    let parent: ToolOutput<'list_contents'>['parent'];
    if ('placeId' in start) parent = await placeRefOf(op.client, start.placeId);
    else {
      const v = await viewOf(op.tx, op.client, op.scope, null, start.containerId);
      parent = thingRefOf(v, loc.name);
    }
    return {
      data: { parent, items },
      nextCursor:
        offset + size < entries.length ? encodeToolCursor({ c: null, o: offset + size }) : null,
      cursorAt: (kept) => encodeToolCursor({ c: null, o: offset + kept }),
    };
  },
};

// ---------------------------------------------------------------------------------------------

const ACTOR_TYPES = ['user', 'token', 'system'] as const;

export const thingHistoryTool: Handler<'thing_history'> = {
  action: 'content.view',
  subjectLocation: (client, input) => locationOfRef(client, input.thing_id),
  run: async (op, input) => {
    const loc = op.location as NonNullable<Op['location']>;
    const id = await thingIn(op.client, loc.id, input.thing_id);
    const size = pageSize(input.limit);
    // The route's own rendering: renderAudit() redacts per the viewer (D110, D183) and the
    // summary never carries a value; the tool answers no diff at all.
    const page = await paged(input.cursor, async (c) => {
      const res = await thingHistory(op.tx, op.client, op.scope, id, {
        limit: size,
        ...(c ? { cursor: c } : {}),
      });
      return { items: res.items, next: res.next_cursor };
    });
    return {
      nextCursor: page.nextCursor,
      cursorAt: page.cursorAt,
      data: {
        items: page.items.map((e) => ({
          id: e.id,
          at: e.at,
          action: e.action,
          actor_type: (ACTOR_TYPES as readonly string[]).includes(e.actor.type)
            ? (e.actor.type as (typeof ACTOR_TYPES)[number])
            : 'system',
          untrusted: { actor: e.actor.displayName, summary: e.summary },
        })),
      },
    };
  },
};

// ---------------------------------------------------------------------------------------------
// find_documents: a thing's attachments (files/attachments.ts), documents whose text matches
// (search's documents group), or the paperwork library (paperwork/library.ts). Never file bytes
// or signed URLs (D63): the subject's page in Kept instead.
// ---------------------------------------------------------------------------------------------

type DocRef = {
  attachmentId: string;
  role: ToolOutput<'find_documents'>['items'][number]['role'];
  subject: { type: ToolOutput<'find_documents'>['items'][number]['subject']['type']; id: string };
  subjectName: string;
};

const ListKey = z.tuple([z.number(), z.uuid()]);

function subjectLink(op: Op, s: DocRef['subject'], code: string | null): string {
  if (s.type === 'thing') return op.link(thingPath({ id: s.id, short_code: code }));
  if (s.type === 'place') return op.link(placePath({ id: s.id, short_code: code }));
  if (s.type === 'location') return op.link(`/loc/${s.id}`);
  if (s.type === 'incident') return op.link(`/incidents/${s.id}`);
  return op.link('/paperwork');
}

/** The answer's items: only attachments in the call's locations (a location whose door or
 * module is off is not among them, even where the operation reads all visible ones). */
async function documentsOf(op: Op, refs: DocRef[]) {
  if (refs.length === 0) return [];
  const { rows } = await op.client.query<{
    id: string;
    mime: string | null;
    bytes: string | null;
    created_at: Date;
  }>(
    `SELECT a.id, f.mime, f.bytes::text AS bytes, a.created_at
       FROM public.attachments a LEFT JOIN public.files f ON f.id = a.file_id
      WHERE a.id = ANY ($1::uuid[]) AND a.location_id = ANY ($2::uuid[])`,
    [refs.map((r) => r.attachmentId), op.locations.map((l) => l.id)],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const { rows: codes } = await op.client.query<{ id: string; code: string }>(
    `SELECT coalesce(thing_id, place_id) AS id, code FROM public.short_ids
      WHERE coalesce(thing_id, place_id) = ANY ($1::uuid[]) AND is_primary AND state = 'assigned'`,
    [refs.map((r) => r.subject.id)],
  );
  const codeOf = new Map(codes.map((c) => [c.id, c.code]));
  return refs.flatMap((r) => {
    const a = byId.get(r.attachmentId);
    if (!a) return [];
    return [
      {
        attachment_id: r.attachmentId,
        role: r.role,
        subject: r.subject,
        // A link attachment (a URL, no file) says so by its type.
        mime: a.mime ?? 'text/uri-list',
        bytes: a.bytes === null ? 0 : Number(a.bytes),
        added_at: a.created_at.toISOString(),
        url: subjectLink(op, r.subject, codeOf.get(r.subject.id) ?? null),
        untrusted: { title: null, subject: r.subjectName },
      },
    ];
  });
}

export const findDocuments: Handler<'find_documents'> = {
  action: 'content.view',
  global: true,
  subjectLocation: (client, input) => locationOfRef(client, input.thing_id),
  run: async (op, input) => {
    const size = pageSize(input.limit);
    const roles = input.roles && input.roles.length > 0 ? new Set(input.roles) : null;
    const keep = (role: string) => !roles || roles.has(role as never);

    if (input.thing_id) {
      const loc = op.location as NonNullable<Op['location']>;
      const id = await thingIn(op.client, loc.id, input.thing_id);
      const v = await viewOf(op.tx, op.client, op.scope, null, id);
      const page = await paged(input.cursor, async (c) => {
        let after: [number, string] | null = null;
        if (c) {
          const parsed = ListKey.safeParse(decodeCursor(c));
          if (!parsed.success) throw invalid('The cursor is not valid; start again without one.');
          after = parsed.data;
        }
        const res = await listAttachments(
          op.client,
          null,
          (locationId) => gateFor(op.tx, locationId, op.scope),
          'thing',
          id,
          { role: roles?.size === 1 ? [...roles][0] : undefined, limit: size, after },
        );
        return { items: res.items, next: res.next_cursor };
      });
      const refs = page.items
        .filter((a) => keep(a.role))
        .map((a) => ({
          attachmentId: a.id,
          role: a.role,
          subject: { type: 'thing' as const, id },
          subjectName: v.name ?? '',
        }));
      return { ...page, data: { items: await documentsOf(op, refs) } };
    }

    const locationIds = op.locations.map((l) => l.id);
    if (input.query) {
      // Search's documents group: text of files, money snippets only where the gate shows money
      // (the tool answers no snippet at all). One page of up to `size`.
      const q = SearchQuery.parse({
        q: input.query,
        locationId: locationIds,
        kind: 'documents',
        limit: size,
      });
      const res = await search(op.tx, op.client, op.scope, null, q);
      const refs = res.documents.items
        .filter((d) => keep(d.role))
        .map((d) => ({
          attachmentId: d.attachmentId,
          role: d.role,
          subject: { type: d.subject.kind, id: d.subject.id },
          subjectName: d.subject.name ?? '',
        }));
      return { data: { items: await documentsOf(op, refs) } };
    }

    // The paperwork library (its own module check is in its query: kept.module_on()).
    const page = await paged(input.cursor, async (c) => {
      const res = await listPaperwork(
        op.tx,
        op.client,
        null,
        op.scope,
        {
          ...(op.location ? { locationId: op.location.id } : {}),
          ...(roles?.size === 1 ? { role: [...roles][0] } : {}),
        },
        { limit: size, after: c ? decodeCursor(c) : null },
      );
      return { items: res.items, next: res.next_cursor };
    });
    const refs = page.items
      .filter((r) => keep(r.attachment.role))
      .map((r) => ({
        attachmentId: r.attachment.id,
        role: r.attachment.role,
        subject: { type: r.subject.type, id: r.subject.id },
        subjectName: r.subject.name,
      }));
    return { ...page, data: { items: await documentsOf(op, refs) } };
  },
};
