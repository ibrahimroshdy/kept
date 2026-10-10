import type { PlaceRef, ThingRef, ToolOutput } from '@kept/mcp';
import { normalize } from '@kept/shared';
import { undoableEventIds } from '../../audit/audited.js';
import { undoableUntil } from '../../audit/undo.js';
import { invalid, notFound } from '../../http/errors.js';
import { createReading } from '../../meters/service.js';
import { createPlace } from '../../places/service.js';
import { unplacedOf } from '../../places/view.js';
import { moveThings } from '../../things/move.js';
import { insertThing, liveThing, markSeen, updateThing } from '../../things/service.js';
import type { UpdateBody } from '../../things/validate.js';
import { viewOf } from '../../things/view.js';
import { placePath, placeRefOf, thingPath, thingRefOf } from '../output.js';
import { brandNamed, locationOfRef, placeIn, targetIn, thingIn, typeNamed } from '../resolve.js';
import type { Handler, Op } from '../types.js';

// The write tools (§2.5, D58, D124). Each calls the route's own operation, which checks the
// role, the money gate and the row's version and writes the audit row. What a tool writes is
// undoable for 7 days: the moves and edits already are; a tool's creates (things, places,
// readings) pass `undoable` so they are too (undo/registry.ts has their handlers). The answer
// names the audit event(s) and how long they can be undone.

const locationOf = (op: Op) => {
  if (!op.location) throw new Error('a write tool always runs in one location');
  return op.location;
};

/** The newest audit event this call wrote about an entity (a write that isn't undoable still
 * answers its event, so the person can find it in the history). */
async function lastEvent(op: Op, entityType: string, entityId: string) {
  const { rows } = await op.client.query<{ id: string; undoable_until: Date | null }>(
    `SELECT id, undoable_until FROM public.audit_events
      WHERE request_id = $1 AND entity_type = $2 AND entity_id = $3
      ORDER BY id DESC LIMIT 1`,
    [op.requestId, entityType, entityId],
  );
  const r = rows[0];
  if (!r) throw new Error(`no audit event for ${entityType} ${entityId}`);
  return { audit_event_id: r.id, undo_until: r.undoable_until?.toISOString() ?? null };
}

/** The write's result: its first undoable event, else the newest event about the entity. */
export async function writeResult(op: Op, entityType: string, entityId: string) {
  const ids = undoableEventIds(op.tx);
  if (ids.length === 0) return lastEvent(op, entityType, entityId);
  const { rows } = await op.client.query<{ undoable_until: Date | null }>(
    'SELECT undoable_until FROM public.audit_events WHERE id = $1',
    [ids[0]],
  );
  return {
    audit_event_id: ids[0] as string,
    undo_until: rows[0]?.undoable_until?.toISOString() ?? null,
  };
}

async function thingRef(op: Op, id: string): Promise<ThingRef> {
  const v = await viewOf(op.tx, op.client, op.scope, null, id);
  return thingRefOf(v, locationOf(op).name);
}

/** The place kind a tool gives a new place when it names none: a room (D33's built-ins). */
export const DEFAULT_PLACE_KIND = 'room';

/** A live place with that name under that parent, so a name said twice is one place. */
async function existingPlace(
  op: Op,
  locationId: string,
  parentId: string | null,
  name: string,
): Promise<string | null> {
  const { rows } = await op.client.query<{ id: string }>(
    `SELECT id FROM public.places
      WHERE location_id = $1 AND parent_id IS NOT DISTINCT FROM $2::uuid AND deleted_at IS NULL
        AND NOT is_unplaced AND kept.normalize(name) = kept.normalize($3)
      ORDER BY id LIMIT 1`,
    [locationId, parentId, name],
  );
  return rows[0]?.id ?? null;
}

// ---------------------------------------------------------------------------------------------
// add_thing (D213): every item of a spoken list in one call, one transaction; each thing (and
// each new place) is its own undoable event, and the web's one Undo undoes them all in reverse
// (components/history/undo.ts undoEvents()).
// ---------------------------------------------------------------------------------------------

export const addThing: Handler<'add_thing'> = {
  action: 'things.edit',
  run: async (op, input) => {
    const loc = locationOf(op);
    const until = undoableUntil();
    const newPlaces = new Map<string, string>();
    const places: PlaceRef[] = [];
    const placeIndex = new Map<string, number>();
    const thingIds: string[] = [];
    const placed: {
      item: number;
      status: 'found' | 'created' | 'unplaced';
      place: number | null;
    }[] = [];
    const notSet: NonNullable<ToolOutput<'add_thing'>['not_set']> = [];
    let unplaced: string | null = null;

    // Every distinct place involved, first use first, so a `new_place` that matched an
    // existing place still carries its id. Unplaced items point nowhere: their bucket is the
    // location's default, not a place they named.
    const rememberPlace = async (placeId: string) => {
      const at = placeIndex.get(placeId);
      if (at !== undefined) return at;
      places.push(await placeRefOf(op.client, placeId));
      placeIndex.set(placeId, places.length - 1);
      return places.length - 1;
    };

    for (const [i, item] of input.items.entries()) {
      let target: { placeId: string } | { containerId: string };
      if (item.place_id) {
        target = await targetIn(op.client, loc.id, item.place_id);
        placed.push({ item: i, status: 'found', place: await rememberPlace(item.place_id) });
      } else if (item.new_place) {
        const np = item.new_place;
        const parentId = np.parent_id ? await placeIn(op.client, loc.id, np.parent_id) : null;
        const key = `${parentId ?? ''}|${normalize(np.name)}`;
        let placeId = newPlaces.get(key) ?? (await existingPlace(op, loc.id, parentId, np.name));
        if (!placeId) {
          const created = await createPlace(
            op,
            loc.id,
            { name: np.name, kindKey: np.kind ?? DEFAULT_PLACE_KIND, parentId },
            { undoable: true },
          );
          placeId = created.id;
          placed.push({ item: i, status: 'created', place: await rememberPlace(placeId) });
        } else {
          placed.push({ item: i, status: 'found', place: await rememberPlace(placeId) });
        }
        newPlaces.set(key, placeId);
        target = { placeId };
      } else {
        unplaced ??= await unplacedOf(op.client, loc.id);
        target = { placeId: unplaced };
        placed.push({ item: i, status: 'unplaced', place: null });
      }
      const typeId = item.type ? await typeNamed(op.client, loc.id, item.type) : null;
      if (item.type && !typeId)
        notSet.push({ item: i, field: 'type', untrusted: { value: item.type } });
      const brandId = item.brand ? await brandNamed(op.client, loc.id, item.brand) : null;
      if (item.brand && !brandId)
        notSet.push({ item: i, field: 'brand', untrusted: { value: item.brand } });
      const id = await insertThing(
        op,
        {
          locationId: loc.id,
          ...target,
          name: item.name,
          ...(item.quantity !== undefined ? { quantity: item.quantity } : {}),
          ...(typeId ? { typeId } : {}),
          ...(brandId ? { brandId } : {}),
          ...(item.model ? { model: item.model } : {}),
          ...(item.serial ? { serial: item.serial } : {}),
          ...(item.notes ? { notes: item.notes } : {}),
        },
        { audit: { action: 'thing.create', undoableUntil: until } },
      );
      thingIds.push(id);
    }

    const ids = undoableEventIds(op.tx);
    const things = [];
    for (const id of thingIds) things.push(await thingRef(op, id));
    return {
      data: {
        audit_event_id: ids[0] as string,
        undo_until: until.toISOString(),
        audit_event_ids: ids,
        things,
        places,
        placed,
        ...(notSet.length > 0 ? { not_set: notSet } : {}),
      },
    };
  },
};

// ---------------------------------------------------------------------------------------------

/** The language an alias list is stored under: the question's interface language. */
const aliasLanguage = (locale: string) => {
  const lang = locale.slice(0, 2).toLowerCase();
  return /^[a-z]{2}$/.test(lang) ? lang : 'en';
};

export const updateThingTool: Handler<'update_thing'> = {
  action: 'things.edit',
  subjectLocation: (client, input) => locationOfRef(client, input.thing_id),
  run: async (op, input) => {
    const loc = locationOf(op);
    const id = await thingIn(op.client, loc.id, input.thing_id);
    const f = input.fields;
    const body: UpdateBody = {};
    if (f.name !== undefined) body.name = f.name;
    if (f.notes !== undefined) body.notes = f.notes;
    if (f.model !== undefined) body.model = f.model;
    if (f.serial !== undefined) body.serial = f.serial;
    if (f.condition !== undefined) body.condition = f.condition;
    if (f.custom !== undefined) body.custom = f.custom;
    if (f.aliases !== undefined) {
      const v = await viewOf(op.tx, op.client, op.scope, null, id);
      body.aliases = { ...(v.aliases ?? {}), [aliasLanguage(op.locale)]: f.aliases };
    }
    if (f.brand !== undefined) {
      if (f.brand === null) body.brandId = null;
      else {
        const brandId = await brandNamed(op.client, loc.id, f.brand);
        if (!brandId)
          throw invalid('There is no brand with that name here; leave brand out or name another.');
        body.brandId = brandId;
      }
    }
    const expected = op.ifMatch ?? (await liveThing(op.client, id)).row_version;
    // The route's operation: secret keys in `custom` are refused (they have their own route,
    // Q3, D116), a money value where the gate hides money is `module_off`, and a changed row
    // since the proposal is 412 (D156).
    await updateThing(op, id, expected, body);
    return {
      data: {
        ...(await writeResult(op, 'thing', id)),
        thing: await thingRef(op, id),
        changed_fields: Object.keys(f),
      },
    };
  },
};

export const moveThing: Handler<'move_thing'> = {
  action: 'things.edit',
  subjectLocation: (client, input) => locationOfRef(client, input.thing_id),
  run: async (op, input) => {
    const loc = locationOf(op);
    const id = await thingIn(op.client, loc.id, input.thing_id);
    const raw = input.to_place_id ?? input.to_container_id;
    if (!raw || (input.to_place_id && input.to_container_id)) {
      throw invalid('Give exactly one of to_place_id and to_container_id.');
    }
    const to = await targetIn(op.client, loc.id, raw);
    const { moved } = await moveThings(
      op,
      { thingIds: [id], to, ...(input.quantity !== undefined ? { quantity: input.quantity } : {}) },
      op.ifMatch ?? null,
    );
    const movedId = moved[0] as string;
    return {
      data: {
        ...(await writeResult(op, 'thing', movedId)),
        thing: await thingRef(op, movedId),
        ...(movedId !== id ? { split_from: id } : {}),
      },
    };
  },
};

export const markSeenTool: Handler<'mark_seen'> = {
  action: 'things.mark-seen',
  subjectLocation: (client, input) => locationOfRef(client, input.thing_id),
  run: async (op, input) => {
    const loc = locationOf(op);
    const id = await thingIn(op.client, loc.id, input.thing_id);
    const { lastSeenAt } = await markSeen(op, id);
    return {
      data: {
        ...(await writeResult(op, 'thing', id)),
        thing: await thingRef(op, id),
        last_seen_at: lastSeenAt,
      },
    };
  },
};

export const createPlaceTool: Handler<'create_place'> = {
  action: 'things.edit',
  subjectLocation: (client, input) => locationOfRef(client, input.parent_id),
  run: async (op, input) => {
    const loc = locationOf(op);
    const parentId = input.parent_id ? await placeIn(op.client, loc.id, input.parent_id) : null;
    const created = await createPlace(
      op,
      loc.id,
      { name: input.name, kindKey: input.kind ?? DEFAULT_PLACE_KIND, parentId },
      { undoable: true },
    );
    return {
      data: {
        ...(await writeResult(op, 'place', created.id)),
        place: await placeRefOf(op.client, created.id),
      },
    };
  },
};

// ---------------------------------------------------------------------------------------------
// attach_link (D63): no file over MCP; a link into Kept where the person adds it themself.
// ---------------------------------------------------------------------------------------------

/**
 * Where a person adds a photo or document to a thing or place: the thing's Paperwork tab
 * (routes/_app/t.$id.tsx `tab`), the place's page. The web has no capture target for "attach to
 * this thing" yet (the plan's `/capture?attach=`; capture's `into` means "capture new things
 * into this box"); when T19/T21 add one, it changes here only.
 */
export function attachPath(subject: {
  type: 'thing' | 'place';
  id: string;
  short_code: string | null;
}) {
  return subject.type === 'thing' ? `${thingPath(subject)}?tab=paperwork` : placePath(subject);
}

export const attachLink: Handler<'attach_link'> = {
  action: 'attachments.add',
  subjectLocation: (client, input) => locationOfRef(client, input.subject_id),
  run: async (op, input) => {
    const loc = locationOf(op);
    if (input.subject_type === 'thing') {
      const id = await thingIn(op.client, loc.id, input.subject_id);
      const ref = await thingRef(op, id);
      return {
        data: { url: op.link(attachPath({ type: 'thing', id, short_code: ref.short_code })) },
      };
    }
    const id = await placeIn(op.client, loc.id, input.subject_id);
    const ref = await placeRefOf(op.client, id);
    return {
      data: { url: op.link(attachPath({ type: 'place', id, short_code: ref.short_code })) },
    };
  },
};

// ---------------------------------------------------------------------------------------------
// log_reading: step 2's readings operation, as the sync op logs one (D112): a misfit is kept
// for review in the Inbox, never refused and never silently accepted.
// ---------------------------------------------------------------------------------------------

type MeterRow = { id: string; location_id: string; unit: string };

async function meterOf(
  op: Op,
  locationId: string,
  input: { thing_id?: string | undefined; meter_id?: string | undefined },
): Promise<MeterRow> {
  if (input.meter_id) {
    const { rows } = await op.client.query<MeterRow>(
      'SELECT id, location_id, unit FROM public.meters WHERE id = $1',
      [input.meter_id.toLowerCase()],
    );
    const m = rows[0];
    if (!m || m.location_id !== locationId) throw notFound();
    return m;
  }
  if (!input.thing_id) throw invalid('Give thing_id or meter_id.');
  const thingId = await thingIn(op.client, locationId, input.thing_id);
  const { rows } = await op.client.query<MeterRow>(
    `SELECT id, location_id, unit FROM public.meters
      WHERE thing_id = $1 ORDER BY created_at, id`,
    [thingId],
  );
  if (rows.length === 0) throw invalid('This thing has no meter.');
  if (rows.length > 1) {
    throw invalid(`It has ${rows.length} meters; pass meter_id (get_thing lists them).`);
  }
  return rows[0] as MeterRow;
}

export const logReading: Handler<'log_reading'> = {
  action: 'logs.add',
  subjectLocation: async (client, input) => {
    if (input.meter_id) {
      const { rows } = await client.query<{ location_id: string }>(
        'SELECT location_id FROM public.meters WHERE id = $1',
        [input.meter_id.toLowerCase()],
      );
      return rows[0]?.location_id ?? null;
    }
    return locationOfRef(client, input.thing_id);
  },
  run: async (op, input) => {
    const loc = locationOf(op);
    const meter = await meterOf(op, loc.id, input);
    const res = await createReading(
      op,
      meter.id,
      { value: String(input.value), takenAt: input.taken_at ?? new Date().toISOString() },
      'manual',
      { via: 'op', undoable: true },
    );
    return {
      data: {
        ...(await writeResult(op, 'meter_reading', res.reading.id)),
        reading: {
          id: res.reading.id,
          meter_id: meter.id,
          value: Number(res.reading.value),
          unit: meter.unit,
          taken_at: res.reading.takenAt,
        },
        to_inbox: res.state === 'needs_review',
      },
    };
  },
};
