/**
 * Mock handlers for the "To review" inbox (T15). Items are serialised from the live inventory,
 * listed for writable locations only (a viewer gets 403), "Mine" by default, newest batch first,
 * with the per-kind counts the chips read (the web hides zero-count chips, D191). Every action
 * checks If-Match against the item's `rowVersion` and resolves the item.
 *
 * T27's additions, for T15 to match: `q` searches the list (the counts ignore it); a draft shows
 * its brand, model, colour and serial; a batch says how many it captured; candidates rank for a
 * receipt `line` and say why they match; a merge's `into` is the survivor, either side of the
 * pair; an accept applies the accepted suggestions and `set`.
 */
import { aliasSuggestionLanguage, type InboxKind, normalize } from '@kept/shared';
import { hh, moduleOn, newId } from '../../household/mock/db';
import {
  accessOf,
  liveThing,
  now,
  paginate,
  placePath,
  recordEvent,
  rowOf,
  type StoredThing,
  versionError,
} from '../../inventory/mock/db';
import type { MockState } from '../../mock/fixtures';
import {
  err,
  forbidden,
  type MockRequest,
  type MockRoute,
  notFound,
  reply,
  route,
  sessionGate,
} from '../../mock/kit';
import { capturePaths as p } from '../paths';
import {
  type CandidateMatch,
  canAcceptSuggestion,
  type InboxAcceptBody,
  type InboxBulkBody,
  type InboxCurrencyBody,
  type InboxItem,
  type InboxMergeBody,
  type InboxReadingBody,
  isDocumentSuggestion,
  type Suggestion,
} from '../types';
import { actor, emptyCounts, type StoredInboxItem } from './state';

export function inboxRoutes(state: MockState): MockRoute[] {
  const inv = () => state.inventory;
  const cap = () => state.capture;
  const access = () => accessOf(state);
  const myId = () => state.me.user.id;

  /** Saturday's drafts join the inventory the first time the inbox is asked for (./state.ts). */
  const seed = () => {
    const seeds = cap().seedThings;
    if (seeds.length === 0) return;
    const template = inv().things.find((t) => t.reviewState === 'draft');
    if (!template) return;
    for (const { typeId, ...rest } of seeds.splice(0)) {
      const type = typeId ? inv().types.find((x) => x.id === typeId) : undefined;
      inv().things.push({
        ...structuredClone(template),
        ...rest,
        type: type
          ? { id: type.id, icon: type.icon, name: type.name, builtinKey: type.builtinKey }
          : null,
        fields: type?.fields ?? [],
      });
    }
  };

  const view = (s: StoredInboxItem): InboxItem => {
    const {
      createdById,
      createdByName,
      batchId,
      thingId,
      photos,
      fieldStatus,
      duplicate,
      resolvedAt: _r,
      resolution: _res,
      ...rest
    } = s;
    const batch = batchId ? cap().batches.find((b) => b.batchId === batchId) : undefined;
    const t = thingId ? liveThing(inv(), thingId) : undefined;
    const other = duplicate ? liveThing(inv(), duplicate.otherThingId) : undefined;
    return {
      ...rest,
      createdBy: actor(createdById === myId() ? state.me.user.displayName : (createdByName ?? '—')),
      batch: batch
        ? {
            id: batch.batchId,
            capturedAt: batch.capturedAt,
            placePath: placePath(inv(), batch.placeId),
            count: batch.thingIds.length,
          }
        : null,
      ...(t
        ? {
            thing: {
              ...rowOf(inv(), t),
              brand: t.brand,
              model: t.model,
              colour: t.colour,
              serial: t.serial,
              photos: photos ?? [],
              fieldStatus: fieldStatus ?? {},
            },
          }
        : {}),
      ...(duplicate && other
        ? { duplicate: { other: rowOf(inv(), other), reason: duplicate.reason } }
        : {}),
    };
  };

  /** Open items in locations the caller can write to. */
  const open = () =>
    cap().inbox.filter((i) => i.resolvedAt === null && access().canWrite(i.locationId));

  /** The item, If-Match checked; or the reply to send instead. */
  const target = (req: MockRequest): { item: StoredInboxItem } | { error: unknown } => {
    const gate = sessionGate(state);
    if (gate) return { error: gate };
    seed();
    const item = cap().inbox.find((i) => i.id === req.params.id && i.resolvedAt === null);
    if (!item || !access().visible(item.locationId)) return { error: notFound() };
    if (!access().canWrite(item.locationId)) return { error: forbidden() };
    const stale = versionError(req.headers, item, [], 'Alfred');
    if (stale) return { error: reply(stale.status, stale.body) };
    return { item };
  };
  const resolve = (item: StoredInboxItem, resolution: string) => {
    item.resolvedAt = now();
    item.resolution = resolution;
    item.rowVersion += 1;
    return {};
  };
  /** One action route: find, check, then act. */
  const action = (path: string, act: (item: StoredInboxItem, body: unknown) => unknown) =>
    route('POST', path, (req) => {
      const found = target(req);
      if ('error' in found) return found.error;
      return act(found.item, req.body);
    });

  /** A function that puts an item and its draft back as they are now (for an undo). */
  const snapshot = (item: StoredInboxItem, t: StoredThing | undefined) => {
    const was = { resolvedAt: item.resolvedAt, resolution: item.resolution };
    const thing = t ? structuredClone(t) : undefined;
    return () => {
      Object.assign(item, was);
      item.rowVersion += 1;
      if (t && thing) Object.assign(t, thing, { rowVersion: t.rowVersion + 1 });
    };
  };

  /** What `q` matches: the draft's name, the vendor as seen, the meter, the batch's place. */
  const searchText = (i: StoredInboxItem): string => {
    const t = i.thingId ? liveThing(inv(), i.thingId) : undefined;
    const batch = i.batchId ? cap().batches.find((b) => b.batchId === i.batchId) : undefined;
    return [
      t?.name,
      t?.brand?.name,
      t?.model,
      i.receipt?.vendorSeen,
      ...(i.receipt?.lines.map((l) => l.description) ?? []),
      i.claim?.claimedFor.name,
      i.syncDrop?.entity?.name,
      ...(batch ? placePath(inv(), batch.placeId).map((s) => s.name) : []),
    ]
      .filter(Boolean)
      .join(' ');
  };

  return [
    route('GET', p.inbox, ({ query }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const writable = state.locations.filter((l) => access().canWrite(l.id));
      if (writable.length === 0) return forbidden();
      seed();
      const q = normalize(query.get('q') ?? '');
      const locationId = query.get('locationId');
      const mine = query.get('mine') !== '0' && query.get('mine') !== 'false';
      const kind = query.get('kind') as InboxKind | null;
      const batchId = query.get('batchId');
      const scoped = open().filter((i) => !locationId || i.locationId === locationId);
      const byKind = emptyCounts();
      for (const i of scoped.filter((x) => !mine || x.createdById === myId())) byKind[i.kind] += 1;
      const items = scoped
        .filter((i) => !mine || i.createdById === myId())
        .filter((i) => !kind || i.kind === kind)
        .filter((i) => !batchId || i.batchId === batchId)
        .filter((i) => !q || normalize(searchText(i)).includes(q))
        .sort((a, b) => {
          const ba = cap().batches.find((x) => x.batchId === a.batchId)?.capturedAt ?? a.createdAt;
          const bb = cap().batches.find((x) => x.batchId === b.batchId)?.capturedAt ?? b.createdAt;
          return bb.localeCompare(ba) || b.createdAt.localeCompare(a.createdAt);
        })
        .map(view);
      return {
        ...paginate(items, query),
        counts: {
          byKind,
          mine: scoped.filter((i) => i.createdById === myId()).length,
          everyone: scoped.length,
        },
      };
    }),

    route('POST', p.inboxBulk, ({ body }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      seed();
      const b = body as InboxBulkBody;
      if (b.ids.length > 200) return err(400, 'validation', 'At most 200 items at once.');
      // What the bulk event's undo puts back (D150: one event reverts them all).
      const before: (() => void)[] = [];
      const results = b.ids.map((id) => {
        const item = open().find((i) => i.id === id);
        if (!item) return { id, ok: false, error: 'not_found' };
        const t = item.thingId ? liveThing(inv(), item.thingId) : undefined;
        if (b.action === 'accept_names' && t && !t.name)
          return { id, ok: false, error: 'validation' };
        before.push(snapshot(item, t));
        if (b.action === 'discard' && t) t.deletedAt = now();
        if (b.action === 'set_type' && t && b.typeId) {
          const type = inv().types.find((x) => x.id === b.typeId);
          if (type)
            t.type = { id: type.id, icon: type.icon, name: type.name, builtinKey: type.builtinKey };
        }
        if (b.action === 'set_tags' && t && b.tagIds) {
          t.tags = inv()
            .tags.filter((x) => b.tagIds?.includes(x.id))
            .map((x) => ({ id: x.id, name: x.name, colour: x.colour ?? null }));
        }
        if (b.action === 'set_place' && t && b.to) {
          if ('placeId' in b.to) {
            t.placeId = b.to.placeId;
            t.containerId = null;
          } else {
            t.placeId = null;
            t.containerId = b.to.containerId;
          }
        }
        if (t && b.action === 'accept_names') t.reviewState = 'confirmed';
        if (b.action === 'accept_names' || b.action === 'discard')
          resolve(item, b.action === 'discard' ? 'discarded' : 'accepted');
        return { id, ok: true };
      });
      const done = results.filter((r) => r.ok);
      const first = done[0]
        ? open()
            .concat(cap().inbox)
            .find((i) => i.id === done[0]?.id)
        : null;
      if (!first) return { results };
      // One undoable bulk event: the server's X-Kept-Audit-Event names it, and `undo` repeats it.
      const event = recordEvent(inv(), state.me.user, {
        action: 'inbox.bulk',
        entity: { type: 'thing', id: first.thingId ?? first.id },
        locationId: first.locationId,
        name: String(done.length),
        undo: () => {
          for (const put of before) put();
        },
      });
      return { results, undo: { eventId: event.id, until: event.undoable_until ?? now() } };
    }),

    route('GET', p.inboxCandidates(':id'), ({ params, query }) => {
      seed();
      const item = open().find((i) => i.id === params.id);
      if (!item) return notFound();
      const lineAt = query.get('line');
      const line = lineAt === null ? undefined : item.receipt?.lines[Number(lineAt)];
      const words = normalize(line?.description ?? '')
        .split(' ')
        .filter((w) => w.length > 1);
      const scored = inv()
        .things.filter((t) => !t.deletedAt && t.locationId === item.locationId && t.name)
        .map((t) => {
          const brand = normalize(t.brand?.name ?? '');
          const model = normalize(t.model ?? '');
          const name = normalize(t.name ?? '');
          const byBrand = !!brand && words.includes(brand);
          const byModel = !!model && words.some((w) => model.includes(w));
          const byName = words.filter((w) => name.includes(w)).length;
          const match: CandidateMatch | undefined =
            byBrand && (byModel || byName > 0) ? 'brand_model' : byName > 0 ? 'name' : undefined;
          return { t, match, score: (match === 'brand_model' ? 100 : 0) + byName };
        })
        .filter((x) => !line || x.match)
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);
      return {
        things: scored.map(({ t, match }) => ({
          ...rowOf(inv(), t),
          ...(match ? { match } : {}),
        })),
      };
    }),

    action(p.inboxAccept(':id'), (item, body) => {
      const b = (body ?? {}) as InboxAcceptBody;
      // T15's checks: each named field is suggested, none is both, and accept writes only the
      // fields T10 suggests (ACCEPTABLE_SUGGESTIONS); anything else is set on the thing's page.
      const suggested = new Set((item.suggestions ?? []).map((s) => s.field));
      for (const f of [...(b.accept ?? []), ...(b.reject ?? [])])
        if (!suggested.has(f))
          return err(400, 'validation', `Check accept and reject: nothing suggests ${f}.`);
      if ((b.accept ?? []).some((f) => b.reject?.includes(f)))
        return err(400, 'validation', 'Check accept and reject: a field is one or the other.');
      const refused = (b.accept ?? []).find((f) => !canAcceptSuggestion(f));
      if (refused)
        return err(
          400,
          'validation',
          `Check accept: ${refused} is set on the thing's page, not accepted here.`,
        );
      const t = item.thingId ? liveThing(inv(), item.thingId) : undefined;
      // Step 5 (T10, Q15): a vehicle's card becomes its expiring document, with Paperwork or
      // Vehicles on in its location (409 `module_off` otherwise).
      const doc = (item.suggestions ?? []).find(
        (s) => s.field === 'document' && b.accept?.includes('document'),
      );
      if (t && doc) {
        if (!isDocumentSuggestion(doc.value))
          return err(400, 'validation', 'Check accept: this document suggestion is not valid.');
        if (
          !moduleOn(state, t.locationId, 'paperwork') &&
          !moduleOn(state, t.locationId, 'vehicles')
        )
          return err(409, 'module_off', 'Turn on Paperwork or Vehicles to keep this document.');
        hh(state).documents.push({
          id: newId(),
          locationId: t.locationId,
          subject: { thingId: t.id },
          kind: doc.value.kind,
          title: null,
          expiresOn: doc.value.expiresOn,
          leadDays: 30,
          supersededById: null,
          documents: [],
          rowVersion: 1,
          createdAt: now(),
        });
      }
      if (t) {
        const name = b.set?.name ?? t.name;
        if (!name?.trim()) return err(400, 'validation', 'A thing needs a name.');
        if (b.set?.name !== undefined) t.name = b.set.name;
        if (b.set?.serial !== undefined) t.serial = b.set.serial;
        if (b.set?.quantity !== undefined) t.quantity = b.set.quantity;
        if (b.set?.typeId !== undefined) {
          const type = inv().types.find((x) => x.id === b.set?.typeId);
          t.type = type
            ? { id: type.id, icon: type.icon, name: type.name, builtinKey: type.builtinKey }
            : null;
        }
        for (const s of item.suggestions ?? []) {
          if (!b.accept?.includes(s.field)) continue;
          applySuggestion(t, s);
          const key = aliasSuggestionLanguage(s.field) ? 'aliases' : s.field;
          t.fieldStatus[key] = { state: 'confirmed', confidence: s.confidence };
        }
        for (const [field, st] of Object.entries(item.fieldStatus ?? {}))
          if (st.state === 'extracted') t.fieldStatus[field] = { ...st, state: 'confirmed' };
        t.reviewState = 'confirmed';
        t.rowVersion += 1;
      }
      resolve(item, b.set ? 'edited' : 'accepted');
      return {};
    }),
    action(p.inboxReceipt(':id'), (item) => resolve(item, 'accepted')),
    action(p.inboxCurrency(':id'), (item, body) => {
      const c = (body as InboxCurrencyBody).currency;
      if (item.currency && !item.currency.options.includes(c) && !/^[A-Z]{3}$/.test(c))
        return err(400, 'validation', 'Pick a currency.');
      if (item.receipt) item.receipt.currency = c;
      return resolve(item, 'accepted');
    }),
    action(p.inboxMerge(':id'), (item, body) => {
      const into = (body as InboxMergeBody).into;
      const pair = [item.thingId, item.duplicate?.otherThingId].filter((x): x is string => !!x);
      if (!pair.includes(into) || !liveThing(inv(), into)) return notFound();
      // The other one of the pair is merged into the survivor.
      const loser = liveThing(inv(), pair.find((id) => id !== into) ?? null);
      if (loser) {
        loser.deletedAt = now();
        loser.mergedIntoId = into;
      }
      return resolve(item, 'merged');
    }),
    action(p.inboxNotDuplicate(':id'), (item) => resolve(item, 'dismissed')),
    action(p.inboxReading(':id'), (item, body) => {
      const a = (body as InboxReadingBody).action;
      return resolve(item, a === 'discard' ? 'discarded' : a === 'edit' ? 'edited' : 'accepted');
    }),
    action(p.inboxRestore(':id'), (item) => {
      resolve(item, 'restored');
      return { outcome: 'applied' };
    }),
    action(p.inboxDismiss(':id'), (item) => resolve(item, 'dismissed')),
    action(p.inboxDiscard(':id'), (item) => {
      const t = item.thingId ? liveThing(inv(), item.thingId) : undefined;
      const put = snapshot(item, t);
      if (t) t.deletedAt = now();
      resolve(item, 'discarded');
      if (!t) return {};
      const event = recordEvent(inv(), state.me.user, {
        action: 'thing.trash',
        entity: { type: 'thing', id: t.id },
        locationId: t.locationId,
        name: t.name ?? '',
        undo: put,
      });
      return { undo: { eventId: event.id, until: event.undoable_until ?? now() } };
    }),
  ];
}

/** A confirmed suggestion, written to the draft as T15's `suggestedEdit` does. */
function applySuggestion(t: StoredThing, s: Suggestion) {
  const v = String(s.value);
  if (s.field === 'serial') t.serial = v;
  else if (s.field === 'quantity') t.quantity = Number(s.value);
  else if (s.field === 'model') t.model = v;
  else if (s.field === 'colour') t.colour = v;
  else if (s.field === 'name') t.name = v;
  else if (s.field === 'expires_on') t.expiresOn = v;
  else if (s.field === 'document') return;
  else if (s.field === 'vin' || s.field === 'plate' || s.field === 'manufactured_on')
    t.custom = { ...t.custom, [s.field]: v };
  else {
    // An alias AI proposed (`alias_ar`, D214) joins the thing's own in that language.
    const lang = aliasSuggestionLanguage(s.field);
    if (lang && !(t.aliases[lang] ?? []).includes(v))
      t.aliases = { ...t.aliases, [lang]: [...(t.aliases[lang] ?? []), v] };
  }
}
