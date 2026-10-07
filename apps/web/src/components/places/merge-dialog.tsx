/**
 * Merge a place into another in the same location (D160): everything in it, places and things,
 * moves into the target, and the merged place is gone. Two rooms that turned out to be the same
 * room, say. The target can't be the place itself or anything inside it.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import type { PlaceView } from '@/api/inventory/types';
import { Notice, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { placeApi, subtreeOf, useInvalidateBrowse, usePlaceTree } from './api';
import { type PickedPlace, PlacePicker } from './move-picker';
import { Sheet } from './sheet';

export function MergePlaceDialog({
  place,
  isOpen,
  onOpenChange,
  onMerged,
}: {
  place: PlaceView;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onMerged: (targetId: string) => void;
}) {
  const { t } = useLingui();
  const name = place.name;
  return (
    <Sheet isOpen={isOpen} onOpenChange={onOpenChange} wide title={t`Merge ${name} into…`}>
      {({ close }) => <MergeForm place={place} onCancel={close} onMerged={onMerged} />}
    </Sheet>
  );
}

function MergeForm({
  place,
  onCancel,
  onMerged,
}: {
  place: PlaceView;
  onCancel: () => void;
  onMerged: (targetId: string) => void;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const invalidate = useInvalidateBrowse();
  const tree = usePlaceTree(place.locationId);
  const [target, setTarget] = useState<PickedPlace | null>(null);
  const merge = useMutation({
    mutationFn: (to: PickedPlace) => placeApi.mergeInto(place.id, to.placeId, place.rowVersion),
    onSuccess: async (_view, to) => {
      await invalidate();
      const from = place.name;
      const into = to.name;
      toast({ title: t`Merged ${from} into ${into}`, tone: 'ok' });
      onMerged(to.placeId);
    },
  });
  const name = place.name;
  const into = target?.name ?? '';
  return (
    <div className="grid gap-4">
      <p className="m-0 text-ink-2">
        <Trans>
          Everything in <bdi>{name}</bdi> moves into the place you choose, and <bdi>{name}</bdi>{' '}
          goes away. Its history stays with the things.
        </Trans>
      </p>
      <PlacePicker
        label={t`Merge into`}
        locationIds={[place.locationId]}
        exclude={subtreeOf(tree.data?.places ?? [], place.id)}
        includeUnplaced={false}
        value={target}
        onChange={setTarget}
      />
      {merge.error ? <Notice tone="danger">{errorText(merge.error)}</Notice> : null}
      <DialogFooter>
        <Button variant="secondary" onPress={onCancel}>
          <Trans>Cancel</Trans>
        </Button>
        <Button
          isDisabled={!target}
          isPending={merge.isPending}
          onPress={() => target && merge.mutate(target)}
        >
          {target ? <Trans>Merge into {into}</Trans> : <Trans>Merge</Trans>}
        </Button>
      </DialogFooter>
    </div>
  );
}
