/**
 * Mock handlers for things, moves, meters, purchases and secrets (tasks 12, 14, 15, 16, 19).
 * Task 26 extends these as its screens need.
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
import type {
  CreateLinkBody,
  CreateReadingBody,
  CreateThingBody,
  EmptyIntoBody,
  LifecycleBody,
  MoveBody,
  MovePreviewBody,
  MoveTarget,
  Reading,
  RetypeBody,
  SetSecretBody,
  SplitBody,
  ThingView,
  UpdateThingBody,
} from '../types';
import {
  accessOf,
  contentsOf,
  derivedStateOf,
  fold,
  liveThing,
  matches,
  newId,
  now,
  paginate,
  recordEvent,
  rowOf,
  type StoredThing,
  versionError,
  viewOf,
} from './db';
import { narrow } from './filters';
import { contentsTemplate } from './places';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function mockCode(seed: number): string {
  let out = '';
  let n = seed * 7919 + 104_729;
  for (let i = 0; i < 6; i++) {
    out += CROCKFORD[n % 32];
    n = Math.floor(n / 32) + i * 31;
  }
  return out;
}

export function thingsRoutes(state: MockState): MockRoute[] {
  const inv = () => state.inventory;
  const access = () => accessOf(state);
  const me = () => ({ id: state.me.user.id, displayName: state.me.user.displayName });
  const visibleThing = (id: string | undefined) => {
    const t = liveThing(inv(), id ?? null);
    return t && access().visible(t.locationId) ? t : null;
  };
  /** Resolve a move target to its location, or null when it isn't visible. */
  const targetLocation = (to: MoveTarget): string | null => {
    if ('placeId' in to) {
      const pl = inv().places.find((x) => x.id === to.placeId && !x.deletedAt);
      return pl && access().visible(pl.locationId) ? pl.locationId : null;
    }
    const box = visibleThing(to.containerId);
    return box ? box.locationId : null;
  };
  const moveInto = (t: StoredThing, to: MoveTarget) => {
    if ('placeId' in to) {
      t.placeId = to.placeId;
      t.containerId = null;
    } else {
      t.placeId = null;
      t.containerId = to.containerId;
    }
    t.locationUncertain = false;
  };
  /** Would moving `id` into container `into` put it inside itself? */
  const isOwnDescendant = (id: string, into: string) => {
    let cur = inv().things.find((x) => x.id === into);
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      if (cur.id === id) return true;
      seen.add(cur.id);
      cur = inv().things.find((x) => x.id === cur?.containerId);
    }
    return false;
  };

  const brandRef = (id: string | undefined) => {
    const x = inv().brands.find((r) => r.id === id);
    return x ? { id: x.id, name: x.name } : null;
  };
  const vendorRef = (id: string | undefined) => {
    const x = inv().vendors.find((r) => r.id === id);
    return x ? { id: x.id, name: x.name } : null;
  };
  /**
   * Task 26: the server's response gates (T2's serialize/gates.ts), approximated. Money leaves
   * only with the Money module on and money visible to the role (viewers: never here, D13);
   * a secret's `canReveal` follows the default policy, admins and above (D116).
   */
  const gated = (v: ThingView): ThingView => {
    const loc = state.locations.find((l) => l.id === v.locationId);
    const role = loc?.role ?? 'viewer';
    const moneyOn = loc?.modules.includes('money') ?? false;
    const showMoney = moneyOn && (role !== 'viewer' || loc?.moneyVisibleToViewers === true);
    const out = structuredClone(v);
    if (!showMoney) {
      // Omitted, never null, and marked (T26): the price, its currency and the receipts with it.
      out.moneyHidden = true;
      if (out.purchase) {
        delete out.purchase.unitPrice;
        delete out.purchase.currency;
        out.purchase.receipts = [];
        out.purchase.moneyHidden = true;
      }
      if (out.ended) {
        delete out.ended.price;
        delete out.ended.currency;
        out.ended.moneyHidden = true;
      }
      for (const f of out.fields) if (f.kind === 'money') delete out.custom[f.key];
    }
    const admin = role === 'owner' || role === 'admin';
    out.secrets = out.secrets.map((x) => ({ ...x, canReveal: x.canReveal && admin }));
    return out;
  };
  const readingOwner = (id: string | undefined) => {
    for (const [meterId, list] of Object.entries(inv().readings)) {
      const r = list.find((x) => x.id === id);
      if (r) return { meterId, list, reading: r };
    }
    return null;
  };
  const thingOfMeter = (meterId: string) =>
    inv().things.find((t) => t.meters.some((m) => m.id === meterId) && !t.deletedAt);
  /** Recompute a meter's latest and needs-review count after a reading changes. */
  const touchMeter = (meterId: string) => {
    const t = thingOfMeter(meterId);
    const m = t?.meters.find((x) => x.id === meterId);
    const list = inv().readings[meterId] ?? [];
    if (!m) return;
    const accepted = list
      .filter((r) => r.state === 'accepted')
      .sort((a, b) => b.takenAt.localeCompare(a.takenAt))[0];
    m.latest = accepted ? { value: accepted.value, takenAt: accepted.takenAt } : null;
    m.needsReview = list.filter((r) => r.state === 'needs_review').length;
  };

  return [
    // ----- list and detail -----
    route('GET', p.things, ({ query }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
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
      if (f('vendorId')) rows = rows.filter((t) => t.purchase?.vendor?.id === f('vendorId'));
      if (f('lifecycle')) rows = rows.filter((t) => t.lifecycle === f('lifecycle'));
      rows = narrow(rows, query, 'state', (t, v) =>
        derivedStateOf(t, inv()).includes(v as 'draft'),
      );
      if (f('q'))
        rows = rows.filter((t) =>
          matches([t.name ?? '', ...Object.values(t.aliases).flat()].join(' '), f('q') ?? ''),
        );
      const sort = f('sort') ?? 'name';
      // D211: `dir` turns the sort around (the name A to Z, the dates newest first by default).
      const date = sort === 'updated' || sort === 'lastSeen';
      const flip = f('dir') === (date ? 'asc' : 'desc') ? -1 : 1;
      rows = [...rows].sort(
        (a, b) =>
          flip *
          (sort === 'updated'
            ? b.updatedAt.localeCompare(a.updatedAt)
            : sort === 'lastSeen'
              ? (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? '')
              : (a.name ?? '').localeCompare(b.name ?? '')),
      );
      const group = f('group');
      if (group === 'type')
        rows.sort((a, b) =>
          (a.type?.builtinKey ?? a.type?.name ?? '~').localeCompare(
            b.type?.builtinKey ?? b.type?.name ?? '~',
          ),
        );
      if (group === 'place')
        rows.sort((a, b) =>
          (a.placeId ?? a.containerId ?? '').localeCompare(b.placeId ?? b.containerId ?? ''),
        );
      return paginate(
        rows.map((t) => rowOf(inv(), t)),
        query,
      );
    }),

    route('GET', p.thing(':id'), ({ params }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const t = visibleThing(params.id);
      return t ? gated(viewOf(inv(), t)) : notFound();
    }),

    route('POST', p.things, ({ body }) => {
      const b = body as CreateThingBody;
      if (!access().visible(b.locationId)) return notFound();
      if (!access().canWrite(b.locationId)) return forbidden();
      if (!b.name?.trim()) return err(400, 'validation', 'A thing needs a name.');
      if (!b.placeId === !b.containerId)
        return err(400, 'validation', 'Put it in exactly one place or container.');
      const type = inv().types.find((t) => t.id === b.typeId) ?? null;
      const created: StoredThing = {
        ...contentsTemplate(),
        id: b.id ?? newId(),
        locationId: b.locationId,
        shortCode: mockCode(inv().things.length + 1),
        name: b.name.trim(),
        type: type
          ? { id: type.id, icon: type.icon, name: type.name, builtinKey: type.builtinKey }
          : null,
        fields: type?.fields ?? [],
        quantity: b.quantity ?? 1,
        placeId: b.placeId ?? null,
        containerId: b.containerId ?? null,
        model: b.model ?? null,
        serial: b.serial ?? null,
        barcode: b.barcode ?? null,
        colour: b.colour ?? null,
        condition: b.condition ?? null,
        notes: b.notes ?? null,
        custom: b.custom ?? {},
        aliases: b.aliases ?? {},
        isContainer: type?.resolvedCapabilities.includes('container') ?? false,
        // Task 26: what the create sheet sends beyond the basics.
        brand: brandRef(b.brandId),
        lastSeenAt: now(),
        createdAt: now(),
        updatedAt: now(),
        purchase: b.purchase
          ? {
              purchaseId: newId(),
              purchasedOn: b.purchase.purchasedOn,
              vendor: vendorRef(b.purchase.vendorId),
              currency: b.purchase.currency,
              lineDescription: b.name.trim(),
              quantity: b.quantity ?? 1,
              unitPrice: b.purchase.price,
              receipts: [],
            }
          : null,
        meters: type?.defaultMeter
          ? [
              {
                id: newId(),
                kind: type.defaultMeter.kind,
                unit: type.defaultMeter.unit,
                label: null,
                latest: null,
                needsReview: 0,
                rowVersion: 1,
              },
            ]
          : [],
      };
      for (const m of created.meters) inv().readings[m.id] = [];
      inv().things.push(created);
      return reply(201, viewOf(inv(), created));
    }),

    route('PATCH', p.thing(':id'), ({ params, body, headers }) => {
      const t = visibleThing(params.id);
      if (!t) return notFound();
      if (!access().canWrite(t.locationId)) return forbidden();
      const b = body as UpdateThingBody;
      const stale = versionError(headers, t, Object.keys(b));
      if (stale) return reply(stale.status, stale.body);
      const { custom, tagIds, brandId, typeId: _typeId, belongsToPersonId: _p, ...plain } = b;
      // What undo puts back (D150): the fields this edit touches, as they were.
      const before = structuredClone({
        ...Object.fromEntries(Object.keys(plain).map((k) => [k, t[k as keyof typeof t]])),
        custom: t.custom,
        tags: t.tags,
        brand: t.brand,
      });
      recordEvent(inv(), me(), {
        action: 'thing.update',
        entity: { type: 'thing', id: t.id },
        locationId: t.locationId,
        name: t.name ?? '',
        diff: Object.fromEntries(
          Object.entries(plain).map(([k, v]) => [
            k,
            { before: t[k as keyof typeof t] ?? null, after: v, class: 'plain' as const },
          ]),
        ),
        undo: () => {
          Object.assign(t, before);
          t.rowVersion += 1;
        },
      });
      Object.assign(t, plain);
      if (custom)
        for (const [key, value] of Object.entries(custom)) {
          if (value === null) delete t.custom[key];
          else t.custom[key] = value;
        }
      if (tagIds)
        t.tags = inv()
          .tags.filter((g) => tagIds.includes(g.id))
          .map((g) => ({ id: g.id, name: g.name, colour: g.colour }));
      if (brandId !== undefined) {
        const brand = inv().brands.find((x) => x.id === brandId);
        t.brand = brand ? { id: brand.id, name: brand.name } : null;
      }
      t.rowVersion += 1;
      t.updatedAt = now();
      return viewOf(inv(), t);
    }),

    route('POST', p.thingLifecycle(':id'), ({ params, body, headers }) => {
      const t = visibleThing(params.id);
      if (!t) return notFound();
      if (!access().canWrite(t.locationId)) return forbidden();
      const stale = versionError(headers, t, ['lifecycle']);
      if (stale) return reply(stale.status, stale.body);
      const b = body as LifecycleBody;
      // Undoable, as on the server (D150): the status and its end details go back.
      const was = { lifecycle: t.lifecycle, ended: structuredClone(t.ended) };
      recordEvent(inv(), me(), {
        action: 'thing.lifecycle',
        entity: { type: 'thing', id: t.id },
        locationId: t.locationId,
        name: t.name ?? '',
        diff: { lifecycle: { before: t.lifecycle, after: b.lifecycle, class: 'plain' } },
        undo: () => {
          Object.assign(t, was);
          t.rowVersion += 1;
        },
      });
      t.lifecycle = b.lifecycle;
      t.ended =
        b.lifecycle === 'in_use'
          ? null
          : {
              on: b.endedOn ?? null,
              ...(b.endedPrice ? { price: b.endedPrice, currency: b.endedCurrency ?? 'EGP' } : {}),
              to: b.endedTo ?? null,
              notes: b.endedNotes ?? null,
            };
      t.rowVersion += 1;
      return viewOf(inv(), t);
    }),

    route('POST', p.thingSeen(':id'), ({ params }) => {
      const t = visibleThing(params.id);
      if (!t) return notFound();
      if (!access().canWrite(t.locationId)) return forbidden();
      t.lastSeenAt = now();
      t.locationUncertain = false;
      return { lastSeenAt: t.lastSeenAt };
    }),

    route('POST', p.thingNotHere(':id'), ({ params }) => {
      const t = visibleThing(params.id);
      if (!t) return notFound();
      if (!access().canWrite(t.locationId)) return forbidden();
      t.locationUncertain = true;
      return viewOf(inv(), t);
    }),

    route('POST', p.thingRetype(':id'), ({ params, body, headers }) => {
      const t = visibleThing(params.id);
      if (!t) return notFound();
      if (!access().canWrite(t.locationId)) return forbidden();
      const stale = versionError(headers, t, ['typeId']);
      if (stale) return reply(stale.status, stale.body);
      const type = inv().types.find((x) => x.id === (body as RetypeBody).typeId);
      if (!type) return notFound();
      const keys = new Set(type.fields.map((f) => f.key));
      // Undoable, as on the server (D150): the type and the fields it archived go back.
      const was = structuredClone({
        type: t.type,
        fields: t.fields,
        custom: t.custom,
        archivedCustom: t.archivedCustom,
      });
      recordEvent(inv(), me(), {
        action: 'thing.retype',
        entity: { type: 'thing', id: t.id },
        locationId: t.locationId,
        name: t.name ?? '',
        undo: () => {
          Object.assign(t, was);
          t.rowVersion += 1;
        },
      });
      for (const [key, value] of Object.entries(t.custom))
        if (!keys.has(key)) {
          t.archivedCustom[key] = value;
          delete t.custom[key];
        }
      t.type = { id: type.id, icon: type.icon, name: type.name, builtinKey: type.builtinKey };
      t.fields = type.fields;
      t.rowVersion += 1;
      return viewOf(inv(), t);
    }),

    route('POST', p.thingDuplicate(':id'), ({ params, body }) => {
      const t = visibleThing(params.id);
      if (!t) return notFound();
      if (!access().canWrite(t.locationId)) return forbidden();
      const copy: StoredThing = {
        ...structuredClone(t),
        id: (body as { id?: string } | undefined)?.id ?? newId(),
        serial: null,
        shortCode: mockCode(inv().things.length + 1),
        purchase: null,
        rowVersion: 1,
      };
      inv().things.push(copy);
      return reply(201, viewOf(inv(), copy));
    }),

    route('POST', p.thingSplit(':id'), ({ params, body }) => {
      const t = visibleThing(params.id);
      if (!t) return notFound();
      if (!access().canWrite(t.locationId)) return forbidden();
      const b = body as SplitBody;
      if (t.quantity <= 1 || b.quantity <= 0 || b.quantity >= t.quantity)
        return err(400, 'validation', 'Split off fewer than the whole quantity.');
      const part: StoredThing = {
        ...structuredClone(t),
        id: b.id ?? newId(),
        quantity: b.quantity,
        shortCode: null,
        rowVersion: 1,
      };
      if (b.to) moveInto(part, b.to);
      t.quantity -= b.quantity;
      t.rowVersion += 1;
      inv().things.push(part);
      return { originalId: t.id, newId: part.id };
    }),

    route('POST', p.thingLinks(':id'), ({ params, body }) => {
      const t = visibleThing(params.id);
      const b = body as CreateLinkBody;
      const other = visibleThing(b.toThingId);
      if (!t || !other) return notFound();
      if (!access().canWrite(t.locationId)) return forbidden();
      const link = { id: newId(), kind: b.kind, toThingId: other.id };
      t.links.push(link);
      return reply(201, {
        id: link.id,
        kind: link.kind,
        direction: 'from',
        thing: rowOf(inv(), other),
      });
    }),

    route('DELETE', p.thingLink(':linkId'), ({ params }) => {
      for (const t of inv().things) t.links = t.links.filter((l) => l.id !== params.linkId);
      return reply(204);
    }),

    route('POST', p.thingConvertToPlace(':id'), ({ params }) => {
      const t = visibleThing(params.id);
      if (!t) return notFound();
      if (!access().canWrite(t.locationId)) return forbidden();
      inv().places.push({
        id: t.id,
        locationId: t.locationId,
        parentId: t.placeId,
        name: t.name ?? '',
        kindKey: 'zone',
        icon: null,
        isUnplaced: false,
        shortCode: t.shortCode,
        fields: [],
        custom: {},
        secrets: [],
        rowVersion: 1,
        sort: 99,
        deletedAt: null,
        trashBatchId: null,
        deletedBy: null,
      });
      for (const c of contentsOf(inv(), t.id)) {
        c.containerId = null;
        c.placeId = t.id;
      }
      inv().things = inv().things.filter((x) => x.id !== t.id);
      return { placeId: t.id };
    }),

    route('GET', p.code(':code'), ({ params }) => {
      const code = fold(params.code ?? '')
        .toUpperCase()
        .replace(/O/g, '0')
        .replace(/[IL]/g, '1');
      const t = inv().things.find((x) => x.shortCode === code && !x.deletedAt);
      if (t && access().visible(t.locationId)) return { kind: 'thing', id: t.id };
      const pl = inv().places.find((x) => x.shortCode === code && !x.deletedAt);
      if (pl && access().visible(pl.locationId)) return { kind: 'place', id: pl.id };
      return notFound(); // the same 404 for missing and forbidden codes (D137)
    }),

    // ----- moves (task 15) -----
    route('POST', p.movePreview, ({ body }) => {
      const b = body as MovePreviewBody;
      const moving = b.thingIds.map((id) => visibleThing(id));
      const target = targetLocation(b.to);
      if (moving.some((t) => !t) || !target) return notFound();
      const from = new Set(moving.map((t) => t?.locationId));
      const crossLocation = [...from].some((l) => l !== target);
      const crossAccount = [...from].some(
        (l) => l && inv().accountOf[l] !== inv().accountOf[target],
      );
      const loc = state.locations.find((l) => l.id === target);
      return {
        crossLocation,
        crossAccount,
        targetLocation: { id: target, name: loc?.name ?? '' },
        losesSight: crossLocation ? [{ displayName: 'Alfred' }, { displayName: 'Louis' }] : [],
        copies: {
          types: crossAccount ? 1 : 0,
          tags: 0,
          people: 0,
          vendors: 0,
          brands: 0,
          purchases: 0,
        },
      };
    }),

    route('POST', p.move, ({ body }) => {
      const b = body as MoveBody;
      if (b.thingIds.length > 200)
        return err(400, 'validation', 'Move at most 200 things at once.');
      const target = targetLocation(b.to);
      if (!target || !access().canWrite(target)) return notFound();
      const moved: string[] = [];
      for (const id of b.thingIds) {
        const t = visibleThing(id);
        if (!t) return notFound();
        if (!access().canWrite(t.locationId)) return forbidden();
        if ('containerId' in b.to && isOwnDescendant(t.id, b.to.containerId))
          return err(409, 'conflict', "Something can't go inside itself.");
        const from = { placeId: t.placeId, containerId: t.containerId, locationId: t.locationId };
        recordEvent(inv(), me(), {
          action: 'thing.move',
          entity: { type: 'thing', id: t.id },
          locationId: target,
          name: t.name ?? '',
          undo: () => Object.assign(t, from),
        });
        moveInto(t, b.to);
        t.locationId = target;
        t.lastSeenAt = now();
        moved.push(t.id);
      }
      return { moved };
    }),

    route('POST', p.thingEmptyInto(':id'), ({ params, body }) => {
      const t = visibleThing(params.id);
      if (!t) return notFound();
      if (!access().canWrite(t.locationId)) return forbidden();
      const to = (body as EmptyIntoBody).to;
      const moved = contentsOf(inv(), t.id).map((c) => {
        moveInto(c, to);
        return c.id;
      });
      return { moved };
    }),

    // ----- meters and readings (task 16) -----
    route('GET', p.meterReadings(':id'), ({ params, query }) => {
      const list = inv().readings[params.id ?? ''];
      if (!list) return notFound();
      return paginate(
        [...list].sort((a, b) => b.takenAt.localeCompare(a.takenAt)),
        query,
      );
    }),

    route('POST', p.meterReadings(':id'), ({ params, body }) => {
      const list = inv().readings[params.id ?? ''];
      if (!list) return notFound();
      const b = body as CreateReadingBody;
      const previous = [...list]
        .filter((r) => r.state === 'accepted' && r.takenAt <= b.takenAt)
        .sort((a, c) => c.takenAt.localeCompare(a.takenAt))[0];
      // Online, a backwards reading is refused with its neighbour (T16); a big jump waits for
      // review (implausible_jump: more than ten times the previous value, in the mock).
      if (previous && Number(b.value) < Number(previous.value))
        return err(
          409,
          'conflict',
          'That conflicts with the current state.',
          `Lower than the reading before it (${previous.value}). Check the value, or record that the meter was replaced first.`,
          {
            reason: 'lower_than_previous',
            previous: { value: previous.value, takenAt: previous.takenAt },
          },
        );
      const jump =
        previous && Number(previous.value) > 0 && Number(b.value) > 10 * Number(previous.value);
      const reading: Reading = {
        id: b.id ?? newId(),
        value: b.value,
        takenAt: b.takenAt > now() ? now() : b.takenAt,
        source: 'manual',
        state: jump ? 'needs_review' : 'accepted',
        reviewReason: jump ? 'implausible_jump' : null,
        loggedBy: { displayName: state.me.user.displayName },
        note: b.note ?? null,
        rowVersion: 1,
      };
      list.push(reading);
      touchMeter(params.id ?? '');
      return reply(201, {
        reading,
        state: reading.state,
        ...(reading.reviewReason ? { reason: reading.reviewReason } : {}),
      });
    }),

    // ----- purchases (task 12) -----
    route('GET', p.purchase(':id'), ({ params }) => {
      const found = inv().purchases.find((x) => x.id === params.id);
      if (!found || !access().visible(found.locationId)) return notFound();
      const loc = state.locations.find((l) => l.id === found.locationId);
      const show =
        !!loc?.modules.includes('money') &&
        (loc.role !== 'viewer' || loc.moneyVisibleToViewers === true);
      if (show) return found;
      // The server's gate (T12): amounts omitted and marked, receipts withheld with them.
      const { total: _t, tax: _x, ...rest } = found;
      return {
        ...rest,
        moneyHidden: true,
        flagged: false,
        receipts: [],
        lines: found.lines.map(({ unitPrice: _u, ...l }) => ({ ...l, moneyHidden: true })),
      };
    }),

    // ----- secrets (task 19) -----
    route('PUT', p.thingSecret(':id', ':fieldKey'), ({ params, body }) => {
      const t = visibleThing(params.id);
      if (!t) return notFound();
      if (!access().canWrite(t.locationId)) return forbidden();
      if (!state.admin.status.recoveryKitAcknowledged)
        return err(
          409,
          'recovery_kit_required',
          'Download the recovery kit first.',
          'Ask your instance admin to download the recovery kit.',
        );
      inv().secrets[`${t.id}:${params.fieldKey}`] = (body as SetSecretBody).value;
      return reply(204);
    }),

    route('POST', p.thingSecretReveal(':id', ':fieldKey'), ({ params }) => {
      const t = visibleThing(params.id);
      const summary = t?.secrets.find((s) => s.fieldKey === params.fieldKey);
      const value = inv().secrets[`${params.id}:${params.fieldKey}`];
      // Not permitted and not set look alike (a 404 either way).
      if (!t || !summary?.canReveal || value === undefined) return notFound();
      if (!gated(viewOf(inv(), t)).secrets.find((x) => x.fieldKey === params.fieldKey)?.canReveal)
        return notFound();
      return { value, revealedUntil: new Date(Date.now() + 30_000).toISOString() };
    }),

    route('POST', p.thingSecretCopied(':id', ':fieldKey'), () => reply(204)),
    // ----- task 26: needs-review readings (Keep / Edit / Discard, D112) -----
    route('POST', p.readingAccept(':id'), ({ params }) => {
      const found = readingOwner(params.id);
      const t = found && thingOfMeter(found.meterId);
      if (!found || !t || !access().visible(t.locationId)) return notFound();
      if (!access().canWrite(t.locationId)) return forbidden();
      found.reading.state = 'accepted';
      found.reading.reviewReason = null;
      touchMeter(found.meterId);
      return found.reading;
    }),

    route('PATCH', p.reading(':id'), ({ params, body }) => {
      const found = readingOwner(params.id);
      const t = found && thingOfMeter(found.meterId);
      if (!found || !t || !access().visible(t.locationId)) return notFound();
      const mine = found.reading.loggedBy.displayName === state.me.user.displayName;
      if (!(mine ? access().canWrite(t.locationId) : access().isAdmin(t.locationId)))
        return forbidden();
      const b = body as { value?: string; takenAt?: string; note?: string | null };
      if (b.value !== undefined) found.reading.value = b.value;
      if (b.takenAt !== undefined) found.reading.takenAt = b.takenAt;
      if (b.note !== undefined) found.reading.note = b.note;
      // An edited reading is checked again against the one before it (D112).
      const before = found.list
        .filter((r) => r.id !== found.reading.id && r.state === 'accepted')
        .filter((r) => r.takenAt <= found.reading.takenAt)
        .sort((a, c) => c.takenAt.localeCompare(a.takenAt))[0];
      const low = before && Number(found.reading.value) < Number(before.value);
      found.reading.state = low ? 'needs_review' : 'accepted';
      found.reading.reviewReason = low ? 'lower_than_previous' : null;
      touchMeter(found.meterId);
      return found.reading;
    }),

    route('DELETE', p.reading(':id'), ({ params }) => {
      const found = readingOwner(params.id);
      const t = found && thingOfMeter(found.meterId);
      if (!found || !t || !access().visible(t.locationId)) return notFound();
      const mine = found.reading.loggedBy.displayName === state.me.user.displayName;
      if (!(mine ? access().canWrite(t.locationId) : access().isAdmin(t.locationId)))
        return forbidden();
      inv().readings[found.meterId] = found.list.filter((r) => r.id !== found.reading.id);
      touchMeter(found.meterId);
      return reply(204);
    }),
  ];
}
