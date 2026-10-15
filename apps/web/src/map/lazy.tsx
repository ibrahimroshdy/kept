/**
 * The location map, loaded on demand (1.x, D237): three.js, the engine and the models are in
 * their own chunk (vite.config.ts), out of the precache, fetched the first time someone opens a
 * map. While it loads, a skeleton; when it can't load (offline before it was ever fetched),
 * "Needs a connection" (M10: the map needs one).
 */
import { useLingui } from '@lingui/react/macro';
import { lazy, Suspense } from 'react';
import { LoadingRows, Notice } from '@/components/page';

function Unavailable() {
  const { t } = useLingui();
  return <Notice title={t`Needs a connection`} />;
}

const Lazy = lazy(() => import('./map-view').catch(() => ({ default: Unavailable })));

export function LocationMapLazy(props: { locationId: string; name: string }) {
  return (
    <Suspense fallback={<LoadingRows rows={3} />}>
      <Lazy {...props} />
    </Suspense>
  );
}
