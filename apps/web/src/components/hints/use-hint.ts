/**
 * One-time hints at first use (D138; plan T31; spike V18): a pulsing beacon on one element, and
 * one sentence when it's opened.
 *
 *   const strip = useRef<HTMLDivElement>(null);
 *   useHint('capture.mode_strip', strip, { when: cameraOpen });
 *
 * - **Once per person, on the server:** `GET /me/hints` is read when the app starts
 *   (hints-provider.tsx) and shared through the query cache, so a hint doesn't repeat on each
 *   phone. The hook itself only reads the cache (hints and locations): it never fetches. Showing it records `seen`, "Got it" records `dismissed` (`PUT /me/hints/:key`), and the
 *   cache is updated first, so a second render never shows it again.
 * - **Never blocking:** a beacon, not an overlay; the popover takes focus only when opened (or,
 *   with `autoOpen`, right after a dialog closed); "Got it" puts focus back on the element.
 * - **Only for modules that are on** in at least one of your locations (D113).
 * - **One at a time,** and none while "Show me around" runs.
 * - Nothing shows until the hints are known: offline at start, or a failed read, means no hints.
 * - driver.js loads on the first hint that is due (driver-kit.ts), not with the app.
 */
import type { ModuleId } from '@kept/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type RefObject, useCallback, useEffect, useSyncExternalStore } from 'react';
import { api } from '@/api/client';
import { inventoryPaths as p } from '@/api/inventory/paths';
import { inventoryKeys } from '@/api/inventory/queries';
import type { Hint, HintsResponse, UpdateHintBody } from '@/api/inventory/types';
import { listLocations } from '@/api/locations';
import { keys } from '@/api/queries';
import type { Shown } from './driver-kit';
import { type FirstUseHint, useHintCopy } from './hint-copy';
import { type LogicalAlign, type LogicalSide, pageIsRtl, prefersReducedMotion } from './placement';

/** The module a hint belongs to; `null` for the core. Off in every location ⇒ no hint (D113). */
export const HINT_MODULE: Readonly<Record<FirstUseHint, ModuleId | null>> = {
  'capture.mode_strip': null,
  'inbox.suggested': 'ai_capture',
  'labels.first_print': 'labels',
  'scan.first_open': 'labels',
};

// ----- the hints the server remembers ----------------------------------------------------------

/**
 * `GET /me/hints`, once per session: the app shell reads it at start (hints-provider.tsx). With
 * `enabled: false` it only watches the cache, so a screen that shows a hint never makes a request
 * of its own (the scanner, offline, makes none).
 */
export function useHints(enabled = true) {
  return useQuery({
    queryKey: inventoryKeys.hints,
    queryFn: () => api.get<HintsResponse>(p.hints),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    enabled,
  });
}

/** Your locations as already loaded (by the app shell), without asking for them. */
const useLoadedLocations = () =>
  useQuery({ queryKey: keys.locations, queryFn: listLocations, enabled: false });

/** Records a hint on the server, updating the cache first so nothing shows twice. */
export function useMarkHint() {
  const qc = useQueryClient();
  return useCallback(
    async (key: string, body: UpdateHintBody) => {
      const now = new Date().toISOString();
      qc.setQueryData<HintsResponse>(inventoryKeys.hints, (old) => {
        const hints = old?.hints ?? [];
        const had = hints.find((h) => h.key === key);
        const next: Hint = {
          key,
          seenAt: body.seen ? (had?.seenAt ?? now) : (had?.seenAt ?? null),
          dismissedAt:
            body.dismissed === undefined ? (had?.dismissedAt ?? null) : body.dismissed ? now : null,
        };
        return { hints: [...hints.filter((h) => h.key !== key), next] };
      });
      try {
        await api.put<void>(p.hint(key), body);
      } catch {
        // Offline or refused: this session remembers it; the next one may show it again.
      }
    },
    [qc],
  );
}

/** Whether a hint has been shown or dismissed before. */
export const hintDone = (hints: Hint[] | undefined, key: string): boolean => {
  const h = hints?.find((x) => x.key === key);
  return !!(h?.seenAt || h?.dismissedAt);
};

// ----- one at a time ---------------------------------------------------------------------------

/** What holds the screen: a hint's key, `'tour'`, or nothing. */
let holder: string | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

export const hintSlot = {
  get: () => holder,
  subscribe: (l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  /** Take the slot for `who`; false when someone else has it. */
  claim: (who: string): boolean => {
    if (holder !== null && holder !== who) return false;
    if (holder !== who) {
      holder = who;
      emit();
    }
    return true;
  },
  /** Take the slot whoever has it ("Show me around" puts any open hint away). */
  take: (who: string) => {
    if (holder === who) return;
    holder = who;
    emit();
  },
  release: (who: string) => {
    if (holder !== who) return;
    holder = null;
    emit();
  },
};

// ----- the hook --------------------------------------------------------------------------------

export type UseHintOptions = {
  /** Whether the moment has come (the camera is open, the item has suggestions). Default true. */
  when?: boolean;
  /** Where the popover sits against the beacon, logically (default: below, at the end). */
  side?: LogicalSide;
  align?: LogicalAlign;
  /** Open the popover at once, moving focus to "Got it": only right after a dialog closed. */
  autoOpen?: boolean;
};

/** Shows `key`'s hint on `targetRef`'s element, once per person (see the header). */
export function useHint(
  key: FirstUseHint,
  targetRef: RefObject<Element | null>,
  { when = true, side, align, autoOpen = false }: UseHintOptions = {},
): void {
  const copy = useHintCopy();
  const hints = useHints(false);
  const locations = useLoadedLocations();
  const mark = useMarkHint();
  const holderNow = useSyncExternalStore(hintSlot.subscribe, hintSlot.get, hintSlot.get);
  const module = HINT_MODULE[key];
  const moduleOn = module === null || !!locations.data?.some((l) => l.modules.includes(module));
  const due = when && hints.isSuccess && moduleOn && !hintDone(hints.data?.hints, key);
  // Once this hint holds the slot it stays up (its own `seen` has flipped `due`) until "Got it",
  // or the element leaves the screen.
  const mine = holderNow === key;
  const start = (due && holderNow === null) || mine;
  const { title, description } = copy[key];
  const gotIt = copy.gotIt;

  useEffect(() => {
    if (!start) return;
    const element = targetRef.current;
    if (!element || !hintSlot.claim(key)) return;
    let shown: Shown | null = null;
    let live = true;
    import('./driver-kit')
      .then((kit) => {
        if (!live) return;
        shown = kit.showHint({
          id: key,
          element,
          title,
          description,
          buttonText: gotIt,
          rtl: pageIsRtl(),
          reducedMotion: prefersReducedMotion(),
          autoOpen,
          ...(side ? { side } : {}),
          ...(align ? { align } : {}),
          onDismiss: () => {
            void mark(key, { dismissed: true });
            shown = null;
            hintSlot.release(key);
          },
        });
        void mark(key, { seen: true });
      })
      .catch(() => hintSlot.release(key));
    return () => {
      live = false;
      shown?.destroy();
      hintSlot.release(key);
    };
  }, [start, key, targetRef, title, description, gotIt, autoOpen, side, align, mark]);
}
