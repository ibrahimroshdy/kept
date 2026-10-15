/**
 * The room a box goes to (1.x, D251): the places of the move's destination, from the phone's
 * snapshot so it works offline in the new house, never the Unplaced area. With nothing on the
 * phone yet it is the server-backed place picker. Nothing is chosen for you: an unpack waits for
 * a room, the box's own when one was chosen at packing.
 */
import { useLingui } from '@lingui/react/macro';
import { Label, Radio, RadioGroup } from 'react-aria-components';
import { flattenPlaces } from '@/components/capture/target';
import { usePlaceName } from '@/components/places/labels';
import { type PickedPlace, PlacePicker } from '@/components/places/move-picker';
import { usePhoneWorld } from '@/components/scan/where-picker';
import type { OfflineStore } from '@/offline/store';

export function RoomPicker({
  store,
  label,
  locationId,
  value,
  onChange,
}: {
  store: OfflineStore | null;
  label: string;
  locationId: string;
  value: PickedPlace | null;
  onChange: (picked: PickedPlace) => void;
}) {
  const { t } = useLingui();
  const world = usePhoneWorld(store, [locationId]);
  const placeName = usePlaceName();
  const places = world?.places[locationId];
  if (world && !places) {
    return (
      <PlacePicker
        label={label}
        value={value}
        onChange={onChange}
        locationIds={[locationId]}
        includeUnplaced={false}
      />
    );
  }
  if (!places) return <div className="min-h-24" aria-busy="true" />;
  const rows = flattenPlaces(places).filter((r) => !r.place.isUnplaced);
  return (
    <RadioGroup
      value={value?.placeId ?? null}
      onChange={(id) => {
        const p = places.find((x) => x.id === id);
        if (p) onChange({ placeId: p.id, locationId, name: placeName(p) });
      }}
      className="grid gap-2"
    >
      <Label className="font-medium text-small text-ink">{label}</Label>
      {rows.length === 0 ? (
        <p className="m-0 text-small text-ink-2">{t`This location has no rooms yet.`}</p>
      ) : (
        <div className="grid max-h-72 overflow-y-auto rounded-[10px] border border-line bg-surface">
          {rows.map(({ place, depth }) => (
            <Radio
              key={place.id}
              value={place.id}
              aria-label={placeName(place)}
              style={{ paddingInlineStart: `${0.875 + depth * 1.25}rem` }}
              className="flex min-h-11 cursor-pointer items-center gap-2 border-line py-2 pe-3.5 text-[15px] text-ink outline-none not-first:border-t data-focus-visible:outline-2 data-focus-visible:-outline-offset-2 data-focus-visible:outline-info data-hovered:bg-sunken data-selected:bg-sunken data-selected:font-semibold"
            >
              <bdi className="min-w-0 flex-1 [overflow-wrap:anywhere]">{placeName(place)}</bdi>
            </Radio>
          ))}
        </div>
      )}
    </RadioGroup>
  );
}
