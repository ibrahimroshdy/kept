/**
 * A location's layout, remembered (1.x, D237, M11): List, Grid or Map is the address's `view`
 * (D223), and Kept remembers the last one per person and location on this device, so a location
 * someone keeps as a map opens as one. List stays the default. Small and precached: the map
 * itself loads on demand (./lazy.tsx).
 */
import { useLingui } from '@lingui/react/macro';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { useMe } from '@/api/queries';
import { MapIcon } from '@/components/icons';
import { Segmented } from '@/components/ui/segmented';
import { SHEET, useMediaQuery } from '@/lib/media';

/** 1.x (D250): `table`, the spreadsheet view, on a screen 1024 px wide or more. */
export type LocationLayout = 'list' | 'grid' | 'map' | 'table';

const LAYOUTS: readonly string[] = ['grid', 'map', 'table'];
const layoutOf = (v: unknown): LocationLayout =>
  typeof v === 'string' && LAYOUTS.includes(v) ? (v as LocationLayout) : 'list';

const keyOf = (userId: string, locationId: string) => `kept.loc.view.${userId}.${locationId}`;
/** Set once a map has been opened on this device; the Map option stops shining. */
const SEEN = 'kept.map.seen';
function seen(): boolean {
  try {
    return localStorage.getItem(SEEN) === '1';
  } catch {
    return true;
  }
}
function markSeen(): void {
  try {
    localStorage.setItem(SEEN, '1');
  } catch {
    // A shine that comes back is harmless.
  }
}

function read(key: string): LocationLayout | null {
  try {
    const v = localStorage.getItem(key);
    return v && LAYOUTS.includes(v) ? (v as LocationLayout) : null;
  } catch {
    return null;
  }
}

function write(key: string, v: LocationLayout): void {
  try {
    if (v === 'list') localStorage.removeItem(key);
    else localStorage.setItem(key, v);
  } catch {
    // Remembering is a convenience: the address still says the layout.
  }
}

/** The layout in the address, after restoring the remembered one on arrival. */
export function useRememberedLayout(locationId: string): LocationLayout {
  const search = useSearch({ strict: false }) as { view?: unknown };
  const navigate = useNavigate();
  const me = useMe();
  const userId = me.data?.user.id;
  const view = layoutOf(search.view);
  const explicit = search.view !== undefined;
  // Only on arrival does a missing `view` mean "as last time"; afterwards it means List (the
  // Display menu clears `view` for its default).
  const arrived = useRef(false);
  useEffect(() => {
    if (!userId) return;
    const key = keyOf(userId, locationId);
    const first = !arrived.current;
    arrived.current = true;
    if (explicit || !first) {
      write(key, view);
      return;
    }
    const stored = read(key);
    if (stored)
      void navigate({
        to: '.',
        search: (prev: Record<string, unknown>) => ({ ...prev, view: stored }),
        replace: true,
      });
  }, [userId, locationId, view, explicit, navigate]);
  return view;
}

/** List · Grid · Map (· Table on a wide screen) above the map, where the list's Display menu
 * isn't. */
export function LayoutSwitch() {
  const { t } = useLingui();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { view?: unknown };
  const wide = useMediaQuery(SHEET);
  const asked = layoutOf(search.view);
  const value: LocationLayout = asked === 'table' && !wide ? 'list' : asked;
  const shine = value !== 'map' && !seen();
  useEffect(() => {
    if (value === 'map') markSeen();
  }, [value]);
  return (
    <Segmented<LocationLayout>
      aria-label={t`Layout`}
      // The guided tour points here (components/hints/tour.ts, D242).
      data-tour="location-layout"
      className={wide ? 'w-full max-w-sm' : 'w-full max-w-xs'}
      value={value}
      onChange={(v) =>
        void navigate({
          to: '.',
          search: (prev: Record<string, unknown>) => ({ ...prev, view: v === 'list' ? 'list' : v }),
        })
      }
      options={[
        { id: 'list', label: t`List` },
        { id: 'grid', label: t`Grid` },
        {
          id: 'map',
          label: (
            <span
              className={`inline-flex items-center gap-1.5 rounded-md px-1 ${shine ? 'kept-shine' : ''}`}
            >
              <MapIcon className="size-4 shrink-0" />
              {t`Map`}
            </span>
          ),
        },
        ...(wide ? [{ id: 'table' as const, label: t`Table` }] : []),
      ]}
    />
  );
}
