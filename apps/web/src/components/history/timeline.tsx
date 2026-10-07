/**
 * The history timeline (D76, D110, D183), for a thing's History tab (task 26 hosts it), a place's
 * page, and the Activity feed (which reuses `EventRow` and `useDayHeadings`).
 *
 *   <HistoryTimeline subject={{ kind: 'thing', id }} />
 *   <HistoryTimeline subject={{ kind: 'place', id }} heading={<Trans>History</Trans>} />
 *
 * Rows are the server's rendered events, newest first, under the list standard (cursor
 * pagination; history has no search or filters of its own). Each shows who, when, the one-line
 * summary and every changed field as before → after. What the server withheld stays withheld:
 * money you may not see arrives as `hidden` and reads "hidden" (never a value, never "empty"); a
 * secret reads "changed · value not recorded" (D110). A thing that moved in from a location you
 * can't see is its own row, "Moved in from another location", with no old path (D183). A thing's
 * AI calls (D206) are rows of their own, with the AI line (components/ai/ai-history-row.tsx).
 */
import { printedCode } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useEffect, useMemo, useRef } from 'react';
import { useUndoable } from '@/api/capture/queries';
import { inventoryApi, inventoryKeys as k, nextCursor } from '@/api/inventory/queries';
import type { HistoryEvent, RenderedChange } from '@/api/inventory/types';
import { AiHistoryRow } from '@/components/ai/ai-history-row';
import { ActivityIcon, BoxIcon, LockIcon } from '@/components/icons';
import { ListSurface } from '@/components/list-surface';
import { Avatar, EmptyState, Pill, Section } from '@/components/page';
import { Button } from '@/components/ui/button';
import { addressOf } from '@/lib/address';
import { sep, useBytes, useFormat } from '@/lib/format';
import { cn } from '@/lib/utils';
import { FSI, PDI, plainText, useFieldLabel, useSummary, useValueWords } from './labels';
import { useUndo } from './undo';

export type HistorySubject = { kind: 'thing' | 'place'; id: string };

export type HistoryTimelineProps = {
  /** Whose history: a thing (its own events, and those rooted in it) or a place. */
  subject: HistorySubject;
  /** A section heading above the list; none by default (a tab already names it). */
  heading?: ReactNode;
  className?: string;
};

/** The history of one thing or place, newest first, grouped by day. */
export function HistoryTimeline({ subject, heading, className }: HistoryTimelineProps) {
  const { t } = useLingui();
  const query = useInfiniteQuery({
    queryKey:
      subject.kind === 'thing' ? k.things.history(subject.id) : k.places.history(subject.id),
    queryFn: ({ pageParam }) =>
      subject.kind === 'thing'
        ? inventoryApi.thingHistory(subject.id, pageParam)
        : inventoryApi.placeHistory(subject.id, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });
  const events = query.data?.pages.flatMap((pg) => pg.items) ?? [];
  const dayOf = useDayHeadings(events);
  const undoable = useThingUndoable(subject, query.dataUpdatedAt);
  const list = (
    <ListSurface<HistoryEvent>
      label={t`History`}
      search={false}
      query={query}
      getKey={(e) => e.id}
      renderRow={(e) => (
        <>
          {dayOf.get(e.id) ? <DayHeading>{dayOf.get(e.id)}</DayHeading> : null}
          {e.aiCall ? (
            <AiHistoryRow event={e} />
          ) : (
            <EventRow event={e} {...(undoable ? { undoable: undoable.has(e.id) } : {})} />
          )}
        </>
      )}
      empty={
        <EmptyState icon={<ActivityIcon />} title={<Trans>No history yet</Trans>}>
          {subject.kind === 'thing' ? (
            <Trans>Changes to this thing show here, newest first.</Trans>
          ) : (
            <Trans>Changes to this place show here, newest first.</Trans>
          )}
        </EmptyState>
      }
      className={className}
    />
  );
  return heading ? <Section title={heading}>{list}</Section> : list;
}

/**
 * A thing's timeline offers Undo on the events the server still lets you undo (`GET
 * /things/:id/undoable`, D150: 7 days), re-read whenever the history is. A place's history, and
 * the Activity feed, decide from each event (undo.ts `isUndoable`). Null: not a thing.
 */
function useThingUndoable(subject: HistorySubject, historyAt: number): Set<string> | null {
  const thingId = subject.kind === 'thing' ? subject.id : '';
  const undoable = useUndoable(thingId);
  const { refetch } = undoable;
  const first = useRef(true);
  useEffect(() => {
    if (!thingId || !historyAt) return;
    // The first history load and the first list load go together; later ones re-read it.
    if (first.current) {
      first.current = false;
      return;
    }
    void refetch();
  }, [thingId, historyAt, refetch]);
  const items = undoable.data?.items;
  return useMemo(
    () => (thingId ? new Set((items ?? []).map((i) => i.eventId)) : null),
    [thingId, items],
  );
}

// ----- rows ------------------------------------------------------------------------------------

/**
 * "Today · Mon 19 Oct" above the first event of each day. Returns, per event id, the heading to
 * show before it (only the first event of a day has one).
 */
export function useDayHeadings(events: HistoryEvent[]): Map<string, string> {
  const { t } = useLingui();
  const f = useFormat();
  const out = new Map<string, string>();
  const dayKey = (iso: string) => new Date(iso).toDateString();
  const today = dayKey(new Date().toISOString());
  const yesterday = dayKey(new Date(Date.now() - 86_400_000).toISOString());
  let last: string | null = null;
  for (const e of events) {
    const key = dayKey(e.at);
    if (key === last) continue;
    last = key;
    const long = f.longDay(e.at);
    out.set(
      e.id,
      key === today ? t`Today · ${long}` : key === yesterday ? t`Yesterday · ${long}` : long,
    );
  }
  return out;
}

export function DayHeading({ children }: { children: ReactNode }) {
  return (
    <div className="eyebrow bg-sunken px-3.5 py-2" role="presentation">
      {children}
    </div>
  );
}

export type EventRowProps = {
  event: HistoryEvent;
  /** Link the summary to the thing or place it's about (the Activity feed; not on its own page). */
  linkEntity?: boolean;
  /** The event's location, when the list spans locations (the Activity feed, D174). */
  locationName?: string | null;
  /** Who, what and when only, without the field changes or Undo (Home's recent activity). */
  compact?: boolean;
  /** Whether to offer Undo, when the server said (a thing's timeline); else decided here. */
  undoable?: boolean;
  /**
   * In place of the row's own Undo: a list that undoes its own way (Connections' recent changes,
   * whose server says what may be undone and whose refusal stays on the row).
   */
  trailing?: ReactNode;
  /** A line under the row's details (that refusal). */
  footer?: ReactNode;
};

/** One rendered event: who, when, what, and each field before → after. */
export function EventRow({
  event,
  linkEntity = false,
  locationName,
  compact = false,
  undoable: offered,
  trailing,
  footer,
}: EventRowProps) {
  const { t } = useLingui();
  const f = useFormat();
  const summarise = useSummary();
  const { canUndo, undo } = useUndo();
  const who = event.actor.displayName ?? t`Kept`;
  const moved = event.movedInFromElsewhere === true;
  const line = summarise(event);
  const summary = plainText(line);
  const title = moved ? <Trans>Moved in from another location</Trans> : <Isolated text={line} />;
  const undoable = !compact && trailing === undefined && (offered ?? canUndo(event));
  const target = linkEntity ? entityRoute(event) : null;
  const created = event.summaryKey.endsWith('.create');
  const changes =
    moved || compact
      ? []
      : Object.entries(event.diff ?? {}).filter(
          (entry) => shown(entry) && !(created && startsAsDefault(entry)),
        );
  return (
    <article
      aria-label={moved ? t`Moved in from another location` : summary}
      className="flex items-start gap-3 px-3.5 py-3"
    >
      {moved ? (
        <span
          aria-hidden="true"
          className="grid size-9 shrink-0 place-items-center rounded-full bg-sunken text-ink-2 [&_svg]:size-[18px]"
        >
          <BoxIcon />
        </span>
      ) : (
        <Avatar name={who} />
      )}
      <div className="grid min-w-0 flex-1 gap-1">
        <div className="font-semibold text-[15px] leading-snug text-ink [overflow-wrap:anywhere]">
          {target ? (
            <Link
              {...target}
              className="rounded-sm underline-offset-2 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-info"
            >
              {title}
            </Link>
          ) : (
            title
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-small text-ink-2">
          {moved ? null : (
            <>
              <bdi>{who}</bdi>
              <span aria-hidden="true">{sep().trim()}</span>
            </>
          )}
          <time dateTime={event.at}>{f.dateTime(event.at)}</time>
          {event.mergedFrom ? <MergedFrom name={event.mergedFrom.name} /> : null}
          {locationName ? (
            <Pill className="ms-1">
              <bdi>{locationName}</bdi>
            </Pill>
          ) : null}
        </div>
        {changes.length ? (
          <dl className="m-0 grid gap-1 text-small">
            {changes.map(([key, change]) => (
              <Change key={key} field={key} change={change} entity={event.entity.type} />
            ))}
          </dl>
        ) : null}
        {footer}
      </div>
      {trailing}
      {undoable ? (
        <Button
          variant="secondary"
          size="small"
          className="shrink-0"
          aria-label={t`Undo: ${summary}`}
          onPress={() => void undo(event)}
        >
          <Trans>Undo</Trans>
        </Button>
      ) : null}
    </article>
  );
}

/**
 * "merged from <name>" (D36, T15): an event of a thing that was merged into this one, in this
 * thing's history. A thing merged away without a name says so.
 */
function MergedFrom({ name }: { name: string | null }) {
  return (
    <>
      <span aria-hidden="true">{sep().trim()}</span>
      <span>
        {name ? (
          <Trans>
            merged from <bdi>{name}</bdi>
          </Trans>
        ) : (
          <Trans>merged from a thing with no name</Trans>
        )}
      </span>
    </>
  );
}

/** A sentence in the reader's direction, each FSI…PDI span in it as its own <bdi>. */
function Isolated({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let rest = text;
  for (let i = 0; rest; i++) {
    const start = rest.indexOf(FSI);
    const end = start < 0 ? -1 : rest.indexOf(PDI, start);
    if (start < 0 || end < 0) {
      parts.push(rest);
      break;
    }
    if (start > 0) parts.push(rest.slice(0, start));
    parts.push(<bdi key={i}>{rest.slice(start + 1, end)}</bdi>);
    rest = rest.slice(end + 1);
  }
  return <span>{parts}</span>;
}

function entityRoute(
  e: HistoryEvent,
): { to: '/t/$id' | '/p/$id' | '/loc/$id'; params: { id: string } } | null {
  const id = e.entity.id;
  if (!id) return null;
  // The short address when the row names one (D208), so the page needn't replace it on arrival.
  const address = addressOf({ id, shortCode: e.entity.shortCode ?? null });
  if (e.entity.type === 'thing') return { to: '/t/$id', params: { id: address } };
  if (e.entity.type === 'place') return { to: '/p/$id', params: { id: address } };
  if (e.entity.type === 'location') return { to: '/loc/$id', params: { id } };
  return null;
}

function Change({
  field,
  change,
  entity,
}: {
  field: string;
  change: RenderedChange;
  /** The event's entity type, for words that differ by record (a valuation's value). */
  entity?: string;
}) {
  const label = useFieldLabel();
  return (
    <div className="flex flex-wrap items-baseline gap-x-1.5 text-ink-2">
      <dt className="font-medium text-ink">{label(field, change, entity)}</dt>
      <dd className="m-0 flex min-w-0 flex-wrap items-baseline gap-x-1.5 [overflow-wrap:anywhere]">
        {'hidden' in change ? (
          <span className="inline-flex items-center gap-1 text-ink-3 [&_svg]:size-3.5">
            <LockIcon aria-hidden="true" />
            <Trans>hidden</Trans>
          </span>
        ) : 'changed' in change ? (
          <span className="inline-flex items-center gap-1 text-ink-3 [&_svg]:size-3.5">
            <LockIcon aria-hidden="true" />
            <Trans>changed · value not recorded</Trans>
          </span>
        ) : (
          <>
            <Value
              field={field}
              value={change.before}
              money={change.class === 'money'}
              entity={entity}
            />
            <Arrow />
            <Value
              field={field}
              value={change.after}
              money={change.class === 'money'}
              entity={entity}
            />
          </>
        )}
      </dd>
    </div>
  );
}

/** "→", pointing the way the line reads (← in Arabic). */
function Arrow() {
  const { t } = useLingui();
  return (
    <span aria-label={t`to`} role="img" className="inline-block text-ink-3 rtl:-scale-x-100">
      →
    </span>
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isRef = (v: unknown): boolean =>
  v === null ||
  v === undefined ||
  (typeof v === 'string' && UUID.test(v)) ||
  (Array.isArray(v) && v.every((x) => typeof x === 'string' && UUID.test(x))) ||
  // A move target, `{placeId}` or `{containerId}` (thing.trash's `moved_to`).
  (typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(isRef));

/**
 * A diff entry worth a line: not one that only swaps internal ids (a container, a type, a tag
 * set, a purchase line), which would read as raw UUIDs. The summary line already says what
 * happened; a move's own path is on the thing.
 */
/**
 * Columns an audit row carries that mean nothing to a reader (UI audit 2026-09-29): a saved view's
 * list key, an attachment's order, a file's storage class, GPS flag and preview state. The change
 * itself still shows as its summary line ("File uploaded", "Saved view added").
 */
const INTERNAL_FIELDS = new Set([
  // Step 4 (T29): what a delete keeps so undo can put it back (its documents, a service's lines
  // and the schedules it completed), not a change anyone made.
  'documents',
  'lines',
  'completes',
  // Step 5: what a service or a fill keeps for its undo (whether it made the reading, the
  // schedules it cleared) and a starter set's or a draft's ids (UI step-5 review M8).
  'reading_created',
  'cleared_schedules',
  'schedule_ids',
  'extraction_id',
  'invoice_ids',
  'surface',
  'sort',
  'class',
  'has_gps',
  'derivative_state',
  'sha256',
  'width',
  'height',
]);

function shown([key, change]: [string, RenderedChange]): boolean {
  if (INTERNAL_FIELDS.has(key)) return false;
  if (!('before' in change)) return true;
  return !(isRef(change.before) && isRef(change.after));
}

/**
 * Values every new thing or place starts with (the columns' defaults, apps/server's schema): a
 * create row listing "Review → Confirmed", "Not sure where → no", "Status → In use" says
 * nothing (UI audit L9). An edit that sets one of them still shows.
 */
const CREATE_DEFAULTS: Record<string, (v: unknown) => boolean> = {
  review_state: (v) => v === 'confirmed',
  location_uncertain: (v) => v === false,
  lifecycle: (v) => v === 'in_use',
  created_via: (v) => v === 'app',
  quantity: (v) => Number(v) === 1,
  meter_version: (v) => v === 0,
};

const isEmptyValue = (v: unknown): boolean =>
  v === null ||
  v === undefined ||
  v === '' ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0);

function startsAsDefault([key, change]: [string, RenderedChange]): boolean {
  if (!('before' in change) || !isEmptyValue(change.before)) return false;
  return isEmptyValue(change.after) || (CREATE_DEFAULTS[key]?.(change.after) ?? false);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const DECIMAL = /^-?\d+(\.\d+)?$/;

function Value({
  field,
  value,
  money,
  entity,
}: {
  field: string;
  value: unknown;
  money: boolean;
  entity?: string | undefined;
}) {
  const f = useFormat();
  const bytes = useBytes();
  const words = useValueWords();
  const empty = (
    <span className="text-ink-3 italic">
      <Trans>empty</Trans>
    </span>
  );
  if (value === null || value === undefined || value === '') return empty;
  if (Array.isArray(value)) {
    if (value.length === 0) return empty;
    return (
      <bdi dir="auto">
        {value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(', ')}
      </bdi>
    );
  }
  if (typeof value === 'boolean') return value ? <Trans>yes</Trans> : <Trans>no</Trans>;
  if (field === 'bytes' && typeof value === 'number')
    return <span className="tabular-nums">{bytes(value)}</span>;
  if (typeof value === 'number') return <span className="tabular-nums">{f.num(value)}</span>;
  // A label's short ID reads as printed on the tape: "3CB-8WN", monospace, left to right.
  if (field === 'short_code' && typeof value === 'string')
    return <span className="ltr font-mono text-[13px]">{printedCode(value)}</span>;
  if (typeof value === 'string') {
    // Amounts, quantities and dates follow the reader's digits (D143); text stays as written.
    if ((money || field === 'quantity') && DECIMAL.test(value))
      return <span className={cn('tabular-nums')}>{f.num(Number(value))}</span>;
    if (DATE.test(value)) return <span>{f.day(`${value}T12:00:00`)}</span>;
    if (DATE_TIME.test(value)) return <span>{f.dateTime(value)}</span>;
    return <bdi dir="auto">{words(field, value, entity)}</bdi>;
  }
  if (typeof value === 'object' && 'amount' in value && 'currency' in value) {
    const m = value as { amount: unknown; currency: unknown };
    return (
      <span className="tabular-nums">
        {typeof m.amount === 'string' && DECIMAL.test(m.amount)
          ? f.num(Number(m.amount))
          : String(m.amount)}{' '}
        <bdi dir="ltr">{String(m.currency)}</bdi>
      </span>
    );
  }
  // Aliases per language (D41): {en: ['display cable'], ar: [...]} reads as the words.
  if (typeof value === 'object' && Object.values(value).every((v) => Array.isArray(v))) {
    const words = Object.values(value as Record<string, unknown[]>).flat();
    if (words.length === 0) return empty;
    return <bdi dir="auto">{words.map(String).join(', ')}</bdi>;
  }
  return <bdi dir="auto">{JSON.stringify(value)}</bdi>;
}
