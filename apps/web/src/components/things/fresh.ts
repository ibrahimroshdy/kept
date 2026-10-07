/**
 * Things created in this tab whose ID chip hasn't been shown yet: the thing page prints the chip
 * like tape on its first view (D195), once. In memory only; a reload shows it plainly.
 */
import { useEffect, useState } from 'react';

const fresh = new Set<string>();

export function markFresh(id: string): void {
  fresh.add(id);
}

/** True on the first view of a freshly created thing; later views (and reloads) get false. */
export function useFresh(id: string): boolean {
  const [isFresh] = useState(() => fresh.has(id));
  useEffect(() => {
    fresh.delete(id);
  }, [id]);
  return isFresh;
}
