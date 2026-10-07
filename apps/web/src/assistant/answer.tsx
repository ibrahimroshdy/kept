/**
 * One answer from the assistant (D22, D179, D195; screens §5 "Replies", frame 04 · 4): the text
 * through the link-only renderer (./link-only-markdown.tsx), then every thing it links, each with
 * its full path and, beside the path, its container's photo, as Search shows them (D195). Those
 * rows come from Kept's own API (`GET /things/:id`), never from model text: the photo is Kept's
 * own file URL, and the name and path are what Kept holds now. While a row loads it shows what the
 * tool said (the turn saw it), as untrusted text.
 *
 * Also here: what a turn's tool steps say ("Looked in Garage"), and a part redacted because the
 * person lost access to its location (D164), which names nothing.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import { inventoryApi, inventoryKeys } from '@/api/inventory/queries';
import { useLocations } from '@/api/queries';
import { IdChip } from '@/components/id-chip';
import { usePlaceName } from '@/components/places/labels';
import { isolate } from '@/lib/bidi';
import { useFormat } from '@/lib/format';
import { useLocationName } from '@/lib/labels';
import { type Block, LinkOnlyMarkdown, linkedIds, parse } from './link-only-markdown';

/** What a tool result said about a thing: its name and path, user-written (D179). */
export type SeenThing = { name: string; path: string[]; shortCode: string | null };
export type SeenIndex = ReadonlyMap<string, SeenThing>;

/** At most this many things are listed under one answer; the text links every one. */
const MAX_REFS = 6;

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/**
 * Every thing a set of tool outputs named (`{id, short_code?, untrusted: {name, path?}}`, the
 * output contract's thingRef), by id.
 */
export function seenThings(outputs: readonly unknown[]): Map<string, SeenThing> {
  const out = new Map<string, SeenThing>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 8 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    const o = v as Record<string, unknown>;
    const u = o.untrusted as Record<string, unknown> | undefined;
    if (typeof o.id === 'string' && u && typeof u.name === 'string' && !out.has(o.id))
      out.set(o.id, {
        name: u.name,
        path: strings(u.path ?? o.path),
        shortCode: typeof o.short_code === 'string' ? o.short_code : null,
      });
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  for (const output of outputs) walk(output, 0);
  return out;
}

/** A thumbnail URL Kept serves itself (a path on this origin), never one from elsewhere. */
export const ownFileUrl = (url: string | null | undefined): url is string =>
  !!url && ((url.startsWith('/') && !url.startsWith('//')) || url.startsWith('data:image/'));

/** "Home › Office › Desk drawer", each part isolated. */
export function PathText({ parts }: { parts: string[] }) {
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

function ThingRef({
  id,
  seen,
  onNavigate,
}: {
  id: string;
  seen: SeenThing | undefined;
  onNavigate?: () => void;
}) {
  const { t } = useLingui();
  const f = useFormat();
  const locations = useLocations();
  const locationName = useLocationName();
  const placeName = usePlaceName();
  const thing = useQuery({
    queryKey: inventoryKeys.things.detail(id),
    queryFn: () => inventoryApi.thing(id),
    retry: false,
  });
  const live = thing.data;
  const location = live ? locations.data?.find((l) => l.id === live.locationId) : undefined;
  const name = live ? (live.name ?? t`Untitled draft`) : (seen?.name ?? '');
  const path = live
    ? [location ? locationName(location) : '', ...live.path.map((s) => placeName(s))].filter(
        Boolean,
      )
    : (seen?.path ?? []);
  const code = live ? live.shortCode : (seen?.shortCode ?? null);
  if (!name) return null;
  return (
    <li className="grid min-h-11 gap-1 border-line px-3 py-2.5 not-first:border-t">
      <Link
        to="/t/$id"
        params={{ id: code ?? id }}
        onClick={onNavigate}
        className="w-fit font-semibold text-[14.5px] text-ink leading-snug underline decoration-ink-3 decoration-1 underline-offset-[3px] outline-none [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-info"
      >
        <bdi>{name}</bdi>
        {live && live.quantity > 1 ? (
          <span className="ms-1.5 font-normal text-ink-2 text-small no-underline">
            × {f.num(live.quantity)}
          </span>
        ) : null}
      </Link>
      {path.length ? (
        <span className="flex items-center gap-2 text-small text-ink-2">
          {ownFileUrl(live?.containerThumbUrl) ? (
            <img
              src={live.containerThumbUrl}
              alt=""
              data-container-photo=""
              className="size-7 shrink-0 rounded-md border border-line object-cover"
            />
          ) : null}
          <PathText parts={path} />
        </span>
      ) : null}
      {code ? (
        <span className="flex">
          <IdChip code={code} />
        </span>
      ) : null}
    </li>
  );
}

export function Answer({
  text,
  seen,
  onNavigate,
}: {
  text: string;
  seen: SeenIndex;
  onNavigate?: () => void;
}) {
  const { t } = useLingui();
  const blocks: Block[] = useMemo(() => parse(text), [text]);
  const things = linkedIds(blocks)
    .filter((l) => l.kind === 'thing')
    .slice(0, MAX_REFS);
  const nav = onNavigate ? { onNavigate } : {};
  return (
    <div className="grid gap-2">
      <LinkOnlyMarkdown blocks={blocks} {...nav} />
      {things.length ? (
        <ul
          aria-label={t`Things in this answer`}
          className="m-0 grid list-none rounded-[10px] border border-line bg-paper p-0"
        >
          {things.map((l) => (
            <ThingRef key={l.id} id={l.id} seen={seen.get(l.id)} {...nav} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** A part the person may no longer see (D164): it names no location. */
export function Redacted() {
  return (
    <p className="m-0 rounded-[10px] border border-dashed border-line px-3 py-2 text-small text-ink-2">
      <Trans>Removed: you no longer have access to this</Trans>
    </p>
  );
}

/**
 * A tool step as a quiet line (screens §5: "Looked in Garage"): what the tool does, in Kept's own
 * words, and the locations its result came from. Never the model's arguments.
 */
export function ToolStep({
  tool,
  locationIds,
  pending,
}: {
  tool: string;
  locationIds: string[] | null;
  pending: boolean;
}) {
  const { t, i18n } = useLingui();
  const locations = useLocations();
  const locationName = useLocationName();
  const names = (locationIds ?? [])
    .map((id) => locations.data?.find((l) => l.id === id))
    .filter((l): l is NonNullable<typeof l> => !!l)
    .map((l) => isolate(locationName(l)));
  const where = names.length
    ? new Intl.ListFormat(i18n.locale, { type: 'conjunction' }).format(names)
    : '';
  let text: string;
  if (pending) text = t`Looking…`;
  else if (tool === 'capabilities' || tool === 'list_locations') text = t`Checked your locations`;
  else if (tool === 'upcoming')
    text = where ? t`Checked what's due in ${where}` : t`Checked what's due`;
  else if (tool === 'find_documents')
    text = where ? t`Looked through the paperwork in ${where}` : t`Looked through the paperwork`;
  else text = where ? t`Looked in ${where}` : t`Looked it up`;
  return (
    <p className="m-0 flex items-center gap-1.5 text-small text-ink-3">
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-line" />
      {text}
    </p>
  );
}
