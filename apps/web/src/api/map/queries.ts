/**
 * The location map's fetchers, key and hook (1.x, D237) over ./types.ts and ./paths.ts.
 */
import { useQuery } from '@tanstack/react-query';
import { api, written } from '../client';
import { mapPaths as p } from './paths';
import type { LayoutBody, MapView } from './types';

export const mapKeys = {
  map: (locationId: string) => ['map', locationId] as const,
};

export const mapApi = {
  map: (locationId: string) => api.get<MapView>(p.map(locationId)),
  saveLayout: (locationId: string, body: LayoutBody) =>
    written.put<{ version: string | null }>(p.layout(locationId), body),
};

export function useLocationMap(locationId: string) {
  return useQuery({
    queryKey: mapKeys.map(locationId),
    queryFn: () => mapApi.map(locationId),
  });
}
