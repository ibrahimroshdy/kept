/**
 * Which of the map's labels show (1.x, D237): nothing on the map is cut off with … or written over
 * another label (Kept's phone rule). Each frame the engine measures every label's box and this
 * keeps them greedily by priority: a label that would touch one already kept, or a control on
 * the map (the bar, the floor buttons, the card), is hidden until zooming in makes room. Room
 * names win over contents; the selected or hovered thing's label wins over both. Pure, so it is
 * tested without a browser.
 */

export type LabelBox = {
  /** Left, top, width and height in the map's pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Higher wins. Ties keep the earlier one. */
  priority: number;
};

export type Rect = { x: number; y: number; w: number; h: number };

/** Label priorities, highest first. */
export const LABEL_PRIORITY = {
  /** The selected or hovered thing. */
  focus: 40,
  /** A floor's name in the stacked view. */
  level: 30,
  room: 20,
  contents: 10,
} as const;

/** Space kept between two labels, in pixels. */
export const LABEL_GAP = 3;

const touches = (a: Rect, b: Rect, gap: number) =>
  a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;

/**
 * Which labels show: a label inside the map, clear of every obstacle and of every label kept
 * before it in priority order.
 */
export function declutter(
  boxes: readonly LabelBox[],
  view: { w: number; h: number },
  obstacles: readonly Rect[] = [],
  gap = LABEL_GAP,
): boolean[] {
  const shown = boxes.map(() => false);
  const order = boxes
    .map((_, i) => i)
    .sort((a, b) => (boxes[b]?.priority ?? 0) - (boxes[a]?.priority ?? 0) || a - b);
  const kept: Rect[] = [];
  for (const i of order) {
    const b = boxes[i];
    if (!b || b.w <= 0 || b.h <= 0) continue;
    if (b.x < 0 || b.y < 0 || b.x + b.w > view.w || b.y + b.h > view.h) continue;
    // The selected or hovered thing's label always shows.
    const focus = b.priority >= LABEL_PRIORITY.focus;
    if (!focus && obstacles.some((o) => touches(b, o, 0))) continue;
    if (!focus && kept.some((k) => touches(b, k, gap))) continue;
    kept.push(b);
    shown[i] = true;
  }
  return shown;
}
