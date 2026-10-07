/**
 * A batch as print-styled sheets (plan T28; D44, D97, D185): one `<section>` per page at the
 * stock's exact size, each label absolutely placed in millimetres from the page's top-left
 * corner. The print view installs one `@page` rule for the stock, so the browser's own dialog
 * prints it at 100 % with no margin, Arabic shaped by the browser.
 *
 * The `@page` rule goes in through a constructed stylesheet: the CSP allows no inline `<style>`
 * (server http/csp-styles.ts), and a constructed sheet is the CSSOM, which CSP doesn't govern.
 * A browser without constructed sheets prints at its default size; the dialog then says so.
 */
import type { LabelStock } from '@kept/shared';
import { useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import type { LabelCellContent } from '@/api/capture/types';
import { useFormat } from '@/lib/format';
import { LabelCell } from './label-cell';
import { mm, pageCss, placeLabels } from './layout';
import type { Encode } from './qr';

/** Installs `css` for as long as the caller is mounted. */
export function usePageRule(css: string) {
  useEffect(() => {
    let sheet: CSSStyleSheet;
    try {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    } catch {
      return; // No constructed stylesheets (an old browser, or jsdom).
    }
    return () => {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
    };
  }, [css]);
}

/** CSS pixels per millimetre (96 per inch). */
const PX_PER_MM = 96 / 25.4;

/**
 * On a screen narrower than the paper, the sheets are zoomed to fit (a phone at 375 px shows a
 * whole A4 page); printing always uses zoom 1.
 */
function useFitZoom(pageWidthMm: number): number {
  const fitted = () =>
    typeof window === 'undefined'
      ? 1
      : Math.min(1, (window.innerWidth - 32) / (pageWidthMm * PX_PER_MM));
  const [zoom, setZoom] = useState(fitted);
  // biome-ignore lint/correctness/useExhaustiveDependencies: fitted reads only pageWidthMm
  useEffect(() => {
    const on = () => setZoom(fitted());
    on();
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, [pageWidthMm]);
  return zoom;
}

export function LabelSheets({
  stock,
  labels,
  startCell,
  encode,
}: {
  stock: LabelStock;
  labels: readonly LabelCellContent[];
  startCell: number;
  encode: Encode | null;
}) {
  const { t } = useLingui();
  const fmt = useFormat();
  usePageRule(pageCss(stock));
  const zoom = useFitZoom(stock.page.w);
  const pages = placeLabels(stock, labels, startCell);
  const total = fmt.num(pages.length);
  return (
    <div
      className="grid justify-center gap-4 py-4 print:block print:p-0 print:[zoom:1]!"
      style={{ zoom }}
    >
      {pages.map((page, i) => {
        const n = fmt.num(i + 1);
        return (
          <section
            // biome-ignore lint/suspicious/noArrayIndexKey: a page is its position
            key={i}
            aria-label={t`Sheet ${n} of ${total}`}
            dir="ltr"
            data-slot="sheet"
            className="relative overflow-hidden bg-white shadow-[0_8px_24px_rgba(0,0,0,.12)] not-first:break-before-page print:shadow-none"
            // A hair under the paper, so rounding never spills a sheet onto an extra page.
            style={{ inlineSize: mm(stock.page.w), blockSize: mm(stock.page.h - 0.1) }}
          >
            {page.map(({ label, cell }) => (
              <div
                key={cell.cell}
                data-cell={cell.cell + 1}
                className="absolute"
                style={{
                  insetInlineStart: mm(cell.x),
                  insetBlockStart: mm(cell.y),
                  inlineSize: mm(stock.cell.w),
                  blockSize: mm(stock.cell.h),
                }}
              >
                <LabelCell label={label} stock={stock} encode={encode} />
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}
