/**
 * Move (task 15, D45). Pick where; when it leaves this location the preview says who will lose
 * sight of it ("Alfred and 2 others will lose sight of it") and what gets copied into the other
 * account, before you confirm. A move marks it seen and clears "not sure where".
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { thingApi } from '@/api/inventory/thing-api';
import type { MovePreview } from '@/api/inventory/types';
import { useOfferUndo } from '@/components/history/undo';
import { Notice, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { useFormat } from '@/lib/format';
import { useThingCtx } from './context';
import { isChosen, WherePicker, type WhereValue } from './pickers';
import { Sheet } from './sheet';
import { currentTarget } from './split-sheet';

export function useLosesSightText() {
  const { t } = useLingui();
  const fmt = useFormat();
  return (p: MovePreview) => {
    const [first, ...rest] = p.losesSight;
    if (!first) return null;
    if (rest.length === 0) return t`${first.displayName} will lose sight of it.`;
    return t`${first.displayName} and ${fmt.num(rest.length)} others will lose sight of it.`;
  };
}

export function MoveSheet({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { thing, refresh } = useThingCtx();
  const offerUndo = useOfferUndo();
  const { t } = useLingui();
  const errorText = useErrorText();
  const losesSight = useLosesSightText();
  const [where, setWhere] = useState<WhereValue>({
    locationId: thing.locationId,
    target: currentTarget(thing),
  });
  const [busy, setBusy] = useState(false);
  const chosen = isChosen(where.target);
  const same =
    JSON.stringify(where.target) === JSON.stringify(currentTarget(thing)) &&
    where.locationId === thing.locationId;
  const preview = useQuery({
    queryKey: ['things', 'move-preview', thing.id, where],
    queryFn: () => thingApi.movePreview({ thingIds: [thing.id], to: where.target }),
    enabled: isOpen && chosen && where.locationId !== thing.locationId,
  });

  const save = async () => {
    setBusy(true);
    try {
      const { auditEvents } = await thingApi.move(
        { thingIds: [thing.id], to: where.target },
        thing.rowVersion,
      );
      await refresh();
      offerUndo({ title: t`Moved` }, auditEvents);
      onClose();
    } catch (e) {
      toast({ title: t`Couldn't move it`, description: errorText(e), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const p = preview.data;
  const copies = p
    ? Object.entries(p.copies)
        .filter(([, n]) => n > 0)
        .map(([k]) => k)
    : [];
  return (
    <Sheet
      isOpen={isOpen}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={t`Move ${thing.name ?? ''}`}
    >
      <div className="grid gap-3.5">
        <WherePicker value={where} onChange={setWhere} exclude={thing.id} />
        {p?.crossLocation ? (
          <Notice tone="warn" title={<Trans>It leaves this location</Trans>}>
            {losesSight(p) ? <span className="block">{losesSight(p)}</span> : null}
            {p.crossAccount && copies.length ? (
              <Trans>Its type, tags and shop are copied into the other home's lists.</Trans>
            ) : null}
          </Notice>
        ) : null}
        <DialogFooter>
          <Button variant="secondary" onPress={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button isDisabled={!chosen || same} isPending={busy} onPress={() => void save()}>
            <Trans>Move here</Trans>
          </Button>
        </DialogFooter>
      </div>
    </Sheet>
  );
}
