/**
 * Trash a place, with a choice for what's inside (D45, D160). An empty place just asks. A place
 * with contents asks where they go: moved to another place (its parent, or the Unplaced area,
 * unless you pick another), or trashed with it. Everything trashed together shares one batch, so
 * Restore brings it all back; the toast offers Undo for that.
 *
 * The server is the judge: if contents arrived since the page loaded, its 409
 * `contents_choice_required` carries the counts and the dialog asks.
 */
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Radio, RadioGroup } from 'react-aria-components';
import { isApiError } from '@/api/client';
import { inventoryApi } from '@/api/inventory/queries';
import type { ContentsChoiceDetails, PlaceView, TrashResult } from '@/api/inventory/types';
import { useOfferUndo } from '@/components/history/undo';
import { Notice, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { subtreeOf, useInvalidateBrowse, usePlaceTree } from './api';
import { usePlaceName } from './labels';
import { type PickedPlace, PlacePicker } from './move-picker';
import { Sheet } from './sheet';

type Choice = 'move' | 'trash';

export function isContentsChoice(e: unknown): e is { details: ContentsChoiceDetails } {
  return (
    isApiError(e) &&
    (e.serverCode === 'contents_choice_required' ||
      (e.code as string) === 'contents_choice_required')
  );
}

export function TrashPlaceDialog({
  place,
  isOpen,
  onOpenChange,
  onTrashed,
}: {
  place: PlaceView;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onTrashed: (result: TrashResult) => void;
}) {
  const name = place.name;
  const { t } = useLingui();
  return (
    <Sheet
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      role="alertdialog"
      wide
      title={t`Move ${name} to the trash?`}
    >
      {({ close }) => <TrashForm place={place} onCancel={close} onTrashed={onTrashed} />}
    </Sheet>
  );
}

function TrashForm({
  place,
  onCancel,
  onTrashed,
}: {
  place: PlaceView;
  onCancel: () => void;
  onTrashed: (result: TrashResult) => void;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const offerUndo = useOfferUndo();
  const nameOf = usePlaceName();
  const invalidate = useInvalidateBrowse();
  const tree = usePlaceTree(place.locationId);
  const [counts, setCounts] = useState(place.counts);
  const [choice, setChoice] = useState<Choice>('move');
  const [picked, setPicked] = useState<PickedPlace | null>(null);
  const [picking, setPicking] = useState(false);
  const hasContents = counts.places + counts.things > 0;

  // Where the contents go by default: the parent, or the Unplaced area at the top level. Child
  // places can't go into the Unplaced area, so at the top level they become top-level places.
  const places = tree.data?.places ?? [];
  const parent = places.find((pl) => pl.id === place.parentId);
  const unplaced = places.find((pl) => pl.isUnplaced);
  const fallback = parent ?? unplaced;
  const target: PickedPlace | null =
    picked ??
    (fallback
      ? { placeId: fallback.id, locationId: place.locationId, name: nameOf(fallback) }
      : null);

  const trash = useMutation({
    mutationFn: () =>
      inventoryApi.trashPlace(
        place.id,
        !hasContents
          ? {}
          : choice === 'trash'
            ? { contents: 'trash' }
            : { contents: 'move', ...(target ? { moveTo: { placeId: target.placeId } } : {}) },
      ),
    onSuccess: async ({ body, auditEvents }) => {
      await invalidate();
      const name = place.name;
      // Undo is `place.trash`'s audit undo, which also puts moved contents back; a server that
      // recorded nothing undoable gets a plain restore from Trash.
      offerUndo(
        { title: t`${name} is in the trash`, description: t`It stays there for 30 days.` },
        auditEvents,
        { fallback: () => inventoryApi.restorePlace(place.id) },
      );
      onTrashed(body);
    },
    onError: (e) => {
      if (isContentsChoice(e) && e.details.counts) setCounts(e.details.counts);
    },
  });

  const radio =
    'group flex cursor-pointer items-start gap-3 rounded-[10px] border border-line p-3 outline-none data-selected:border-ink data-focus-visible:outline-2 data-focus-visible:outline-info';
  const dot = (
    <span
      aria-hidden="true"
      className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border-2 border-ink-3 group-data-selected:border-ink"
    >
      <span className="hidden size-2.5 rounded-full bg-ink group-data-selected:block" />
    </span>
  );
  const inside = (
    <>
      {counts.places > 0 ? <Plural value={counts.places} one="# place" other="# places" /> : null}
      {counts.places > 0 && counts.things > 0 ? <Trans> and </Trans> : null}
      {counts.things > 0 ? <Plural value={counts.things} one="# thing" other="# things" /> : null}
    </>
  );
  const targetName = target?.name ?? '';

  return (
    <div className="grid gap-4">
      {hasContents ? (
        <>
          <p className="m-0 text-ink-2">
            <Trans>
              <bdi>{place.name}</bdi> has {inside} inside. What should happen to them?
            </Trans>
          </p>
          <RadioGroup
            aria-label={t`What happens to what's inside`}
            value={choice}
            onChange={(v) => setChoice(v as Choice)}
            className="grid gap-2"
          >
            <Radio value="move" className={radio}>
              {dot}
              <span className="grid gap-0.5">
                <span className="font-semibold">
                  <Trans>
                    Move them to <bdi>{targetName}</bdi>
                  </Trans>
                </span>
                <span className="text-small text-ink-2">
                  <Trans>Only {place.name} goes to the trash.</Trans>
                </span>
              </span>
            </Radio>
            <Radio value="trash" className={radio}>
              {dot}
              <span className="grid gap-0.5">
                <span className="font-semibold">
                  <Trans>Trash them too</Trans>
                </span>
                <span className="text-small text-ink-2">
                  <Trans>Everything inside goes with it, and comes back with it on Restore.</Trans>
                </span>
              </span>
            </Radio>
          </RadioGroup>
          {choice === 'move' ? (
            picking ? (
              <PlacePicker
                label={t`Move them to`}
                locationIds={[place.locationId]}
                exclude={subtreeOf(places, place.id)}
                value={target}
                onChange={setPicked}
              />
            ) : (
              <Button
                variant="ghost"
                size="small"
                className="justify-self-start"
                onPress={() => setPicking(true)}
              >
                <Trans>Choose another place</Trans>
              </Button>
            )
          ) : null}
        </>
      ) : (
        <p className="m-0 text-ink-2">
          <Trans>It's empty. You can restore it from Trash for 30 days.</Trans>
        </p>
      )}
      {trash.error && !isContentsChoice(trash.error) ? (
        <Notice tone="danger">{errorText(trash.error)}</Notice>
      ) : null}
      <DialogFooter>
        <Button variant="secondary" autoFocus onPress={onCancel}>
          <Trans>Cancel</Trans>
        </Button>
        <Button
          variant="danger"
          isPending={trash.isPending}
          isDisabled={hasContents && choice === 'move' && !target}
          onPress={() => trash.mutate()}
        >
          <Trans>Move to trash</Trans>
        </Button>
      </DialogFooter>
    </div>
  );
}
