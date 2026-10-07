/**
 * Mock handlers for Home and hints (task 22), computed from the inventory like the server. Step 3
 * (T22): "to review" adds the open inbox items of writable locations, and `counts` carries them
 * for the Inbox badge with the never-printed labels. "A label printed" stays open here, as the
 * screens' tests expect; the server ticks it from printed codes.
 */
import { isLow } from '@kept/shared';
import type { MockState } from '../../mock/fixtures';
import { type MockRoute, notFound, reply, route, sessionGate } from '../../mock/kit';
import { paths } from '../../paths';
import { pt } from '../../portability/mock/state';
import type { LocationDetail } from '../../types';
import { inventoryPaths as p } from '../paths';
import type { HomeResponse, SearchStateFilter, UpdateHintBody } from '../types';
import { accessOf, now, type StoredThing } from './db';

const LONG_UNSEEN_MS = 365 * 86_400_000;

/**
 * The things an attention row counts (task 22), shared with search's `state` filter so a row
 * and the list it opens agree (task 29). `null` for the derived states search handles itself.
 */
export function attentionMatch(
  state: MockState,
  filter: SearchStateFilter,
): ((t: StoredThing) => boolean) | null {
  const inv = state.inventory;
  switch (filter) {
    case 'unplaced': {
      const unplaced = new Set(inv.places.filter((pl) => pl.isUnplaced).map((pl) => pl.id));
      return (t) => t.placeId !== null && unplaced.has(t.placeId);
    }
    case 'long_unseen':
      return (t) =>
        t.lifecycle === 'in_use' &&
        t.lastSeenAt !== null &&
        Date.now() - Date.parse(t.lastSeenAt) > LONG_UNSEEN_MS;
    case 'to_review':
      return (t) =>
        t.meters.some((m) => (inv.readings[m.id] ?? []).some((r) => r.state === 'needs_review'));
    default:
      return null;
  }
}

export function homeRoutes(state: MockState): MockRoute[] {
  const inv = () => state.inventory;
  /** A location with its live thing count (trash left out), as locations/views.ts answers it. */
  const counted = (l: LocationDetail): LocationDetail => ({
    ...l,
    thingCount: inv().things.filter((t) => t.locationId === l.id && !t.deletedAt).length,
  });

  return [
    // Step 1's location routes (api/mock/server.ts) answer a fixed thingCount; these override
    // them with the live count.
    route(
      'GET',
      paths.locations,
      () => sessionGate(state) ?? { locations: state.locations.map(counted) },
    ),
    route('GET', paths.location(':id'), ({ params }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      // `/locations/deleted` matches this pattern too: step 1's list of deleted locations.
      if (params.id === 'deleted') return { locations: state.deletedLocations, nextCursor: null };
      const found = state.locations.find((l) => l.id === params.id);
      return found ? counted(found) : notFound();
    }),
    route('GET', p.home, () => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const visible = accessOf(state).visibleIds();
      const things = inv().things.filter((t) => !t.deletedAt && visible.has(t.locationId));
      const isUnplaced = attentionMatch(state, 'unplaced') as (t: StoredThing) => boolean;
      const longUnseen = attentionMatch(state, 'long_unseen') as (t: StoredThing) => boolean;
      const owns = state.locations.some((l) => l.kind !== 'personal' && l.role === 'owner');
      const administers = state.locations.filter(
        (l) => l.kind !== 'personal' && (l.role === 'owner' || l.role === 'admin'),
      );
      const invitedMember = administers.length === 0;
      const essentialsOnly = state.locations.every((l) => l.preset === 'essentials');
      const hint = (key: string) => inv().hints.find((h) => h.key === key);
      const access = accessOf(state);
      // Step 3: open inbox items where you can write (a trashed draft's item is hidden).
      const inbox = state.capture.inbox.filter(
        (i) =>
          i.resolvedAt === null &&
          access.canWrite(i.locationId) &&
          !(i.thingId && inv().things.find((t) => t.id === i.thingId)?.deletedAt),
      ).length;
      const printedSet = new Set(state.capture.codes.filter((c) => c.printedAt).map((c) => c.code));
      const unprintedLabels = things.filter(
        (t) => t.shortCode && !printedSet.has(t.shortCode),
      ).length;
      const items: HomeResponse['checklist']['items'] = [
        { key: 'locationCreated', done: owns },
        { key: 'threeThings', done: things.length >= 3 },
        { key: 'labelPrinted', done: false },
        ...(invitedMember
          ? []
          : [
              {
                key: 'invited' as const,
                done: administers.some((l) => l.memberCount > 1 || l.pendingInviteCount > 0),
              },
              ...(essentialsOnly ? [] : [{ key: 'aiConnected' as const, done: false }]),
            ]),
        { key: 'installed', done: !!hint('installed_standalone')?.seenAt },
      ];
      // Step 7 (T17): things below their "keep at least", where Consumables is on.
      const stocked = new Set(
        state.locations
          .filter((l) => (l.effectiveModules ?? l.modules).includes('consumables'))
          .map((l) => l.id),
      );
      const lowStock = pt(state).stockRules.filter((r) => {
        const t = things.find((x) => x.id === r.thingId);
        return !!t && stocked.has(t.locationId) && isLow(t.quantity, r.minQuantity);
      }).length;
      const out: HomeResponse = {
        checklist: { dismissed: inv().checklistDismissed, items },
        attention: {
          toReview:
            inbox +
            Object.values(inv().readings)
              .flat()
              .filter((r) => r.state === 'needs_review').length,
          uncertain: things.filter((t) => t.locationUncertain).length,
          longUnseen: things.filter(longUnseen).length,
          unplaced: things.filter(isUnplaced).length,
          lowStock,
        },
        counts: { inbox, unprintedLabels },
        locations: state.locations.map((l) => ({
          id: l.id,
          thingCount: things.filter((t) => t.locationId === l.id).length,
          unplacedCount: things.filter((t) => t.locationId === l.id && isUnplaced(t)).length,
        })),
      };
      return out;
    }),

    route('GET', p.hints, () => sessionGate(state) ?? { hints: inv().hints }),
    route('PUT', p.hint(':key'), ({ params, body }) => {
      const b = body as UpdateHintBody;
      const key = params.key ?? '';
      let h = inv().hints.find((x) => x.key === key);
      if (!h) {
        h = { key, seenAt: null, dismissedAt: null };
        inv().hints.push(h);
      }
      if (b.seen) h.seenAt ??= now();
      if (b.dismissed !== undefined) h.dismissedAt = b.dismissed ? now() : null;
      if (key === 'checklist') inv().checklistDismissed = !!h.dismissedAt;
      return reply(204);
    }),
  ];
}
