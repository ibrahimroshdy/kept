/**
 * "Show me around" (D138): every stop in TOUR_STOPS has a title and a description, in English
 * and in Arabic, so a longer tour never points at a speechless step.
 */
import { describe, expect, it } from 'vitest';
import { renderUI } from '@/test/render';
import { useTourCopy } from './hint-copy';
import { TOUR_STOPS } from './tour';

function Probe({ onCopy }: { onCopy: (c: ReturnType<typeof useTourCopy>) => void }) {
  onCopy(useTourCopy());
  return null;
}

async function copyOf(locale: 'en' | 'ar') {
  const seen: { current: ReturnType<typeof useTourCopy> | null } = { current: null };
  await renderUI(<Probe onCopy={(c) => (seen.current = c)} />, { locale });
  if (!seen.current) throw new Error('no copy');
  return seen.current;
}

describe('the tour copy', () => {
  for (const locale of ['en', 'ar'] as const) {
    it(`covers every stop in ${locale}`, async () => {
      const copy = await copyOf(locale);
      expect(Object.keys(copy.stops).sort()).toEqual([...TOUR_STOPS].sort());
      for (const stop of TOUR_STOPS) {
        expect(copy.stops[stop].title, `${stop} title`).toBeTruthy();
        expect(copy.stops[stop].description, `${stop} description`).toBeTruthy();
      }
      expect(copy.labels.next).toBeTruthy();
      expect(copy.labels.done).toBeTruthy();
    });
  }
});
