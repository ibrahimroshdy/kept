/**
 * Consumables (D14; screens "Other screens": "low stock, with Adjust"; frame 08 "Consumables";
 * step-7 plan T23): the things with a "keep at least" in one location, low first, then by name
 * (the server's order), each with what's left, its minimum, where it is and Adjust.
 *
 * The list standard (D205): the filter strip holds the search (matched here, on the rows loaded),
 * the location (one: `GET /consumables` reads one location; absent, the first with the module on)
 * and Low; the Display button groups by low or enough (the default) or not at all; Load more
 * follows the server's cursor. All of it is in the URL.
 *
 * Where the module is off in the chosen location: "Things you run out of is off in this
 * location", with Turn on for its owners and admins; with none chosen and none on, "off in your
 * locations". Viewers see the list without Adjust; offline,
 * Adjust is disabled with "Needs a connection" (screens §3).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';
import { useCallback, useState } from 'react';
import { useConsumables } from '@/api/portability/queries';
import type { ConsumableRow } from '@/api/portability/types';
import { useLocations } from '@/api/queries';
import { useFilterRegistry } from '@/components/filters/registry';
import { FilterStrip } from '@/components/filters/strip';
import type { FilterDef } from '@/components/filters/types';
import { AlertIcon, BoxIcon } from '@/components/icons';
import { ListSurface } from '@/components/list-surface';
import { EmptyState, LinkButton, Pill } from '@/components/page';
import { PathText, Tile } from '@/components/places/rows';
import { accessOf } from '@/components/schedules/access';
import { oneValue, useOrderedQuery } from '@/components/schedules/list-query';
import { TypeIcon } from '@/components/type-icon';
import { Button } from '@/components/ui/button';
import { addressOf } from '@/lib/address';
import { sep } from '@/lib/format';
import { useLocationName } from '@/lib/labels';
import { useOnline } from '@/lib/online';
import { useListState } from '@/lib/url-state';
import { AdjustSheet, StockLine } from './stock.household';

export function StockList() {
  const { t } = useLingui();
  const [list] = useListState();
  const f = useFilterRegistry();
  const locations = useLocations();
  const locationName = useLocationName();
  const all = locations.data ?? [];
  const chosen = oneValue(list, 'location');
  const location =
    all.find((l) => l.id === chosen) ??
    all.find((l) => accessOf(l).moduleOn('consumables')) ??
    all[0];
  const access = accessOf(location);
  const on = access.moduleOn('consumables');
  const lowOnly = oneValue(list, 'state') === 'low';
  const query = useConsumables(
    { locationId: location?.id ?? '', ...(lowOnly ? { state: 'low' as const } : {}) },
    !!location && on,
  );
  const q = list.q.trim().toLocaleLowerCase();
  const keep = useCallback(
    (r: ConsumableRow) => !q || (r.thing.name ?? '').toLocaleLowerCase().includes(q),
    [q],
  );
  const ordered = useOrderedQuery(query, keep, null);
  const [adjusting, setAdjusting] = useState<ConsumableRow['thing'] | null>(null);

  const filters: FilterDef[] = [
    ...(all.length > 1
      ? [
          {
            ...f.location(),
            kind: 'single' as const,
            values: {
              from: 'static' as const,
              options: all.map((l) => ({ value: l.id, label: locationName(l) })),
            },
          },
        ]
      : []),
    {
      key: 'state',
      label: t`Low`,
      icon: <AlertIcon />,
      kind: 'boolean',
      on: 'low',
      values: { from: 'static', options: [{ value: 'low', label: t`Low` }] },
    },
  ];

  if (!locations.data) return null;
  if (!location || !on) {
    // Off in the location chosen (with Turn on for its admins), or nowhere on at all.
    const here = location && chosen === location.id ? location : undefined;
    const admin = !!here && (here.role === 'owner' || here.role === 'admin');
    return (
      <div className="grid gap-3">
        {/* Another location may have it on: the location filter stays. */}
        {all.length > 1 ? <FilterStrip filters={filters.slice(0, 1)} search={false} /> : null}
        {here ? (
          <OffHere admin={admin} locationId={here.id} />
        ) : (
          <EmptyState
            icon={<BoxIcon />}
            title={<Trans>Things you run out of is off in your locations</Trans>}
          >
            <Trans>
              An owner or admin turns it on in the location's settings, under What to track.
            </Trans>
          </EmptyState>
        )}
      </div>
    );
  }

  return (
    <>
      <ListSurface<ConsumableRow>
        label={t`Consumables`}
        search={{ label: t`Search consumables`, placeholder: t`Search by name` }}
        filters={filters}
        groups={[
          { value: 'stock', label: t`Low or enough`, short: t`by stock` },
          { value: 'none', label: t`None` },
        ]}
        defaultGroup="stock"
        query={ordered}
        getKey={(r) => r.thing.id}
        groupOf={(r, by) =>
          by === 'none'
            ? null
            : r.low
              ? { key: 'low', label: <Trans>Low</Trans> }
              : { key: 'enough', label: <Trans>Enough</Trans> }
        }
        renderRow={(r) => (
          <StockRow
            row={r}
            canAdjust={access.can('things.edit')}
            onAdjust={() => setAdjusting(r.thing)}
          />
        )}
        empty={
          <EmptyState icon={<BoxIcon />} title={<Trans>Nothing to keep stocked yet</Trans>}>
            <Trans>
              On a thing you run out of, such as batteries or filters, set "Keep at least", and it
              shows here, low first.
            </Trans>
          </EmptyState>
        }
      />
      <AdjustSheet thing={adjusting} onClose={() => setAdjusting(null)} />
    </>
  );
}

function OffHere({ admin, locationId }: { admin: boolean; locationId: string }) {
  return (
    <EmptyState
      icon={<BoxIcon />}
      title={<Trans>Things you run out of is off in this location</Trans>}
      action={
        admin ? (
          <LinkButton size="small" to="/settings/location/$id/track" params={{ id: locationId }}>
            <Trans>Turn on</Trans>
          </LinkButton>
        ) : undefined
      }
    >
      {admin ? (
        <Trans>Turn it on under What to track to keep a minimum of things you use up.</Trans>
      ) : (
        <Trans>Ask an owner or admin of this location to turn it on.</Trans>
      )}
    </EmptyState>
  );
}

function StockRow({
  row,
  canAdjust,
  onAdjust,
}: {
  row: ConsumableRow;
  canAdjust: boolean;
  onAdjust: () => void;
}) {
  const { t } = useLingui();
  const online = useOnline();
  const { thing } = row;
  const name = thing.name ?? t`Untitled draft`;
  return (
    <article aria-label={name} className="flex flex-wrap items-center gap-3 px-3.5 py-3">
      <div className="flex min-w-0 flex-1 basis-56 items-start gap-3">
        <Tile>
          {thing.thumbUrl ? (
            <img src={thing.thumbUrl} alt="" className="size-full object-cover" />
          ) : (
            <TypeIcon icon={thing.type?.icon} />
          )}
        </Tile>
        <div className="grid min-w-0 flex-1 gap-1">
          <Link
            to="/t/$id"
            params={{ id: addressOf(thing) }}
            className="font-semibold text-[15px] leading-snug text-ink underline-offset-2 [overflow-wrap:anywhere] hover:underline"
          >
            <bdi>{name}</bdi>
          </Link>
          <div className="text-small text-ink-2 [overflow-wrap:anywhere]">
            <StockLine quantity={thing.quantity} min={row.minQuantity} />
            {thing.path.length ? (
              <>
                {sep()}
                <PathText path={thing.path.slice(-1)} />
              </>
            ) : null}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 ps-14 md:ps-0">
        {row.low ? (
          <Pill tone="warn" icon={<AlertIcon />}>
            <Trans>Low</Trans>
          </Pill>
        ) : null}
        {canAdjust ? (
          <Button
            size="small"
            variant="secondary"
            isDisabled={!online}
            aria-label={online ? t`Adjust ${name}` : t`Needs a connection`}
            onPress={onAdjust}
          >
            <Trans>Adjust</Trans>
          </Button>
        ) : null}
      </div>
    </article>
  );
}
