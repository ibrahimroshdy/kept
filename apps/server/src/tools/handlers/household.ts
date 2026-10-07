import { pageSize, parseRef, type ThingRef } from '@kept/mcp';
import { addDays } from '@kept/shared';
import type pg from 'pg';
import { LISTED_SOURCES, listAgenda } from '../../agenda/query.js';
import { undoableEventIds } from '../../audit/audited.js';
import { decodeCursor } from '../../http/conventions.js';
import { invalid, notFound } from '../../http/errors.js';
import { returnLoan } from '../../lending/return.js';
import { borrow, lend, type PersonInput } from '../../lending/service.js';
import { unplacedOf } from '../../places/view.js';
import { snoozeSchedule, todayIn } from '../../schedules/service.js';
import { completeSchedule } from '../../schedules/services.js';
import { viewOf } from '../../things/view.js';
import { createClaim, updateClaim } from '../../warranties/claims.js';
import { createWarranty, defaultsFor } from '../../warranties/service.js';
import { decodeToolCursor, encodeToolCursor, thingRefOf } from '../output.js';
import { locationOfRef, targetIn, thingIn } from '../resolve.js';
import type { Handler, Op } from '../types.js';

// Step 4's tools (D124): lending, schedules, warranties and claims, and `upcoming` over the
// agenda. Each calls the operation step 4's route calls; the module gate is runTool's (and the
// operation's own, where it has one).

const locationOf = (op: Op) => {
  if (!op.location) throw new Error('this tool always runs in one location');
  return op.location;
};

async function thingRef(op: Op, id: string): Promise<ThingRef> {
  const v = await viewOf(op.tx, op.client, op.scope, null, id);
  return thingRefOf(v, locationOf(op).name);
}

/** The newest audit event this call wrote about an entity, and its undo window. */
export async function eventOf(op: Op, entityType: string, entityId: string) {
  const undoable = undoableEventIds(op.tx);
  const { rows } = await op.client.query<{ id: string; undoable_until: Date | null }>(
    `SELECT id, undoable_until FROM public.audit_events
      WHERE request_id = $1 AND entity_type = $2 AND entity_id = $3
      ORDER BY (id = ANY ($4::uuid[])) DESC, id DESC LIMIT 1`,
    [op.requestId, entityType, entityId, undoable],
  );
  const r = rows[0];
  if (!r) throw new Error(`no audit event for ${entityType} ${entityId}`);
  return { audit_event_id: r.id, undo_until: r.undoable_until?.toISOString() ?? null };
}

/** A person as the model names them: an id, else a person of the location's account with that
 * name (so "Murdock" twice is one person), else a new one by name (step 4, D11). */
async function personOf(
  client: pg.ClientBase,
  locationId: string,
  raw: string,
): Promise<PersonInput> {
  const ref = parseRef(raw);
  if (ref?.kind === 'id') return { id: ref.id };
  const { rows } = await client.query<{ id: string }>(
    `SELECT pe.id FROM public.people pe
       JOIN public.locations l ON l.owner_account_id = pe.owner_account_id
      WHERE l.id = $1 AND kept.normalize(pe.display_name) = kept.normalize($2)
      ORDER BY pe.created_at, pe.id LIMIT 1`,
    [locationId, raw],
  );
  return rows[0] ? { id: rows[0].id } : { name: raw };
}

const scheduleLocation = async (client: pg.ClientBase, id: string) => {
  const { rows } = await client.query<{ location_id: string }>(
    'SELECT location_id FROM public.schedules WHERE id = $1',
    [id.toLowerCase()],
  );
  return rows[0]?.location_id ?? null;
};

async function scheduleIn(op: Op, id: string) {
  const { rows } = await op.client.query<{ location_id: string; row_version: number }>(
    'SELECT location_id, row_version FROM public.schedules WHERE id = $1',
    [id.toLowerCase()],
  );
  const r = rows[0];
  if (!r || r.location_id !== locationOf(op).id) throw notFound();
  return { id: id.toLowerCase(), version: op.ifMatch ?? r.row_version };
}

// ---------------------------------------------------------------------------------------------
// upcoming: the agenda (agenda/query.ts), as Home's attention panel reads it.
// ---------------------------------------------------------------------------------------------

type Kind = 'due' | 'overdue' | 'expiring' | 'low_stock' | 'loans';

export const upcoming: Handler<'upcoming'> = {
  action: 'content.view',
  global: true,
  run: async (op, input) => {
    const size = pageSize(input.limit);
    const within = input.within_days ?? 30;
    const anchor = op.location ?? op.locations[0];
    if (!anchor) return { data: { items: [] } };
    const to = addDays(await todayIn(op.client, anchor.id), within);
    const wanted = new Set<Kind>(
      input.kinds ?? ['due', 'overdue', 'expiring', 'loans', 'low_stock'],
    );
    const ids = new Set(op.locations.map((l) => l.id));
    const at = decodeToolCursor(input.cursor);
    const res = await listAgenda(
      op.client,
      {
        to,
        // Low stock is a source the agenda lists only when asked for (0104).
        sourceType: wanted.has('low_stock') ? [...LISTED_SOURCES, 'stock'] : [...LISTED_SOURCES],
        ...(op.location ? { locationId: op.location.id } : {}),
      },
      { limit: size, after: at.c ? decodeCursor(at.c) : null },
    );
    const items = res.items
      .filter((i) => ids.has(i.locationId))
      .map((i) => {
        // An expired document is past its date: overdue, in the contract's words.
        const kind: Kind =
          i.sourceType === 'stock'
            ? 'low_stock'
            : i.sourceType === 'loan'
              ? 'loans'
              : i.state === 'upcoming'
                ? 'due'
                : i.state === 'expired'
                  ? 'overdue'
                  : i.state;
        return { i, kind };
      })
      .filter(({ kind }) => wanted.has(kind))
      .slice(at.o)
      .map(({ i, kind }) => ({
        kind,
        source_type: i.sourceType,
        source_id: i.sourceId,
        due_on: i.dueOn,
        ...(i.subject.type === 'thing'
          ? {
              thing: {
                id: i.subject.id,
                short_code: i.subject.shortCode ?? null,
                location_id: i.locationId,
                // SubjectRef's path is "Home › Kitchen › Drawer"; its steps, then the thing.
                untrusted: {
                  name: i.subject.name,
                  path: i.subject.path ? i.subject.path.split(' › ') : [],
                },
              },
            }
          : {}),
        untrusted: { title: i.title },
      }));
    return {
      data: { items },
      nextCursor: res.next_cursor ? encodeToolCursor({ c: res.next_cursor, o: 0 }) : null,
      cursorAt: (kept) => encodeToolCursor({ c: at.c, o: at.o + kept }),
    };
  },
};

// ---------------------------------------------------------------------------------------------
// Lending (lending/service.ts, lending/return.ts)
// ---------------------------------------------------------------------------------------------

export const lendThing: Handler<'lend_thing'> = {
  action: 'things.edit',
  subjectLocation: (client, input) => locationOfRef(client, input.thing_id),
  run: async (op, input) => {
    const loc = locationOf(op);
    const id = await thingIn(op.client, loc.id, input.thing_id);
    const res = await lend(op, id, {
      person: await personOf(op.client, loc.id, input.person),
      ...(input.due_on ? { dueOn: input.due_on } : {}),
      ...(input.quantity !== undefined ? { quantity: String(input.quantity) } : {}),
    });
    return {
      data: {
        ...(await eventOf(op, 'loan', res.loan.id)),
        thing: await thingRef(op, res.thing.id),
        loan_id: res.loan.id,
      },
    };
  },
};

export const returnThing: Handler<'return_thing'> = {
  action: 'things.edit',
  subjectLocation: (client, input) => locationOfRef(client, input.thing_id),
  run: async (op, input) => {
    const loc = locationOf(op);
    const id = await thingIn(op.client, loc.id, input.thing_id);
    const { rows } = await op.client.query<{ id: string; row_version: number; quantity: string }>(
      `SELECT o.id, o.row_version, trim_scale(t.quantity)::text AS quantity
         FROM public.loans o JOIN public.things t ON t.id = o.thing_id
        WHERE o.thing_id = $1 AND o.returned_at IS NULL`,
      [id],
    );
    const loan = rows[0];
    if (!loan) throw invalid('It isn’t on loan.');
    // A loan comes back whole (step 4): a part lent was split off first, and is its own thing.
    if (input.quantity !== undefined && String(input.quantity) !== loan.quantity) {
      throw invalid(`A loan comes back whole: all ${loan.quantity} of it.`);
    }
    const res = await returnLoan(op, loan.id, op.ifMatch ?? loan.row_version, {});
    return {
      data: {
        ...(await eventOf(op, 'loan', loan.id)),
        thing: await thingRef(op, res.thing.id),
        loan_id: loan.id,
      },
    };
  },
};

export const borrowThing: Handler<'borrow_thing'> = {
  action: 'things.edit',
  subjectLocation: (client, input) => locationOfRef(client, input.place_id),
  run: async (op, input) => {
    const loc = locationOf(op);
    const target = input.place_id
      ? await targetIn(op.client, loc.id, input.place_id)
      : { placeId: await unplacedOf(op.client, loc.id) };
    const res = await borrow(op, loc.id, {
      name: input.name,
      target,
      person: await personOf(op.client, loc.id, input.person),
      ...(input.due_on ? { dueOn: input.due_on } : {}),
    });
    return {
      data: {
        ...(await eventOf(op, 'loan', res.loan.id)),
        thing: await thingRef(op, res.thing.id),
        loan_id: res.loan.id,
      },
    };
  },
};

// ---------------------------------------------------------------------------------------------
// Schedules (schedules/service.ts, schedules/services.ts)
// ---------------------------------------------------------------------------------------------

export const completeScheduleTool: Handler<'complete_schedule'> = {
  action: 'schedules-claims.manage',
  subjectLocation: (client, input) => scheduleLocation(client, input.schedule_id),
  run: async (op, input) => {
    const s = await scheduleIn(op, input.schedule_id);
    const res = await completeSchedule(op, s.id, s.version, {
      ...(input.done_on ? { servicedOn: input.done_on } : {}),
      ...(input.value !== undefined ? { reading: { value: String(input.value) } } : {}),
    });
    return {
      data: {
        ...(await eventOf(op, 'service_record', res.serviceRecord.id)),
        schedule_id: s.id,
        next_due_on: res.schedule.next.dueOn,
      },
    };
  },
};

export const snoozeScheduleTool: Handler<'snooze_schedule'> = {
  action: 'schedules-claims.manage',
  subjectLocation: (client, input) => scheduleLocation(client, input.schedule_id),
  run: async (op, input) => {
    const s = await scheduleIn(op, input.schedule_id);
    if (input.until_date && input.until_value !== undefined) {
      throw invalid('Give until_date or until_value, not both.');
    }
    await snoozeSchedule(
      op,
      s.id,
      s.version,
      input.until_date
        ? { untilDate: input.until_date }
        : input.until_value !== undefined
          ? { untilValue: String(input.until_value) }
          : {},
    );
    return { data: { ...(await eventOf(op, 'schedule', s.id)), schedule_id: s.id } };
  },
};

// ---------------------------------------------------------------------------------------------
// Warranties and claims (warranties/service.ts, warranties/claims.ts)
// ---------------------------------------------------------------------------------------------

export const addWarranty: Handler<'add_warranty'> = {
  action: 'things.edit',
  subjectLocation: (client, input) => locationOfRef(client, input.thing_id),
  run: async (op, input) => {
    const loc = locationOf(op);
    const id = await thingIn(op.client, loc.id, input.thing_id);
    if (input.ends_on && input.term_months !== undefined) {
      throw invalid('Give ends_on or term_months, not both.');
    }
    const defaults = await defaultsFor(op.client, id);
    const term = input.ends_on
      ? undefined
      : (input.term_months ?? defaults.termMonths ?? undefined);
    if (!input.ends_on && term === undefined) {
      throw invalid('Give ends_on or term_months: nothing here says how long it lasts.');
    }
    const w = await createWarranty(op, id, {
      kind: input.kind,
      startsOn: defaults.startsOn ?? (await todayIn(op.client, loc.id)),
      ...(input.ends_on ? { endsOn: input.ends_on } : { termMonths: term as number }),
      ...(input.provider ? { provider: input.provider } : {}),
    });
    return {
      data: {
        ...(await eventOf(op, 'warranty', w.id)),
        warranty_id: w.id,
        ends_on: w.effectiveEndsOn,
      },
    };
  },
};

export const openClaim: Handler<'open_claim'> = {
  action: 'schedules-claims.manage',
  subjectLocation: (client, input) => locationOfRef(client, input.thing_id),
  run: async (op, input) => {
    const loc = locationOf(op);
    const id = await thingIn(op.client, loc.id, input.thing_id);
    const c = await createClaim(op, id, {
      openedOn: await todayIn(op.client, loc.id),
      ...(input.warranty_id ? { warrantyId: input.warranty_id } : {}),
      ...(input.reference ? { reference: input.reference } : {}),
    });
    return {
      data: { ...(await eventOf(op, 'claim', c.id)), claim_id: c.id, status: c.status },
    };
  },
};

export const updateClaimTool: Handler<'update_claim'> = {
  action: 'schedules-claims.manage',
  subjectLocation: (client, input) => locationOfRef(client, input.thing_id),
  run: async (op, input) => {
    const loc = locationOf(op);
    const id = await thingIn(op.client, loc.id, input.thing_id);
    // The thing's claim: the newest still open (of that warranty, when one is named).
    const { rows } = await op.client.query<{ id: string; row_version: number }>(
      `SELECT id, row_version FROM public.claims
        WHERE thing_id = $1 AND status NOT IN ('resolved', 'rejected')
          AND ($2::uuid IS NULL OR warranty_id = $2::uuid)
        ORDER BY opened_on DESC, id DESC LIMIT 1`,
      [id, input.warranty_id ?? null],
    );
    const claim = rows[0];
    if (!claim) throw invalid('It has no open claim; open_claim opens one.');
    if (input.status === undefined && input.reference === undefined) {
      throw invalid('Give status or reference.');
    }
    const c = await updateClaim(op, claim.id, op.ifMatch ?? claim.row_version, {
      ...(input.status ? { status: input.status } : {}),
      ...(input.reference !== undefined ? { reference: input.reference } : {}),
    });
    return {
      data: { ...(await eventOf(op, 'claim', claim.id)), claim_id: claim.id, status: c.status },
    };
  },
};
