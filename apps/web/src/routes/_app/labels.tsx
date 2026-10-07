/**
 * Labels (plan T28; D43, D44, D137, D175). Without a source it is the labels screen: "Print
 * pending labels (N)" for this phone's offline captures, per location "Label everything
 * unprinted" and "Blank sheet", recent batches to reprint (a reprint uses the same codes, D45),
 * and the locations where Labels is off. With a source in the URL it is the batch builder:
 *
 *   ?loc=<id>&things=<id>,<id>   a selection, or a thing's own label
 *   ?loc=<id>&places=<id>        a place's label
 *   ?loc=<id>&unprinted=1        everything unprinted in the location (&place=<id>: in a place)
 *   ?loc=<id>&blank=<n>          a blank sheet
 *
 * `validateSearch` is not code-split (D80), so it stays a few lines of plain checks.
 */
import { can, labelStock } from '@kept/shared';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { createFileRoute, Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useLabelBatches, useLabelSummary } from '@/api/capture/queries';
import type { LabelBatch } from '@/api/capture/types';
import { useLocation, useLocations } from '@/api/queries';
import type { LocationDetail } from '@/api/types';
import { BoxIcon, PrinterIcon, QrIcon, TagIcon } from '@/components/icons';
import { BatchBuilder, type BatchSource, MAX_BLANK } from '@/components/labels/batch-builder';
import { perPage } from '@/components/labels/layout';
import { PendingPrompt } from '@/components/labels/pending-prompt';
import { rememberedStock, useStockText } from '@/components/labels/stock-picker';
import {
  EmptyState,
  ErrorState,
  List,
  LoadingRows,
  Notice,
  Page,
  Pill,
  Row,
  Section,
} from '@/components/page';
import { Button } from '@/components/ui/button';
import { useFormat } from '@/lib/format';
import { useLocationName } from '@/lib/labels';

export type LabelsSearch = {
  loc?: string;
  things?: string;
  places?: string;
  unprinted?: 1;
  place?: string;
  blank?: number;
};

const text = (v: unknown) =>
  typeof v === 'string' && v.length > 0 && v.length < 20_000 ? v : undefined;

export const Route = createFileRoute('/_app/labels')({
  validateSearch: (s: Record<string, unknown>): LabelsSearch => {
    const out: LabelsSearch = {};
    const loc = text(s.loc);
    if (loc) out.loc = loc;
    const things = text(s.things);
    if (things) out.things = things;
    const places = text(s.places);
    if (places) out.places = places;
    if (s.unprinted === 1 || s.unprinted === '1') out.unprinted = 1;
    const place = text(s.place);
    if (place) out.place = place;
    const blank = Number(s.blank);
    if (Number.isInteger(blank) && blank > 0) out.blank = blank;
    return out;
  },
  component: LabelsPage,
});

const ids = (csv: string) => csv.split(',').filter(Boolean).slice(0, 500);

function sourceOf(s: LabelsSearch): BatchSource | null {
  if (!s.loc) return null;
  const locationId = s.loc;
  if (s.blank) return { locationId, kind: 'blank', blankCount: Math.min(s.blank, MAX_BLANK) };
  if (s.unprinted)
    return { locationId, kind: 'things', unprinted: s.place ? { placeId: s.place } : {} };
  if (s.things) return { locationId, kind: 'things', thingIds: ids(s.things) };
  if (s.places) return { locationId, kind: 'places', placeIds: ids(s.places) };
  return null;
}

const labelsOn = (l: LocationDetail) => (l.effectiveModules ?? l.modules).includes('labels');
const isAdmin = (l: LocationDetail) => l.role === 'owner' || l.role === 'admin';

function LabelsPage() {
  const { t } = useLingui();
  const source = sourceOf(Route.useSearch());
  if (source)
    return (
      <Page title={t`Print labels`} back="/labels" wide>
        <Builder source={source} />
      </Page>
    );
  return (
    <Page title={t`Labels`} wide>
      <LabelsHome />
    </Page>
  );
}

function Builder({ source }: { source: BatchSource }) {
  const location = useLocation(source.locationId);
  if (location.isPending) return <LoadingRows />;
  if (location.isError)
    return <ErrorState error={location.error} onRetry={() => location.refetch()} />;
  const l = location.data;
  if (!labelsOn(l)) return <LabelsOff location={l} />;
  if (!can(l.role, 'labels.use'))
    return (
      <Notice>
        <Trans>Printing labels is for members and admins of this location.</Trans>
      </Notice>
    );
  return <BatchBuilder key={JSON.stringify(source)} source={source} location={l} />;
}

function TurnOn({ location }: { location: LocationDetail }) {
  return (
    <Link
      to="/settings/location/$id/track"
      params={{ id: location.id }}
      className="shrink-0 text-small font-semibold text-ink underline underline-offset-2 outline-none focus-visible:outline-2 focus-visible:outline-info"
    >
      <Trans>Turn on</Trans>
    </Link>
  );
}

/** The module is off here (screens §3): say so, with "Turn on" for admins. */
function LabelsOff({ location }: { location: LocationDetail }) {
  const admin = isAdmin(location);
  return (
    <Notice
      title={<Trans>Off in this location</Trans>}
      action={admin ? <TurnOn location={location} /> : undefined}
    >
      {admin ? (
        <Trans>Labels are switched off here. Turn them on in What to track.</Trans>
      ) : (
        <Trans>Labels are switched off here. Ask an admin to turn them on.</Trans>
      )}
    </Notice>
  );
}

function LabelsHome() {
  const locations = useLocations();
  const locationName = useLocationName();
  if (locations.isPending) return <LoadingRows />;
  if (locations.isError)
    return <ErrorState error={locations.error} onRetry={() => locations.refetch()} />;
  const all = locations.data as LocationDetail[];
  const on = all.filter((l) => labelsOn(l) && can(l.role, 'labels.use'));
  const off = all.filter((l) => !labelsOn(l));
  return (
    <>
      <PendingPrompt />
      {on.length === 0 ? (
        <EmptyState icon={<TagIcon />} title={<Trans>No location to print labels for</Trans>}>
          <Trans>Labels are off, or you can only view, in every location you're in.</Trans>
        </EmptyState>
      ) : (
        on.map((l) => <LocationLabels key={l.id} location={l} name={locationName(l)} />)
      )}
      <RecentBatches locations={all} />
      {off.length > 0 ? (
        <Section title={<Trans>Labels off</Trans>}>
          <List>
            {off.map((l) => (
              <li key={l.id}>
                <Row
                  title={<bdi>{locationName(l)}</bdi>}
                  subtitle={<Trans>Off in this location</Trans>}
                  trailing={isAdmin(l) ? <TurnOn location={l} /> : undefined}
                />
              </li>
            ))}
          </List>
        </Section>
      ) : null}
    </>
  );
}

const tileClass =
  'grid size-10 shrink-0 place-items-center rounded-[10px] bg-sunken text-ink-2 [&_svg]:size-5';
const rowLinkClass =
  'block text-ink no-underline outline-none hover:bg-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-info';

function LinkRow({
  icon,
  title,
  subtitle,
  search,
  disabled = false,
}: {
  icon: ReactNode;
  title: ReactNode;
  subtitle: ReactNode;
  search: LabelsSearch;
  disabled?: boolean;
}) {
  const leading = (
    <span aria-hidden="true" className={tileClass}>
      {icon}
    </span>
  );
  return (
    <li>
      {disabled ? (
        <Row
          leading={leading}
          title={<span className="text-ink-3">{title}</span>}
          subtitle={subtitle}
        />
      ) : (
        <Link to="/labels" search={search} className={rowLinkClass}>
          <Row leading={leading} title={title} subtitle={subtitle} />
        </Link>
      )}
    </li>
  );
}

function LocationLabels({ location, name }: { location: LocationDetail; name: string }) {
  const summary = useLabelSummary(location.id);
  const fmt = useFormat();
  const unprinted = summary.data?.unprinted ?? 0;
  const stock = labelStock(rememberedStock());
  const sheetCount = Math.min(MAX_BLANK, perPage(stock) > 1 ? perPage(stock) : 10);
  const b = fmt.num(summary.data?.blankUnclaimed ?? 0);
  const s = fmt.num(sheetCount);
  return (
    <Section title={<bdi>{name}</bdi>}>
      <List>
        <LinkRow
          icon={<PrinterIcon />}
          title={<Trans>Label everything unprinted</Trans>}
          subtitle={
            summary.isPending ? (
              <Trans>Counting…</Trans>
            ) : unprinted === 0 ? (
              <Trans>Every thing here has a printed label</Trans>
            ) : (
              plural(unprinted, {
                one: '# thing has no printed label',
                other: '# things have no printed label',
              })
            )
          }
          search={{ loc: location.id, unprinted: 1 }}
          disabled={!summary.isPending && unprinted === 0}
        />
        <LinkRow
          icon={<QrIcon />}
          title={<Trans>Blank sheet ({s})</Trans>}
          subtitle={
            <Trans>Stick them on now, name them on the first scan. {b} unclaimed here.</Trans>
          }
          search={{ loc: location.id, blank: sheetCount }}
        />
      </List>
    </Section>
  );
}

function RecentBatches({ locations }: { locations: LocationDetail[] }) {
  const { t } = useLingui();
  const fmt = useFormat();
  const stockText = useStockText();
  const locationName = useLocationName();
  const batches = useLabelBatches();
  const items = batches.data?.pages.flatMap((p) => p.items) ?? [];
  if (batches.isPending) return <LoadingRows rows={2} label={t`Loading recent batches`} />;
  if (items.length === 0) return null;
  const titleOf = (b: LabelBatch) => {
    const n = b.labels.length;
    return b.kind === 'blank'
      ? plural(n, { one: '# blank label', other: '# blank labels' })
      : plural(n, { one: '# label', other: '# labels' });
  };
  const stockName = (key: string) => {
    try {
      return stockText(labelStock(key)).title;
    } catch {
      return key; // A stock this build doesn't know.
    }
  };
  return (
    <Section title={<Trans>Recent batches</Trans>}>
      <List>
        {items.map((b) => {
          const loc = locations.find((l) => l.id === b.locationId);
          const stock = stockName(b.stock);
          const when = fmt.day(b.createdAt);
          const where = loc ? locationName(loc) : '';
          return (
            <li key={b.id}>
              <Link to="/labels/$batchId" params={{ batchId: b.id }} className={rowLinkClass}>
                <Row
                  leading={
                    <span aria-hidden="true" className={tileClass}>
                      {b.kind === 'blank' ? <QrIcon /> : <BoxIcon />}
                    </span>
                  }
                  title={titleOf(b)}
                  subtitle={
                    <Trans>
                      <bdi>{where}</bdi> · {stock} · {when}
                    </Trans>
                  }
                  trailing={
                    b.printedConfirmedAt ? (
                      <Pill tone="ok">
                        <Trans>Printed</Trans>
                      </Pill>
                    ) : (
                      <Pill>
                        <Trans>Not confirmed</Trans>
                      </Pill>
                    )
                  }
                />
              </Link>
            </li>
          );
        })}
      </List>
      {batches.hasNextPage ? (
        <Button
          variant="secondary"
          size="small"
          className="justify-self-start"
          isPending={batches.isFetchingNextPage}
          onPress={() => batches.fetchNextPage()}
        >
          <Trans>Load more</Trans>
        </Button>
      ) : null}
    </Section>
  );
}
