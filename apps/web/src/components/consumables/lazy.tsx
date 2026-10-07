/**
 * The thing page's "Keep at least" (a precached screen), loaded on demand from
 * ./stock.household.tsx (its own chunk, cached by the service worker on first use). It reads the
 * server, so while it loads, and offline before its first load, it shows nothing.
 */
import { lazy, Suspense } from 'react';
import { useThingCtx } from '@/components/things/context';

const LazySection = lazy(() =>
  import('./stock.household')
    .then((m) => ({ default: m.KeepAtLeastSection }))
    .catch(() => ({ default: () => null })),
);

/** "Keep at least" on a thing's page: where Consumables is on and the thing has a type. */
export function KeepAtLeastSection() {
  const { thing, moduleOn } = useThingCtx();
  if (!thing.type || !moduleOn('consumables')) return null;
  return (
    <Suspense fallback={null}>
      <LazySection />
    </Suspense>
  );
}
