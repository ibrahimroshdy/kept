/**
 * The spreadsheet view, loaded on demand (1.x, D250): the grid, its editors and bulk actions are
 * their own chunk (vite.config.ts ON_DEMAND_ENTRIES), out of the precache, fetched the first time
 * someone opens a Table; it reads and writes the server only. While it loads, a skeleton; when it
 * can't load (offline before it was ever fetched), "Needs a connection".
 */
import { useLingui } from '@lingui/react/macro';
import { lazy, Suspense } from 'react';
import type { LocationDetail } from '@/api/types';
import { LoadingRows, Notice } from '@/components/page';

function Unavailable() {
  const { t } = useLingui();
  return <Notice title={t`Needs a connection`} />;
}

const Lazy = lazy(() => import('./sheet-view').catch(() => ({ default: Unavailable })));

export function SheetLazy(props: { location: LocationDetail }) {
  return (
    <Suspense fallback={<LoadingRows rows={6} />}>
      <Lazy {...props} />
    </Suspense>
  );
}
