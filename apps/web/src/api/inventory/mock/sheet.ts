/**
 * Mock handlers for the spreadsheet view (1.x, D250; apps/server/src/things/sheet.ts): its wide
 * rows, "Save N changes" row by row (a stale row is a 412 result and stays unsaved), the bulk
 * trash (all or none) and undoing a write's events together (all or none).
 */
import type { MockState } from '../../mock/fixtures';
import { err, forbidden, type MockRoute, notFound, reply, route } from '../../mock/kit';
import { inventoryPaths as p } from '../paths';
import type { BulkEditBody, BulkEditRowResult, BulkTrashBody, SheetRow, ThingRow } from '../types';
import {
  accessOf,
  contentsOf,
  derivedStateOf,
  liveThing,
  matches,
  newId,
  now,
  paginate,
  recordEvent,
  rowOf,
  runUndo,
  type StoredThing,
  summaryOf,
} from './db';
import { narrow } from './filters';

export function sheetRoutes(state: MockState): MockRoute[] {
  const inv = () => state.inventory;
  const access = () => accessOf(state);
  const me = () => ({ id: state.me.user.id, displayName: state.me.user.displayName });
  const showMoney = (locationId: string) => {
    const loc = state.locations.find((l) => l.id === locationId);
    const role = loc?.role ?? 'viewer';
    return (
      (loc?.modules.includes('money') ?? false) &&
      (role !== 'viewer' || loc?.moneyVisibleToViewers === true)
    );
  };
  const warrantiesOn = (locationId: string) =>
    state.locations.find((l) => l.id === locationId)?.modules.includes('warranties') ?? false;

  const sheetRowOf = (t: StoredThing): SheetRow => {
    const row: ThingRow = rowOf(inv(), t);
    const caps = inv().types.find((x) => x.id === t.type?.id)?.resolvedCapabilities ?? [];
    const money = showMoney(t.locationId);
    return {
      ...row,
      rowVersion: t.rowVersion,
      updatedAt: t.updatedAt,
      placeId: t.placeId,
      containerId: t.containerId,
      brand: t.brand,
      model: t.model,
      serial: t.serial,
      barcode: t.barcode,
      colour: t.colour,
      condition: t.condition,
      notes: t.notes,
      manualUrl: t.manualUrl,
      expiresOn: t.expiresOn,
      tags: t.tags,
      belongsTo: t.belongsTo,
      reviewState: t.reviewState,
      quantityFixed: caps.includes('serialized') || caps.includes('metered') || t.meters.length > 0,
      purchase: t.purchase
        ? {
            purchasedOn: t.purchase.purchasedOn,
            ...(money
              ? {
                  ...(t.purchase.unitPrice ? { price: t.purchase.unitPrice } : {}),
                  ...(t.purchase.currency ? { currency: t.purchase.currency } : {}),
                }
              : { moneyHidden: true as const }),
          }
        : null,
      ...(warrantiesOn(t.locationId) ? { warranty: null } : {}),
    };
  };

  const text = (s: string | null | undefined) => (s ?? '').toLocaleLowerCase();

  return [
    route('GET', p.thingsSheet, ({ query }) => {
      const visible = access().visibleIds();
      const f = (name: string) => query.get(name);
      let rows = inv().things.filter((t) => !t.deletedAt && visible.has(t.locationId));
      rows = narrow(rows, query, 'locationId', (t, v) => t.locationId === v);
      if (f('placeId')) rows = rows.filter((t) => t.placeId === f('placeId'));
      if (f('containerId')) rows = rows.filter((t) => t.containerId === f('containerId'));
      rows = narrow(rows, query, 'typeId', (t, v) => t.type?.id === v);
      rows = narrow(rows, query, 'tagId', (t, v) => t.tags.some((g) => g.id === v));
      rows = narrow(rows, query, 'belongsToId', (t, v) => t.belongsTo?.id === v);
      rows = narrow(rows, query, 'brandId', (t, v) => t.brand?.id === v);
      rows = narrow(rows, query, 'state', (t, v) =>
        derivedStateOf(t, inv()).includes(v as 'draft'),
      );
      if (f('q'))
        rows = rows.filter((t) =>
          matches(
            [t.name ?? '', t.serial ?? '', ...Object.values(t.aliases).flat()].join(' '),
            f('q') ?? '',
          ),
        );
      const sort = f('sort') ?? 'name';
      const date = sort === 'updated' || sort === 'lastSeen';
      const key = (t: StoredThing): string | number =>
        sort === 'updated'
          ? t.updatedAt
          : sort === 'lastSeen'
            ? (t.lastSeenAt ?? '')
            : sort === 'brand'
              ? text(t.brand?.name)
              : sort === 'model'
                ? text(t.model)
                : sort === 'serial'
                  ? text(t.serial)
                  : sort === 'quantity'
                    ? t.quantity
                    : sort === 'expires'
                      ? (t.expiresOn ?? '9999-12-31')
                      : text(t.name);
      const desc = f('dir') ? f('dir') === 'desc' : date;
      rows = [...rows].sort((a, b) => {
        const x = key(a);
        const y = key(b);
        const c =
          typeof x === 'number' && typeof y === 'number'
            ? x - y
            : String(x).localeCompare(String(y));
        return (desc ? -c : c) || a.id.localeCompare(b.id);
      });
      if (f('group') === 'type')
        rows.sort((a, b) =>
          (a.type?.builtinKey ?? a.type?.name ?? '~').localeCompare(
            b.type?.builtinKey ?? b.type?.name ?? '~',
          ),
        );
      return paginate(rows.map(sheetRowOf), query, 100);
    }),

    route('POST', p.thingsBulkEdit, ({ body }) => {
      const b = body as BulkEditBody;
      if (!b.edits?.length || b.edits.length > 200)
        return err(400, 'validation', 'Save 1 to 200 rows at a time.');
      const results: BulkEditRowResult[] = [];
      const saved: StoredThing[] = [];
      const events: string[] = [];
      for (const edit of b.edits) {
        const t = liveThing(inv(), edit.id);
        if (!t || !access().visible(t.locationId)) {
          results.push({ id: edit.id, ok: false, status: 404, code: 'not_found' });
          continue;
        }
        if (!access().canWrite(t.locationId)) {
          results.push({ id: edit.id, ok: false, status: 403, code: 'forbidden' });
          continue;
        }
        const { to, tagIds, brandId, typeId, belongsToPersonId, ...plain } = edit.set;
        if (t.rowVersion !== edit.rowVersion) {
          results.push({
            id: edit.id,
            ok: false,
            status: 412,
            code: 'precondition_failed',
            conflicts: Object.keys(edit.set),
            rowVersion: t.rowVersion,
            changedBy: { displayName: 'Alfred' },
          });
          continue;
        }
        if (plain.name !== undefined && !plain.name.trim()) {
          results.push({ id: edit.id, ok: false, status: 400, code: 'validation' });
          continue;
        }
        const before = structuredClone({
          ...Object.fromEntries(Object.keys(plain).map((k) => [k, t[k as keyof typeof t]])),
          tags: t.tags,
          brand: t.brand,
          type: t.type,
          belongsTo: t.belongsTo,
          placeId: t.placeId,
          containerId: t.containerId,
        });
        const ev = recordEvent(inv(), me(), {
          action: 'thing.update',
          entity: { type: 'thing', id: t.id },
          locationId: t.locationId,
          name: t.name ?? '',
          undo: () => {
            Object.assign(t, before);
            t.rowVersion += 1;
          },
        });
        events.push(ev.id);
        Object.assign(t, plain);
        if (tagIds)
          t.tags = inv()
            .tags.filter((g) => tagIds.includes(g.id))
            .map((g) => ({ id: g.id, name: g.name, colour: g.colour }));
        if (brandId !== undefined) {
          const brand = inv().brands.find((x) => x.id === brandId);
          t.brand = brand ? { id: brand.id, name: brand.name } : null;
        }
        if (typeId !== undefined) {
          const type = inv().types.find((x) => x.id === typeId);
          t.type = type
            ? { id: type.id, icon: type.icon, name: type.name, builtinKey: type.builtinKey }
            : null;
        }
        if (belongsToPersonId !== undefined) {
          const person = inv().people.find((x) => x.id === belongsToPersonId);
          t.belongsTo = person ? { id: person.id, displayName: person.displayName } : null;
        }
        if (to) {
          if ('placeId' in to) {
            t.placeId = to.placeId;
            t.containerId = null;
          } else {
            t.placeId = null;
            t.containerId = to.containerId;
          }
        }
        t.rowVersion += 1;
        t.updatedAt = now();
        saved.push(t);
        results.push({ id: edit.id, ok: true });
      }
      return { results, rows: saved.map(sheetRowOf), events };
    }),

    route('POST', p.thingsBulkTrash, ({ body }) => {
      const b = body as BulkTrashBody;
      const things = b.thingIds.map((id) => liveThing(inv(), id));
      for (const [i, t] of things.entries()) {
        if (!t || !access().visible(t.locationId))
          return err(404, 'not_found', 'Not found.', undefined, { thingId: b.thingIds[i] });
        if (!access().canWrite(t.locationId)) return forbidden();
        if (contentsOf(inv(), t.id).length && !b.contents)
          return err(
            409,
            'contents_choice_required',
            'Choose what happens to what is inside.',
            undefined,
            { thingId: t.id },
          );
      }
      const trashed: string[] = [];
      const moved: string[] = [];
      const events: string[] = [];
      for (const t of things) {
        if (!t || t.deletedAt) continue;
        const batch = newId();
        const inside = contentsOf(inv(), t.id);
        const was = inside.map((c) => ({ c, placeId: c.placeId, containerId: c.containerId }));
        const ev = recordEvent(inv(), me(), {
          action: 'thing.trash',
          entity: { type: 'thing', id: t.id },
          locationId: t.locationId,
          name: t.name ?? '',
          undo: () => {
            for (const row of inv().things)
              if (row.trashBatchId === batch)
                Object.assign(row, { deletedAt: null, trashBatchId: null, deletedBy: null });
            for (const w of was)
              Object.assign(w.c, { placeId: w.placeId, containerId: w.containerId });
          },
        });
        events.push(ev.id);
        const stamp = { deletedAt: now(), trashBatchId: batch, deletedBy: me().displayName };
        Object.assign(t, stamp);
        trashed.push(t.id);
        for (const c of inside) {
          if (b.contents === 'trash') {
            Object.assign(c, stamp);
            trashed.push(c.id);
          } else {
            c.placeId = t.placeId;
            c.containerId = t.containerId;
            moved.push(c.id);
          }
        }
      }
      return { trashed, moved, events };
    }),

    route('POST', p.undoTogether, ({ body }) => {
      const ids = (body as { eventIds: string[] }).eventIds ?? [];
      const events = ids.map((id) => inv().events.find((x) => x.id === id));
      for (const e of events) {
        if (!e?.location_id || !access().visible(e.location_id)) return notFound();
        if (!access().canWrite(e.location_id)) return forbidden();
        if (inv().events.some((x) => x.undo_of === e.id))
          return err(409, 'undo_refused', "That can't be undone any more.", undefined, {
            reason: 'already_undone',
          });
      }
      const undone: { undoOf: string; eventId: string }[] = [];
      for (const e of [...events].reverse()) {
        if (!e?.location_id || !runUndo(inv(), e.id)) continue;
        const entity = e.entity as { type: 'thing' | 'place'; id: string };
        const done = recordEvent(inv(), me(), {
          action: e.action,
          entity,
          locationId: e.location_id,
          name: e.summaryParams.name ?? '',
        });
        done.undo_of = e.id;
        Object.assign(done, summaryOf('undo', e.summaryParams.name ?? ''));
        undone.push({ undoOf: e.id, eventId: done.id });
      }
      return reply(200, { undone });
    }),
  ];
}
