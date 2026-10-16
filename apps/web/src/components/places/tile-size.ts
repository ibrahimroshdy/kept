/**
 * A grid's tile size, remembered (1.x, #139): Small · Medium · Large is the address's `size`, and
 * Kept remembers the last one per person on this device, the way a location's layout is
 * remembered (map/remembered.tsx), so someone who likes small tiles gets them on every location
 * and place. Medium stays the default and is never stored.
 *
 * Only when a grid first shows does a missing `size` mean "as last time"; afterwards it means
 * Medium (the Display menu clears `size` for its default), so Back undoes a size like any other
 * list choice.
 */
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { useMe } from '@/api/queries';
import type { TileSize } from '@/components/list-surface';

const SIZES: readonly string[] = ['small', 'medium', 'large'];
export const tileSizeOf = (v: unknown): TileSize =>
  typeof v === 'string' && SIZES.includes(v) ? (v as TileSize) : 'medium';

export const tileSizeKey = (userId: string) => `kept.grid.size.${userId}`;

function read(key: string): TileSize | null {
  try {
    const v = localStorage.getItem(key);
    return v && v !== 'medium' && SIZES.includes(v) ? (v as TileSize) : null;
  } catch {
    return null;
  }
}

function write(key: string, v: TileSize): void {
  try {
    if (v === 'medium') localStorage.removeItem(key);
    else localStorage.setItem(key, v);
  } catch {
    // Remembering is a convenience: the address still says the size.
  }
}

/** The tile size in the address, after restoring the remembered one when a grid first shows. */
export function useTileSize(grid: boolean): TileSize {
  const search = useSearch({ strict: false }) as { size?: unknown };
  const navigate = useNavigate();
  const userId = useMe().data?.user.id;
  const size = tileSizeOf(search.size);
  const explicit = search.size !== undefined;
  const shown = useRef(false);
  useEffect(() => {
    if (!grid || !userId) return;
    const key = tileSizeKey(userId);
    const first = !shown.current;
    shown.current = true;
    if (explicit || !first) {
      write(key, size);
      return;
    }
    const stored = read(key);
    if (stored)
      void navigate({
        to: '.',
        search: (prev: Record<string, unknown>) => ({ ...prev, size: stored }),
        replace: true,
      });
  }, [grid, userId, size, explicit, navigate]);
  return size;
}
