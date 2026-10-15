/**
 * "Needs you" (screens §5 Home and §8; D185, D240): one row of count tiles, each opening the list
 * it counts, filtered in the URL (`f.<key>`).
 *
 * D240 (the approved Home design) replaced the row-per-kind panel with tiles that never move:
 *
 * - **Six fixed tiles:** overdue · due · expiring · lent out · uncertain · low stock. A zero shows
 *   muted and dashed, so a tile never jumps when its count changes. A tile whose module is off in
 *   every location (Lending, Consumables) is not shown: there is nothing it could count (§3,
 *   "not applicable means hidden").
 * - **Borrowed in and long unseen** join after the six, only while they have a count, so the six
 *   keep their places.
 * - **To review** left for Recent activity's "Photos to review" strip, and **Unplaced** for each
 *   location card ("2 things need a place"); the Inbox badge is unchanged.
 * - **On a wide Home** each tile names its most urgent item (`/home/overview`'s `top`): the
 *   earliest due, the most overdue loan, the lowest stock.
 *
 * Counts and links are step 4's (T13, T27): overdue, due and expiring come from the one agenda
 * (`/home`'s counts and `agendaBySource`), so a tile's count is what the list it opens shows:
 * overdue and due open Schedules when every item is a schedule, otherwise Expiring with that
 * state (and the sources among them); expiring opens Expiring. Lent out and borrowed in are the
 * open loans and open Lending. Uncertain and long unseen open Search's state filter; low stock
 * opens Consumables, low first.
 */
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';
import { useId } from 'react';
import { useAgenda, useLoans } from '@/api/household/queries';
import type { HomeOverview, HomeResponse, OverviewTile, OverviewTop } from '@/api/inventory/types';
import { useLocations } from '@/api/queries';
import { useModuleAnywhere } from '@/components/schedules/access';
import { useFormat } from '@/lib/format';
import { useLocationName } from '@/lib/labels';
import { cn } from '@/lib/utils';
import { HomeSection } from './section';

/** Screens §8's order. Keys without a registered row are simply not shown yet. */
export const ATTENTION_ORDER = [
  'toReview',
  'overdue',
  'due',
  'expiring',
  'lentOut',
  'borrowedIn',
  'uncertain',
  'longUnseen',
  'unplaced',
  'lowStock',
] as const;

export type AttentionKey = (typeof ATTENTION_ORDER)[number];
export type AttentionCounts = Partial<Record<AttentionKey, number>>;

/** The list a row opens, with its filters in the URL (`f.<key>`). */
export type AttentionLink = {
  to: '/search' | '/inbox' | '/schedules' | '/expiring' | '/lending' | '/consumables';
  search: Record<string, string | string[]>;
};

const searchFor = (state: string): AttentionLink => ({
  to: '/search',
  search: { 'f.state': state },
});

type AgendaCounts = { overdue: number; due: number; expiring: number };
const NONE: AgendaCounts = { overdue: 0, due: 0, expiring: 0 };

/**
 * Where an overdue or due row goes (T13's rule): Schedules when every item is a schedule;
 * Expiring with the state when every item is one of its own sources; otherwise Expiring with the
 * state and the sources among them, so the list holds exactly what the row counts (stale
 * readings, step 5, are due only).
 */
export function stateLink(
  state: 'overdue' | 'due',
  n: { all: number; schedules: number; loans: number; readings?: number },
): AttentionLink {
  if (n.all > 0 && n.schedules === n.all) return { to: '/schedules', search: { 'f.state': state } };
  const readings = n.readings ?? 0;
  const own = n.all - n.schedules - n.loans - readings;
  if (own === n.all) return { to: '/expiring', search: { 'f.state': state } };
  const sources = [
    ...(own > 0 ? ['warranty', 'document', 'thing_expiry'] : []),
    ...(n.schedules > 0 ? ['schedule'] : []),
    ...(n.loans > 0 ? ['loan'] : []),
    ...(readings > 0 ? ['reading'] : []),
  ];
  return { to: '/expiring', search: { 'f.state': state, 'f.source': sources } };
}

/** What `/home` says of step 4 (T13): the counts, and each agenda row's by source. */
export type HouseholdHome = Pick<HomeResponse, 'attention' | 'agendaBySource'>;

/**
 * Step 4's counts. `/home` carries them (the agenda's counts, split by source for the rows'
 * links, and the open loans'); when it doesn't (an older server, the mock), they're read from
 * the agenda (every source, and schedules alone) and the open loans. Errors (a module off
 * everywhere, offline) count nothing.
 */
export function useHouseholdAttention(home?: HouseholdHome): {
  counts: AttentionCounts;
  links: Pick<Record<AttentionKey, AttentionLink>, 'overdue' | 'due'>;
} {
  const h = home?.attention;
  const bySource = home?.agendaBySource;
  const fromHome = !!bySource && h?.overdue !== undefined;
  const all = useAgenda({}, !fromHome);
  const schedules = useAgenda({ sourceType: ['schedule'] }, !fromHome);
  const readings = useAgenda({ sourceType: ['reading_stale'] }, !fromHome);
  const loans = useLoans({ state: 'open' }, !fromHome);
  if (fromHome && h && bySource) {
    const of = (state: 'overdue' | 'due', source: 'schedule' | 'loan' | 'reading_stale') =>
      bySource[state][source] ?? 0;
    const overdue = h.overdue ?? 0;
    const due = h.due ?? 0;
    return {
      counts: {
        overdue,
        due,
        expiring: h.expiring ?? 0,
        lentOut: h.lentOut ?? 0,
        borrowedIn: h.borrowedIn ?? 0,
      },
      links: {
        overdue: stateLink('overdue', {
          all: overdue,
          schedules: of('overdue', 'schedule'),
          loans: of('overdue', 'loan'),
        }),
        due: stateLink('due', {
          all: due,
          schedules: of('due', 'schedule'),
          loans: of('due', 'loan'),
          readings: of('due', 'reading_stale'),
        }),
      },
    };
  }
  const a: AgendaCounts = all.data?.pages[0]?.counts ?? NONE;
  const s: AgendaCounts = schedules.data?.pages[0]?.counts ?? NONE;
  const r: AgendaCounts = readings.data?.pages[0]?.counts ?? NONE;
  const l = loans.data?.pages[0]?.counts ?? { out: 0, in: 0, overdue: 0 };
  // Loans are only ever overdue (Q7): what the agenda counts beyond schedules and its own sources.
  const loanOverdue = Math.max(0, Math.min(l.overdue, a.overdue - s.overdue));
  return {
    counts: {
      overdue: a.overdue,
      due: a.due,
      expiring: a.expiring,
      lentOut: l.out,
      borrowedIn: l.in,
    },
    links: {
      overdue: stateLink('overdue', { all: a.overdue, schedules: s.overdue, loans: loanOverdue }),
      due: stateLink('due', { all: a.due, schedules: s.due, loans: 0, readings: r.due }),
    },
  };
}

/** Step 2's counts from `/home`, under the registry's keys. */
export function attentionCounts(a: HomeResponse['attention']): AttentionCounts {
  return {
    toReview: a.toReview,
    uncertain: a.uncertain,
    longUnseen: a.longUnseen,
    unplaced: a.unplaced,
    ...(a.lowStock !== undefined ? { lowStock: a.lowStock } : {}),
  };
}

// ----- the tiles -------------------------------------------------------------------------------

type Tile = OverviewTile;

/** The six that always show (where their module is on somewhere), in §8's order. */
export const FIXED_TILES: readonly Tile[] = [
  'overdue',
  'due',
  'expiring',
  'lentOut',
  'uncertain',
  'lowStock',
];
/** Join after the six, only with a count. */
export const EXTRA_TILES: readonly Tile[] = ['borrowedIn', 'longUnseen'];

const TONE: Record<Tile, string> = {
  overdue: 'bg-danger',
  due: 'bg-amber',
  expiring: 'bg-warn',
  lentOut: 'bg-info',
  borrowedIn: 'bg-info',
  uncertain: 'bg-violet',
  longUnseen: 'bg-ink-3',
  lowStock: 'bg-warn',
};

/** Whole days from `iso` (a day) to today, in this browser's calendar. */
function daysFrom(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const now = new Date();
  return Math.round(
    (Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.UTC(y, m - 1, d)) /
      86_400_000,
  );
}

/** A tile's second line: its most urgent item, said for its kind. */
function useTopLine(): (tile: Tile, top: OverviewTop) => string {
  const { t } = useLingui();
  const f = useFormat();
  const locations = useLocations().data ?? [];
  const nameOf = useLocationName();
  return (tile, top) => {
    const name = top.name ?? '';
    const person = top.person;
    const who = person ? t`${name}, with ${person}` : name;
    switch (tile) {
      case 'overdue': {
        if (!top.dueOn) return who;
        const late = Math.max(1, daysFrom(top.dueOn));
        return `${who}${f.sep}${plural(late, { one: '# day late', other: '# days late' })}`;
      }
      case 'due':
      case 'expiring':
        return top.dueOn ? `${name}${f.sep}${f.relative(`${top.dueOn}T12:00:00`)}` : name;
      case 'lentOut':
      case 'borrowedIn':
        return top.person ? `${name}${f.sep}${top.person}` : name;
      case 'uncertain': {
        const l = locations.find((x) => x.id === top.locationId);
        return l ? `${name}${f.sep}${nameOf(l)}` : name;
      }
      case 'longUnseen': {
        if (!top.lastSeenAt) return name;
        const day = f.day(top.lastSeenAt);
        return `${name}${f.sep}${t`last seen ${day}`}`;
      }
      case 'lowStock': {
        const left = f.num(Number(top.quantity ?? 0));
        const keep = f.num(Number(top.minimum ?? 0));
        return `${name}${f.sep}${t`${left} left, keep ${keep}`}`;
      }
    }
  };
}

function useTileLabels(): Record<Tile, string> {
  const { t } = useLingui();
  return {
    overdue: t`Overdue`,
    due: t`Due`,
    expiring: t`Expiring`,
    lentOut: t`Lent out`,
    borrowedIn: t`Borrowed in`,
    uncertain: t`Uncertain`,
    longUnseen: t`Long unseen`,
    lowStock: t`Low stock`,
  };
}

const COLS: Record<number, string> = {
  4: '@min-[860px]/home:grid-cols-4',
  5: '@min-[860px]/home:grid-cols-5',
  6: '@min-[860px]/home:grid-cols-6',
  7: '@min-[860px]/home:grid-cols-7',
  8: '@min-[860px]/home:grid-cols-8',
};

function TileLink({
  tile,
  n,
  link,
  label,
  line,
}: {
  tile: Tile;
  n: number;
  link: AttentionLink;
  label: string;
  line: string | null;
}) {
  const f = useFormat();
  const id = useId();
  const zero = n === 0;
  return (
    <Link
      to={link.to}
      // Each list declares its own `f.<key>`s; the tile's are among them.
      search={link.search as never}
      aria-label={`${label} ${f.num(n)}`}
      aria-describedby={line ? id : undefined}
      data-tile={tile}
      data-zero={zero || undefined}
      className={cn(
        'grid min-h-[78px] min-w-0 content-start gap-[3px] rounded-xl border px-3 pt-2.5 pb-[11px] text-start text-ink outline-none hover:border-ink-3 focus-visible:outline-2 focus-visible:outline-info',
        '@max-[559px]/home:min-h-[68px] @max-[559px]/home:px-2.5 @max-[559px]/home:py-[9px]',
        zero ? 'border-dashed border-line bg-transparent' : 'border-line bg-surface',
      )}
    >
      <span
        className={cn(
          'font-semibold text-[26px] leading-[1.1] tabular-nums @max-[559px]/home:text-[24px]',
          zero && 'text-ink-3',
        )}
      >
        {f.num(n)}
      </span>
      <span
        data-title
        className={cn(
          'flex items-center gap-1.5 font-semibold text-[13px] leading-[1.3] [overflow-wrap:anywhere]',
          zero && 'text-ink-3',
        )}
      >
        <span
          aria-hidden="true"
          className={cn('size-2 shrink-0 rounded-full', zero ? 'bg-line' : TONE[tile])}
        />
        {label}
      </span>
      {line ? (
        <span
          id={id}
          className="text-[12px] leading-[1.4] text-ink-2 [overflow-wrap:anywhere] @max-[559px]/home:hidden"
        >
          <bdi>{line}</bdi>
        </span>
      ) : null}
    </Link>
  );
}

export function NeedsYou({
  home,
  overview,
  className,
}: {
  /** `/home`: the counts, and the agenda's split for the links. */
  home: HomeResponse;
  /** `/home/overview`: each tile's most urgent item (absent while it loads). */
  overview?: HomeOverview;
  className?: string;
}) {
  const { t } = useLingui();
  const labels = useTileLabels();
  const topLine = useTopLine();
  const lending = useModuleAnywhere('lending');
  const consumables = useModuleAnywhere('consumables');
  const household = useHouseholdAttention(home);
  const counts: AttentionCounts = { ...household.counts, ...attentionCounts(home.attention) };
  const links: Record<Tile, AttentionLink> = {
    overdue: household.links.overdue,
    due: household.links.due,
    expiring: { to: '/expiring', search: { 'f.state': 'expiring' } },
    lentOut: { to: '/lending', search: { 'f.direction': 'out', 'f.state': 'open' } },
    borrowedIn: { to: '/lending', search: { 'f.direction': 'in', 'f.state': 'open' } },
    uncertain: searchFor('uncertain'),
    longUnseen: searchFor('long_unseen'),
    lowStock: { to: '/consumables', search: { 'f.state': 'low' } },
  };
  const applies = (tile: Tile) =>
    tile === 'lentOut' || tile === 'borrowedIn'
      ? lending.on
      : tile === 'lowStock'
        ? consumables.on
        : true;
  const tiles = [
    ...FIXED_TILES.filter(applies),
    ...EXTRA_TILES.filter((k) => applies(k) && (counts[k] ?? 0) > 0),
  ];
  return (
    <HomeSection title={<Trans>Needs you</Trans>} className={className}>
      <div className={cn('grid grid-cols-3 gap-2', COLS[tiles.length])}>
        {tiles.map((tile) => {
          const n = counts[tile] ?? 0;
          const top = overview?.top[tile];
          return (
            <TileLink
              key={tile}
              tile={tile}
              n={n}
              link={links[tile]}
              label={labels[tile]}
              line={n === 0 ? t`Nothing` : top ? topLine(tile, top) : null}
            />
          );
        })}
      </div>
    </HomeSection>
  );
}
