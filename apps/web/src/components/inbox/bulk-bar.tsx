/**
 * The bulk bar (D36, screens §5): for the drafts selected with `x` or their checkboxes, accept
 * their names (`shift+a`), set a type, a place or tags, or discard them. Each is one request and
 * one undoable bulk event (D150): the toast's Undo reverts the whole selection.
 *
 * A type, place or tags belong to one location's lists, so those three need a selection from one
 * location; the bar says so rather than guessing.
 */
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { Key } from 'react-aria-components';
import { captureApi } from '@/api/capture/queries';
import type { InboxBulkResult, InboxItem } from '@/api/capture/types';
import type { Written } from '@/api/client';
import { inventoryApi } from '@/api/inventory/queries';
import type { LocationSummary } from '@/api/types';
import { Sheet } from '@/components/things/sheet';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { DialogFooter } from '@/components/ui/dialog';
import { Select, SelectItem } from '@/components/ui/select';
import { sep, useFormat } from '@/lib/format';
import { undoEventsOf, useInboxRun } from './actions';
import { MoveSheet, TypeSheet } from './item-card';
import { type Blocked, BlockedReason } from './shell';

/** A draft the bulk actions can take: named, with nothing waiting to be confirmed. */
export const acceptsName = (i: InboxItem) =>
  i.kind === 'draft' && !!i.thing?.name && (i.suggestions ?? []).length === 0;

/** "Accepted 3; 1 needs a name first", from a bulk result. */
function useBulkDone() {
  const { t } = useLingui();
  const fmt = useFormat();
  return (verb: (n: string) => string) => (w: Written<InboxBulkResult>) => {
    const ok = w.body.results.filter((r) => r.ok).length;
    const failed = w.body.results.length - ok;
    const head = verb(fmt.num(ok));
    return failed ? `${head}${sep()}${t`${fmt.num(failed)} couldn't be changed`}` : head;
  };
}

export function useAcceptNames() {
  const { t } = useLingui();
  const { run, busy } = useInboxRun();
  const done = useBulkDone();
  const accept = (items: InboxItem[]) =>
    run(() => captureApi.inboxBulk({ ids: items.map((i) => i.id), action: 'accept_names' }), {
      done: done((n) => t`Accepted ${n} names`),
      undo: undoEventsOf,
    });
  return { accept, busy };
}

export function BulkBar({
  selected,
  locations,
  onClear,
  blocked,
}: {
  selected: InboxItem[];
  locations: LocationSummary[];
  onClear: () => void;
  blocked: Blocked;
}) {
  const { t } = useLingui();
  const fmt = useFormat();
  const confirm = useConfirm();
  const { run, busy } = useInboxRun();
  const { accept, busy: accepting } = useAcceptNames();
  const done = useBulkDone();
  const [sheet, setSheet] = useState<'type' | 'place' | 'tags' | null>(null);
  const ids = selected.map((i) => i.id);
  const n = selected.length;
  const count = fmt.num(n);
  const oneLocation = new Set(selected.map((i) => i.locationId)).size === 1;
  const location = oneLocation
    ? locations.find((l) => l.id === selected[0]?.locationId)
    : undefined;
  const nameable = selected.filter(acceptsName);
  const whereReason: Blocked =
    blocked ??
    (oneLocation ? undefined : t`Select drafts from one location to set a type, place or tags.`);
  const names = t`${count} drafts`;

  const discard = async () => {
    const ok = await confirm({
      title: t`Discard ${count} drafts?`,
      body: t`They go to the trash with their photos. You can restore them for 30 days.`,
      confirmLabel: t`Discard`,
      destructive: true,
    });
    if (!ok) return;
    const r = await run(() => captureApi.inboxBulk({ ids, action: 'discard' }), {
      done: done((x) => t`Discarded ${x} drafts`),
      undo: undoEventsOf,
    });
    if (r) onClear();
  };

  return (
    <div
      role="toolbar"
      aria-label={t`Selected drafts`}
      className="sticky bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-10 flex flex-wrap items-center gap-2 rounded-[10px] border border-ink bg-surface p-2.5 shadow-[0_10px_30px_rgba(0,0,0,.14)] md:bottom-4"
    >
      <span className="grow font-semibold text-[14px] text-ink" aria-live="polite">
        <Plural value={n} one="# selected" other="# selected" />
      </span>
      <Button
        size="small"
        isDisabled={!!blocked || nameable.length === 0}
        isPending={accepting}
        aria-keyshortcuts="Shift+A"
        onPress={() =>
          void accept(nameable).then((r) => {
            if (r) onClear();
          })
        }
      >
        {nameable.length === n ? (
          <Trans>Accept names</Trans>
        ) : (
          <Trans>Accept {fmt.num(nameable.length)} names</Trans>
        )}
      </Button>
      <Button
        size="small"
        variant="secondary"
        isDisabled={!!whereReason}
        onPress={() => setSheet('type')}
      >
        <Trans>Set type</Trans>
      </Button>
      <Button
        size="small"
        variant="secondary"
        isDisabled={!!whereReason}
        onPress={() => setSheet('place')}
      >
        <Trans>Move</Trans>
      </Button>
      <Button
        size="small"
        variant="secondary"
        isDisabled={!!whereReason}
        onPress={() => setSheet('tags')}
      >
        <Trans>Set tags</Trans>
      </Button>
      <Button
        size="small"
        variant="ghost"
        isDisabled={!!blocked}
        isPending={busy}
        onPress={() => void discard()}
      >
        <Trans>Discard</Trans>
      </Button>
      <Button size="small" variant="ghost" onPress={onClear}>
        <Trans>Clear selection</Trans>
      </Button>
      <BlockedReason reason={whereReason} />
      {nameable.length < n && !blocked ? (
        <p className="m-0 w-full text-small text-ink-3">
          <Trans>
            Drafts without a name, or with values to confirm, are left for you to review.
          </Trans>
        </p>
      ) : null}
      {location ? (
        <>
          <TypeSheet
            isOpen={sheet === 'type'}
            onClose={() => setSheet(null)}
            ids={ids}
            accountId={location.ownerAccountId}
            names={names}
          />
          <MoveSheet
            isOpen={sheet === 'place'}
            onClose={() => setSheet(null)}
            ids={ids}
            locationId={location.id}
            names={names}
          />
          <TagsSheet
            isOpen={sheet === 'tags'}
            onClose={() => setSheet(null)}
            ids={ids}
            accountId={location.ownerAccountId}
            names={names}
          />
        </>
      ) : null}
    </div>
  );
}

/** Set the tags of drafts (`set_tags`: the set replaces theirs, one undoable event). */
function TagsSheet({
  isOpen,
  onClose,
  ids,
  accountId,
  names,
}: {
  isOpen: boolean;
  onClose: () => void;
  ids: string[];
  accountId: string;
  names: string;
}) {
  const { t } = useLingui();
  const { run, busy } = useInboxRun();
  const [tagIds, setTagIds] = useState<string[]>([]);
  const tags = useQuery({
    queryKey: ['registry', 'tags', accountId, { limit: 200 }],
    queryFn: () => inventoryApi.registry('tags', accountId, { limit: 200 }),
    enabled: isOpen && !!accountId,
  });
  const items = (tags.data?.items ?? []).map((x) => ({ id: x.id, name: x.name }));
  const save = () =>
    void run(() => captureApi.inboxBulk({ ids, action: 'set_tags', tagIds }), {
      done: t`Set the tags of ${names}`,
      undo: undoEventsOf,
    }).then((r) => {
      if (r) onClose();
    });
  return (
    <Sheet
      isOpen={isOpen}
      onOpenChange={(o) => !o && onClose()}
      title={t`Set the tags of ${names}`}
    >
      <div className="grid gap-4">
        <Select<{ id: string; name: string }, 'multiple'>
          label={t`Tags`}
          selectionMode="multiple"
          items={items}
          value={tagIds}
          onChange={(keys: Key[]) => setTagIds(keys.map(String))}
          renderValue={(chosen) => chosen.map((x) => <bdi key={x.id}>{x.name}</bdi>)}
        >
          {(x) => (
            <SelectItem id={x.id} textValue={x.name}>
              <bdi>{x.name}</bdi>
            </SelectItem>
          )}
        </Select>
        <DialogFooter>
          <Button variant="secondary" onPress={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button isPending={busy} onPress={save}>
            <Trans>Set tags</Trans>
          </Button>
        </DialogFooter>
      </div>
    </Sheet>
  );
}
