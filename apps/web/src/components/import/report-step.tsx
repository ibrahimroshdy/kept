/**
 * The dry run's report (plan T30 step 6; §5 "mapped, as text, skipped, why"): what the import
 * would make, then every row with its status and reasons, in the reader's language (labels.ts).
 * Then Adjust mapping, or Import.
 *
 * The rows are a list-standard list (D205): the filter strip's search (a row number, a column, a
 * reason) and Status and Column filters, in the URL. A report can hold 10,000 rows, so it is
 * shown 100 at a time with "Load more"; filtering runs over the report in memory. It is in file
 * order and not sortable, so it has no Display button (D211).
 */
import type { ImportIssue } from '@kept/shared';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useInfiniteQuery } from '@tanstack/react-query';
import { type ReactNode, useMemo } from 'react';
import type { DryRunReport, ImportRowStatus } from '@/api/capture/types';
import { nextCursor } from '@/api/inventory/queries';
import type { Page } from '@/api/inventory/types';
import type { FilterDef } from '@/components/filters/types';
import { ListSurface } from '@/components/list-surface';
import { Pill, type PillTone } from '@/components/page';
import { useFormat } from '@/lib/format';
import { isNot, useListState } from '@/lib/url-state';
import { useIssueText, useStatusLabel } from './labels';

/** Rows per page of the report. */
export const REPORT_PAGE = 100;

type ReportRow = DryRunReport['rows'][number];

const TONE: Record<ImportRowStatus, PillTone> = { ok: 'ok', text: 'warn', skipped: 'danger' };
const STATUSES: ImportRowStatus[] = ['ok', 'text', 'skipped'];

const EASTERN = /[٠-٩۰-۹]/g;
const foldDigits = (s: string) =>
  s.replace(EASTERN, (d) => {
    const c = d.charCodeAt(0);
    return String(c >= 0x06f0 ? c - 0x06f0 : c - 0x0660);
  });

export function ReportSummary({ summary }: { summary: DryRunReport['summary'] }) {
  const f = useFormat();
  const tiles: { value: number; label: ReactNode }[] = [
    {
      value: summary.things,
      label: <Plural value={summary.things} one="thing to add" other="things to add" />,
    },
    {
      value: summary.places,
      label: <Plural value={summary.places} one="place to make" other="places to make" />,
    },
    {
      value: summary.purchases,
      label: (
        <Plural value={summary.purchases} one="purchase to record" other="purchases to record" />
      ),
    },
    {
      value: summary.legacyCodes,
      label: <Plural value={summary.legacyCodes} one="own code" other="own codes" />,
    },
    {
      value: summary.asText,
      label: (
        <Plural
          value={summary.asText}
          one="row with cells kept as text"
          other="rows with cells kept as text"
        />
      ),
    },
    {
      value: summary.skipped,
      label: <Plural value={summary.skipped} one="row skipped" other="rows skipped" />,
    },
  ];
  return (
    <dl className="m-0 grid grid-cols-2 gap-2 sm:grid-cols-3">
      {tiles.map((tile, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed set of tiles
          key={i}
          className="grid gap-0.5 rounded-[10px] border border-line bg-surface px-3.5 py-3"
        >
          <dd className="m-0 font-semibold text-[22px] leading-tight">{f.num(tile.value)}</dd>
          <dt className="text-small text-ink-2">{tile.label}</dt>
        </div>
      ))}
    </dl>
  );
}

export function ReportList({
  report,
  reportKey,
  nameOf,
}: {
  report: DryRunReport;
  /** Changes when the report does (the run and its version). */
  reportKey: string;
  /** The row's name cell, when the file is still in memory. */
  nameOf?: (row: number) => string | undefined;
}) {
  const { t } = useLingui();
  const f = useFormat();
  const [list] = useListState();
  const issueText = useIssueText();
  const statusLabel = useStatusLabel();

  const columns = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of report.rows) {
      for (const c of new Set(r.issues.map((i) => i.column).filter(Boolean))) {
        counts.set(c, (counts.get(c) ?? 0) + 1);
      }
    }
    return counts;
  }, [report]);

  const statusCounts = useMemo(() => {
    const counts: Record<ImportRowStatus, number> = { ok: 0, text: 0, skipped: 0 };
    for (const r of report.rows) counts[r.status] += 1;
    return counts;
  }, [report]);

  const filters: FilterDef[] = [
    {
      key: 'status',
      label: t`Status`,
      kind: 'multi',
      hideZero: true,
      values: {
        from: 'static',
        options: STATUSES.map((s) => ({
          value: s,
          label: statusLabel(s),
          count: statusCounts[s],
        })),
      },
    },
    ...(columns.size > 0
      ? [
          {
            key: 'column',
            label: t`Column`,
            kind: 'multi' as const,
            values: {
              from: 'static' as const,
              options: [...columns].map(([c, count]) => ({ value: c, label: c, count })),
            },
          },
        ]
      : []),
  ];

  const statuses = list.filters.status ?? [];
  const cols = list.filters.column ?? [];
  const notStatus = isNot(list, 'status');
  const notCols = isNot(list, 'column');
  const q = foldDigits(list.q.trim()).toLocaleLowerCase();

  const query = useInfiniteQuery({
    queryKey: ['import-report', reportKey, q, statuses, notStatus, cols, notCols],
    queryFn: ({ pageParam }): Page<ReportRow> => {
      const matches = (r: ReportRow) => {
        if (statuses.length && statuses.includes(r.status) === notStatus) return false;
        if (cols.length) {
          const hit = r.issues.some((i) => cols.includes(i.column));
          if (hit === notCols) return false;
        }
        if (!q) return true;
        if (/^\d+$/.test(q)) return String(r.row) === q;
        const text = [nameOf?.(r.row) ?? '', ...r.issues.flatMap((i) => [i.column, issueText(i)])]
          .join('\n')
          .toLocaleLowerCase();
        return text.includes(q);
      };
      const all = report.rows.filter(matches);
      const start = Number(pageParam ?? 0);
      const end = start + REPORT_PAGE;
      return {
        items: all.slice(start, end),
        next_cursor: end < all.length ? String(end) : null,
      };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
    staleTime: Number.POSITIVE_INFINITY,
  });

  return (
    <ListSurface<ReportRow>
      label={t`Rows`}
      search={{ label: t`Search rows`, placeholder: t`Row number, column or reason` }}
      filters={filters}
      query={query}
      getKey={(r) => String(r.row)}
      empty={
        <p className="m-0 text-ink-2">
          <Trans>The file has no rows.</Trans>
        </p>
      }
      renderRow={(r) => {
        const rowNo = f.num(r.row);
        const name = nameOf?.(r.row);
        return (
          <div className="grid gap-1 px-3.5 py-2.5">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <span className="font-semibold">
                <Trans>Row {rowNo}</Trans>
              </span>
              {name ? (
                <span className="min-w-0 text-ink-2 [overflow-wrap:anywhere]">
                  <bdi>{name}</bdi>
                </span>
              ) : null}
              <Pill tone={TONE[r.status]}>{statusLabel(r.status)}</Pill>
            </div>
            {r.issues.length > 0 ? (
              <ul className="m-0 grid list-none gap-0.5 p-0 text-small text-ink-2">
                {r.issues.map((issue: ImportIssue, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a row's reasons never move
                  <li key={i} className="[overflow-wrap:anywhere]">
                    {issue.column ? (
                      <>
                        <bdi className="font-medium text-ink">{issue.column}</bdi>
                        {': '}
                      </>
                    ) : null}
                    {issueText(issue)}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        );
      }}
    />
  );
}
