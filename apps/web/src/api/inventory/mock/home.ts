/**
 * Mock handlers for Home and hints (task 22), computed from the inventory like the server. Step 3
 * (T22): "to review" adds the open inbox items of writable locations, and `counts` carries them
 * for the Inbox badge with the never-printed labels. "A label printed" stays open here, as the
 * screens' tests expect; the server ticks it from printed codes.
 */
import { isLow } from '@kept/shared';
import {
  agendaItems,
  ensureSeeded,
  hh,
  moduleOn,
  personRef,
  showsMoney,
} from '../../household/mock/db';
import { insightsOf } from '../../insights/mock';
import type { MockState } from '../../mock/fixtures';
import { type MockRoute, notFound, reply, route, sessionGate } from '../../mock/kit';
import { paths } from '../../paths';
import { pt } from '../../portability/mock/state';
import type { LocationDetail } from '../../types';
import { inventoryPaths as p } from '../paths';
import type {
  HomeOverview,
  HomeResponse,
  OverviewTop,
  SearchStateFilter,
  UpdateHintBody,
} from '../types';
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

    // D240: Home's own read, from the same mock rows as the lists each tile opens.
    route('GET', p.homeOverview, () => sessionGate(state) ?? overviewOf(state)),

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

/**
 * GET /home/overview (D240), as apps/server/src/home/overview.ts computes it: the cards' places,
 * flags and value, the tiles' first items, and the teaser from the mock's Insights, so the two
 * agree.
 */
export function overviewOf(state: MockState): HomeOverview {
  // Step 4's people and things (Murdock and the loans' things), as every household route has.
  ensureSeeded(state);
  const inv = state.inventory;
  const visible = accessOf(state).visibleIds();
  const locations = state.locations.filter((l) => visible.has(l.id));
  const things = inv.things.filter((t) => !t.deletedAt && visible.has(t.locationId));
  const agenda = agendaItems(state).filter(
    (a) => a.sourceType !== 'stock' && ['overdue', 'due', 'expiring'].includes(a.state),
  );
  const loans = hh(state).loans.filter(
    (o) =>
      !o.returnedAt &&
      visible.has(o.locationId) &&
      moduleOn(state, o.locationId, 'lending') &&
      things.some((t) => t.id === o.thingId),
  );
  const nameOf = (id: string) => things.find((t) => t.id === id)?.name ?? null;
  const low = pt(state).stockRules.flatMap((r) => {
    const t = things.find((x) => x.id === r.thingId);
    return t && moduleOn(state, t.locationId, 'consumables') && isLow(t.quantity, r.minQuantity)
      ? [{ t, min: r.minQuantity }]
      : [];
  });
  const insights = insightsOf(state, []);
  const locationValue = (id: string) => insights.value.locations.find((v) => v.locationId === id);

  const top: HomeOverview['top'] = {};
  for (const state_ of ['overdue', 'due', 'expiring'] as const) {
    const first = agenda
      .filter((a) => a.state === state_)
      .sort((a, b) => (a.dueOn ?? '9999').localeCompare(b.dueOn ?? '9999'))[0];
    if (first) {
      const loan = first.sourceType === 'loan' ? loans.find((o) => o.id === first.sourceId) : null;
      top[state_] = {
        name: first.title || first.subject.name || null,
        locationId: first.locationId,
        dueOn: first.dueOn,
        person: loan ? personRef(state, loan.personId).name : null,
      };
    }
  }
  for (const direction of ['out', 'in'] as const) {
    const first = loans
      .filter((o) => o.direction === direction)
      .sort((a, b) => (a.dueOn ?? '9999').localeCompare(b.dueOn ?? '9999'))[0];
    if (first) {
      top[direction === 'out' ? 'lentOut' : 'borrowedIn'] = {
        name: nameOf(first.thingId),
        locationId: first.locationId,
        dueOn: first.dueOn,
        person: personRef(state, first.personId).name,
      };
    }
  }
  const uncertain = things.find((t) => t.locationUncertain);
  if (uncertain) top.uncertain = { name: uncertain.name, locationId: uncertain.locationId };
  const unseen = things
    .filter(attentionMatch(state, 'long_unseen') as (t: StoredThing) => boolean)
    .sort((a, b) => (a.lastSeenAt ?? '').localeCompare(b.lastSeenAt ?? ''))[0];
  if (unseen?.lastSeenAt)
    top.longUnseen = {
      name: unseen.name,
      locationId: unseen.locationId,
      lastSeenAt: unseen.lastSeenAt,
    };
  const lowest = low.sort((a, b) => a.t.quantity / a.min - b.t.quantity / b.min)[0];
  if (lowest) {
    const tile: OverviewTop = {
      name: lowest.t.name,
      locationId: lowest.t.locationId,
      quantity: String(lowest.t.quantity),
      minimum: String(lowest.min),
    };
    top.lowStock = tile;
  }

  const shown = locations.filter((l) => l.modules.includes('money') && showsMoney(state, l.id));
  const years = insights.spending.years.slice(-4).map((y) => ({
    year: y.year,
    soFar: y.soFar,
    byCurrency: y.byCurrency,
  }));
  const total = new Map<string, number>();
  let valued = 0;
  let counted = 0;
  for (const l of shown) {
    const v = locationValue(l.id);
    valued += v?.valued ?? 0;
    counted += v?.things ?? 0;
    for (const a of v?.byCurrency ?? [])
      total.set(a.currency, (total.get(a.currency) ?? 0) + Number(a.amount));
  }
  const anything = total.size > 0 || years.some((y) => y.byCurrency.length > 0);

  return {
    locations: locations.map((l) => {
      const money = l.modules.includes('money');
      const v = money && showsMoney(state, l.id) ? locationValue(l.id) : undefined;
      const here = (a: { locationId: string }) => a.locationId === l.id;
      return {
        id: l.id,
        places: inv.places.filter((pl) => pl.locationId === l.id && !pl.isUnplaced && !pl.deletedAt)
          .length,
        flags: {
          overdue: agenda.filter((a) => here(a) && a.state === 'overdue').length,
          due: agenda.filter((a) => here(a) && a.state === 'due').length,
          expiring: agenda.filter((a) => here(a) && a.state === 'expiring').length,
          lentOut: loans.filter((o) => here(o) && o.direction === 'out').length,
          uncertain: things.filter((t) => here(t) && t.locationUncertain).length,
          lowStock: low.filter((x) => here(x.t)).length,
        },
        ...(money && showsMoney(state, l.id)
          ? {
              value: {
                things: v?.things ?? 0,
                valued: v?.valued ?? 0,
                byCurrency: v?.byCurrency ?? [],
              },
            }
          : {}),
        ...(money && !showsMoney(state, l.id) ? { moneyHidden: true as const } : {}),
      };
    }),
    top,
    insights:
      shown.length > 0 && anything
        ? {
            thisYear: insights.thisYear,
            years,
            value: {
              things: counted,
              valued,
              byCurrency: [...total]
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([currency, n]) => ({ currency, amount: String(n) })),
            },
            included: shown.map((l) => l.id),
            hiddenIn: locations
              .filter((l) => l.modules.includes('money') && !showsMoney(state, l.id))
              .map((l) => l.id),
            moneyOff: locations.filter((l) => !l.modules.includes('money')).map((l) => l.id),
          }
        : null,
  };
}
