// SPIKE (step 5, T0, V38). attachPull() copied verbatim from apps/web/src/components/pull-to-refresh.tsx
// at a010a9a (D212), minus the React component, so the drag test runs the app's real gesture rule
// against a visx chart. Only the NEVER selector's imports are gone; the logic is unchanged.
export const ARM_PX = 16;
/** The indicator stops following the finger here. */
const MAX_PULL = 96;
/** Where a touch never arms. */
const NEVER =
  'header, [data-tab-bar], [role="dialog"], [role="alertdialog"], [aria-modal="true"], input, textarea, select, [contenteditable=""], [contenteditable="true"], [data-no-pull]';

export type PullOptions = {
  /** Whether a touch may arm now (the screen pulls, no dialog is open, a touch screen). */
  canArm: () => boolean;
  /** The page's scroll position: it arms only at 0. */
  scrollTop: () => number;
  onPull: (distance: number) => void;
  /** Let go: `refresh` when it was pulled far enough. */
  onRelease: (refresh: boolean) => void;
};

type Touchish = Event & { touches?: ArrayLike<{ clientX: number; clientY: number }> };

/**
 * Listens on `el` (the page's `main`). Returns the function that stops listening. Exported for
 * the tests, which drive it with synthetic touches.
 */
export function attachPull(el: HTMLElement, o: PullOptions): () => void {
  let start: { x: number; y: number } | null = null;
  let claimed = false;
  let distance = 0;
  let dyNow = 0;
  const reset = () => {
    start = null;
    claimed = false;
    distance = 0;
    dyNow = 0;
  };
  const point = (e: Touchish) => {
    const t = e.touches?.[0];
    return t ? { x: t.clientX, y: t.clientY } : null;
  };
  const onStart = (e: Touchish) => {
    reset();
    if ((e.touches?.length ?? 0) !== 1 || !o.canArm() || o.scrollTop() > 0) return;
    const target = e.target instanceof Element ? e.target : null;
    if (!target || target.closest(NEVER)) return;
    start = point(e);
  };
  const onMove = (e: Touchish) => {
    if (!start) return;
    const p = point(e);
    if (!p) return;
    const dx = p.x - start.x;
    const dy = p.y - start.y;
    if (!claimed) {
      // Up, or mostly sideways: a scroll or a swipe, never a pull. Let it go for good.
      if (dy < -4 || (Math.abs(dx) > 8 && Math.abs(dx) >= Math.abs(dy))) {
        reset();
        return;
      }
      // A tap's wobble: nothing claimed, nothing prevented, the click still comes.
      if (dy < ARM_PX || dy < Math.abs(dx) * 2 || o.scrollTop() > 0) return;
      claimed = true;
    }
    if (e.cancelable) e.preventDefault();
    dyNow = dy;
    distance = Math.min(MAX_PULL, Math.max(0, (dy - ARM_PX) * 0.6));
    o.onPull(distance);
  };
  const onEnd = () => {
    if (claimed) o.onRelease(dyNow >= ARM_PX);
    reset();
  };
  const onCancel = () => {
    if (claimed) o.onRelease(false);
    reset();
  };
  el.addEventListener('touchstart', onStart, { passive: true });
  // Not passive: once claimed, the move is the pull's, not the page's.
  el.addEventListener('touchmove', onMove, { passive: false });
  el.addEventListener('touchend', onEnd, { passive: true });
  el.addEventListener('touchcancel', onCancel, { passive: true });
  return () => {
    el.removeEventListener('touchstart', onStart);
    el.removeEventListener('touchmove', onMove);
    el.removeEventListener('touchend', onEnd);
    el.removeEventListener('touchcancel', onCancel);
  };
}

