/**
 * Mock handlers for lending and borrowing (T10; D56, D57, D119, D172). Lending part of a quantity
 * splits the thing and the loan sits on the split-off row; returning it merges it back into the
 * row it came from when that row is live, in the same place and of the same type (Q14). A borrowed
 * thing belongs to the person, and returning it ends it as `returned_to_owner` (Q15). One open
 * loan per thing; nothing is lent while in repair. Kept never contacts the person (D57).
 */
import { can } from '@kept/shared';
import { liveThing, now, paginate, type StoredThing, versionError } from '../../inventory/mock/db';
import type { MockState } from '../../mock/fixtures';
import { err, type MockRoute, notFound, reply, route } from '../../mock/kit';
import { householdPaths as p } from '../paths';
import type {
  BorrowBody,
  CreateLoanAttachmentBody,
  LendBody,
  LoanPersonInput,
  LoanRow,
  ReturnBody,
  UpdateLoanBody,
} from '../types';
import {
  ensureSeeded,
  gateFor,
  hh,
  householdRowOf,
  listLocations,
  loanRowView,
  loanView,
  locOf,
  newId,
  openLoanOf,
  placeSubject,
  recordHouseholdEvent,
  repairOf,
  thingSubject,
  todayIn,
} from './db';
import type { StoredLoan } from './state';

const invalid = (hint: string) => err(400, 'validation', 'The request is not valid.', hint);

export function lendingRoutes(state: MockState): MockRoute[] {
  const h = () => hh(state);
  const inv = () => state.inventory;
  const me = () => state.me.user;

  /** The person a loan is with: an existing row, a new one by name, or a member (D57, Q16). */
  const personFor = (locationId: string, input: LoanPersonInput): string | null => {
    const accountId = locOf(state, locationId)?.ownerAccountId ?? '';
    if ('id' in input)
      return inv().people.some((x) => x.id === input.id && x.ownerAccountId === accountId)
        ? input.id
        : null;
    if ('memberUserId' in input) {
      const linked = inv().people.find(
        (x) => x.userId === input.memberUserId && x.ownerAccountId === accountId,
      );
      if (linked) return linked.id;
      const member = state.members[locationId]?.members.find(
        (m) => m.userId === input.memberUserId,
      );
      if (!member) return null;
      const id = newId();
      inv().people.push({
        id,
        ownerAccountId: accountId,
        displayName: member.displayName,
        userId: member.userId,
        rowVersion: 1,
      });
      return id;
    }
    const name = input.name.trim();
    if (!name) return null;
    const id = newId();
    inv().people.push({
      id,
      ownerAccountId: accountId,
      displayName: name,
      userId: null,
      rowVersion: 1,
    });
    return id;
  };

  const unplacedOf = (locationId: string) =>
    inv().places.find((pl) => pl.locationId === locationId && pl.isUnplaced && !pl.deletedAt);

  return [
    route('POST', p.thingLend(':id'), ({ params, body }) => {
      ensureSeeded(state);
      const t = liveThing(inv(), params.id ?? null);
      if (!t) return notFound();
      const gated = gateFor(state, t.locationId, 'lending', 'write');
      if (gated) return gated;
      if (openLoanOf(state, t.id)) return err(409, 'already_on_loan', 'This is already on loan.');
      if (repairOf(state, t.id)) return err(409, 'thing_in_repair', 'This is in repair.');
      const b = body as LendBody;
      const personId = personFor(t.locationId, b.person);
      if (!personId) return notFound();
      const quantity = b.quantity === undefined ? t.quantity : Number(b.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0 || quantity > t.quantity)
        return invalid('quantity: more than 0 and at most what there is');
      // A partial quantity splits (step 2's split): the loan is on the new row (D10, D57).
      let lent: StoredThing = t;
      let splitFrom: StoredThing | null = null;
      if (quantity < t.quantity) {
        lent = { ...structuredClone(t), id: newId(), shortCode: null, quantity, rowVersion: 1 };
        t.quantity -= quantity;
        t.rowVersion += 1;
        inv().things.push(lent);
        splitFrom = t;
      }
      const loan: StoredLoan = {
        id: b.loanId ?? newId(),
        thingId: lent.id,
        locationId: t.locationId,
        direction: 'out',
        personId,
        startedAt: b.startedAt ?? now(),
        dueOn: b.dueOn ?? null,
        returnedAt: null,
        quantity: String(quantity),
        splitFromThingId: splitFrom?.id ?? null,
        returnPlace: null,
        // Where it left from: a place, or the container it was in (a thing subject).
        previousPlace: lent.containerId
          ? (() => {
              const box = liveThing(inv(), lent.containerId);
              return box ? thingSubject(state, box) : null;
            })()
          : lent.placeId
            ? placeSubject(state, lent.placeId)
            : null,
        notes: b.notes ?? null,
        conditionOut: [],
        conditionIn: [],
        rowVersion: 1,
        createdBy: { displayName: me().displayName },
        createdById: me().id,
      };
      h().loans.push(loan);
      recordHouseholdEvent(state, {
        action: 'loan.create',
        entity: { type: 'loan', id: loan.id },
        locationId: t.locationId,
        rootThingId: lent.id,
        name: lent.name ?? '',
      });
      return reply(201, {
        loan: loanView(state, loan),
        thing: householdRowOf(state, lent),
        ...(splitFrom ? { splitFrom: householdRowOf(state, splitFrom) } : {}),
      });
    }),

    route('POST', p.locationBorrow(':id'), ({ params, body }) => {
      ensureSeeded(state);
      const locationId = params.id ?? '';
      const gated = gateFor(state, locationId, 'lending', 'write');
      if (gated) return gated;
      const b = body as BorrowBody;
      if (!b.name?.trim()) return invalid('name: required');
      const personId = personFor(locationId, b.person);
      if (!personId) return notFound();
      const template = inv().things.find((x) => x.locationId === locationId) ?? inv().things[0];
      if (!template) return notFound();
      const person = inv().people.find((x) => x.id === personId);
      const type = b.typeId ? inv().types.find((x) => x.id === b.typeId) : undefined;
      const thing: StoredThing = {
        ...structuredClone(template),
        id: b.thingId ?? newId(),
        locationId,
        shortCode: null,
        name: b.name.trim(),
        type: type
          ? { id: type.id, icon: type.icon, name: type.name, builtinKey: type.builtinKey }
          : null,
        fields: type?.fields ?? [],
        custom: {},
        quantity: 1,
        lifecycle: 'in_use',
        brand: null,
        model: null,
        serial: null,
        tags: [],
        purchase: null,
        photos: [],
        meters: [],
        links: [],
        secrets: [],
        ended: null,
        belongsTo: person ? { id: person.id, displayName: person.displayName } : null,
        placeId: 'placeId' in b.target ? b.target.placeId : null,
        containerId: 'containerId' in b.target ? b.target.containerId : null,
        rowVersion: 1,
        createdAt: now(),
        updatedAt: now(),
        deletedAt: null,
        trashBatchId: null,
        deletedBy: null,
      };
      inv().things.push(thing);
      const loan: StoredLoan = {
        id: b.loanId ?? newId(),
        thingId: thing.id,
        locationId,
        direction: 'in',
        personId,
        startedAt: now(),
        dueOn: b.dueOn ?? null,
        returnedAt: null,
        quantity: '1',
        splitFromThingId: null,
        returnPlace: null,
        previousPlace: null,
        notes: b.notes ?? null,
        conditionOut: [],
        conditionIn: [],
        rowVersion: 1,
        createdBy: { displayName: me().displayName },
        createdById: me().id,
      };
      h().loans.push(loan);
      recordHouseholdEvent(state, {
        action: 'loan.create',
        entity: { type: 'loan', id: loan.id },
        locationId,
        rootThingId: thing.id,
        name: thing.name ?? '',
      });
      return reply(201, { loan: loanView(state, loan), thing: householdRowOf(state, thing) });
    }),

    route('POST', p.loanReturn(':id'), ({ params, body, headers }) => {
      const loan = h().loans.find((x) => x.id === params.id);
      const t = loan ? liveThing(inv(), loan.thingId) : undefined;
      if (!loan || !t) return notFound();
      // An open loan can be returned with Lending off (the server's rule, UI step-4 review L3).
      const gated = loan.returnedAt ? gateFor(state, loan.locationId, 'lending', 'write') : null;
      if (gated) return gated;
      if (loan.returnedAt) return err(409, 'conflict', 'This was already returned.');
      const stale = versionError(headers, loan);
      if (stale) return reply(stale.status, stale.body);
      const b = (body ?? {}) as ReturnBody;
      const beforeLoan = { ...loan };
      const beforeThing = structuredClone(t);
      let mergedInto: StoredThing | null = null;
      let beforeOriginal: StoredThing | null = null;
      if (loan.direction === 'out') {
        const to = b.to ?? 'previous';
        if (to === 'previous') {
          const prev = loan.previousPlace;
          const box = prev?.type === 'thing' ? liveThing(inv(), prev.id) : undefined;
          if (box) {
            t.placeId = null;
            t.containerId = box.id;
          } else {
            t.placeId =
              (prev?.type === 'place' ? prev.id : null) ?? unplacedOf(t.locationId)?.id ?? null;
            t.containerId = null;
          }
        } else if ('placeId' in to) {
          t.placeId = to.placeId;
          t.containerId = null;
        } else {
          t.placeId = null;
          t.containerId = to.containerId;
        }
        const original = loan.splitFromThingId
          ? liveThing(inv(), loan.splitFromThingId)
          : undefined;
        if (
          b.mergeBack !== false &&
          original &&
          original.placeId === t.placeId &&
          original.containerId === t.containerId &&
          original.type?.id === t.type?.id
        ) {
          beforeOriginal = structuredClone(original);
          original.quantity += t.quantity;
          original.rowVersion += 1;
          t.deletedAt = now();
          t.mergedIntoId = original.id;
          mergedInto = original;
        }
        const box = t.containerId ? liveThing(inv(), t.containerId) : undefined;
        loan.returnPlace = box
          ? thingSubject(state, box)
          : t.placeId
            ? placeSubject(state, t.placeId)
            : null;
      } else {
        t.lifecycle = 'returned_to_owner';
        t.ended = { on: todayIn(state, t.locationId), to: null, notes: null };
      }
      t.rowVersion += 1;
      loan.returnedAt = b.returnedAt ?? now();
      if (b.notes !== undefined) loan.notes = b.notes;
      loan.rowVersion += 1;
      recordHouseholdEvent(state, {
        action: 'loan.return',
        entity: { type: 'loan', id: loan.id },
        locationId: loan.locationId,
        rootThingId: mergedInto?.id ?? t.id,
        name: t.name ?? '',
        undo: () => {
          Object.assign(loan, beforeLoan, { rowVersion: loan.rowVersion + 1 });
          Object.assign(t, beforeThing, { rowVersion: t.rowVersion + 1 });
          if (mergedInto && beforeOriginal)
            Object.assign(mergedInto, beforeOriginal, { rowVersion: mergedInto.rowVersion + 1 });
        },
      });
      return {
        loan: loanView(state, loan),
        thing: householdRowOf(state, t),
        ...(mergedInto ? { mergedInto: householdRowOf(state, mergedInto) } : {}),
      };
    }),

    route('PATCH', p.loan(':id'), ({ params, body, headers }) => {
      const loan = h().loans.find((x) => x.id === params.id);
      if (!loan) return notFound();
      const gated = gateFor(state, loan.locationId, 'lending', 'write');
      if (gated) return gated;
      const stale = versionError(headers, loan);
      if (stale) return reply(stale.status, stale.body);
      const b = body as UpdateLoanBody;
      const before = { ...loan };
      if (b.dueOn !== undefined) loan.dueOn = b.dueOn;
      if (b.notes !== undefined) loan.notes = b.notes;
      if (b.person) {
        const personId = personFor(loan.locationId, b.person);
        if (!personId) return notFound();
        loan.personId = personId;
      }
      loan.rowVersion += 1;
      recordHouseholdEvent(state, {
        action: 'loan.update',
        entity: { type: 'loan', id: loan.id },
        locationId: loan.locationId,
        rootThingId: loan.thingId,
        name: liveThing(inv(), loan.thingId)?.name ?? '',
        undo: () => Object.assign(loan, before, { rowVersion: loan.rowVersion + 1 }),
      });
      return loanView(state, loan);
    }),

    route('DELETE', p.loan(':id'), ({ params, headers }) => {
      const loan = h().loans.find((x) => x.id === params.id);
      if (!loan) return notFound();
      const gated = gateFor(state, loan.locationId, 'lending', 'write');
      if (gated) return gated;
      const stale = versionError(headers, loan);
      if (stale) return reply(stale.status, stale.body);
      h().loans = h().loans.filter((x) => x !== loan);
      recordHouseholdEvent(state, {
        action: 'loan.delete',
        entity: { type: 'loan', id: loan.id },
        locationId: loan.locationId,
        rootThingId: loan.thingId,
        name: liveThing(inv(), loan.thingId)?.name ?? '',
        undo: () => {
          h().loans.push(loan);
        },
      });
      return reply(204);
    }),

    // The Lending screen: global, overdue first, with a location filter (screens §1).
    route('GET', p.loans, ({ query }) => {
      ensureSeeded(state);
      const allowed = listLocations(state, 'lending');
      const direction = query.get('direction');
      const want = query.get('state');
      const loc = query.get('locationId');
      const personId = query.get('personId');
      const q = query.get('q')?.trim().toLowerCase();
      const rows = h()
        .loans.filter((l) => allowed.has(l.locationId) && (!loc || l.locationId === loc))
        .map((l) => loanRowView(state, l))
        .filter((r): r is LoanRow => r !== null);
      const open = rows.filter((r) => !r.returnedAt);
      const counts = {
        out: open.filter((r) => r.direction === 'out').length,
        in: open.filter((r) => r.direction === 'in').length,
        overdue: open.filter((r) => r.overdue).length,
      };
      const items = rows
        .filter(
          (r) =>
            (!direction || r.direction === direction) &&
            (!personId || r.person.id === personId) &&
            (!q ||
              (r.thing.name ?? '').toLowerCase().includes(q) ||
              r.person.name.toLowerCase().includes(q)) &&
            (want === 'returned'
              ? !!r.returnedAt
              : want === 'overdue'
                ? r.overdue
                : want === 'open'
                  ? !r.returnedAt
                  : true),
        )
        .sort(
          (a, b) =>
            Number(b.overdue) - Number(a.overdue) ||
            Number(!!a.returnedAt) - Number(!!b.returnedAt) ||
            (a.dueOn ?? '9999').localeCompare(b.dueOn ?? '9999'),
        );
      return { ...paginate(items, query, 20), counts };
    }),

    route('GET', p.thingLoans(':id'), ({ params }) => {
      ensureSeeded(state);
      const t = liveThing(inv(), params.id ?? null);
      if (!t) return notFound();
      // With Lending off, only its open loan (the server's rule, UI step-4 review L3).
      const off = gateFor(state, t.locationId, 'lending', 'read');
      const open = h().loans.find((l) => l.thingId === t.id && !l.returnedAt);
      if (off && !open) return off;
      const items = h()
        .loans.filter((l) => l.thingId === t.id && (!off || l === open))
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .map((l) => loanView(state, l));
      return { items };
    }),

    // The person page (D57): what they have from us, what they lent us, and the history.
    route('GET', p.personLoans(':id'), ({ params, query }) => {
      ensureSeeded(state);
      const person = inv().people.find((x) => x.id === params.id);
      const mine = new Set(state.locations.map((l) => l.ownerAccountId));
      if (!person || !mine.has(person.ownerAccountId)) return notFound();
      const allowed = listLocations(state, 'lending');
      const rows = h()
        .loans.filter((l) => l.personId === person.id && allowed.has(l.locationId))
        .map((l) => loanRowView(state, l))
        .filter((r): r is LoanRow => r !== null);
      const history = paginate(
        rows
          .filter((r) => !!r.returnedAt)
          .sort((a, b) => (b.returnedAt ?? '').localeCompare(a.returnedAt ?? '')),
        query,
        20,
      );
      return {
        has: rows.filter((r) => !r.returnedAt && r.direction === 'out'),
        lentUs: rows.filter((r) => !r.returnedAt && r.direction === 'in'),
        history: history.items,
        next_cursor: history.next_cursor,
      };
    }),

    // Condition photos only (the attachments' OWNERS table gains `loan`).
    route('POST', p.loanAttachments(':id'), ({ params, body }) => {
      const loan = h().loans.find((x) => x.id === params.id);
      if (!loan) return notFound();
      const gated = gateFor(state, loan.locationId, 'lending', 'write');
      if (gated) return gated;
      const b = body as CreateLoanAttachmentBody;
      if (b.role !== 'condition_out' && b.role !== 'condition_in')
        return invalid('role: condition_out or condition_in');
      const file = inv().files[b.fileId];
      if (!file) return notFound();
      const role = locOf(state, loan.locationId)?.role;
      if (!role || !can(role, 'things.edit'))
        return err(403, 'forbidden', "You don't have permission.");
      const attachment = {
        id: newId(),
        role: b.role,
        sort: 0,
        file,
        url: null,
        subject: { loanId: loan.id },
        createdBy: { displayName: me().displayName },
        rowVersion: 1,
      };
      (b.role === 'condition_out' ? loan.conditionOut : loan.conditionIn).push(attachment);
      return reply(201, attachment);
    }),
  ];
}
