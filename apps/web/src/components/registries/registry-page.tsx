/**
 * The person, vendor and brand pages (screens §2 `/people/<id>` · `/vendors/<id>` · `/brands/<id>`;
 * §5 "Person page: what belongs to them", D57). Who or what it is, its details (a brand's support
 * line and claim page, a vendor's address), a person's contact card when the server returns it
 * (D177), and the things that point at it: the list standard, global across your locations with a
 * location chip (D174), all in the URL.
 *
 * A person's page lists their loans first (step 4, D57: "Has from us", "Lent to us", then the
 * returned ones), then what belongs to them.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import type { RegistryPathKind } from '@/api/inventory/paths';
import type { Brand, RegistryItem, ThingListParams, Vendor } from '@/api/inventory/types';
import { useLocations } from '@/api/queries';
import { ListExport } from '@/components/filters/list-export';
import { filterParams } from '@/components/filters/params';
import { useFilterRegistry } from '@/components/filters/registry';
import { PersonLoans } from '@/components/lending/person-loans';
import { ListSurface } from '@/components/list-surface';
import { EmptyState, ErrorState, LoadingRows, Page, Pill, Section } from '@/components/page';
import { useThingsQuery } from '@/components/places/api';
import { ThingRowView } from '@/components/places/rows';
import { Button } from '@/components/ui/button';
import { useListState } from '@/lib/url-state';
import { registryKeys, useAccountScope, useRegistryItem } from './api';
import { BrandLogo, BrandLogoActions } from './brand-logo';
import { ContactCard } from './contact-card';
import { useVendorKindLabels } from './labels';
import { MergeSheet, type MergeSubject } from './merge-sheet';
import { RegistryEditSheet, registryName } from './registry-edit-sheet';
import { RegistryIcon } from './registry-list';

export function RegistryPage<K extends 'brands' | 'vendors' | 'people'>({
  kind,
  id,
}: {
  kind: K;
  id: string;
}) {
  const { t } = useLingui();
  const item = useRegistryItem(kind, id);
  const title = { brands: t`Brand`, vendors: t`Vendor`, people: t`Person` }[kind];
  const back = `/settings/account/${kind}` as const;
  if (item.isPending)
    return (
      <Page title={title} back={back}>
        <LoadingRows rows={3} />
      </Page>
    );
  if (item.error)
    return (
      <Page title={title} back={back}>
        <ErrorState error={item.error} onRetry={() => void item.refetch()} />
      </Page>
    );
  return <Loaded kind={kind} item={item.data} back={back} />;
}

function Loaded<K extends 'brands' | 'vendors' | 'people'>({
  kind,
  item,
  back,
}: {
  kind: K;
  item: RegistryItem[K];
  back: string;
}) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const scope = useAccountScope(item.ownerAccountId ?? undefined);
  const vendorKinds = useVendorKindLabels();
  const [editing, setEditing] = useState(false);
  const [merging, setMerging] = useState<MergeSubject | null>(null);
  const name = registryName(item);
  const builtin = item.ownerAccountId === null;
  const canChange = scope.canManage && !builtin;

  const details: { label: string; value: ReactNode }[] = [];
  if (kind === 'brands') {
    const b = item as Brand;
    if (b.supportPhone)
      details.push({ label: t`Support phone`, value: <span dir="ltr">{b.supportPhone}</span> });
    if (b.website) details.push({ label: t`Website`, value: <ExternalLink href={b.website} /> });
    if (b.claimUrl)
      details.push({ label: t`Warranty claims`, value: <ExternalLink href={b.claimUrl} /> });
    if (b.defaultWarrantyMonths)
      details.push({
        label: t`Usual warranty`,
        value: <Trans>{b.defaultWarrantyMonths} months</Trans>,
      });
  }
  if (kind === 'vendors') {
    const v = item as Vendor;
    details.push({ label: t`Kind`, value: vendorKinds[v.kind] });
    if (v.address) details.push({ label: t`Address`, value: <bdi>{v.address}</bdi> });
    if (v.phone) details.push({ label: t`Phone`, value: <span dir="ltr">{v.phone}</span> });
    if (v.website) details.push({ label: t`Website`, value: <ExternalLink href={v.website} /> });
  }

  return (
    <Page
      title={<bdi>{name}</bdi>}
      back={back as never}
      actions={
        canChange ? (
          <div className="flex gap-2">
            <Button size="small" variant="secondary" onPress={() => setEditing(true)}>
              <Trans>Edit</Trans>
            </Button>
            <Button
              size="small"
              variant="secondary"
              onPress={() => setMerging({ id: item.id, name, accountId: scope.accountId })}
            >
              <Trans>Merge into…</Trans>
            </Button>
          </div>
        ) : undefined
      }
    >
      <div className="flex items-center gap-3 rounded-[10px] border border-line bg-surface p-3.5">
        {kind === 'brands' && !builtin ? (
          <BrandLogo
            brandId={item.id}
            name={name}
            hasLogo={(item as Brand).hasLogo}
            fallback={<RegistryIcon kind={kind} item={item} />}
          />
        ) : (
          <RegistryIcon kind={kind} item={item} />
        )}
        <div className="grid min-w-0 flex-1 gap-1">
          <div className="font-semibold text-[16px] [overflow-wrap:anywhere]">
            <bdi>{name}</bdi>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-small text-ink-2">
            {kind === 'people' ? (
              (item as RegistryItem['people']).userId ? (
                <Trans>Has a Kept account</Trans>
              ) : (
                <Trans>A contact, without a Kept account</Trans>
              )
            ) : null}
            {builtin ? (
              <Pill>
                <Trans>Built in</Trans>
              </Pill>
            ) : null}
          </div>
          {kind === 'brands' && canChange ? <BrandLogoActions brandId={item.id} /> : null}
        </div>
      </div>

      {details.length ? (
        <dl className="m-0 grid gap-x-4 gap-y-2 rounded-[10px] border border-line bg-surface p-3.5 sm:grid-cols-[auto_minmax(0,1fr)]">
          {details.map((d) => (
            <div key={d.label} className="contents">
              <dt className="text-small text-ink-2">{d.label}</dt>
              <dd className="m-0 [overflow-wrap:anywhere]">{d.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {kind === 'people' ? (
        <ContactCard personId={item.id} name={name} canEdit={scope.canManage} />
      ) : null}

      {kind === 'people' ? <PersonLoans personId={item.id} name={name} /> : null}

      <Things kind={kind} id={item.id} name={name} />

      <RegistryEditSheet
        kind={kind}
        item={editing ? item : null}
        onClose={() => {
          setEditing(false);
          void qc.invalidateQueries({ queryKey: registryKeys.item(kind, item.id) });
        }}
      />
      <MergeSheet
        kind={kind as RegistryPathKind}
        subject={merging}
        onClose={() => setMerging(null)}
        onMerged={(targetId) =>
          void navigate({ to: `/${kind}/$id` as never, params: { id: targetId } as never })
        }
      />
    </Page>
  );
}

function Things({
  kind,
  id,
  name,
}: {
  kind: 'brands' | 'vendors' | 'people';
  id: string;
  name: string;
}) {
  const { t } = useLingui();
  const [list] = useListState();
  const locations = useLocations();
  const f = useFilterRegistry();
  const params: ThingListParams = {
    ...filterParams(list, {
      location: 'locationId',
      type: 'typeId',
      tag: 'tagId',
      state: 'state',
      ...(kind === 'brands' ? {} : { brand: 'brandId' }),
      ...(kind === 'people' ? {} : { belongsTo: 'belongsToId' }),
    }),
    // The page's own subject last, so a filter never replaces it.
    ...(kind === 'people'
      ? { belongsToId: id }
      : kind === 'brands'
        ? { brandId: id }
        : { vendorId: id }),
    ...(list.q ? { q: list.q } : {}),
  } as ThingListParams;
  const query = useThingsQuery(params, true);
  const any = (query.data?.pages[0]?.items.length ?? 0) > 0;
  const heading =
    kind === 'people'
      ? t`Belongs to ${name}`
      : kind === 'brands'
        ? t`Things by ${name}`
        : t`Bought from ${name}`;
  return (
    <Section title={heading}>
      <ListSurface
        label={heading}
        // Export is the list as it's filtered (D169): anyone who can see it.
        search={any ? { end: <ListExport params={params} /> } : {}}
        query={query}
        filters={[
          ...((locations.data?.length ?? 0) > 1 ? [f.location()] : []),
          f.type(),
          f.tag(),
          f.state(['uncertain', 'draft', 'ended']),
          ...(kind === 'brands' ? [] : [f.brand()]),
          ...(kind === 'people' ? [] : [f.belongsTo()]),
        ]}
        surface="things"
        getKey={(x) => x.id}
        renderRow={(x) => <ThingRowView thing={x} showPath />}
        empty={
          <EmptyState title={<Trans>Nothing yet</Trans>}>
            {kind === 'people' ? (
              <Trans>Things show here when you set who they belong to, on the thing's page.</Trans>
            ) : kind === 'brands' ? (
              <Trans>Things show here when you set their brand.</Trans>
            ) : (
              <Trans>Things show here when a purchase from here is recorded for them.</Trans>
            )}
          </EmptyState>
        }
      />
    </Section>
  );
}

function ExternalLink({ href }: { href: string }) {
  const safe = /^https?:\/\//i.test(href);
  if (!safe) return <span dir="ltr">{href}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      dir="ltr"
      className="text-info underline-offset-2 hover:underline [overflow-wrap:anywhere]"
    >
      {href.replace(/^https?:\/\//i, '')}
    </a>
  );
}
