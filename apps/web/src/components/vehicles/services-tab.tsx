/**
 * A vehicle's Services tab (plan T20; screens §5, §8; the board's frame 68; Q12): its service
 * records on the `services` surface (date, vendor, line kind, drafts), drafts first. A draft (an
 * invoice attached, not yet saved) says so, with **Finish logging**, which opens Log a service on
 * it, and **Discard draft** (step 4's DELETE; a draft isn't undoable, so it asks first). **Log a
 * service** opens the sheet for this vehicle.
 *
 * Plugs into the vehicle page through ./slots.tsx as `VehicleServices` (no props: the thing comes
 * from `useThingCtx()`). Service records carry money, so offline the tab says it needs a
 * connection, and Log a service says why it can't save.
 */
import { SERVICE_LINE_KINDS } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { householdApi } from '@/api/household/queries';
import { inventoryApi } from '@/api/inventory/queries';
import { useVehicleServiceRecords } from '@/api/vehicles/queries';
import type { ServiceRecordsParams, ServiceRecordV5 } from '@/api/vehicles/types';
import { useFilterRegistry } from '@/components/filters/registry';
import type { FilterDef } from '@/components/filters/types';
import { DocumentIcon, PencilIcon, WrenchIcon } from '@/components/icons';
import { ListSurface } from '@/components/list-surface';
import { EmptyState, Notice, Section, useErrorText } from '@/components/page';
import { accessOf, useInvalidateHousehold } from '@/components/schedules/access';
import { useServiceLineLabels } from '@/components/services/labels';
import { LogServiceSheet } from '@/components/services/log-service-sheet';
import { useThingCtx } from '@/components/things/context';
import { useLocationAccountId } from '@/components/things/pickers';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { toast } from '@/components/ui/toast';
import { useOnline } from '@/lib/online';
import { type ListState, useListState } from '@/lib/url-state';
import { ServiceLine } from './recent-services';

/** The URL's list state as `GET /things/:id/service-records` reads it (the `services` surface). */
export function servicesParams(list: ListState): ServiceRecordsParams {
  const many = (k: string) => list.filters[k] ?? [];
  const not = list.not.filter((k): k is 'when' | 'vendor' | 'kind' | 'draft' =>
    ['when', 'vendor', 'kind', 'draft'].includes(k),
  );
  const when = many('when')[0];
  const draft = many('draft')[0];
  return {
    ...(list.q ? { q: list.q } : {}),
    ...(when ? { 'f.when': when } : {}),
    ...(many('vendor').length ? { 'f.vendor': many('vendor') } : {}),
    ...(many('kind').length
      ? { 'f.kind': many('kind') as NonNullable<ServiceRecordsParams['f.kind']> }
      : {}),
    ...(draft === '0' || draft === '1' ? { 'f.draft': draft } : {}),
    ...(not.length ? { not } : {}),
    ...(list.sort === 'total' || list.sort === 'servicedOn' ? { sort: list.sort } : {}),
    ...(list.dir ? { dir: list.dir } : {}),
  };
}

export function VehicleServices() {
  const { thing, location, me } = useThingCtx();
  const { t } = useLingui();
  const online = useOnline();
  const [list] = useListState();
  const f = useFilterRegistry();
  const kinds = useServiceLineLabels();
  const accountId = useLocationAccountId(location);
  const access = accessOf(location);
  const canLog = access.can('logs.add');
  const query = useVehicleServiceRecords(thing.id, servicesParams(list));
  const [open, setOpen] = useState<{ draft: ServiceRecordV5 | null } | null>(null);

  const filters: FilterDef[] = [
    f.date('when', t`Date`),
    {
      key: 'vendor',
      label: t`Vendor`,
      icon: <DocumentIcon />,
      kind: 'multi',
      values: {
        from: 'load',
        queryKey: ['filters', 'vendors', accountId],
        load: async () =>
          accountId
            ? (await inventoryApi.registry('vendors', accountId, { limit: 200 })).items.map(
                (v) => ({ value: v.id, label: v.name }),
              )
            : [],
      },
    },
    {
      key: 'kind',
      label: t`Line kind`,
      icon: <WrenchIcon />,
      kind: 'multi',
      values: {
        from: 'static',
        options: SERVICE_LINE_KINDS.map((k) => ({ value: k, label: kinds[k] })),
      },
    },
    {
      key: 'draft',
      label: t`Drafts`,
      icon: <PencilIcon />,
      kind: 'single',
      negatable: false,
      values: {
        from: 'static',
        options: [
          { value: '1', label: t`Drafts only` },
          { value: '0', label: t`Saved only` },
        ],
      },
    },
  ];

  return (
    <Section
      title={<Trans>Services</Trans>}
      action={
        canLog ? (
          <Button size="small" onPress={() => setOpen({ draft: null })}>
            <Trans>Log a service</Trans>
          </Button>
        ) : undefined
      }
    >
      {!online ? (
        <Notice tone="warn" title={t`Needs a connection`}>
          <Trans>Services have money in them. A reading alone can be logged offline.</Trans>
        </Notice>
      ) : null}
      <ListSurface<ServiceRecordV5>
        label={t`Services`}
        search={{ label: t`Search services`, placeholder: t`Search lines, vendor, notes` }}
        filters={filters}
        surface="services"
        sorts={[
          { value: 'servicedOn', label: t`Date`, kind: 'date' },
          { value: 'total', label: t`Total` },
        ]}
        query={query}
        getKey={(r) => r.id}
        renderRow={(r) =>
          r.reviewState === 'draft' ? (
            <DraftRow
              record={r}
              mine={r.loggedBy.displayName === me}
              onFinish={() => setOpen({ draft: r })}
            />
          ) : (
            <ServiceLine record={r} />
          )
        }
        empty={
          <EmptyState icon={<WrenchIcon />} title={<Trans>No services yet</Trans>}>
            <Trans>Log a service with its invoice, and it shows here with what it cost.</Trans>
          </EmptyState>
        }
      />
      {canLog ? (
        <LogServiceSheet
          open={open !== null}
          subject={{ thingId: thing.id }}
          subjectRef={{
            type: 'thing',
            id: thing.id,
            name: thing.name ?? '',
            path: '',
            shortCode: thing.shortCode,
          }}
          locationId={thing.locationId}
          draft={open?.draft ?? null}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </Section>
  );
}

/** A draft: what was read so far, and Finish logging or Discard draft. */
function DraftRow({
  record,
  mine,
  onFinish,
}: {
  record: ServiceRecordV5;
  mine: boolean;
  onFinish: () => void;
}) {
  const { location } = useThingCtx();
  const { t } = useLingui();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const invalidate = useInvalidateHousehold();
  const online = useOnline();
  const access = accessOf(location);
  const mayChange = mine ? access.can('logs.edit-own') : access.can('logs.edit-delete-others');
  const discard = async () => {
    const ok = await confirm({
      title: t`Discard this draft?`,
      body: t`Its invoice and what was read from it go too. This can't be undone.`,
      confirmLabel: t`Discard draft`,
      destructive: true,
    });
    if (!ok) return;
    try {
      await householdApi.deleteServiceRecord(record.id, record.rowVersion);
      toast({ title: t`Draft discarded`, tone: 'ok' });
      await invalidate();
    } catch (e) {
      toast({ title: t`Couldn't discard the draft`, description: errorText(e), tone: 'danger' });
    }
  };
  return (
    <div className="grid gap-1 pb-2.5">
      <ServiceLine record={record} />
      {mayChange ? (
        <div className="flex flex-wrap gap-2 ps-[3.75rem] pe-3.5">
          <Button size="small" isDisabled={!online} onPress={onFinish}>
            <Trans>Finish logging</Trans>
          </Button>
          <Button
            size="small"
            variant="secondary"
            isDisabled={!online}
            onPress={() => void discard()}
          >
            <Trans>Discard draft</Trans>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
