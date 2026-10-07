/**
 * Mock handlers for warranties, claims and brand logos (T9; D53–D55, D158, D195). Several
 * warranties per thing, the longest cover first; defaults from the brand, else the nearest type
 * up the chain, and the purchase date (never an AI guess); claims whose `in_repair` puts the thing
 * "at <service centre>"; the claim prefill from the longest active warranty.
 */
import { CLAIM_TRANSITIONS, type ClaimStatus, coverage } from '@kept/shared';
import { liveThing, versionError } from '../../inventory/mock/db';
import type { MockState } from '../../mock/fixtures';
import { err, type MockRoute, notFound, reply, route } from '../../mock/kit';
import { householdPaths as p } from '../paths';
import type {
  CreateClaimBody,
  CreateWarrantyBody,
  UpdateClaimBody,
  UpdateWarrantyBody,
  WarrantyDefaults,
} from '../types';
import {
  byCover,
  claimView,
  ensureSeeded,
  gateFor,
  hh,
  newId,
  recordHouseholdEvent,
  repairOf,
  todayIn,
  warrantyView,
} from './db';
import type { StoredClaim, StoredWarranty } from './state';

const invalid = (hint: string) => err(400, 'validation', 'The request is not valid.', hint);

export function warrantiesRoutes(state: MockState): MockRoute[] {
  const h = () => hh(state);
  const me = () => ({ displayName: state.me.user.displayName });
  const thingOf = (id: string | undefined) => liveThing(state.inventory, id ?? null);

  /** A vendor by id, or a new one by name (D11, `people-vendors.create-inline`). */
  const vendorId = (
    accountId: string,
    v: { id: string } | { name: string } | null | undefined,
  ): string | null => {
    if (!v) return null;
    if ('id' in v) return v.id;
    const found = state.inventory.vendors.find(
      (x) => x.ownerAccountId === accountId && x.name.toLowerCase() === v.name.toLowerCase(),
    );
    if (found) return found.id;
    const id = newId();
    state.inventory.vendors.push({
      id,
      ownerAccountId: accountId,
      name: v.name,
      kind: 'service_centre',
      address: null,
      phone: null,
      website: null,
      rowVersion: 1,
    });
    return id;
  };
  const accountOf = (locationId: string) =>
    state.locations.find((l) => l.id === locationId)?.ownerAccountId ?? '';

  return [
    // ----- warranties -----
    route('GET', p.thingWarranties(':id'), ({ params }) => {
      ensureSeeded(state);
      const t = thingOf(params.id);
      if (!t) return notFound();
      const gated = gateFor(state, t.locationId, 'warranties', 'read');
      if (gated) return gated;
      const rows = h().warranties.filter((w) => w.thingId === t.id);
      const items = rows.map((w) => warrantyView(state, w)).sort(byCover);
      const cover = coverage(rows, todayIn(state, t.locationId));
      return {
        items,
        coverage: {
          longestId: cover.longestId,
          boughtOn: t.purchase?.purchasedOn ?? cover.boughtOn,
          coveredUntil: cover.coveredUntil,
        },
      };
    }),
    route('GET', p.thingWarrantyDefaults(':id'), ({ params }) => {
      ensureSeeded(state);
      const t = thingOf(params.id);
      if (!t) return notFound();
      const gated = gateFor(state, t.locationId, 'warranties', 'read');
      if (gated) return gated;
      const startsOn = t.purchase?.purchasedOn ?? null;
      const brand = t.brand ? state.inventory.brands.find((b) => b.id === t.brand?.id) : undefined;
      if (brand?.defaultWarrantyMonths)
        return {
          termMonths: brand.defaultWarrantyMonths,
          from: { kind: 'brand', id: brand.id, name: brand.name },
          startsOn,
        } satisfies WarrantyDefaults;
      // The nearest type up the chain with a default (D92).
      let type = t.type ? state.inventory.types.find((x) => x.id === t.type?.id) : undefined;
      const seen = new Set<string>();
      while (type && !seen.has(type.id)) {
        seen.add(type.id);
        const months = type.defaultWarrantyMonths;
        if (months)
          return {
            termMonths: months,
            from: { kind: 'type', id: type.id, name: type.name ?? type.builtinKey ?? '' },
            startsOn,
          } satisfies WarrantyDefaults;
        type = state.inventory.types.find((x) => x.id === type?.parentId);
      }
      return { termMonths: null, from: null, startsOn } satisfies WarrantyDefaults;
    }),
    route('POST', p.thingWarranties(':id'), ({ params, body }) => {
      const t = thingOf(params.id);
      if (!t) return notFound();
      const gated = gateFor(state, t.locationId, 'warranties', 'write');
      if (gated) return gated;
      if (t.quantity !== 1)
        return err(409, 'quantity_not_one', 'A warranty covers one thing.', 'Split it first.');
      const b = body as CreateWarrantyBody;
      const ends = [b.endsOn, b.termMonths, b.lifetime].filter((x) => x !== undefined).length;
      if (ends !== 1) return invalid('one of endsOn, termMonths or lifetime');
      const row: StoredWarranty = {
        id: b.id ?? newId(),
        thingId: t.id,
        kind: b.kind,
        provider: b.provider ?? null,
        startsOn: b.startsOn,
        endsOn: b.endsOn ?? null,
        termMonths: b.termMonths ?? null,
        lifetime: b.lifetime === true,
        leadDays: b.leadDays ?? 30,
        claimContact: b.claimContact ?? null,
        registered: b.registered ?? false,
        registrationDeadline: b.registrationDeadline ?? null,
        documents: [],
        rowVersion: 1,
        createdBy: me(),
      };
      h().warranties.push(row);
      recordHouseholdEvent(state, {
        action: 'warranty.create',
        entity: { type: 'warranty', id: row.id },
        locationId: t.locationId,
        rootThingId: t.id,
        name: t.name ?? '',
      });
      return reply(201, warrantyView(state, row));
    }),
    route('PATCH', p.warranty(':id'), ({ params, body, headers }) => {
      const w = h().warranties.find((x) => x.id === params.id);
      const t = w ? thingOf(w.thingId) : undefined;
      if (!w || !t) return notFound();
      const gated = gateFor(state, t.locationId, 'warranties', 'write');
      if (gated) return gated;
      const stale = versionError(headers, w);
      if (stale) return reply(stale.status, stale.body);
      const before = { ...w };
      Object.assign(w, body as UpdateWarrantyBody);
      w.rowVersion += 1;
      recordHouseholdEvent(state, {
        action: 'warranty.update',
        entity: { type: 'warranty', id: w.id },
        locationId: t.locationId,
        rootThingId: t.id,
        name: t.name ?? '',
        undo: () => Object.assign(w, before, { rowVersion: w.rowVersion + 1 }),
      });
      return warrantyView(state, w);
    }),
    route('DELETE', p.warranty(':id'), ({ params, headers }) => {
      const w = h().warranties.find((x) => x.id === params.id);
      const t = w ? thingOf(w.thingId) : undefined;
      if (!w || !t) return notFound();
      const gated = gateFor(state, t.locationId, 'warranties', 'write');
      if (gated) return gated;
      const stale = versionError(headers, w);
      if (stale) return reply(stale.status, stale.body);
      h().warranties = h().warranties.filter((x) => x !== w);
      recordHouseholdEvent(state, {
        action: 'warranty.delete',
        entity: { type: 'warranty', id: w.id },
        locationId: t.locationId,
        rootThingId: t.id,
        name: t.name ?? '',
        undo: () => {
          h().warranties.push(w);
        },
      });
      return reply(204);
    }),

    // ----- claims -----
    route('GET', p.thingClaims(':id'), ({ params }) => {
      ensureSeeded(state);
      const t = thingOf(params.id);
      if (!t) return notFound();
      const gated = gateFor(state, t.locationId, 'warranties', 'read');
      if (gated) return gated;
      const items = h()
        .claims.filter((c) => c.thingId === t.id)
        .sort((a, b) => b.openedOn.localeCompare(a.openedOn))
        .map((c) => claimView(state, c));
      return { items };
    }),
    route('GET', p.thingClaimPrefill(':id'), ({ params }) => {
      ensureSeeded(state);
      const t = thingOf(params.id);
      if (!t) return notFound();
      const gated = gateFor(state, t.locationId, 'warranties', 'read');
      if (gated) return gated;
      const active = h()
        .warranties.filter((w) => w.thingId === t.id)
        .map((w) => warrantyView(state, w))
        .filter((w) => w.state !== 'ended')
        .sort(byCover)[0];
      const brand = t.brand ? state.inventory.brands.find((b) => b.id === t.brand?.id) : undefined;
      return {
        warrantyId: active?.id ?? null,
        claimUrl: brand?.claimUrl ?? null,
        supportPhone: brand?.supportPhone ?? null,
        claimContact: active?.claimContact ?? null,
      };
    }),
    route('POST', p.thingClaims(':id'), ({ params, body }) => {
      const t = thingOf(params.id);
      if (!t) return notFound();
      const gated = gateFor(state, t.locationId, 'warranties', 'write');
      if (gated) return gated;
      const b = body as CreateClaimBody;
      const status = b.status ?? 'open';
      if (status === 'in_repair' && repairOf(state, t.id))
        return err(409, 'thing_in_repair', 'This is already in repair.');
      const row: StoredClaim = {
        id: b.id ?? newId(),
        thingId: t.id,
        warrantyId: b.warrantyId ?? null,
        incidentId: b.incidentId ?? null,
        vendorId: vendorId(accountOf(t.locationId), b.vendor),
        openedOn: b.openedOn,
        reference: b.reference ?? null,
        status,
        cost: null,
        coveredAmount: null,
        notes: b.notes ?? null,
        closedOn: null,
        documents: [],
        rowVersion: 1,
      };
      h().claims.push(row);
      recordHouseholdEvent(state, {
        action: 'claim.create',
        entity: { type: 'claim', id: row.id },
        locationId: t.locationId,
        rootThingId: t.id,
        name: t.name ?? '',
      });
      return reply(201, claimView(state, row));
    }),
    route('PATCH', p.claim(':id'), ({ params, body, headers }) => {
      const c = h().claims.find((x) => x.id === params.id);
      const t = c ? thingOf(c.thingId) : undefined;
      if (!c || !t) return notFound();
      const gated = gateFor(state, t.locationId, 'warranties', 'write');
      if (gated) return gated;
      const stale = versionError(headers, c);
      if (stale) return reply(stale.status, stale.body);
      const b = body as UpdateClaimBody;
      if (b.status && b.status !== c.status) {
        const allowed: readonly ClaimStatus[] = CLAIM_TRANSITIONS[c.status];
        if (!allowed.includes(b.status))
          return err(409, 'invalid_transition', "A claim can't move to that status from here.");
        if (b.status === 'in_repair' && repairOf(state, t.id))
          return err(409, 'thing_in_repair', 'This is already in repair.');
      }
      const before = { ...c };
      const currency = b.currency ?? c.cost?.currency ?? c.coveredAmount?.currency ?? 'EGP';
      if (b.status !== undefined) c.status = b.status;
      if (b.reference !== undefined) c.reference = b.reference;
      if (b.vendor !== undefined) c.vendorId = vendorId(accountOf(t.locationId), b.vendor);
      if (b.cost !== undefined) c.cost = b.cost === null ? null : { amount: b.cost, currency };
      if (b.coveredAmount !== undefined)
        c.coveredAmount = b.coveredAmount === null ? null : { amount: b.coveredAmount, currency };
      if (b.notes !== undefined) c.notes = b.notes;
      if (b.closedOn !== undefined) c.closedOn = b.closedOn;
      if ((c.status === 'resolved' || c.status === 'rejected') && !c.closedOn)
        c.closedOn = todayIn(state, t.locationId);
      c.rowVersion += 1;
      recordHouseholdEvent(state, {
        action: b.status && b.status !== before.status ? 'claim.status' : 'claim.update',
        entity: { type: 'claim', id: c.id },
        locationId: t.locationId,
        rootThingId: t.id,
        name: t.name ?? '',
        undo: () => Object.assign(c, before, { rowVersion: c.rowVersion + 1 }),
      });
      return claimView(state, c);
    }),
    route('DELETE', p.claim(':id'), ({ params, headers }) => {
      const c = h().claims.find((x) => x.id === params.id);
      const t = c ? thingOf(c.thingId) : undefined;
      if (!c || !t) return notFound();
      const gated = gateFor(state, t.locationId, 'warranties', 'write');
      if (gated) return gated;
      const stale = versionError(headers, c);
      if (stale) return reply(stale.status, stale.body);
      h().claims = h().claims.filter((x) => x !== c);
      recordHouseholdEvent(state, {
        action: 'claim.delete',
        entity: { type: 'claim', id: c.id },
        locationId: t.locationId,
        rootThingId: t.id,
        name: t.name ?? '',
        undo: () => {
          h().claims.push(c);
        },
      });
      return reply(204);
    }),

    // ----- brand logos (account admins) -----
    route('PUT', p.brandLogo(':id'), ({ params }) => {
      const brand = state.inventory.brands.find((b) => b.id === params.id);
      if (!brand) return notFound();
      const admin = state.locations.some(
        (l) =>
          l.ownerAccountId === brand.ownerAccountId && (l.role === 'owner' || l.role === 'admin'),
      );
      if (!admin) return err(403, 'forbidden', "You don't have permission.");
      const url = `/f/mock-logo-${brand.id}.png`;
      h().brandLogos[brand.id] = url;
      return {
        brandId: brand.id,
        width: 256,
        height: 256,
        sha256: brand.id.replaceAll('-', '').padEnd(64, '0'),
        updatedAt: new Date().toISOString(),
      };
    }),
    route('DELETE', p.brandLogo(':id'), ({ params }) => {
      const brand = state.inventory.brands.find((b) => b.id === params.id);
      if (!brand) return notFound();
      delete h().brandLogos[brand.id];
      return reply(204);
    }),
  ];
}
