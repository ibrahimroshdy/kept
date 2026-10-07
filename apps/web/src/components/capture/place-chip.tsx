/**
 * The place chip, pinned at the top of the camera (screens §5 "Capture"; D153, D195): where the
 * next capture lands, why ("Nearby · tap to change"), and a thumbnail dropped in by each shutter
 * press (none under reduced motion's animation, the thumbnail still appears). Tapping it opens
 * the place sheet: every place in the locations you can add to, from this phone's snapshot, so
 * it works offline; and the "Suggest where I am" switch (D153), which asks for the position only
 * when turned on.
 */
import type { SnapLocation, SnapPlace } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useId, useState } from 'react';
import { Button, Radio, RadioGroup } from 'react-aria-components';
import type { LocationKind } from '@/api/types';
import { ChevronDownIcon, SearchIcon } from '@/components/icons';
import { usePlaceName } from '@/components/places/labels';
import { placeMatches } from '@/components/places/move-picker';
import { Sheet } from '@/components/things/sheet';
import { Switch } from '@/components/ui/switch';
import { useLocationName } from '@/lib/labels';
import type { ChipTarget } from './target';
import { flattenPlaces, placePath } from './target';

/** "Home › Garage › Shelf A", "Home › Box 3", "Personal › Unplaced". */
export function useTargetPath() {
  const { t } = useLingui();
  const placeName = usePlaceName();
  const locationName = useLocationName();
  return (
    target: ChipTarget,
    locations: readonly SnapLocation[],
    places: readonly SnapPlace[],
  ): string => {
    const loc = locations.find((l) => l.id === target.locationId);
    const head = loc ? locationName({ kind: loc.kind as LocationKind, name: loc.name }) : '';
    const tail = target.containerId
      ? [target.containerName ?? t`a box`]
      : placePath(places, target.placeId).map((p) => placeName(p));
    return [head, ...(tail.length ? tail : [t`Unplaced`])].filter(Boolean).join(' › ');
  };
}

export function PlaceChip({
  path,
  why,
  thumbs,
  onPress,
}: {
  path: string;
  why: ChipTarget['why'];
  /** Object URLs of this session's last shots, newest last. */
  thumbs: string[];
  onPress: () => void;
}) {
  const { t } = useLingui();
  const sub =
    why === 'nearby'
      ? t`Nearby · tap to change`
      : why === 'last'
        ? t`Last place · tap to change`
        : why === 'scanned'
          ? t`From the label · tap to change`
          : t`Tap to change`;
  return (
    <Button
      onPress={onPress}
      aria-label={t`Capturing into ${path}. Change place`}
      className="flex min-h-12 min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-xl border border-[#34302A] bg-[#26231F] py-1.5 ps-3 pe-2.5 text-start text-[#F2EFE9] outline-none data-focus-visible:outline-2 data-focus-visible:outline-[#F2EFE9]"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="size-5 shrink-0 fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:1.8]"
      >
        <path d="M12 21s-6-5.6-6-11a6 6 0 1 1 12 0c0 5.4-6 11-6 11Z" />
        <circle cx="12" cy="10" r="2" />
      </svg>
      <span className="grid min-w-0 flex-1">
        <bdi className="font-semibold text-[14.5px] leading-tight [overflow-wrap:anywhere]">
          {path}
        </bdi>
        <span className="mt-0.5 font-medium text-[#BDB7AC] text-[12px]">{sub}</span>
      </span>
      {thumbs.length ? (
        <span aria-hidden="true" className="flex shrink-0 -space-x-2">
          {thumbs.slice(-3).map((src) => (
            <img
              key={src}
              src={src}
              alt=""
              className="size-7 rounded-md border border-[#34302A] object-cover motion-safe:transition-[translate,opacity] motion-safe:duration-300 motion-safe:starting:-translate-y-5 motion-safe:starting:opacity-0"
            />
          ))}
        </span>
      ) : null}
      <ChevronDownIcon className="size-[18px] shrink-0" />
    </Button>
  );
}

export type SuggestState = 'off' | 'finding' | 'found' | 'none' | 'denied' | 'unavailable';

export function PlaceSheet({
  isOpen,
  onClose,
  locations,
  placesOf,
  value,
  onPick,
  suggest,
  onSuggest,
}: {
  isOpen: boolean;
  onClose: () => void;
  locations: readonly SnapLocation[];
  placesOf: (locationId: string) => readonly SnapPlace[];
  value: ChipTarget;
  onPick: (locationId: string, placeId: string) => void;
  suggest: SuggestState;
  onSuggest: (on: boolean) => void;
}) {
  const { t } = useLingui();
  const placeName = usePlaceName();
  const locationName = useLocationName();
  const searchId = useId();
  const [q, setQ] = useState('');
  const current = value.containerId ? null : value.placeId;
  const suggestNote =
    suggest === 'finding'
      ? t`Finding where you are…`
      : suggest === 'none'
        ? t`None of your locations is nearby.`
        : suggest === 'denied'
          ? t`Location access is off for Kept in this browser's settings.`
          : suggest === 'unavailable'
            ? t`Not available on this device.`
            : t`Compares your position with your locations on this phone. It is never sent or kept.`;
  return (
    <Sheet
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t`Capture into`}
    >
      <div className="grid gap-3">
        <div className="grid gap-0.5">
          <Switch
            isSelected={suggest !== 'off'}
            isDisabled={suggest === 'unavailable'}
            onChange={onSuggest}
          >
            <Trans>Suggest where I am</Trans>
          </Switch>
          <p className="m-0 text-[13px] text-ink-3">{suggestNote}</p>
        </div>
        <div className="flex min-h-11 items-center gap-2 rounded-lg border border-line bg-surface px-3 focus-within:border-ink-2">
          <SearchIcon className="size-[18px] shrink-0 text-ink-3" />
          <label htmlFor={searchId} className="sr-only">
            <Trans>Find a place</Trans>
          </label>
          <input
            id={searchId}
            type="search"
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
            placeholder={t`Find a place`}
            className="min-h-10 min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none"
          />
        </div>
        <RadioGroup
          aria-label={t`Places`}
          value={current}
          onChange={(v) => {
            const loc = locations.find((l) => placesOf(l.id).some((p) => p.id === v));
            if (loc) onPick(loc.id, v);
          }}
          className="grid gap-3"
        >
          {locations.map((loc) => {
            const rows = flattenPlaces(placesOf(loc.id)).filter(
              (r) => !q || placeMatches(placeName(r.place), q),
            );
            if (!rows.length) return null;
            return (
              <div key={loc.id} className="grid gap-1">
                <div className="px-1 font-semibold text-[12.5px] text-ink-3 uppercase tracking-[0.06em]">
                  <bdi>{locationName({ kind: loc.kind as LocationKind, name: loc.name })}</bdi>
                </div>
                <div className="grid overflow-hidden rounded-[10px] border border-line bg-surface">
                  {rows.map(({ place, depth }) => (
                    <Radio
                      key={place.id}
                      value={place.id}
                      style={{ paddingInlineStart: `${0.875 + (q ? 0 : depth) * 1.25}rem` }}
                      className="flex min-h-11 cursor-pointer items-center gap-2 border-line py-2 pe-3.5 text-[15px] text-ink outline-none not-first:border-t data-focus-visible:outline-2 data-focus-visible:-outline-offset-2 data-focus-visible:outline-info data-hovered:bg-sunken data-selected:bg-sunken data-selected:font-semibold"
                    >
                      <bdi className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                        {placeName(place)}
                      </bdi>
                    </Radio>
                  ))}
                </div>
              </div>
            );
          })}
        </RadioGroup>
      </div>
    </Sheet>
  );
}
