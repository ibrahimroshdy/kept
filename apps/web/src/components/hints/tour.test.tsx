/**
 * "Show me around" (D138): every stop in TOUR_STOPS has a title and a description, in English
 * and in Arabic, so a longer tour never points at a speechless step. The full guided tour
 * (GUIDED_SECTIONS) carries its own instruction copy per section, covered the same way.
 */
import { describe, expect, it } from 'vitest';
import { renderUI } from '@/test/render';
import { useGuidedTourCopy, useTourCopy } from './hint-copy';
import { GUIDED_SECTIONS, TOUR_STOPS } from './tour';

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

function GuidedProbe({ onCopy }: { onCopy: (c: ReturnType<typeof useGuidedTourCopy>) => void }) {
  onCopy(useGuidedTourCopy());
  return null;
}

async function guidedCopyOf(locale: 'en' | 'ar') {
  const seen: { current: ReturnType<typeof useGuidedTourCopy> | null } = { current: null };
  await renderUI(<GuidedProbe onCopy={(c) => (seen.current = c)} />, { locale });
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

describe('the guided tour copy', () => {
  it('covers every guided section in en and ar', async () => {
    for (const locale of ['en', 'ar'] as const) {
      const copy = await guidedCopyOf(locale);
      for (const s of GUIDED_SECTIONS) {
        const entry = copy[s.id];
        expect(entry?.title, `${s.id} title`).toBeTruthy();
        expect(entry?.description, `${s.id} description`).toBeTruthy();
      }
    }
  });
});
