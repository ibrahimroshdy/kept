/**
 * "Add here" (D45, screens §5): **Thing · Box / container · Room or spot**. "Room or spot" is the
 * UI word for any place (product design §6.2). Thing opens the full create sheet (task 26), with
 * where already set to here; Box and Room or spot open a short sheet with an explicit Save, and
 * a toast offers to open what was made.
 *
 * Where Lending is on, **Borrowed thing** adds a thing someone lent you, as theirs, with its loan
 * (D56, step 4 T20).
 *
 * Inside a container only Thing and Box are offered (a place can't sit inside a box), and the
 * Unplaced area holds things only.
 */

import { effectiveModules } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { type FormEvent, useId, useState } from 'react';
import { inventoryApi, useAccounts, useTypes } from '@/api/inventory/queries';
import type { BuiltinPlaceKind, MoveTarget } from '@/api/inventory/types';
import { useLocation } from '@/api/queries';
import { BoxIcon, HandoffIcon, PlusIcon } from '@/components/icons';
import { BorrowSheet } from '@/components/lending/borrow-sheet';
import { Notice, useErrorText } from '@/components/page';
import { CreateThingSheet } from '@/components/things/create-sheet';
import { TypeIcon } from '@/components/type-icon';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/segmented';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { useInvalidateBrowse } from './api';
import { PLACE_KIND_ICONS, PLACE_KINDS, usePlaceKindLabels } from './labels';
import { Sheet } from './sheet';

type Kind = 'thing' | 'box' | 'place' | 'borrowed';

export type AddHereProps = {
  locationId: string;
  /** Where a new thing or box goes: this place (the Unplaced area on a Location page) or box. */
  thingTarget: MoveTarget;
  /**
   * The parent of a new room or spot: a place id, `null` for the top level of the location, or
   * `undefined` when places can't be added here (a container, the Unplaced area).
   */
  placeParentId?: string | null;
  /** The name of where things land, for the sheet titles ("Add a thing to Garage"). */
  hereName: string;
};

export function AddHere({ locationId, thingTarget, placeParentId, hereName }: AddHereProps) {
  const { t } = useLingui();
  const [open, setOpen] = useState<Kind | null>(null);
  const headingId = useId();
  const button =
    'flex min-h-11 flex-1 basis-0 flex-col items-center justify-center gap-1 px-2 py-2 text-center text-[12.5px] md:flex-row md:text-[13.5px]';
  const canPlace = placeParentId !== undefined;
  // "+ Borrowed thing" (D56, T20): where Lending is on, a thing someone lent you comes in here.
  const location = useLocation(locationId);
  const lending =
    !!location.data &&
    new Set(
      location.data.effectiveModules ??
        effectiveModules(location.data.modules, {
          providerResolved: location.data.providerResolved,
        }),
    ).has('lending');
  return (
    <section aria-labelledby={headingId} className="grid min-w-0 gap-1.5">
      <h2 id={headingId} className="eyebrow m-0">
        <Trans>Add here</Trans>
      </h2>
      <div className="flex gap-2">
        <Button variant="secondary" className={button} onPress={() => setOpen('thing')}>
          <PlusIcon className="size-[18px]" />
          <Trans>Thing</Trans>
        </Button>
        <Button variant="secondary" className={button} onPress={() => setOpen('box')}>
          <BoxIcon className="size-[18px]" />
          <Trans>Box / container</Trans>
        </Button>
        {canPlace ? (
          <Button variant="secondary" className={button} onPress={() => setOpen('place')}>
            <TypeIcon icon="lucide:square-dashed" className="size-[18px]" />
            <Trans>Room or spot</Trans>
          </Button>
        ) : null}
        {lending ? (
          <Button variant="secondary" className={button} onPress={() => setOpen('borrowed')}>
            <HandoffIcon className="size-[18px]" />
            <Trans>Borrowed thing</Trans>
          </Button>
        ) : null}
      </div>
      {lending ? (
        <BorrowSheet
          isOpen={open === 'borrowed'}
          onClose={() => setOpen(null)}
          locationId={locationId}
          target={thingTarget}
        />
      ) : null}
      {open === 'thing' ? (
        <CreateThingSheet
          isOpen
          onClose={() => setOpen(null)}
          locationId={locationId}
          target={thingTarget}
          title={t`Add a thing to ${hereName}`}
          openAfter={false}
        />
      ) : null}
      <Sheet
        isOpen={open === 'box'}
        onOpenChange={(o) => !o && setOpen(null)}
        title={t`Add a box to ${hereName}`}
      >
        {({ close }) => (
          <AddThingForm box locationId={locationId} target={thingTarget} onDone={close} />
        )}
      </Sheet>
      {canPlace ? (
        <Sheet
          isOpen={open === 'place'}
          onOpenChange={(o) => !o && setOpen(null)}
          title={t`Add a room or spot to ${hereName}`}
        >
          {({ close }) => (
            <AddPlaceForm locationId={locationId} parentId={placeParentId} onDone={close} />
          )}
        </Sheet>
      ) : null}
    </section>
  );
}

/** The built-in Box / bin type's id (D154), from the caller's own account's type list. */
function useBoxTypeId(): string | undefined {
  const accounts = useAccounts();
  const own = accounts.data?.accounts.find((a) => a.isOwn) ?? accounts.data?.accounts[0];
  const types = useTypes(own?.id ?? '');
  return types.data?.types.find((ty) => ty.builtinKey === 'box_bin')?.id;
}

function AddThingForm({
  box,
  locationId,
  target,
  onDone,
}: {
  box: boolean;
  locationId: string;
  target: MoveTarget;
  onDone: () => void;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const navigate = useNavigate();
  const invalidate = useInvalidateBrowse();
  const boxTypeId = useBoxTypeId();
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();
  const create = useMutation({
    mutationFn: () =>
      inventoryApi.createThing({
        locationId,
        ...target,
        name: name.trim(),
        ...(box && boxTypeId ? { typeId: boxTypeId } : {}),
      }),
    onSuccess: async (thing) => {
      await invalidate();
      const added = thing.name ?? '';
      toast({
        title: t`Added ${added}`,
        tone: 'ok',
        action: {
          label: t`Open`,
          onAction: () => void navigate({ to: '/t/$id', params: { id: thing.id } }),
        },
      });
      onDone();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return setError(box ? t`Give the box a name, like Box 3.` : t`Give it a name.`);
    if (n.length > 200) return setError(t`Keep the name under 200 characters.`);
    create.mutate();
  };
  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      <TextField
        label={t`Name`}
        value={name}
        autoFocus
        onChange={(v) => {
          setName(v);
          setError(undefined);
        }}
        isInvalid={!!error}
        errorMessage={error}
        inputProps={{ dir: 'auto' }}
        {...(box ? { placeholder: t`Box 3` } : {})}
      />
      {create.error ? <Notice tone="danger">{errorText(create.error)}</Notice> : null}
      <DialogFooter>
        <Button variant="secondary" onPress={onDone}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" isPending={create.isPending}>
          <Trans>Save</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
}

function AddPlaceForm({
  locationId,
  parentId,
  onDone,
}: {
  locationId: string;
  parentId: string | null;
  onDone: () => void;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const invalidate = useInvalidateBrowse();
  const kinds = usePlaceKindLabels();
  const [name, setName] = useState('');
  // A top-level place is usually a room; inside one, a spot (D33).
  const [kind, setKind] = useState<BuiltinPlaceKind>(parentId ? 'zone' : 'room');
  const [error, setError] = useState<string>();
  const create = useMutation({
    mutationFn: () =>
      inventoryApi.createPlace(locationId, {
        ...(parentId ? { parentId } : {}),
        name: name.trim(),
        kindKey: kind,
      }),
    onSuccess: async (place) => {
      await invalidate();
      const added = place.name;
      toast({ title: t`Added ${added}`, tone: 'ok' });
      onDone();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return setError(t`Give it a name, like Shelf A or Balcony.`);
    if (n.length > 120) return setError(t`Keep the name under 120 characters.`);
    create.mutate();
  };
  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      <TextField
        label={t`Name`}
        value={name}
        autoFocus
        maxLength={120}
        onChange={(v) => {
          setName(v);
          setError(undefined);
        }}
        isInvalid={!!error}
        errorMessage={error}
        inputProps={{ dir: 'auto' }}
      />
      <Segmented
        label={t`Kind`}
        value={kind}
        onChange={setKind}
        options={PLACE_KINDS.map((k) => ({
          id: k,
          label: (
            <span className="flex flex-col items-center gap-1">
              <TypeIcon icon={PLACE_KIND_ICONS[k]} className="size-4" />
              {kinds[k]}
            </span>
          ),
        }))}
      />
      {create.error ? <Notice tone="danger">{errorText(create.error)}</Notice> : null}
      <DialogFooter>
        <Button variant="secondary" onPress={onDone}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" isPending={create.isPending}>
          <Trans>Save</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
}
