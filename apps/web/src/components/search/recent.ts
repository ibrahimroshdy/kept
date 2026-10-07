/**
 * Recent searches (screens §5 Search): the last few queries, kept on this device only, per user
 * id, so a shared browser never shows one person's searches to another. Two queries that
 * normalise the same (`الكابل` and `الكابل ` or `HDMI` and `hdmi`) are one entry, the newest
 * spelling kept. Storage can be missing or full (private windows): then nothing is remembered.
 */
import { normalize } from '@kept/shared';
import { useCallback, useState } from 'react';

const MAX = 8;
export const recentKey = (userId: string) => `kept.search.recent.${userId}`;

export function readRecent(userId: string): string[] {
  try {
    const raw = localStorage.getItem(recentKey(userId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string').slice(0, MAX) : [];
  } catch {
    return [];
  }
}

function write(userId: string, list: string[]): void {
  try {
    if (list.length) localStorage.setItem(recentKey(userId), JSON.stringify(list));
    else localStorage.removeItem(recentKey(userId));
  } catch {
    // No storage: recent searches last for this page only.
  }
}

/** `q` first, without an earlier entry that normalises the same; at most 8. */
export function withRecent(list: string[], q: string): string[] {
  const text = q.trim();
  if (!text) return list;
  const key = normalize(text);
  return [text, ...list.filter((x) => normalize(x) !== key)].slice(0, MAX);
}

export function useRecentSearches(userId: string | undefined) {
  const [list, setList] = useState<string[]>(() => (userId ? readRecent(userId) : []));
  const remember = useCallback(
    (q: string) => {
      if (!userId) return;
      setList(() => {
        const next = withRecent(readRecent(userId), q);
        write(userId, next);
        return next;
      });
    },
    [userId],
  );
  const clear = useCallback(() => {
    if (!userId) return;
    write(userId, []);
    setList([]);
  }, [userId]);
  return { recent: list, remember, clear };
}
