/**
 * The attention panel, "Needs you" (screens §5 Home, §8, D185): one row per kind with a count,
 * in a fixed order, zero rows hidden, each opening its filtered list in Search.
 *
 * Rows come from an ordered registry. `ATTENTION_ORDER` is §8's whole order, later steps'
 * rows included; step 2 registers four of them (task 22's counts). A later step adds its row to
 * `useAttentionRows()` and its count to `/home`, and the order takes care of itself:
 *
 *   to review · overdue · due · expiring · lent out · borrowed in · uncertain · long unseen ·
 *   Unplaced · low stock
 *
 * Step 3 (T22): "To review" counts the inbox's open items too (`counts.inbox`, everyone's). While
 * any wait, the row reads "N items need a look" and opens the inbox on Everyone's; otherwise it
 * is the readings to review, in Search.
 *
 * Step 4 (plan T13, T27): overdue, due and expiring come from the one agenda (`GET /agenda`'s
 * counts), so a row's count is what the list it opens shows: overdue and due open Schedules when
 * every item is a schedule, otherwise Expiring with that state (and the sources among them);
 * expiring opens Expiring. Lent out and borrowed in are the open loans (`GET /loans`' counts) and
 * open Lending. A module that's off everywhere counts nothing, so its rows stay hidden.
 *
 * Step 7 (plan T17, T23): "Low stock", last, is `/home`'s `attention.lowStock`: things below
 * their "keep at least" where Consumables is on. It opens Consumables, low first.
 */
import { Plural, Trans } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useAgenda, useLoans } from '@/api/household/queries';
import type { HomeResponse } from '@/api/inventory/types';
import {
  AlertIcon,
  BoxIcon,
  ChevronEndIcon,
  ClockIcon,
  EyeOffIcon,
  HandoffIcon,
  InboxIcon,
  QuestionIcon,
  ScheduleIcon,
} from '@/components/icons';
import { IconTile, Section } from '@/components/page';
import { useFormat } from '@/lib/format';
import { cn } from '@/lib/utils';

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

type AttentionRow = {
  key: AttentionKey;
  icon: ReactNode;
  title: ReactNode;
  /** One line under the title, from the count. */
  detail: (n: number) => ReactNode;
  link: AttentionLink;
};

const searchFor = (state: string): AttentionLink => ({
  to: '/search',
  search: { 'f.state': state },
});

/** The registered rows (any order: they're sorted by `ATTENTION_ORDER`). `inbox`: the open
 * inbox items "To review" includes; `links`: where step 4's overdue and due rows go. */
function useAttentionRows(
  inbox: number,
  links: Pick<Record<AttentionKey, AttentionLink>, 'overdue' | 'due'>,
): AttentionRow[] {
  return [
    {
      key: 'overdue',
      icon: <AlertIcon />,
      title: <Trans>Overdue</Trans>,
      detail: (n) => <Plural value={n} one="# is past its date" other="# are past their date" />,
      link: links.overdue,
    },
    {
      key: 'due',
      icon: <ScheduleIcon />,
      title: <Trans>Due</Trans>,
      detail: (n) => <Plural value={n} one="# is due soon" other="# are due soon" />,
      link: links.due,
    },
    {
      key: 'expiring',
      icon: <ClockIcon />,
      title: <Trans>Expiring</Trans>,
      detail: (n) => <Plural value={n} one="# runs out soon" other="# run out soon" />,
      link: { to: '/expiring', search: { 'f.state': 'expiring' } },
    },
    {
      key: 'lentOut',
      icon: <HandoffIcon />,
      title: <Trans>Lent out</Trans>,
      detail: (n) => (
        <Plural value={n} one="# thing is with someone" other="# things are with someone" />
      ),
      link: { to: '/lending', search: { 'f.direction': 'out', 'f.state': 'open' } },
    },
    {
      key: 'borrowedIn',
      icon: <HandoffIcon />,
      title: <Trans>Borrowed in</Trans>,
      detail: (n) => <Plural value={n} one="# thing to give back" other="# things to give back" />,
      link: { to: '/lending', search: { 'f.direction': 'in', 'f.state': 'open' } },
    },
    inbox > 0
      ? {
          key: 'toReview',
          icon: <InboxIcon />,
          title: <Trans>To review</Trans>,
          detail: (n) => <Plural value={n} one="# item needs a look" other="# items need a look" />,
          link: { to: '/inbox', search: { 'f.mine': 'everyone' } },
        }
      : {
          key: 'toReview',
          icon: <InboxIcon />,
          title: <Trans>To review</Trans>,
          detail: (n) => (
            <Plural value={n} one="# reading needs a look" other="# readings need a look" />
          ),
          link: searchFor('to_review'),
        },
    {
      key: 'uncertain',
      icon: <QuestionIcon />,
      title: <Trans>Uncertain</Trans>,
      detail: (n) => (
        <Plural
          value={n}
          one="# thing isn't where it should be"
          other="# things aren't where they should be"
        />
      ),
      link: searchFor('uncertain'),
    },
    {
      key: 'longUnseen',
      icon: <EyeOffIcon />,
      title: <Trans>Long unseen</Trans>,
      detail: (n) => (
        <Plural
          value={n}
          one="# thing not seen for a long time"
          other="# things not seen for a long time"
        />
      ),
      link: searchFor('long_unseen'),
    },
    {
      key: 'unplaced',
      icon: <BoxIcon />,
      title: <Trans>Unplaced</Trans>,
      detail: (n) => (
        <Plural value={n} one="# thing waiting for a place" other="# things waiting for a place" />
      ),
      link: searchFor('unplaced'),
    },
    {
      key: 'lowStock',
      icon: <BoxIcon />,
      title: <Trans>Low stock</Trans>,
      detail: (n) => <Plural value={n} one="# running low" other="# running low" />,
      link: { to: '/consumables', search: { 'f.state': 'low' } },
    },
  ];
}

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

export function AttentionPanel({
  counts,
  inbox = 0,
  home,
  className,
}: {
  counts: AttentionCounts;
  /** `counts.inbox` from `/home`: the open inbox items "To review" includes. */
  inbox?: number;
  /** `/home` itself, for step 4's counts. */
  home?: HouseholdHome;
  className?: string;
}) {
  const f = useFormat();
  const household = useHouseholdAttention(home);
  const all: AttentionCounts = { ...household.counts, ...counts };
  const rows = useAttentionRows(inbox, household.links)
    .filter((r) => (all[r.key] ?? 0) > 0)
    .sort((a, b) => ATTENTION_ORDER.indexOf(a.key) - ATTENTION_ORDER.indexOf(b.key));
  if (rows.length === 0) return null;
  return (
    // Tiles side by side from xl, and only while the section itself is wide enough for them
    // (a container query): beside the assistant's panel the page is narrower than the window.
    <Section title={<Trans>Needs you</Trans>} className={cn('@container', className)}>
      <ul
        className={cn(
          'm-0 grid list-none overflow-hidden rounded-[10px] border border-line bg-surface p-0 [&>li+li]:border-t [&>li+li]:border-line',
          'xl:@md:grid-cols-2 xl:@md:gap-2.5 xl:@md:overflow-visible xl:@md:rounded-none xl:@md:border-0 xl:@md:bg-transparent',
        )}
      >
        {rows.map((r) => {
          const n = all[r.key] ?? 0;
          return (
            <li
              key={r.key}
              className="xl:@md:rounded-[10px] xl:@md:border xl:@md:border-line xl:@md:bg-surface"
            >
              <Link
                to={r.link.to}
                // Each list declares its own `f.<key>`s; the row's are among them.
                search={r.link.search as never}
                className="flex min-h-16 items-center gap-3 px-3.5 py-3 text-ink outline-none hover:bg-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-info xl:@md:rounded-[10px]"
              >
                <IconTile>{r.icon}</IconTile>
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span data-title className="font-semibold text-[15px] leading-snug">
                    {r.title}
                  </span>
                  <span className="text-small text-ink-2">{r.detail(n)}</span>
                </span>
                <span className="font-semibold text-[20px] tabular-nums leading-none">
                  {f.num(n)}
                </span>
                <ChevronEndIcon className="size-5 shrink-0 text-ink-3" />
              </Link>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
