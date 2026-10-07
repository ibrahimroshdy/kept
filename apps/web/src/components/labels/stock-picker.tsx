/**
 * Choosing the label stock (D44; screens §6 "Choose stock"): the rolls a label printer takes and
 * the office sheets, as radio cards. Sizes follow the digit setting (D143); the names are the
 * app's own words, never a maker's logo (D172). The last stock used is remembered on this
 * browser, since a household has one printer.
 */
import { isSheet, LABEL_STOCKS, type LabelStock } from '@kept/shared';
import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { ChoiceCards } from '@/components/ui/segmented';
import { useFormat } from '@/lib/format';

const STOCK_KEY = 'kept.labels.stock';
export const DEFAULT_STOCK = 'a4_24_70x37';

export function rememberedStock(): string {
  try {
    const key = localStorage.getItem(STOCK_KEY);
    if (key && LABEL_STOCKS.some((s) => s.key === key)) return key;
  } catch {
    // Storage blocked: the default.
  }
  return DEFAULT_STOCK;
}

export function rememberStock(key: string) {
  try {
    localStorage.setItem(STOCK_KEY, key);
  } catch {
    // Nothing to keep it in.
  }
}

/** A stock's name and one line about it, in the person's language and digits. */
export function useStockText() {
  const { t } = useLingui();
  const fmt = useFormat();
  const size = (w: number, h: number) => {
    const a = fmt.num(Math.round(w));
    const b = fmt.num(Math.round(h));
    return t`${a} × ${b} mm`;
  };
  return (stock: LabelStock): { title: string; detail: string } => {
    const cell = size(stock.cell.w, stock.cell.h);
    if (!isSheet(stock))
      return { title: t`${cell} roll`, detail: t`Label printer · one label per thing` };
    const n = stock.cols * stock.rows;
    const count = plural(n, { one: '# label', other: '# labels' });
    const paper = stock.key.startsWith('letter') ? 'Letter' : 'A4';
    const cols = fmt.num(stock.cols);
    const rows = fmt.num(stock.rows);
    return {
      title: t`${paper} sheet · ${count}`,
      detail:
        stock.content === 'compact'
          ? t`${cols} × ${rows}, each ${cell} · QR and code only`
          : t`${cols} × ${rows}, each ${cell} · any office printer`,
    };
  };
}

export function StockPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (key: string) => void;
}) {
  const { t } = useLingui();
  const text = useStockText();
  return (
    <ChoiceCards
      label={t`Label stock`}
      value={value}
      onChange={(key) => {
        rememberStock(key);
        onChange(key);
      }}
      options={LABEL_STOCKS.map((s) => {
        const { title, detail } = text(s);
        return { id: s.key, title, body: detail };
      })}
    />
  );
}
