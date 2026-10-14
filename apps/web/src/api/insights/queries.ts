/**
 * Insights' fetcher, key and hook (1.x, D234) over ./types.ts and ./paths.ts. The location chip
 * (D174) is the `f.location` filter, as on the lists.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../client';
import { qs } from '../inventory/paths';
import { insightsPaths as p } from './paths';
import type { Insights, InsightsParams } from './types';

export const insightsKeys = {
  all: ['insights'] as const,
  of: (params: InsightsParams) => ['insights', params.location ?? []] as const,
};

export const insightsApi = {
  insights: (params: InsightsParams) =>
    api.get<Insights>(`${p.insights}${qs({ 'f.location': params.location })}`),
};

export function useInsights(params: InsightsParams) {
  return useQuery({
    queryKey: insightsKeys.of(params),
    queryFn: () => insightsApi.insights(params),
    placeholderData: keepPreviousData,
  });
}
