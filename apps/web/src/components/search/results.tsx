/**
 * Search results (screens §5 Search, frames 04 · 1 and 04 · 10; D42, D195): grouped by kind
 * (things, places, people, vendors, documents), and things by location within their group, best
 * match first. Documents are the attachments whose text matches (T21, components/search/
 * documents.tsx); offline, their group says they need a connection (§8).
 *
 * A thing shows its type or photo, its name with the words that matched marked, "matched:
 * <alias>" when only an alias matched (screens §8), its ID chip and states, and where it is:
 * its **container's photo** beside the full path (D195). Things page with "Load more" under the
 * list standard; the smaller groups show their first five and a "Show all".
 *
 * With nothing matched: "No match for 'hmdi'" and the server's did-you-mean (§5).
 *
 * Step 6 (T24, D200): a thing found only by meaning says "matched by meaning", and when the server
 * searched by words only, a quiet note says why (./semantic-note.tsx).
 *
 * Offline (or when the server can't be reached), the Things group searches the phone's copy
 * instead, "on this phone · as of last sync" (./offline-results.tsx).
 */
import { normalize, searchVariants } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import type { InfiniteData, UseInfiniteQueryResult } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import { isApiError } from '@/api/client';
import type {
  Page,
  PersonResult,
  PlaceResult,
  SearchParams,
  SearchResponse,
  ThingRow,
  VendorResult,
} from '@/api/inventory/types';
import { useLocations } from '@/api/queries';
import { BuildingIcon, ChevronEndIcon, PersonIcon, SearchIcon } from '@/components/icons';
import { IdChip } from '@/components/id-chip';
import { ListSurface } from '@/components/list-surface';
import { EmptyState, List, Section } from '@/components/page';
import { placeIcon, usePlaceName } from '@/components/places/labels';
import { rowLink, Tile } from '@/components/places/rows';
import { StatusPill } from '@/components/status-pill';
import { TypeIcon } from '@/components/type-icon';
import { Button } from '@/components/ui/button';
import { addressOf } from '@/lib/address';
import { sep, useFormat } from '@/lib/format';
import { useLocationName } from '@/lib/labels';
import { useOnline } from '@/lib/online';
import { useOffline } from '@/offline/provider';
import { useSearchGroup, useSearchPages } from './api';
import { DocumentsGroup, DocumentsOffline } from './documents';
import { OfflineResults } from './offline-results';
import { MatchedByMeaning, SemanticNote } from './semantic-note';

const WORD = /[\p{L}\p{N}]+/gu;

/** The search forms of each word of `q` (normalised, and prefix-stripped), for marking matches. */
export function queryForms(q: string): string[] {
  return (normalize(q).match(WORD) ?? []).flatMap((w) => searchVariants(w));
}

/** `text` with each word that a query word is a prefix of wrapped in <mark> (whole words). */
export function Marked({ text, forms }: { text: string; forms: string[] }) {
  if (!forms.length) return <>{text}</>;
  // Plain text stays plain text nodes (a span per word would drop the spaces from a link's
  // accessible name); only the matched words are elements.
  const out: ReactNode[] = [];
  let plain = '';
  text.split(/(\s+)/).forEach((part, i) => {
    const words = normalize(part).match(WORD) ?? [];
    const hit = words.some((w) =>
      searchVariants(w).some((v) => forms.some((f) => v.startsWith(f))),
    );
    if (!hit) {
      plain += part;
      return;
    }
    if (plain) out.push(plain);
    plain = '';
    out.push(
      // biome-ignore lint/suspicious/noArrayIndexKey: the words of one name, in order
      <mark key={i} className="rounded-[3px] bg-amber/35 px-px text-inherit">
        {part}
      </mark>,
    );
  });
  if (plain) out.push(plain);
  return <>{out}</>;
}

export type SearchResultsProps = {
  params: SearchParams;
  /** Called when a result is opened (to remember the search). */
  onOpen?: () => void;
  /** Replace the words with a suggestion ("Did you mean"). */
  onSuggest: (q: string) => void;
};

export function SearchResults({ params, onOpen, onSuggest }: SearchResultsProps) {
  const fmtCount = useFormat();
  const { t } = useLingui();
  const query = useSearchPages(params, true);
  const online = useOnline();
  const first = query.data?.pages[0];
  const things = query.data?.pages.flatMap((pg) => pg.things.items) ?? [];
  const forms = queryForms(params.q ?? '');
  const locations = useLocations();
  const nameOf = useLocationName();
  const store = useOffline()?.store ?? null;
  const locName = (id: string) => {
    const l = locations.data?.find((x) => x.id === id);
    return l ? nameOf(l) : '';
  };

  // Things, grouped by location in the order each location first appears (best match first).
  const order: string[] = [];
  for (const th of things) if (!order.includes(th.locationId)) order.push(th.locationId);
  const grouped = order.flatMap((loc) => things.filter((th) => th.locationId === loc));
  const headingFor = new Map<string, { loc: string; count: number }>();
  for (const loc of order) {
    const inLoc = grouped.filter((th) => th.locationId === loc);
    if (inLoc[0]) headingFor.set(inLoc[0].id, { loc, count: inLoc.length });
  }
  const thingsQuery = {
    ...query,
    data: query.data
      ? {
          pages: [
            { items: grouped, next_cursor: query.data.pages.at(-1)?.things.next_cursor ?? null },
          ],
          pageParams: [undefined],
        }
      : undefined,
  } as unknown as UseInfiniteQueryResult<InfiniteData<Page<ThingRow>>>;

  const total =
    things.length +
    (first?.places.length ?? 0) +
    (first?.people.length ?? 0) +
    (first?.vendors.length ?? 0) +
    (first?.documents.items.length ?? 0);

  // No connection, or a server that can't be reached: the phone answers what it can.
  const unreachable = isApiError(query.error) && query.error.code === 'offline';
  if (store && (!online || unreachable))
    return (
      <div className="grid gap-5">
        <OfflineResults store={store} params={params} onOpen={onOpen} />
        <DocumentsOffline />
      </div>
    );

  if (first && total === 0 && online)
    return (
      <div className="grid gap-5">
        <SemanticNote semantic={first.semantic} />
        <NoMatch q={params.q ?? ''} didYouMean={first.didYouMean} onSuggest={onSuggest} />
      </div>
    );

  const count = things.length;
  const countText = fmtCount.num(count);
  return (
    <div className="grid gap-5">
      <SemanticNote semantic={first?.semantic} />
      {query.isPending || things.length > 0 || query.isError ? (
        <Section
          title={
            <>
              <Trans>Things</Trans>{' '}
              <span className="font-normal normal-case tracking-normal text-ink-3">
                {sep()}
                {query.hasNextPage ? t`${countText}+` : countText}
              </span>
            </>
          }
          action={
            count > 1 ? (
              <span className="text-small text-ink-3">
                <Trans>Best match first</Trans>
              </span>
            ) : undefined
          }
        >
          <ListSurface<ThingRow>
            label={t`Things found`}
            search={false}
            query={thingsQuery}
            getKey={(th) => th.id}
            renderRow={(th) => {
              const head = headingFor.get(th.id);
              return (
                <>
                  {head && order.length > 1 ? (
                    <div className="eyebrow bg-sunken px-3.5 py-2" role="presentation">
                      <bdi>{locName(head.loc)}</bdi>
                      {sep()}
                      {fmtCount.num(head.count)}
                    </div>
                  ) : null}
                  <ThingResult
                    thing={th}
                    forms={forms}
                    locationName={locName(th.locationId)}
                    onOpen={onOpen}
                  />
                </>
              );
            }}
            empty={null}
            noMatch={null}
          />
        </Section>
      ) : null}
      {first ? (
        <>
          <Group
            kind="places"
            title={<Trans>Places</Trans>}
            params={params}
            first={first}
            render={(pl: PlaceResult) => (
              <PlaceResultRow
                key={pl.id}
                place={pl}
                forms={forms}
                locationName={locName(pl.locationId)}
                onOpen={onOpen}
              />
            )}
          />
          <Group
            kind="people"
            title={<Trans>People</Trans>}
            params={params}
            first={first}
            render={(x: PersonResult) => (
              <RegistryRow
                key={x.id}
                to="/people/$id"
                id={x.id}
                name={x.displayName}
                forms={forms}
                icon={<PersonIcon />}
                onOpen={onOpen}
              />
            )}
          />
          <Group
            kind="vendors"
            title={<Trans>Shops and services</Trans>}
            params={params}
            first={first}
            render={(x: VendorResult) => (
              <RegistryRow
                key={x.id}
                to="/vendors/$id"
                id={x.id}
                name={x.name}
                forms={forms}
                icon={<BuildingIcon />}
                onOpen={onOpen}
              />
            )}
          />
          {online ? (
            <DocumentsGroup
              params={params}
              first={first}
              locationName={locName}
              mark={(text) => <Marked text={text} forms={forms} />}
              onOpen={onOpen}
            />
          ) : null}
        </>
      ) : null}
      {!online ? <DocumentsOffline /> : null}
    </div>
  );
}

const GROUP_PREVIEW = 5;

function Group<K extends 'places' | 'people' | 'vendors'>({
  kind,
  title,
  params,
  first,
  render,
}: {
  kind: K;
  title: ReactNode;
  params: SearchParams;
  first: SearchResponse;
  render: (item: SearchResponse[K][number]) => ReactNode;
}) {
  const fmtGroup = useFormat();
  const [all, setAll] = useState(false);
  const full = useSearchGroup(params, kind, all);
  const items = (all && full.data ? full.data[kind] : first[kind]) as SearchResponse[K];
  if (items.length === 0) return null;
  return (
    <Section
      title={
        <>
          {title}{' '}
          <span className="font-normal normal-case tracking-normal text-ink-3">
            {sep()}
            {fmtGroup.num(items.length)}
          </span>
        </>
      }
    >
      <List>
        {items.map((item) => (
          <li key={item.id}>{render(item)}</li>
        ))}
      </List>
      {!all && first[kind].length >= GROUP_PREVIEW ? (
        <Button
          variant="secondary"
          size="small"
          className="justify-self-start"
          onPress={() => setAll(true)}
          isPending={all && full.isPending}
        >
          <Trans>Show all</Trans>
        </Button>
      ) : null}
    </Section>
  );
}

/** "Home › Office › Desk drawer › Cable box", with the location first. */
function FullPath({
  location,
  steps,
}: {
  location: string;
  steps: { id: string; name: string; isUnplaced?: boolean }[];
}) {
  const placeName = usePlaceName();
  const parts = [location, ...steps.map((s) => placeName(s))].filter(Boolean);
  return (
    <span className="[overflow-wrap:anywhere]">
      {parts.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a path, in order
        <span key={i}>
          {i > 0 ? <span aria-hidden="true"> › </span> : null}
          <bdi>{p}</bdi>
        </span>
      ))}
    </span>
  );
}

export function ThingResult({
  thing,
  forms,
  locationName,
  onOpen,
}: {
  thing: ThingRow;
  forms: string[];
  locationName: string;
  onOpen?: () => void;
}) {
  const f = useFormat();
  // Captured offline and not synced yet: no short ID until the server allocates one (D112).
  const pending = thing.shortCode === null;
  return (
    <Link to="/t/$id" params={{ id: addressOf(thing) }} onClick={onOpen} className={rowLink}>
      <Tile>
        {thing.thumbUrl ? (
          <img src={thing.thumbUrl} alt="" className="size-full object-cover" />
        ) : (
          <TypeIcon icon={thing.type?.icon} />
        )}
      </Tile>
      <span className="grid min-w-0 flex-1 gap-1">
        <span className="font-semibold text-[15px] leading-snug [overflow-wrap:anywhere]">
          {thing.name ? (
            <bdi>
              <Marked text={thing.name} forms={forms} />
            </bdi>
          ) : (
            <Trans>Untitled draft</Trans>
          )}
          {thing.quantity > 1 ? (
            <span className="ms-1.5 font-normal text-ink-2 text-small">
              <span aria-hidden="true">× </span>
              <span className="sr-only">
                <Trans>quantity</Trans>{' '}
              </span>
              {f.num(thing.quantity)}
            </span>
          ) : null}
        </span>
        {thing.matchedBy === 'meaning' && !thing.matchedAlias ? <MatchedByMeaning /> : null}
        {thing.matchedAlias ? (
          <span className="text-small text-ink-2">
            <Trans>
              matched:{' '}
              <bdi className="font-medium text-ink">
                <Marked text={thing.matchedAlias} forms={forms} />
              </bdi>
            </Trans>
          </span>
        ) : null}
        <span className="flex items-center gap-2 text-small text-ink-2">
          {thing.containerThumbUrl ? (
            <img
              src={thing.containerThumbUrl}
              alt=""
              data-container-photo=""
              className="size-7 shrink-0 rounded-md border border-line object-cover"
            />
          ) : null}
          <FullPath location={locationName} steps={thing.path} />
        </span>
        {thing.shortCode || thing.derivedState.length || pending ? (
          <span className="flex flex-wrap items-center gap-1.5">
            <IdChip code={thing.shortCode} pending={pending} />
            {thing.derivedState.map((s) => (
              <StatusPill key={s} state={s} />
            ))}
          </span>
        ) : null}
      </span>
    </Link>
  );
}

function PlaceResultRow({
  place,
  forms,
  locationName,
  onOpen,
}: {
  place: PlaceResult;
  forms: string[];
  locationName: string;
  onOpen?: () => void;
}) {
  return (
    <Link to="/p/$id" params={{ id: place.id }} onClick={onOpen} className={rowLink}>
      <Tile>
        <TypeIcon icon={placeIcon({ ...place, isUnplaced: false })} />
      </Tile>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="font-semibold text-[15px] leading-snug [overflow-wrap:anywhere]">
          <bdi>
            <Marked text={place.name} forms={forms} />
          </bdi>
        </span>
        <span className="text-small text-ink-2">
          <FullPath location={locationName} steps={place.path} />
        </span>
      </span>
      <ChevronEndIcon className="size-5 shrink-0 text-ink-3" />
    </Link>
  );
}

function RegistryRow({
  to,
  id,
  name,
  forms,
  icon,
  onOpen,
}: {
  to: '/people/$id' | '/vendors/$id';
  id: string;
  name: string;
  forms: string[];
  icon: ReactNode;
  onOpen?: () => void;
}) {
  return (
    <Link to={to} params={{ id }} onClick={onOpen} className={rowLink}>
      <Tile>{icon}</Tile>
      <span className="min-w-0 flex-1 font-semibold text-[15px] leading-snug [overflow-wrap:anywhere]">
        <bdi>
          <Marked text={name} forms={forms} />
        </bdi>
      </span>
      <ChevronEndIcon className="size-5 shrink-0 text-ink-3" />
    </Link>
  );
}

function NoMatch({
  q,
  didYouMean,
  onSuggest,
}: {
  q: string;
  didYouMean: string[];
  onSuggest: (q: string) => void;
}) {
  return (
    <EmptyState
      icon={<SearchIcon />}
      title={
        q ? (
          <Trans>
            No match for ‘<bdi>{q}</bdi>’
          </Trans>
        ) : (
          <Trans>Nothing matches these filters</Trans>
        )
      }
      action={
        didYouMean.length ? (
          <div className="grid justify-items-center gap-2">
            <span className="text-small text-ink-2">
              <Trans>Did you mean</Trans>
            </span>
            <div className="flex flex-wrap justify-center gap-2">
              {didYouMean.map((s) => (
                <Button key={s} variant="secondary" size="small" onPress={() => onSuggest(s)}>
                  <bdi>{s}</bdi>
                </Button>
              ))}
            </div>
          </div>
        ) : undefined
      }
    >
      <Trans>Try fewer words, another spelling, or clear a filter.</Trans>
    </EmptyState>
  );
}
