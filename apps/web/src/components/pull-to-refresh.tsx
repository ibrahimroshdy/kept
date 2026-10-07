/**
 * Pull to refresh on phones (D212). An installed iPhone app has no browser pull-to-refresh, so
 * Kept draws its own on the scrolling screens (Home, Search, Inbox, a location, a place's
 * contents, a thing, Activity; step 4's Schedules, Lending, a person's page, Paperwork, Expiring,
 * Notifications and Incidents): pull down at the top and let go, and it runs a sync (send the
 * queue, pull the snapshot) and refetches what the screen shows, with a small spinner and
 * "Updated", or the sync line's own word when it didn't: "Offline", or "Couldn't sync" (the sync
 * line says the rest).
 *
 * **It must never cost a tap** (a lesson from another of the maintainer's apps: an 8 px threshold with `preventDefault` on
 * `touchmove` cancelled the click, so the tab bar needed two taps):
 * - it arms only for one finger that starts inside the page (`main`), with the page scrolled to
 *   the top, never on the header, the tab bar, a field or anything modal, and not while a sheet
 *   or dialog is open, nor while a popover (a menu, a select's or a combobox's list) is;
 * - it claims the gesture only after 16 px of mostly vertical movement down, and calls
 *   `preventDefault` only from then on, so a tap's wobble is left alone and still clicks;
 * - a mostly sideways move, or one up, lets go of it for good; once claimed, letting go below the
 *   16 px refreshes, and pushing back above it first calls it off;
 * - with reduced motion, the indicator stands still and doesn't spin;
 * - while it can pull, the page's own overscroll is off (`html[data-pull]`), so the browser's
 *   bounce doesn't race it;
 * - off with a fine hovering pointer (a desktop), where there is nothing to pull.
 */
import { Trans } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { RetryIcon } from '@/components/icons';
import { FINE_POINTER } from '@/lib/key-hints';
import { useMediaQuery } from '@/lib/media';
import { cn } from '@/lib/utils';
import { useOffline } from '@/offline/provider';
import type { SyncProblem } from '@/offline/sync-engine';

/**
 * Movement before the gesture is claimed (and the first `preventDefault`). A claimed pull still
 * this far down when the finger lifts refreshes: at the top of the page a pull has no other
 * meaning, and a refresh costs nothing.
 */
export const ARM_PX = 16;
/** The indicator stops following the finger here. */
const MAX_PULL = 96;

/** The screens that pull (D212). */
const PULLS = [
  /^\/$/,
  /^\/search\/?$/,
  /^\/inbox\/?$/,
  /^\/loc\/[^/]+\/?$/,
  /^\/p\/[^/]+\/?$/,
  /^\/t\/[^/]+\/?$/,
  /^\/activity\/?$/,
  // Step 4 (D212, plan T27): the schedules and lending lists, and a person's page with its loans;
  // Paperwork, Expiring, the notification centre and incidents. A thing's new sections pull with
  // its page.
  /^\/schedules\/?$/,
  /^\/lending\/?$/,
  /^\/people\/[^/]+\/?$/,
  /^\/paperwork\/?$/,
  /^\/expiring\/?$/,
  /^\/notifications\/?$/,
  /^\/incidents\/?$/,
  /^\/incidents\/[^/]+\/?$/,
  // Step 5 (D212, plan T3): the vehicles list. A vehicle's tabs pull with its thing page.
  /^\/vehicles\/?$/,
];
export const pullsOn = (pathname: string) => PULLS.some((r) => r.test(pathname));

/** Where a touch never arms. */
const NEVER =
  'header, [data-tab-bar], [role="dialog"], [role="alertdialog"], [aria-modal="true"], input, textarea, select, [contenteditable=""], [contenteditable="true"], [data-no-pull]';

/**
 * A sheet, dialog, menu or popover is open over the page. React Aria marks every open popover
 * with `data-trigger`, including the non-modal ones (a select's or a combobox's list) that have no
 * dialog role.
 */
export function modalOpen(doc: Document = document): boolean {
  return !!doc.querySelector(
    '[role="dialog"], [role="alertdialog"], [role="menu"], [data-trigger]',
  );
}

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

type Said = 'updated' | 'offline' | 'failed';

/**
 * What the pill says once the refresh is done: "Updated" only when the sync went through,
 * otherwise the sync line's own word, "Offline" or "Couldn't sync" (never "Updated" over a
 * refused or failed sync; the sync line says why).
 */
export function saidAfter(problem: SyncProblem | null, online: boolean): Said {
  if (!online || problem === 'offline') return 'offline';
  return problem ? 'failed' : 'updated';
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'pulling'; distance: number }
  | { kind: 'refreshing' }
  | { kind: 'done'; said: Said };

function fine(): boolean {
  try {
    return window.matchMedia(FINE_POINTER).matches;
  } catch {
    return false;
  }
}

/** The indicator and the gesture on `main`. Mounted once, in the signed-in shell. */
export function PullToRefresh({ target }: { target: RefObject<HTMLElement | null> }) {
  const qc = useQueryClient();
  const offline = useOffline();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const on = pullsOn(pathname);
  const still = useMediaQuery('(prefers-reduced-motion: reduce)');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const busy = useRef(false);
  const latest = useRef({ offline, on });
  latest.current = { offline, on };

  useEffect(() => {
    const el = target.current;
    if (!el || !on || fine()) return;
    const root = document.documentElement;
    root.setAttribute('data-pull', '');
    const refresh = async () => {
      if (busy.current) return;
      busy.current = true;
      setPhase({ kind: 'refreshing' });
      const engine = latest.current.offline?.engine;
      try {
        await Promise.all([
          engine?.run(),
          qc.refetchQueries({ type: 'active' }).catch(() => undefined),
        ]);
      } finally {
        const online = typeof navigator === 'undefined' || navigator.onLine !== false;
        setPhase({ kind: 'done', said: saidAfter(engine?.getStatus().problem ?? null, online) });
        busy.current = false;
        setTimeout(() => setPhase((p) => (p.kind === 'done' ? { kind: 'idle' } : p)), 1400);
      }
    };
    const detach = attachPull(el, {
      canArm: () => latest.current.on && !busy.current && !modalOpen(),
      scrollTop: () => document.scrollingElement?.scrollTop ?? window.scrollY,
      onPull: (distance) => setPhase({ kind: 'pulling', distance }),
      onRelease: (go) => {
        if (go) void refresh();
        else setPhase({ kind: 'idle' });
      },
    });
    return () => {
      detach();
      root.removeAttribute('data-pull');
    };
  }, [target, on, qc]);

  if (phase.kind === 'idle') return null;
  // With reduced motion the indicator appears in place: no following the finger, no spin.
  const pulled = still ? 0 : phase.kind === 'pulling' ? phase.distance : MAX_PULL / 2;
  return (
    <div
      data-pull-indicator=""
      aria-hidden={phase.kind === 'pulling' ? 'true' : undefined}
      className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+3.5rem)] z-30 flex justify-center md:hidden"
      style={pulled ? { transform: `translateY(${Math.round(pulled / 2)}px)` } : undefined}
    >
      {phase.kind === 'done' ? (
        <output className="rounded-full border border-line bg-surface px-3 py-1 text-small text-ink-2 shadow-[0_4px_14px_rgba(0,0,0,.12)]">
          {phase.said === 'offline' ? (
            <Trans>Offline</Trans>
          ) : phase.said === 'failed' ? (
            <Trans>Couldn't sync</Trans>
          ) : (
            <Trans>Updated</Trans>
          )}
        </output>
      ) : (
        <span
          role={phase.kind === 'refreshing' ? 'status' : undefined}
          className="grid size-9 place-items-center rounded-full border border-line bg-surface text-ink shadow-[0_4px_14px_rgba(0,0,0,.12)] [&_svg]:size-[18px]"
        >
          <RetryIcon
            aria-hidden="true"
            className={cn(phase.kind === 'refreshing' && !still && 'motion-safe:animate-spin')}
            style={
              phase.kind === 'pulling' && !still
                ? { transform: `rotate(${Math.round((phase.distance / MAX_PULL) * 300)}deg)` }
                : undefined
            }
          />
          {phase.kind === 'refreshing' ? (
            <span className="sr-only">
              <Trans>Refreshing…</Trans>
            </span>
          ) : null}
        </span>
      )}
    </div>
  );
}
