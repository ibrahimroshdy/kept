/**
 * The vehicle charts, loaded on demand (plan T18; D133): visx and the charts come with the tab
 * that draws them, never in the entry or the precache (vite.config.ts names ./bars.tsx and
 * ./series.tsx into assets/household/). While one loads, a grey block its height; offline before
 * its first load, nothing: the chart's "Show as table" (./chart-table.tsx) still has the numbers.
 */
import { type ComponentType, lazy, Suspense } from 'react';
import { Skeleton } from '@/components/page';
import type { BarsProps } from './bars';
import type { SeriesProps } from './series';

const nothing = () => null;
const LazyBars = lazy<ComponentType<BarsProps>>(() =>
  import('./bars').catch(() => ({ default: nothing })),
);
const LazySeries = lazy<ComponentType<SeriesProps>>(() =>
  import('./series').catch(() => ({ default: nothing })),
);

export function BarsChart(props: BarsProps) {
  return (
    <Suspense fallback={<Skeleton className="h-[220px]" />}>
      <LazyBars {...props} />
    </Suspense>
  );
}

export function SeriesChart(props: SeriesProps) {
  return (
    <Suspense fallback={<Skeleton className="h-[200px]" />}>
      <LazySeries {...props} />
    </Suspense>
  );
}

export type { BarDatum, BarSeries, BarsProps } from './bars';
export type { SeriesPoint, SeriesProps, SeriesThreshold } from './series';
