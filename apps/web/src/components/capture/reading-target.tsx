/**
 * What a READING capture reads (D34, D52; plan T13): a meter on a thing. The server files a
 * reading's photo as proof on the metered thing (`attachToThingId`, plus `meterId`) and refuses a
 * READING into a plain place with 400, so in READING mode the chip names a meter, not a place,
 * and its sheet offers only things that have one.
 *
 * The list comes from the phone's snapshot, offline as online: each SnapThing carries its meters
 * (id, kind, unit, label), so every thing with a meter is offered, whatever its type, including
 * one added by hand. A meter added or renamed on the server reaches the phone with the next sync
 * (the server resends its thing).
 */
import type { SnapLocation, SnapPlace, SnapThing } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { Button, FieldError, Input, Radio, RadioGroup, TextField } from 'react-aria-components';
import type { PathStep, ThingMeter } from '@/api/inventory/types';
import type { LocationKind } from '@/api/types';
import { ChevronDownIcon } from '@/components/icons';
import { Notice } from '@/components/page';
import { PathText } from '@/components/places/rows';
import { useMeterName } from '@/components/things/meters-section';
import { Sheet } from '@/components/things/sheet';
import { Button as UIButton } from '@/components/ui/button';
import { useLocationName } from '@/lib/labels';
import { useMeterUnit } from '@/lib/units';
import type { OfflineStore } from '@/offline/store';

/** The meter a READING capture is of. */
export type ReadingTarget = {
  locationId: string;
  thingId: string;
  thingName: string;
  meterId: string;
  meterName: string;
  /** The meter's unit, for the typed value's label (T19). */
  unit?: string;
};

export type MeteredThing = {
  id: string;
  locationId: string;
  name: string;
  path: PathStep[];
  meters: Pick<ThingMeter, 'id' | 'kind' | 'unit' | 'label'>[];
};

/** Containers deeper than this are cut from a path (a loop in a stale copy can't hang it). */
const MAX_DEPTH = 32;

/** Where a snapshot thing is: its places from the top, then the containers it is in. */
async function snapPath(
  store: OfflineStore,
  thing: SnapThing,
  places: ReadonlyMap<string, SnapPlace>,
): Promise<PathStep[]> {
  const containers: PathStep[] = [];
  let placeId = thing.placeId;
  let containerId = thing.containerId;
  for (let i = 0; containerId && i < MAX_DEPTH; i++) {
    const c = await store.thing(containerId);
    if (!c) break;
    containers.unshift({ id: c.id, name: c.name ?? '', kind: 'container', isUnplaced: false });
    placeId = c.placeId;
    containerId = c.containerId;
  }
  const up: PathStep[] = [];
  let p = placeId ? places.get(placeId) : undefined;
  for (let i = 0; p && i < MAX_DEPTH; i++) {
    up.unshift({ id: p.id, name: p.name, kind: 'place', isUnplaced: p.isUnplaced });
    p = p.parentId ? places.get(p.parentId) : undefined;
  }
  return [...up, ...containers];
}

/** The things with a meter in these locations, from the phone's snapshot (see the header). */
export function useMeteredThings(
  store: OfflineStore,
  locationIds: readonly string[],
  enabled: boolean,
) {
  const ids = [...locationIds].sort();
  return useQuery({
    queryKey: ['capture', 'metered', ids],
    enabled: enabled && ids.length > 0,
    // The copy changes with every sync: read it each time the sheet opens.
    staleTime: 0,
    gcTime: 0,
    queryFn: async (): Promise<MeteredThing[]> => {
      const places = new Map<string, SnapPlace>();
      for (const id of ids) for (const pl of await store.placesOf(id)) places.set(pl.id, pl);
      const found = (await store.metered(ids))
        .filter((t) => t.name)
        .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
      return Promise.all(
        found.map(async (t) => ({
          id: t.id,
          locationId: t.locationId,
          name: t.name ?? '',
          path: await snapPath(store, t, places),
          meters: t.meters ?? [],
        })),
      );
    },
  });
}

/** The chip in READING mode: the meter the next photo reads, or a prompt to choose one. */
export function ReadingChip({
  value,
  onPress,
}: {
  value: ReadingTarget | null;
  onPress: () => void;
}) {
  const { t } = useLingui();
  const name = value?.thingName ?? '';
  const meter = value?.meterName ?? '';
  return (
    <Button
      onPress={onPress}
      aria-label={value ? t`Reading ${meter} of ${name}. Change` : t`Choose what was read`}
      className="flex min-h-12 min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-xl border border-[#34302A] bg-[#26231F] py-1.5 ps-3 pe-2.5 text-start text-[#F2EFE9] outline-none data-focus-visible:outline-2 data-focus-visible:outline-[#F2EFE9]"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="size-5 shrink-0 fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:1.8]"
      >
        <path d="M4.5 16a7.5 7.5 0 1 1 15 0" />
        <path d="m12 16 3.5-4.5" />
      </svg>
      <span className="grid min-w-0 flex-1">
        <span className="font-semibold text-[14.5px] leading-tight [overflow-wrap:anywhere]">
          {value ? (
            <Trans>
              <bdi>{name}</bdi> · <bdi>{meter}</bdi>
            </Trans>
          ) : (
            <Trans>Choose what was read</Trans>
          )}
        </span>
        <span className="mt-0.5 font-medium text-[#BDB7AC] text-[12px]">
          <Trans>Only things with a meter · tap to change</Trans>
        </span>
      </span>
      <ChevronDownIcon className="size-[18px] shrink-0" />
    </Button>
  );
}

/** "What was read?": the meters of the writable locations' metered things. */
export function ReadingSheet({
  isOpen,
  onClose,
  store,
  locations,
  value,
  onPick,
}: {
  isOpen: boolean;
  onClose: () => void;
  /** The phone's copy, whose things carry their meters. */
  store: OfflineStore;
  locations: readonly SnapLocation[];
  value: ReadingTarget | null;
  onPick: (target: ReadingTarget) => void;
}) {
  const { t } = useLingui();
  const meterName = useMeterName();
  const unitOf = useMeterUnit();
  const locationName = useLocationName();
  const metered = useMeteredThings(
    store,
    locations.map((l) => l.id),
    isOpen,
  );
  const things = metered.data ?? [];
  const rows = things.flatMap((th) =>
    th.meters.map((m) => ({ key: `${th.id}:${m.id}`, thing: th, meter: m })),
  );
  const byLocation = locations
    .map((l) => ({ loc: l, rows: rows.filter((r) => r.thing.locationId === l.id) }))
    .filter((g) => g.rows.length > 0);
  return (
    <Sheet
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t`What was read?`}
    >
      <div className="grid gap-3">
        <p className="m-0 text-[13px] text-ink-3">
          <Trans>
            A reading goes on the thing whose meter it is, with the photo as proof. Only things with
            a meter are listed.
          </Trans>
        </p>
        {metered.isPending ? (
          <p className="m-0 text-[14px] text-ink-2">
            <Trans>Finding things with a meter…</Trans>
          </p>
        ) : metered.isError ? (
          <Notice
            tone="danger"
            title={<Trans>Couldn't check which things have a meter</Trans>}
            action={
              <UIButton size="small" variant="secondary" onPress={() => void metered.refetch()}>
                <Trans>Try again</Trans>
              </UIButton>
            }
          />
        ) : rows.length === 0 ? (
          <Notice tone="info" title={<Trans>Nothing here has a meter yet</Trans>}>
            <Trans>
              A reading needs a meter: a car's odometer, a generator's hours. Add one on the thing's
              page, under Meters, then read it here. Until then, take the photo in Thing mode.
            </Trans>
          </Notice>
        ) : (
          <RadioGroup
            aria-label={t`Meters`}
            value={value ? `${value.thingId}:${value.meterId}` : null}
            onChange={(key) => {
              const row = rows.find((r) => r.key === key);
              if (!row) return;
              onPick({
                locationId: row.thing.locationId,
                thingId: row.thing.id,
                thingName: row.thing.name,
                meterId: row.meter.id,
                meterName: meterName(row.meter),
                unit: row.meter.unit,
              });
            }}
            className="grid gap-3"
          >
            {byLocation.map(({ loc, rows: here }) => (
              <div key={loc.id} className="grid gap-1">
                <div className="px-1 font-semibold text-[12.5px] text-ink-3 uppercase tracking-[0.06em]">
                  <bdi>{locationName({ kind: loc.kind as LocationKind, name: loc.name })}</bdi>
                </div>
                <div className="grid overflow-hidden rounded-[10px] border border-line bg-surface">
                  {here.map(({ key, thing, meter }) => {
                    const name = thing.name;
                    const meterLabel = meterName(meter);
                    const unit = unitOf(meter.unit);
                    return (
                      <Radio
                        key={key}
                        value={key}
                        className="grid min-h-11 cursor-pointer gap-0.5 border-line px-3.5 py-2 text-[15px] text-ink outline-none not-first:border-t data-focus-visible:outline-2 data-focus-visible:-outline-offset-2 data-focus-visible:outline-info data-hovered:bg-sunken data-selected:bg-sunken data-selected:font-semibold"
                      >
                        <span className="[overflow-wrap:anywhere]">
                          <Trans>
                            <bdi>{name}</bdi> · <bdi>{meterLabel}</bdi> (<bdi dir="ltr">{unit}</bdi>
                            )
                          </Trans>
                        </span>
                        {thing.path.length ? <PathText path={thing.path} /> : null}
                      </Radio>
                    );
                  })}
                </div>
              </div>
            ))}
          </RadioGroup>
        )}
      </div>
    </Sheet>
  );
}

/**
 * READING's typed value (plan T19, the step-3 carry-over): beside the note, the number on the
 * meter, in either digits. With one, the shutter queues a `log_reading` with the photo as its
 * proof, online or offline; left empty, the photo goes as step 3's READING capture and AI reads
 * it (or the Inbox asks).
 */
export function ReadingValueField({
  unit: stored,
  value,
  onChange,
  error,
}: {
  unit: string | null;
  value: string;
  onChange: (v: string) => void;
  error: string | null;
}) {
  const { t } = useLingui();
  const unit = useMeterUnit()(stored);
  const label = unit ? t`Reading (${unit}), optional` : t`Reading, optional`;
  return (
    <TextField
      aria-label={label}
      value={value}
      onChange={onChange}
      isInvalid={error !== null}
      className="mx-3 mt-2.5 grid gap-1"
    >
      <div className="flex min-h-12 items-center gap-1.5 rounded-xl border border-[#34302A] bg-[#1E1C19] ps-3.5 pe-3 focus-within:border-[#F2EFE9]">
        <Input
          placeholder={label}
          inputMode="decimal"
          dir="ltr"
          className="min-h-11 min-w-0 flex-1 bg-transparent text-[#F2EFE9] text-[15px] tabular-nums outline-none placeholder:text-[#9A948A]"
        />
      </div>
      <FieldError className="text-[#F2B8A8] text-[13px]">{error}</FieldError>
    </TextField>
  );
}
