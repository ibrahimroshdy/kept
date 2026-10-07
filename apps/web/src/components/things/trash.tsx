/**
 * Trash (D162, D45). A thing goes to Trash for 30 days, with Undo. A container with things in it
 * gets a choice first (the server's 409 `contents_choice_required`): move what's inside to where
 * the container is, or trash it all together.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { isApiError } from '@/api/client';
import { thingApi } from '@/api/inventory/thing-api';
import type { TrashBody } from '@/api/inventory/types';
import { useOfferUndo } from '@/components/history/undo';
import { useErrorText } from '@/components/page';
import { usePlaceName } from '@/components/places/labels';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { DialogFooter } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { useFormat } from '@/lib/format';
import { useThingCtx } from './context';
import { Sheet } from './sheet';
import { currentTarget } from './split-sheet';

export function isContentsChoice(e: unknown): boolean {
  return (
    isApiError(e) &&
    e.status === 409 &&
    (e.serverCode === 'contents_choice_required' || 'counts' in e.details)
  );
}

/**
 * After a trash: back to where it was, with Undo for 10 s. Undo is the audit undo of
 * `thing.trash` (it also puts back what was moved out of a container); a server that recorded
 * nothing undoable gets a plain restore from Trash.
 */
function useAfterTrash() {
  const { thing, refresh } = useThingCtx();
  const { t } = useLingui();
  const navigate = useNavigate();
  const offerUndo = useOfferUndo();
  return async (auditEvents: readonly string[]) => {
    const parent = thing.path.at(-1);
    await refresh();
    offerUndo({ title: t`${thing.name ?? t`Untitled`} is in Trash` }, auditEvents, {
      thingId: thing.id,
      fallback: () => thingApi.restore(thing.id),
      onUndone: () => void navigate({ to: '/t/$id', params: { id: thing.id } }),
    });
    if (parent?.kind === 'container') await navigate({ to: '/t/$id', params: { id: parent.id } });
    else if (parent) await navigate({ to: '/p/$id', params: { id: parent.id } });
    else await navigate({ to: '/loc/$id', params: { id: thing.locationId } });
  };
}

/** Confirm, then trash; a container with contents opens the choice sheet instead. */
export function useTrashThing(openSheet: (s: 'trash') => void) {
  const { thing } = useThingCtx();
  const { t } = useLingui();
  const confirm = useConfirm();
  const after = useAfterTrash();
  return async () => {
    if (thing.contentsCount > 0) {
      openSheet('trash');
      return;
    }
    const ok = await confirm({
      title: t`Move ${thing.name ?? t`Untitled`} to Trash?`,
      body: t`You can restore it from Trash for 30 days.`,
      confirmLabel: t`Move to Trash`,
      destructive: true,
    });
    if (!ok) return;
    let auditEvents: string[];
    try {
      ({ auditEvents } = await thingApi.trash(thing.id));
    } catch (e) {
      if (isContentsChoice(e)) {
        openSheet('trash');
        return;
      }
      throw e;
    }
    await after(auditEvents);
  };
}

export function TrashContentsSheet({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { thing } = useThingCtx();
  const { t } = useLingui();
  const fmt = useFormat();
  const errorText = useErrorText();
  const after = useAfterTrash();
  const [busy, setBusy] = useState<TrashBody['contents'] | null>(null);
  const placeName = usePlaceName();
  const last = thing.path.at(-1);
  const here = last ? placeName(last) : undefined;
  const run = async (contents: 'move' | 'trash') => {
    setBusy(contents);
    try {
      const { auditEvents } = await thingApi.trash(
        thing.id,
        contents === 'move' ? { contents, moveTo: currentTarget(thing) } : { contents },
      );
      onClose();
      await after(auditEvents);
    } catch (e) {
      toast({ title: t`Couldn't trash it`, description: errorText(e), tone: 'danger' });
    } finally {
      setBusy(null);
    }
  };
  return (
    <Sheet
      isOpen={isOpen}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={t`${thing.name ?? t`Untitled`} has things in it`}
    >
      <p className="m-0 text-ink-2">
        <Trans>{fmt.num(thing.contentsCount)} things are inside. What should happen to them?</Trans>
      </p>
      <div className="grid gap-2">
        <Button variant="secondary" isPending={busy === 'move'} onPress={() => void run('move')}>
          {here ? (
            <Trans>Move them to {here}, then trash it</Trans>
          ) : (
            <Trans>Take them out, then trash it</Trans>
          )}
        </Button>
        <Button variant="danger" isPending={busy === 'trash'} onPress={() => void run('trash')}>
          <Trans>Trash them with it</Trans>
        </Button>
      </div>
      <DialogFooter>
        <Button variant="secondary" onPress={onClose}>
          <Trans>Cancel</Trans>
        </Button>
      </DialogFooter>
    </Sheet>
  );
}
