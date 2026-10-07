/**
 * The inbox list (screens §5 "Inbox", D18, D36, D175, D191, D205): what needs a person, global
 * across the locations you can change, on the list standard (ListSurface: search, the location
 * filter, saved views on the `inbox` surface, cursor pagination, all in the URL).
 *
 * - **Whose:** Mine (the default) or Everyone's (`f.mine=everyone`).
 * - **Kinds:** chips with counts; a chip whose count is zero is hidden (D191) unless chosen.
 * - **Grouping:** by capture batch ("Today · 12 captured · Garage › Shelves", with "Accept 6
 *   names" for the batch); items that came without one (a shared receipt, a reading) by day.
 * - **Phone:** each item is a full card. **Desktop (1200 px up):** a list beside the current
 *   item's card (the 7a frame).
 * - **Keys** (./keymap.ts): `j`/`k` move, `x` selects, `shift+a` accepts the selected names; the
 *   rest go to the current item.
 * - **Offline:** what's loaded stays readable; every action says "Needs a connection". Drafts
 *   captured on this phone and not yet synced are listed read-only, "On this phone · waiting to
 *   sync" (screens §8).
 * - **AI paused** in a location: its banner on top (D206). Waiting for the provider has no
 *   banner; the draft's own line says it.
 */
import { INBOX_KEYMAP, type InboxAction, type InboxKind } from '@kept/shared';
import { plural } from '@lingui/core/macro';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Checkbox, Dialog, DialogTrigger, Popover, Radio, RadioGroup } from 'react-aria-components';
import { captureApi, captureKeys, useInbox } from '@/api/capture/queries';
import type { AiStatus, InboxItem, InboxParams } from '@/api/capture/types';
import { useLocations, useMe } from '@/api/queries';
import { PausedBanner } from '@/components/ai/paused-banner';
import { useFilterRegistry } from '@/components/filters/registry';
import type { FilterDef } from '@/components/filters/types';
import { CameraIcon, CheckIcon, InboxIcon } from '@/components/icons';
import { IdChip } from '@/components/id-chip';
import { ListSurface } from '@/components/list-surface';
import { EmptyState, Notice } from '@/components/page';
import { usePlaceName } from '@/components/places/labels';
import { Button, buttonClass } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { sep, useFormat } from '@/lib/format';
import { useKeyHints } from '@/lib/key-hints';
import { useLocationName } from '@/lib/labels';
import { useMediaQuery } from '@/lib/media';
import { useOnline } from '@/lib/online';
import { firstOf, useListState } from '@/lib/url-state';
import { cn } from '@/lib/utils';
import type { OfflineStore } from '@/offline/store';
import { useInboxRun } from './actions';
import { acceptsName, BulkBar, useAcceptNames } from './bulk-bar';
import { ItemCard } from './item-card';
import { INBOX_KEYS, keyCaps, useInboxKeys, useKeyLabels } from './keymap';
import { KIND_ORDER, useFieldLabels, useKindLabels } from './labels';
import { type ItemKeys, KeysProvider, Thumb } from './shell';

/** The split layout's line: a list beside the current item. */
export const SPLIT = '(min-width: 1200px)';

/** What the inbox reads from the phone's offline store: its unsent ops. */
export type LocalQueue = Pick<OfflineStore, 'pending'>;

/**
 * Focuses item `id` on the next frame (`j`/`k`), unless a key pressed before that frame has put
 * focus in a field: `j` then `e` within one frame (a fast typist, or a busy phone) opens the
 * edit form, whose Name field takes focus, and the frame must not take it back (found by the
 * e2e's keyboard walk under load, T32).
 */
export function focusInboxItem(id: string): number {
  return requestAnimationFrame(() => {
    if (document.activeElement?.closest('input, textarea, select, [contenteditable="true"]'))
      return;
    const el = document.querySelector<HTMLElement>(`[data-inbox-item="${CSS.escape(id)}"]`);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView?.({ block: 'nearest' });
  });
}

export function InboxList({ local }: { local?: LocalQueue | null }) {
  const { t } = useLingui();
  const [list, setList] = useListState();
  const locations = useLocations();
  const f = useFilterRegistry();
  const online = useOnline();
  const split = useMediaQuery(SPLIT);
  const kindLabels = useKindLabels();
  const fmt = useFormat();
  const locationName = useLocationName();
  const blocked = online ? undefined : t`Needs a connection`;
  const keyHints = useKeyHints();

  const writable = (locations.data ?? []).filter((l) => l.role !== 'viewer');
  const everyone = firstOf(list, 'mine') === 'everyone';
  const kind = firstOf(list, 'kind') as InboxKind | undefined;
  const locationId = firstOf(list, 'location');
  const params: InboxParams = {
    ...(list.q ? { q: list.q } : {}),
    ...(everyone ? { mine: false } : {}),
    ...(kind ? { kind } : {}),
    ...(locationId ? { locationId } : {}),
  };
  const query = useInbox(params);
  const items = useMemo(() => query.data?.pages.flatMap((pg) => pg.items) ?? [], [query.data]);
  // The review pane beside the list, on a wide screen, only while something waits: with nothing
  // to review it said "Choose an item to review it here." (UI audit L6).
  const reviewPane = split && (items.length > 0 || query.isPending);
  const counts = query.data?.pages[0]?.counts;

  // AI's state per writable location: the paused banner, and each draft's waiting line.
  const statuses = useQueries({
    queries: writable.map((l) => ({
      queryKey: captureKeys.ai.status(l.id),
      queryFn: () => captureApi.aiStatus(l.id),
    })),
  });
  const aiOf = new Map<string, AiStatus>();
  writable.forEach((l, i) => {
    const s = statuses[i]?.data;
    if (s) aiOf.set(l.id, s);
  });
  const paused = writable.filter((l) => aiOf.get(l.id)?.pausedUntil);

  // The current item (keys act on it) and the selection (the bulk bar acts on it).
  const [currentId, setCurrentId] = useState<string | null>(null);
  const lastIndex = useRef(0);
  const index = items.findIndex((i) => i.id === currentId);
  if (index >= 0) lastIndex.current = index;
  const current = index >= 0 ? items[index] : items[Math.min(lastIndex.current, items.length - 1)];
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selectedItems = items.filter((i) => selected.has(i.id));
  const toggle = useCallback(
    (id: string) =>
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );
  // What left the list leaves the selection.
  useEffect(() => {
    setSelected((prev) => {
      const ids = new Set(items.map((i) => i.id));
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [items]);

  const registry = useRef(new Map<string, ItemKeys>());
  const keysValue = useMemo(
    () => ({
      set: (id: string, keys: ItemKeys | null) => {
        if (keys) registry.current.set(id, keys);
        else registry.current.delete(id);
      },
    }),
    [],
  );
  const { accept: acceptNames } = useAcceptNames();

  const move = (by: number) => {
    if (items.length === 0) return;
    const at = current ? items.indexOf(current) : -1;
    const next = items[Math.max(0, Math.min(items.length - 1, at + by))];
    if (!next) return;
    setCurrentId(next.id);
    focusInboxItem(next.id);
  };
  const onAction = (action: InboxAction) => {
    if (action === 'next') return move(1);
    if (action === 'previous') return move(-1);
    if (action === 'select') {
      if (current?.kind === 'draft') toggle(current.id);
      return;
    }
    if (action === 'accept_selected') {
      const nameable = selectedItems.filter(acceptsName);
      if (!blocked && nameable.length)
        void acceptNames(nameable).then((r) => {
          if (r) setSelected(new Set());
        });
      return;
    }
    if (current) registry.current.get(current.id)?.[action]?.();
  };
  useInboxKeys(onAction, writable.length > 0);

  // The location filter: one location (the list takes one), among those you can change.
  const filters: FilterDef[] =
    writable.length > 1
      ? [
          {
            ...f.location(),
            kind: 'single',
            negatable: false,
            values: {
              from: 'static',
              options: writable.map((l) => ({ value: l.id, label: locationName(l) })),
            },
          },
        ]
      : [];
  const locationOf = (id: string) => writable.find((l) => l.id === id);

  const byKind = counts?.byKind;
  const total = byKind ? Object.values(byKind).reduce((a, b) => a + b, 0) : 0;
  const kinds = KIND_ORDER.filter((k) => (byKind?.[k] ?? 0) > 0 || k === kind);

  const groupOf = useGroupOf();
  const renderItem = (item: InboxItem) => {
    const props = {
      item,
      location: locationOf(item.locationId),
      ai: aiOf.get(item.locationId),
      current: current?.id === item.id,
      blocked,
    };
    const selectable = item.kind === 'draft';
    if (split)
      return (
        <CompactRow
          item={item}
          current={props.current}
          selectable={selectable}
          selected={selected.has(item.id)}
          onToggle={() => toggle(item.id)}
          onOpen={() => setCurrentId(item.id)}
        />
      );
    return (
      <div
        className="flex min-w-0 items-start"
        onFocusCapture={() => current?.id !== item.id && setCurrentId(item.id)}
      >
        {selectable ? (
          <SelectBox
            name={item.thing?.name ?? t`Unnamed thing`}
            selected={selected.has(item.id)}
            onToggle={() => toggle(item.id)}
            className="ps-3.5 pt-4"
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <ItemCard {...props} />
        </div>
      </div>
    );
  };

  if (locations.isSuccess && writable.length === 0)
    return (
      <EmptyState icon={<InboxIcon />} title={<Trans>The inbox is for members</Trans>}>
        <Trans>
          You can view your locations but not change them, so there is nothing here for you to
          review.
        </Trans>
      </EmptyState>
    );

  return (
    <KeysProvider value={keysValue}>
      <div className="grid min-w-0 gap-3">
        {paused.map((l) => {
          const s = aiOf.get(l.id);
          return s ? (
            <PausedBanner key={l.id} status={s} note={t`Photos still save; naming waits.`} />
          ) : null;
        })}
        <NameUnnamed items={items} aiOf={aiOf} blocked={blocked} />
        {online ? null : (
          <Notice tone="warn" title={t`Offline`}>
            <Trans>
              Reviewing needs a connection. What's here is as it was when you went offline.
            </Trans>
          </Notice>
        )}
        <div className="flex flex-wrap items-end gap-3">
          <Segmented
            aria-label={t`Whose`}
            value={everyone ? 'everyone' : 'mine'}
            onChange={(v) => setList({ filters: { mine: v === 'everyone' ? ['everyone'] : [] } })}
            options={[
              {
                id: 'mine',
                label: counts ? <Trans>Mine · {fmt.num(counts.mine)}</Trans> : <Trans>Mine</Trans>,
              },
              {
                id: 'everyone',
                label: counts ? (
                  <Trans>Everyone's · {fmt.num(counts.everyone)}</Trans>
                ) : (
                  <Trans>Everyone's</Trans>
                ),
              },
            ]}
            className="min-w-64"
          />
          {split && keyHints ? <ShortcutsButton /> : null}
        </div>
        {byKind ? (
          <RadioGroup
            aria-label={t`Kind`}
            orientation="horizontal"
            value={kind ?? 'all'}
            onChange={(v) => setList({ filters: { kind: v === 'all' ? [] : [v] } })}
            className="flex flex-wrap gap-1.5"
          >
            <KindChip value="all" label={t`All`} count={fmt.num(total)} />
            {kinds.map((k) => (
              <KindChip
                key={k}
                value={k}
                label={kindLabels[k].chip}
                count={fmt.num(byKind[k] ?? 0)}
              />
            ))}
          </RadioGroup>
        ) : null}

        <div
          className={cn(
            'grid min-w-0 gap-4',
            reviewPane && 'grid-cols-[minmax(18rem,24rem)_minmax(0,1fr)] items-start',
          )}
        >
          <ListSurface<InboxItem>
            label={t`Inbox`}
            search={{
              label: t`Search the inbox`,
              placeholder: t`Search names, shops, places`,
              // In the 384 px list column the strip's buttons get their own row (UI audit L6).
              ...(reviewPane ? { fullRow: true } : {}),
            }}
            filters={filters}
            surface="inbox"
            query={query}
            getKey={(i) => i.id}
            renderRow={renderItem}
            groupOf={(i) => groupOf(i, items)}
            defaultGroup="batch"
            empty={
              <EmptyState
                icon={<InboxIcon />}
                title={<Trans>All reviewed</Trans>}
                action={
                  everyone || !counts?.everyone ? (
                    <Link to="/capture" className={buttonClass('secondary')}>
                      <CameraIcon aria-hidden="true" />
                      <Trans>Capture</Trans>
                    </Link>
                  ) : (
                    <Button
                      variant="secondary"
                      onPress={() => setList({ filters: { mine: ['everyone'] } })}
                    >
                      <Plural
                        value={counts.everyone}
                        one="Show everyone's (#)"
                        other="Show everyone's (#)"
                      />
                    </Button>
                  )
                }
              >
                {everyone ? (
                  <Trans>Nothing waits for anyone. What AI can't settle lands here.</Trans>
                ) : (
                  <Trans>
                    Nothing of yours waits. What you capture lands here when it needs you: a value
                    to confirm, a receipt to link, a duplicate.
                  </Trans>
                )}
              </EmptyState>
            }
          />
          {reviewPane ? (
            <section
              aria-label={t`The current item`}
              className="sticky top-20 min-w-0 overflow-hidden rounded-[10px] border border-line bg-surface"
            >
              {current ? (
                <ItemCard
                  key={current.id}
                  item={current}
                  location={locationOf(current.locationId)}
                  ai={aiOf.get(current.locationId)}
                  current
                  blocked={blocked}
                />
              ) : (
                <p className="m-0 p-6 text-center text-ink-3">
                  <Trans>Choose an item to review it here.</Trans>
                </p>
              )}
            </section>
          ) : null}
        </div>

        {local ? <LocalDrafts local={local} /> : null}

        {selectedItems.length > 0 ? (
          <BulkBar
            selected={selectedItems}
            locations={writable}
            onClear={() => setSelected(new Set())}
            blocked={blocked}
          />
        ) : null}
      </div>
    </KeysProvider>
  );
}

/**
 * Drafts whose photo was never read because no AI provider was connected when they were
 * captured (the maintainer's first three photos, 2026-09-29), in locations where one resolves
 * now: one action names them all, asking for each thing's photo to be read (the re-run route,
 * POST /things/:id/extract, as "Re-run extraction" does). Captures that waited as
 * `waiting_provider` are sent by the server when a key is saved; this covers what it can't see
 * and drafts from before there was a queue at all.
 */
export function unnamedToName(items: InboxItem[], aiOf: Map<string, AiStatus>): InboxItem[] {
  return items.filter((i) => {
    if (i.kind !== 'draft' || !i.thing || i.thing.name) return false;
    if (!aiOf.get(i.locationId)?.resolved) return false;
    const x = i.extraction;
    return (
      !x ||
      x.status === 'no_provider' ||
      (x.status === 'waiting_provider' && x.statusReason === 'no_provider')
    );
  });
}

function NameUnnamed({
  items,
  aiOf,
  blocked,
}: {
  items: InboxItem[];
  aiOf: Map<string, AiStatus>;
  blocked: string | undefined;
}) {
  const { run, busy } = useInboxRun();
  const todo = unnamedToName(items, aiOf);
  if (todo.length === 0) return null;
  const nameAll = () =>
    void run(
      async () => {
        for (const i of todo) if (i.thing) await captureApi.extract(i.thing.id);
        return todo.length;
      },
      { done: (n) => plural(n, { one: 'Naming # photo', other: 'Naming # photos' }) },
    );
  return (
    <Notice
      tone="info"
      action={
        <Button size="small" isPending={busy} isDisabled={!!blocked} onPress={nameAll}>
          <Plural value={todo.length} one="Name # unnamed photo" other="Name # unnamed photos" />
        </Button>
      }
    >
      <Plural
        value={todo.length}
        one="# photo was captured before AI was connected, so it has no name yet."
        other="# photos were captured before AI was connected, so they have no names yet."
      />
    </Notice>
  );
}

function KindChip({ value, label, count }: { value: string; label: string; count: string }) {
  return (
    <Radio
      value={value}
      className={({ isSelected, isFocusVisible }) =>
        cn(
          'inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-[13px] font-medium',
          isSelected ? 'border-ink bg-ink text-paper' : 'border-line bg-surface text-ink-2',
          isFocusVisible && 'outline-2 outline-offset-2 outline-info',
        )
      }
    >
      <span>{label}</span>
      <b className="font-semibold tabular-nums">{count}</b>
    </Radio>
  );
}

function SelectBox({
  name,
  selected,
  onToggle,
  className,
}: {
  name: string;
  selected: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const { t } = useLingui();
  return (
    <Checkbox
      isSelected={selected}
      onChange={onToggle}
      aria-label={t`Select ${name}`}
      aria-keyshortcuts="X"
      className={cn('group grid min-h-11 min-w-11 cursor-pointer place-items-start', className)}
    >
      {({ isSelected, isFocusVisible }) => (
        <span
          className={cn(
            'grid size-5 place-items-center rounded-[5px] border-2 [&_svg]:size-3.5',
            isSelected ? 'border-ink bg-ink text-paper' : 'border-ink-3 bg-surface',
            isFocusVisible && 'outline-2 outline-offset-2 outline-info',
          )}
        >
          {isSelected ? <CheckIcon strokeWidth="3" /> : null}
        </span>
      )}
    </Checkbox>
  );
}

/** One line of the desktop list: select it, or open it beside the list. */
function CompactRow({
  item,
  current,
  selectable,
  selected,
  onToggle,
  onOpen,
}: {
  item: InboxItem;
  current: boolean;
  selectable: boolean;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const { t } = useLingui();
  const title = useRowTitle()(item);
  const status = useRowStatus()(item);
  const photo = item.thing?.photos[0] ?? item.receipt?.pages[0];
  return (
    <div
      className={cn('flex min-w-0 items-start gap-1 pe-2', current && 'bg-sunken')}
      aria-current={current ? 'true' : undefined}
    >
      {selectable ? (
        <SelectBox name={title} selected={selected} onToggle={onToggle} className="ps-2.5 pt-3.5" />
      ) : (
        <span className="w-11 shrink-0" />
      )}
      <button
        type="button"
        data-inbox-item={item.id}
        onClick={onOpen}
        onFocus={onOpen}
        aria-label={t`Open ${title}`}
        className="flex min-w-0 flex-1 items-start gap-2.5 py-2.5 text-start outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-info"
      >
        <Thumb photo={photo} className="size-10" />
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 font-semibold text-[14px] text-ink">
            <bdi className="[overflow-wrap:anywhere]">{title}</bdi>
            {item.thing?.shortCode ? <IdChip code={item.thing.shortCode} /> : null}
          </span>
          <span className="text-small text-ink-2 [overflow-wrap:anywhere]">{status}</span>
        </span>
      </button>
    </div>
  );
}

function useRowTitle() {
  const { t } = useLingui();
  return (item: InboxItem): string => {
    if (item.kind === 'receipt' || item.kind === 'currency') {
      const v = item.receipt?.vendorSeen;
      return v ? t`${v} receipt` : t`Receipt`;
    }
    if (item.kind === 'label_claim' && item.claim) return t`Label ${item.claim.code}`;
    if (item.kind === 'sync_drop') return t`A change couldn't apply`;
    return item.thing?.name ?? t`Unnamed thing`;
  };
}

/** The desktop row's second line: what the item waits for. */
function useRowStatus() {
  const { t, i18n } = useLingui();
  const kindLabels = useKindLabels();
  const fieldName = useFieldLabels();
  return (item: InboxItem): string => {
    if (item.kind === 'receipt') {
      const n = item.receipt?.lines.length ?? 0;
      return n === 1 ? t`1 line to link` : t`${n} lines to link`;
    }
    if (item.kind !== 'draft') return kindLabels[item.kind].pill;
    const waiting = item.suggestions ?? [];
    if (waiting.length) {
      const list = new Intl.ListFormat(i18n.locale, { type: 'conjunction' }).format(
        waiting.map((s) => fieldName(s.field)),
      );
      return t`To confirm: ${list}`;
    }
    switch (item.extraction?.status) {
      case 'queued':
      case 'running':
        return t`Naming…`;
      case 'paused_budget':
        return t`Waiting: AI is paused`;
      case 'waiting_provider':
        return t`Waiting for the AI provider`;
      case 'failed':
        return t`Couldn't read the photo`;
    }
    return item.thing?.name ? t`Name accepted by AI · ready` : t`Needs a name`;
  };
}

/** The heading of a batch ("Today · 12 captured · Garage › Shelves · Accept 6 names"), or a day. */
function useGroupOf() {
  const { t } = useLingui();
  const fmt = useFormat();
  const me = useMe();
  const placeName = usePlaceName();
  const locations = useLocations();
  const locationName = useLocationName();
  const { accept, busy } = useAcceptNames();
  const online = useOnline();
  /** "Today", "Yesterday", or "Sat 26 Sep 2026" (local days). */
  const dayOf = (iso: string) => {
    const d = new Date(iso);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return t`Today`;
    if (d.toDateString() === yesterday.toDateString()) return t`Yesterday`;
    return fmt.longDay(iso);
  };
  return (item: InboxItem, all: InboxItem[]) => {
    const b = item.batch;
    if (!b) {
      const d = new Date(item.createdAt);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      return { key: `day:${key}`, label: dayOf(item.createdAt) };
    }
    const nameable = all.filter((i) => i.batch?.id === b.id && acceptsName(i));
    const who =
      item.createdBy.displayName === me.data?.user.displayName ? null : item.createdBy.displayName;
    const loc = locations.data?.find((l) => l.id === item.locationId);
    const where = [loc ? locationName(loc) : null, ...b.placePath.map((s) => placeName(s))]
      .filter(Boolean)
      .join(' › ');
    const count = fmt.num(b.count);
    const when = dayOf(b.capturedAt);
    return {
      key: `batch:${b.id}`,
      label: (
        <span className="flex flex-wrap items-center justify-between gap-2">
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {who ? <bdi>{who}</bdi> : null}
            {who ? sep() : null}
            <Trans>
              {when} · {count} captured · <bdi>{where}</bdi>
            </Trans>
          </span>
          {nameable.length > 1 ? (
            <Button
              size="small"
              variant="secondary"
              className="normal-case"
              isDisabled={!online}
              isPending={busy}
              onPress={() => void accept(nameable)}
            >
              <Trans>Accept {fmt.num(nameable.length)} names</Trans>
            </Button>
          ) : null}
        </span>
      ),
    };
  };
}

/** The "Keyboard shortcuts" popover (desktop, where the keys are). */
function ShortcutsButton() {
  const { t } = useLingui();
  const labels = useKeyLabels();
  return (
    <DialogTrigger>
      <Button variant="ghost" size="small">
        <Trans>Keyboard shortcuts</Trans>
      </Button>
      <Popover
        placement="bottom end"
        offset={6}
        className="z-50 w-80 rounded-[10px] border border-line bg-surface p-3 text-ink shadow-[0_10px_30px_rgba(0,0,0,.14)] outline-none"
      >
        <Dialog aria-label={t`Keyboard shortcuts`} className="outline-none">
          <dl className="m-0 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 text-small">
            {INBOX_KEYS.map((key) => (
              <div key={key} className="contents">
                <dt className="flex gap-1">
                  {keyCaps(key).map((cap) => (
                    <kbd
                      key={cap}
                      className="rounded border border-line bg-sunken px-1.5 font-mono text-[12px]"
                    >
                      {cap}
                    </kbd>
                  ))}
                </dt>
                <dd className="m-0 text-ink-2">{labels[INBOX_KEYMAP[key]]}</dd>
              </div>
            ))}
          </dl>
          <p className="m-0 mt-2 text-small text-ink-3">
            <Trans>Keys do nothing while you type in a field.</Trans>
          </p>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}

/** Captures on this phone the server hasn't had yet: readable, not reviewable (screens §8). */
function LocalDrafts({ local }: { local: LocalQueue }) {
  const { t } = useLingui();
  const pending = useQuery({
    queryKey: ['offline', 'pending-captures'],
    queryFn: () => local.pending(),
    refetchInterval: 5000,
  });
  const drafts = (pending.data ?? []).filter((e) => e.op === 'create_thing');
  if (drafts.length === 0) return null;
  return (
    <section aria-label={t`On this phone · waiting to sync`} className="grid gap-2">
      <h2 className="eyebrow m-0">
        <Trans>On this phone · waiting to sync</Trans>
      </h2>
      <ul className="m-0 grid list-none overflow-hidden rounded-[10px] border border-line bg-surface p-0">
        {drafts.map((e) => {
          const name = (e.payload as { name?: string } | null)?.name;
          return (
            <li
              key={e.idempotencyKey}
              className="flex items-center gap-3 border-line px-3.5 py-3 not-first:border-t"
            >
              <Thumb photo={undefined} className="size-10" />
              <span className="grid min-w-0 gap-0.5">
                <span className="font-semibold text-[14px] text-ink [overflow-wrap:anywhere]">
                  {name ? <bdi>{name}</bdi> : <Trans>Unnamed thing</Trans>}
                </span>
                <span className="text-small text-ink-3">
                  <Trans>On this phone · waiting to sync</Trans>
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
