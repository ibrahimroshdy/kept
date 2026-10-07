/**
 * The name, code and whereabouts of what a scan found, for its answer ("Shelf A · Garage › Shelf
 * A · 11 things"): from the phone's snapshot first, so it works offline, else from the server.
 */
import type { SnapPlace } from '@kept/shared';
import { inventoryApi } from '@/api/inventory/queries';
import type { PathStep } from '@/api/inventory/types';
import { placePath } from '@/components/capture/target';
import type { OfflineStore } from '@/offline/store';
import type { ScanTarget } from './resolve';

export type Described = {
  kind: 'thing' | 'place';
  id: string;
  locationId: string;
  name: string | null;
  shortCode: string | null;
  isContainer: boolean;
  /** Where it is, root first; a step's name is null for the location's Unplaced area. */
  path: { name: string | null }[];
  /** A decimal (D183) for things; 1 for places. */
  quantity: number;
};

const step = (s: PathStep) => ({ name: s.isUnplaced ? null : s.name });
const snapStep = (p: SnapPlace) => ({ name: p.isUnplaced ? null : p.name });

export async function describeTarget(
  target: ScanTarget,
  { store, online }: { store: OfflineStore | null; online: boolean },
): Promise<Described | null> {
  if (store) {
    if (target.kind === 'thing') {
      const t = await store.thing(target.id);
      if (t) {
        const places = await store.placesOf(t.locationId);
        const box = t.containerId ? await store.thing(t.containerId) : undefined;
        const path = box
          ? [...placePath(places, box.placeId).map(snapStep), { name: box.name }]
          : placePath(places, t.placeId).map(snapStep);
        return {
          kind: 'thing',
          id: t.id,
          locationId: t.locationId,
          name: t.name,
          shortCode: t.shortCode,
          isContainer: t.isContainer,
          path,
          quantity: Number(t.quantity) || 1,
        };
      }
    } else {
      const places = await store.placesOf(target.locationId);
      const p = places.find((x) => x.id === target.id);
      if (p)
        return {
          kind: 'place',
          id: p.id,
          locationId: p.locationId,
          name: p.isUnplaced ? null : p.name,
          shortCode: null,
          isContainer: true,
          path: placePath(places, p.parentId).map(snapStep),
          quantity: 1,
        };
    }
  }
  if (!online) return null;
  try {
    if (target.kind === 'thing') {
      const t = await inventoryApi.thing(target.id);
      return {
        kind: 'thing',
        id: t.id,
        locationId: t.locationId,
        name: t.name,
        shortCode: t.shortCode,
        isContainer: t.isContainer,
        path: t.path.map(step),
        quantity: t.quantity,
      };
    }
    const p = await inventoryApi.place(target.id);
    return {
      kind: 'place',
      id: p.id,
      locationId: p.locationId,
      name: p.isUnplaced ? null : p.name,
      shortCode: p.shortCode,
      isContainer: true,
      path: p.path.filter((s) => s.id !== p.id).map(step),
      quantity: 1,
    };
  } catch {
    return null;
  }
}
