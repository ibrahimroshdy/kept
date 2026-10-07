/**
 * Where something goes, for the scan flows (a new box from a blank label, a product added from its
 * barcode, the carrying tray offline): the places of the locations you can add to, from the phone's
 * snapshot so it works offline. With nothing on the phone yet (first open, or a browser without
 * IndexedDB) it is step 2's server-backed place picker instead.
 */
import { can, type SnapLocation, type SnapPlace } from '@kept/shared';
import { useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { Label, Radio, RadioGroup } from 'react-aria-components';
import type { LocationKind } from '@/api/types';
import { flattenPlaces, lastPlaceIn } from '@/components/capture/target';
import { usePlaceName } from '@/components/places/labels';
import { type PickedPlace, PlacePicker } from '@/components/places/move-picker';
import { useLocationName } from '@/lib/labels';
import type { OfflineStore } from '@/offline/store';

type World = { locations: SnapLocation[]; places: Record<string, SnapPlace[]> };

/** The writable locations and their places on the phone, restricted to `locationIds`. */
export function usePhoneWorld(store: OfflineStore | null, locationIds?: readonly string[]) {
  const [world, setWorld] = useState<World | null>(null);
  const key = locationIds?.join(',') ?? '';
  useEffect(() => {
    if (!store) return;
    let live = true;
    void (async () => {
      const only = key ? new Set(key.split(',')) : null;
      const locations = (await store.locations()).filter(
        (l) => can(l.role, 'things.edit') && (!only || only.has(l.id)),
      );
      const places: Record<string, SnapPlace[]> = {};
      for (const l of locations)
        places[l.id] = (await store.placesOf(l.id)).filter((p) => !p.deleted);
      if (live) setWorld({ locations, places });
    })();
    return () => {
      live = false;
    };
  }, [store, key]);
  return world;
}

/** The last place used in the first location, else its Unplaced area (capture's default, D153). */
export function defaultPlace(world: World | null): PickedPlace | null {
  const loc = world?.locations[0];
  if (!loc) return null;
  const places = world.places[loc.id] ?? [];
  const last = lastPlaceIn(loc.id);
  const p =
    places.find((x) => x.id === last) ??
    places.find((x) => x.isUnplaced) ??
    places.find((x) => x.id === loc.unplacedPlaceId);
  return p ? { placeId: p.id, locationId: loc.id, name: p.isUnplaced ? '' : p.name } : null;
}

export function WherePicker({
  store,
  label,
  locationIds,
  value,
  onChange,
}: {
  store: OfflineStore | null;
  label: string;
  locationIds?: readonly string[];
  value: PickedPlace | null;
  onChange: (picked: PickedPlace) => void;
}) {
  const world = usePhoneWorld(store, locationIds);
  const placeName = usePlaceName();
  const locationName = useLocationName();
  const { t } = useLingui();

  // Start from the default once the phone's places are read.
  useEffect(() => {
    if (!value && world) {
      const d = defaultPlace(world);
      if (d) onChange(d);
    }
  }, [world, value, onChange]);

  if (world && world.locations.length === 0) {
    return (
      <PlacePicker
        label={label}
        value={value}
        onChange={onChange}
        {...(locationIds ? { locationIds: [...locationIds] } : {})}
      />
    );
  }
  if (!world) return <div className="min-h-24" aria-busy="true" />;
  return (
    <RadioGroup
      value={value?.placeId ?? null}
      onChange={(id) => {
        for (const l of world.locations) {
          const p = world.places[l.id]?.find((x) => x.id === id);
          if (p) onChange({ placeId: p.id, locationId: l.id, name: placeName(p) });
        }
      }}
      className="grid gap-2"
    >
      <Label className="font-medium text-small text-ink">{label}</Label>
      <div className="grid max-h-72 gap-3 overflow-y-auto">
        {world.locations.map((loc) => (
          <div key={loc.id} className="grid gap-1">
            <div className="px-1 font-semibold text-[12.5px] text-ink-3 uppercase tracking-[0.06em]">
              <bdi>{locationName({ kind: loc.kind as LocationKind, name: loc.name })}</bdi>
            </div>
            <div className="grid overflow-hidden rounded-[10px] border border-line bg-surface">
              {flattenPlaces(world.places[loc.id] ?? []).map(({ place, depth }) => (
                <Radio
                  key={place.id}
                  value={place.id}
                  aria-label={placeName(place) || t`Unplaced`}
                  style={{ paddingInlineStart: `${0.875 + depth * 1.25}rem` }}
                  className="flex min-h-11 cursor-pointer items-center gap-2 border-line py-2 pe-3.5 text-[15px] text-ink outline-none not-first:border-t data-focus-visible:outline-2 data-focus-visible:-outline-offset-2 data-focus-visible:outline-info data-hovered:bg-sunken data-selected:bg-sunken data-selected:font-semibold"
                >
                  <bdi className="min-w-0 flex-1 [overflow-wrap:anywhere]">{placeName(place)}</bdi>
                </Radio>
              ))}
            </div>
          </div>
        ))}
      </div>
    </RadioGroup>
  );
}
