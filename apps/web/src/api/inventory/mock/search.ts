/**
 * Mock handlers for search and saved views (task 20). Matching is word prefixes over
 * `@kept/shared`'s `searchVariants` (the JS twin of `kept.normalize` + `strip_prefixes`, D42 and
 * screens §8): each word is indexed and queried in both its normalised and its prefix-stripped
 * form, as the server's tsvector and `tsQuery()` do. A 6-character Crockford query also looks up
 * short IDs. `containerThumbUrl` is the container's first photo (D195), as the server's lateral
 * join finds it. Saved views follow `saved-views.share` for sharing.
 *
 * Documents (T21) match `inventory.fileText` (a file's text by id) and follow the server's money
 * rule (search/documents.ts): where money is hidden, receipts and invoices are not results and
 * the others carry `moneyHidden` in place of a snippet.
 */
import { normalize, searchVariants } from '@kept/shared';
import type { MockState } from '../../mock/fixtures';
import { forbidden, type MockRoute, notFound, reply, route, sessionGate } from '../../mock/kit';
import { inventoryPaths as p } from '../paths';
import type {
  CreateSavedViewBody,
  DocumentResult,
  SavedView,
  SavedViewPrefs,
  SearchResponse,
  SearchStateFilter,
  ThingRow,
  UpdateSavedViewBody,
} from '../types';
import {
  accessOf,
  derivedStateOf,
  fold,
  type InventoryState,
  newId,
  now,
  paginate,
  placePath,
  rowOf,
  type StoredThing,
} from './db';
import { narrow, valuesOf } from './filters';
import { attentionMatch } from './home';
import { meaningOnly, semanticMock } from './semantic';

const SHORT_CODE = /^[0-9A-HJKMNP-TV-Z]{6}$/;
const WORD = /[\p{L}\p{N}]+/gu;

/** Both search forms of every word of `text` (normalised, and without ال/و/ب/ف/ك/لل). */
function indexOf(text: string): string[] {
  return (normalize(text).match(WORD) ?? []).flatMap((w) => searchVariants(w));
}

/**
 * Every word of `q` matches, as a prefix, some indexed form of `text`: the mock's stand-in for
 * `search_tsv @@ tsQuery(q)` (each query word is `(normalised:* | stripped:*)`, words ANDed).
 */
export function searchMatches(text: string, q: string): boolean {
  const index = indexOf(text);
  const words = normalize(q).match(WORD) ?? [];
  return (
    words.length > 0 &&
    words.every((w) => searchVariants(w).some((v) => index.some((x) => x.startsWith(v))))
  );
}

/** Characters kept before and after the first matching word, as the server's snippet. */
const SNIPPET_BEFORE = 60;
const SNIPPET_AFTER = 140;

/** An excerpt of `text` around the first word a query word prefixes; the opening otherwise. */
export function snippetOf(text: string, q: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const forms = (normalize(q).match(WORD) ?? []).map((w) => searchVariants(w));
  let at = 0;
  let end = 0;
  for (const m of flat.matchAll(/\S+/g)) {
    const index = indexOf(m[0]);
    if (forms.some((f) => f.some((v) => index.some((x) => x.startsWith(v))))) {
      at = m.index ?? 0;
      end = at + m[0].length;
      break;
    }
  }
  const from = Math.max(0, at - SNIPPET_BEFORE);
  const to = Math.min(flat.length, Math.max(end, at) + SNIPPET_AFTER);
  return flat.slice(from, to).trim();
}

/** A thing row with the container's first photo beside its path (D195). */
function resultRow(inv: InventoryState, t: StoredThing): ThingRow {
  const row = rowOf(inv, t);
  if (row.containerThumbUrl || !t.containerId) return row;
  const photo = inv.attachments.find(
    (a) =>
      a.role === 'photo' && 'thingId' in a.subject && a.subject.thingId === t.containerId && a.file,
  );
  return { ...row, containerThumbUrl: photo?.file?.thumbUrl ?? null };
}

export function searchRoutes(state: MockState): MockRoute[] {
  const inv = () => state.inventory;
  /** A personal view is its maker's; a shared one, its maker's or the location admins'. */
  const mayChange = (v: SavedView) =>
    v.createdBy.displayName === state.me.user.displayName ||
    (v.sharedLocationId !== null && accessOf(state).isAdmin(v.sharedLocationId));

  return [
    route('GET', p.search, ({ query }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const visible = accessOf(state).visibleIds();
      const q = (query.get('q') ?? '').trim();
      const kind = query.get('kind');
      const inScope = (loc: string) => visible.has(loc);
      const code = q.toUpperCase();

      let things = inv().things.filter((t) => !t.deletedAt && inScope(t.locationId));
      things = narrow(things, query, 'locationId', (t, v) => t.locationId === v);
      things = narrow(things, query, 'typeId', (t, v) => t.type?.id === v);
      things = narrow(things, query, 'tagId', (t, v) => t.tags.some((g) => g.id === v));
      // Price bounds on the unit price, for callers who see money there (ignored otherwise).
      const priceMin = query.get('priceMin');
      const priceMax = query.get('priceMax');
      const priceCurrency = query.get('currency');
      if (priceMin || priceMax)
        things = things.filter((t) => {
          if (!accessOf(state).canWrite(t.locationId)) return true;
          const unit = t.purchase?.unitPrice;
          if (unit === undefined) return false;
          if (priceCurrency && t.purchase?.currency !== priceCurrency) return false;
          if (priceMin && Number(unit) < Number(priceMin)) return false;
          if (priceMax && Number(unit) > Number(priceMax)) return false;
          return true;
        });
      // Home's attention rows (task 29) share their predicates with /home.
      things = narrow(things, query, 'state', (t, v) => {
        const attention = attentionMatch(state, v as SearchStateFilter);
        return attention ? attention(t) : derivedStateOf(t, inv()).includes(v as 'draft');
      });
      things = narrow(
        things,
        query,
        'placeId',
        (t, root) =>
          placePath(inv(), t.placeId).some((s) => s.id === root) ||
          rowOf(inv(), t).path.some((s) => s.id === root),
      );
      const inLocations = <T extends { locationId: string }>(items: T[]) =>
        narrow(items, query, 'locationId', (x, v) => x.locationId === v);
      const scored = things
        .map((t) => {
          const aliases = Object.values(t.aliases).flat();
          const alias = q ? aliases.find((a) => searchMatches(a, q)) : undefined;
          const hit =
            !q ||
            (SHORT_CODE.test(code) && t.shortCode === code) ||
            searchMatches(
              [t.name ?? '', t.brand?.name ?? '', t.model ?? '', ...t.tags.map((g) => g.name)].join(
                ' ',
              ),
              q,
            ) ||
            (t.serial && fold(t.serial) === fold(q)) ||
            alias !== undefined;
          const exactCode = SHORT_CODE.test(code) && t.shortCode === code;
          return hit ? { t, alias, score: exactCode ? 2 : 1 } : null;
        })
        .filter((x) => x !== null)
        .sort((a, b) => b.score - a.score || (a.t.name ?? '').localeCompare(b.t.name ?? ''));
      const rows: ThingRow[] = scored.map(({ t, alias }) => ({
        ...resultRow(inv(), t),
        ...(alias && !searchMatches(t.name ?? '', q) ? { matchedAlias: alias } : {}),
      }));
      // Step 6 (T14): what only meaning found comes after the words' matches, marked as such.
      for (const id of meaningOnly(state, q)) {
        const t = things.find((x) => x.id === id);
        if (t && !rows.some((r) => r.id === id))
          rows.push({ ...resultRow(inv(), t), matchedBy: 'meaning' });
      }

      const places = inLocations(
        inv().places.filter((pl) => !pl.deletedAt && !pl.isUnplaced && inScope(pl.locationId)),
      )
        .filter((pl) => q && searchMatches(pl.name, q))
        .map((pl) => ({
          id: pl.id,
          locationId: pl.locationId,
          name: pl.name,
          kindKey: pl.kindKey,
          icon: pl.icon,
          path: placePath(inv(), pl.parentId),
        }));
      const chosen = valuesOf(query, 'locationId');
      const none = query.getAll('not').includes('locationId');
      const accounts = new Set(
        [...visible]
          .filter((l) => !chosen.length || chosen.includes(l) !== none)
          .map((l) => inv().accountOf[l]),
      );
      const people = inv()
        .people.filter(
          (x) => accounts.has(x.ownerAccountId) && q && searchMatches(x.displayName, q),
        )
        .map((x) => ({ id: x.id, displayName: x.displayName, ownerAccountId: x.ownerAccountId }));
      const vendors = inv()
        .vendors.filter((x) => accounts.has(x.ownerAccountId) && q && searchMatches(x.name, q))
        .map((x) => ({ id: x.id, name: x.name, kind: x.kind, ownerAccountId: x.ownerAccountId }));

      // Documents (T21): the attachments whose file's text matches, as the server's gates allow.
      const showsMoney = (locationId: string) => {
        const loc = state.locations.find((l) => l.id === locationId);
        const role = loc?.role ?? 'viewer';
        const moneyOn = loc?.modules.includes('money') ?? false;
        return moneyOn && (role !== 'viewer' || loc?.moneyVisibleToViewers === true);
      };
      const subjectOf = (a: InventoryState['attachments'][number]): DocumentResult['subject'] => {
        const s = a.subject;
        if ('thingId' in s) {
          const t = inv().things.find((x) => x.id === s.thingId);
          return { kind: 'thing', id: s.thingId, name: t?.name ?? null };
        }
        if ('placeId' in s) {
          const pl = inv().places.find((x) => x.id === s.placeId);
          return { kind: 'place', id: s.placeId, name: pl?.name ?? null };
        }
        if ('purchaseId' in s) {
          const pu = inv().purchases.find((x) => x.id === s.purchaseId);
          return { kind: 'purchase', id: s.purchaseId, name: pu?.vendor?.name ?? null };
        }
        if ('meterReadingId' in s)
          return { kind: 'meter_reading', id: s.meterReadingId, name: null };
        const l = state.locations.find((x) => x.id === a.locationId);
        return { kind: 'location', id: a.locationId, name: l?.name ?? null };
      };
      const trashed = (a: InventoryState['attachments'][number]) => {
        const s = a.subject;
        if ('thingId' in s) return !!inv().things.find((x) => x.id === s.thingId)?.deletedAt;
        if ('placeId' in s) return !!inv().places.find((x) => x.id === s.placeId)?.deletedAt;
        return false;
      };
      const texts = inv().fileText ?? {};
      const documents: DocumentResult[] = q
        ? inLocations(inv().attachments)
            .filter((a) => a.file && inScope(a.locationId) && !trashed(a))
            .filter((a) => searchMatches(texts[a.file?.id ?? ''] ?? '', q))
            .filter(
              (a) => showsMoney(a.locationId) || (a.role !== 'receipt' && a.role !== 'invoice'),
            )
            .map((a) => ({
              attachmentId: a.id,
              fileId: a.file?.id ?? '',
              locationId: a.locationId,
              subject: subjectOf(a),
              role: a.role,
              ...(showsMoney(a.locationId)
                ? { snippet: snippetOf(texts[a.file?.id ?? ''] ?? '', q) }
                : { moneyHidden: true as const }),
            }))
        : [];

      const limitOf = (n: number) => {
        const qs = new URLSearchParams(query);
        if (!kind && !qs.get('limit')) qs.set('limit', String(n));
        return qs;
      };
      const empty =
        rows.length + places.length + people.length + vendors.length + documents.length === 0;
      const out: SearchResponse = {
        things:
          !kind || kind === 'things'
            ? paginate(rows, limitOf(20))
            : { items: [], next_cursor: null },
        places: !kind || kind === 'places' ? places.slice(0, kind ? undefined : 5) : [],
        people: !kind || kind === 'people' ? people.slice(0, kind ? undefined : 5) : [],
        vendors: !kind || kind === 'vendors' ? vendors.slice(0, kind ? undefined : 5) : [],
        documents: {
          items: !kind || kind === 'documents' ? documents.slice(0, kind ? undefined : 5) : [],
        },
        didYouMean: empty && fold(q) === 'hmdi' ? ['HDMI cable, 2 m'] : [],
        asOf: now(),
        semantic: q ? semanticMock(state).state : null,
      };
      return out;
    }),

    route('GET', p.savedViews, ({ query }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const visible = accessOf(state).visibleIds();
      const surface = query.get('surface');
      const views = inv()
        .savedViews.filter((v) => v.sharedLocationId === null || visible.has(v.sharedLocationId))
        .filter((v) => !surface || v.surface === surface)
        .map((v) => ({ ...v, mine: v.createdBy.displayName === state.me.user.displayName }))
        .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
      const stored = surface ? inv().savedViewPrefs[surface] : undefined;
      const ids = new Set(views.map((v) => v.id));
      return {
        views,
        next_cursor: null,
        prefs: surface
          ? {
              defaultViewId:
                stored?.defaultViewId && ids.has(stored.defaultViewId)
                  ? stored.defaultViewId
                  : null,
              pinned: (stored?.pinned ?? []).filter((id) => ids.has(id)),
            }
          : null,
      };
    }),
    route('POST', p.savedViews, ({ body }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const b = body as CreateSavedViewBody;
      if (b.sharedLocationId) {
        if (!accessOf(state).visible(b.sharedLocationId)) return notFound();
        if (!accessOf(state).canWrite(b.sharedLocationId)) return forbidden();
      }
      const view: SavedView = {
        id: b.id ?? newId(),
        name: b.name,
        surface: b.surface ?? 'search',
        query: b.query,
        sharedLocationId: b.sharedLocationId ?? null,
        createdBy: { displayName: state.me.user.displayName },
        mine: true,
        rowVersion: 1,
      };
      inv().savedViews.push(view);
      return reply(201, view);
    }),
    route('PUT', p.savedViewPrefs(':surface'), ({ params, body }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const b = body as SavedViewPrefs;
      inv().savedViewPrefs[params.surface ?? ''] = {
        defaultViewId: b.defaultViewId,
        pinned: [...b.pinned],
      };
      return b;
    }),
    route('PATCH', p.savedView(':id'), ({ params, body }) => {
      const view = inv().savedViews.find((v) => v.id === params.id);
      if (!view) return notFound();
      if (view.createdBy.displayName !== state.me.user.displayName) return forbidden();
      Object.assign(view, body as UpdateSavedViewBody);
      view.rowVersion += 1;
      return view;
    }),
    route('DELETE', p.savedView(':id'), ({ params }) => {
      const view = inv().savedViews.find((v) => v.id === params.id);
      if (!view) return notFound();
      if (!mayChange(view)) return forbidden();
      inv().savedViews = inv().savedViews.filter((v) => v.id !== params.id);
      return reply(204);
    }),
  ];
}
