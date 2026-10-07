/**
 * The start cell on a partly used sheet (D175; screens §6), which is also the layout preview:
 * the sheet's grid in its own proportions, the cells before the start hatched as used, the start
 * outlined, and the codes in the cells they will print into. Every cell is a radio, so a tap or
 * the arrow keys choose where printing starts.
 *
 * The grid is the paper, so it runs left to right in every language, like the maker's numbering
 * ("row 4, column 1"); only the words around it follow the page.
 */
import { type LabelStock, printedCode } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { Radio, RadioGroup } from 'react-aria-components';
import type { LabelCellContent } from '@/api/capture/types';
import { QrIcon } from '@/components/icons';
import { useFormat } from '@/lib/format';
import { cn } from '@/lib/utils';
import { pagesFor, perPage, rowColOf } from './layout';

export function StartCellPicker({
  stock,
  value,
  onChange,
  labels,
  count,
}: {
  stock: LabelStock;
  value: number;
  onChange: (cell: number) => void;
  /** The labels to print, for their codes; blanks have none until the batch is made. */
  labels: readonly LabelCellContent[];
  /** How many labels print (a blank sheet has no `labels` yet). */
  count: number;
}) {
  const { t } = useLingui();
  const fmt = useFormat();
  const cells = perPage(stock);
  const used = value - 1;
  const { row, col } = rowColOf(stock, value);
  const pages = pagesFor(stock, count, value);
  const start = fmt.num(value);
  const r = fmt.num(row);
  const c = fmt.num(col);
  const n = fmt.num(pages);
  const usedN = fmt.num(used);
  return (
    <RadioGroup
      value={String(value)}
      onChange={(v) => onChange(Number(v))}
      aria-label={t`Start at label`}
      className="grid gap-2"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="eyebrow">
          <Trans>Sheet preview</Trans>
        </span>
        {used > 0 ? (
          <span className="text-small text-ink-3">
            <Trans>{usedN} already used</Trans>
          </span>
        ) : null}
      </div>
      <p className="m-0 text-small text-ink">
        <Trans>
          Start at label {start} (row {r}, column {c}). Tap any cell to start there.
        </Trans>
      </p>
      <div
        dir="ltr"
        className="grid w-full max-w-[380px] gap-[3px] justify-self-center border border-line bg-white shadow-[0_8px_24px_rgba(0,0,0,.1)]"
        style={{
          aspectRatio: `${stock.page.w} / ${stock.page.h}`,
          gridTemplateColumns: `repeat(${stock.cols}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${stock.rows}, minmax(0, 1fr))`,
          paddingBlock: `${(stock.margin.top / stock.page.h) * 100}%`,
          paddingInline: `${(stock.margin.left / stock.page.w) * 100}%`,
        }}
      >
        {Array.from({ length: cells }, (_, i) => {
          const cell = i + 1;
          const index = cell - value;
          const printing = index >= 0 && index < count;
          const label = printing ? labels[index] : undefined;
          const { row: rr, col: cc } = rowColOf(stock, cell);
          const at = fmt.num(cell);
          const rn = fmt.num(rr);
          const cn2 = fmt.num(cc);
          return (
            <Radio
              key={cell}
              value={String(cell)}
              aria-label={t`Label ${at}, row ${rn}, column ${cn2}`}
              className={cn(
                'grid min-w-0 cursor-pointer place-items-center overflow-hidden rounded-[2px] border border-dashed border-[#CFCBC2] text-[#111] outline-none data-focus-visible:outline-2 data-focus-visible:outline-info',
                cell < value &&
                  'border-solid border-[#E2DFD7] bg-[repeating-linear-gradient(135deg,#EEECE6_0_5px,#F8F7F3_5px_10px)]',
                cell === value && 'border-solid outline-2 outline-offset-1 outline-[#1C1B19]',
              )}
            >
              {label ? (
                <bdi
                  dir="ltr"
                  className="font-mono text-[9px] font-semibold leading-none sm:text-[10.5px]"
                >
                  {printedCode(label.code)}
                </bdi>
              ) : printing ? (
                <QrIcon className="size-3.5 text-[#555]" />
              ) : null}
            </Radio>
          );
        })}
      </div>
      {pages > 1 ? (
        <p className="m-0 text-small text-ink-2">
          <Trans>These labels take {n} sheets; the next ones start at label 1.</Trans>
        </p>
      ) : null}
    </RadioGroup>
  );
}
