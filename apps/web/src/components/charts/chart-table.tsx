/**
 * "Show as table" under a chart (plan T18; D133): the same numbers as the marks' tooltips, as a
 * plain table a screen reader and a phone can read. A disclosure, closed by default.
 */
import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import { AiDisclosure } from '@/components/ai/disclosure';

export type TableColumn = { key: string; label: ReactNode; numeric?: boolean };
export type TableRow = { key: string; cells: Record<string, ReactNode> };

export function ChartTable({
  columns,
  rows,
  caption,
}: {
  columns: TableColumn[];
  rows: TableRow[];
  caption: string;
}) {
  return (
    <AiDisclosure quiet title={<Trans>Show as table</Trans>}>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-small" data-chart-table="">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className="border-b border-line px-2 py-1.5 text-start font-semibold text-ink-2"
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} data-row={r.key}>
                {columns.map((c, i) =>
                  i === 0 ? (
                    <th
                      key={c.key}
                      scope="row"
                      className="border-b border-line px-2 py-1.5 text-start font-normal text-ink"
                    >
                      {r.cells[c.key]}
                    </th>
                  ) : (
                    <td
                      key={c.key}
                      data-key={c.key}
                      className={
                        c.numeric
                          ? 'border-b border-line px-2 py-1.5 text-end text-ink tabular-nums'
                          : 'border-b border-line px-2 py-1.5 text-start text-ink'
                      }
                    >
                      {r.cells[c.key]}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AiDisclosure>
  );
}
