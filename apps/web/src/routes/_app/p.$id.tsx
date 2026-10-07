/**
 * A place's page (screens §5 Place, D160): the breadcrumb, its label ID, "Add here", its fields,
 * then what's in it (places first, then things) under the list standard, its attachments, and
 * every place operation: rename, move (re-parent within the location), merge, turn into a box,
 * label, and trash with a choice for what's inside (D45).
 *
 * Controls follow screens §3: hidden for a role that can't use them; the label action shows
 * "Off in this location" when the Labels module is off. The Unplaced area (D118) is a place too,
 * but a fixed one: it can't be renamed, moved, merged, converted or trashed.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { type FormEvent, type ReactNode, useState } from 'react';
import { inventoryApi, usePlace } from '@/api/inventory/queries';
import type { BuiltinPlaceKind, PlaceView } from '@/api/inventory/types';
import { useLocation } from '@/api/queries';
import type { LocationDetail } from '@/api/types';
import { OwnCodesSection } from '@/components/codes/own-codes';
import { SubjectPaperwork } from '@/components/documents/subject-paperwork';
import { useOfferUndo } from '@/components/history/undo';
import {
  BoxIcon,
  ChevronEndIcon,
  DocumentIcon,
  LinkIcon,
  PencilIcon,
  PrinterIcon,
  QrIcon,
  ShareIcon,
  TrashIcon,
} from '@/components/icons';
import { IdChip } from '@/components/id-chip';
import {
  EmptyState,
  ErrorState,
  List,
  LoadingRows,
  Notice,
  Page,
  Row,
  Section,
  useErrorText,
} from '@/components/page';
import { AddHere } from '@/components/places/add-here-sheet';
import { placeApi, subtreeOf, useInvalidateBrowse, usePlaceTree } from '@/components/places/api';
import { Breadcrumb } from '@/components/places/breadcrumb';
import { ContentsList } from '@/components/places/contents-list';
import { contentsSearch } from '@/components/places/contents-search';
import { ConvertToContainerDialog } from '@/components/places/convert-dialog';
import {
  PLACE_KIND_ICONS,
  PLACE_KINDS,
  placeIcon,
  usePlaceKindLabels,
  usePlaceKindName,
  usePlaceName,
} from '@/components/places/labels';
import { MergePlaceDialog } from '@/components/places/merge-dialog';
import { type PickedPlace, PlacePicker } from '@/components/places/move-picker';
import { OfflinePlacePage, useOfflinePage } from '@/components/places/offline-pages';
import { PlaceFields } from '@/components/places/place-fields';
import { PlaceCounts } from '@/components/places/rows';
import { Sheet } from '@/components/places/sheet';
import { TrashPlaceDialog } from '@/components/places/trash-contents-dialog';
import { SortUnplaced } from '@/components/places/unplaced-sort';
import { useOriginalFile } from '@/components/things/original-file';
import { TypeIcon } from '@/components/type-icon';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/segmented';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { useAddress, useCanonicalAddress } from '@/lib/address';
import { sep } from '@/lib/format';
import { useLocationName } from '@/lib/labels';

export const Route = createFileRoute('/_app/p/$id')({
  validateSearch: contentsSearch,
  component: PlacePage,
});

/** `$id` is the short ID or the UUID (D208, T17a; lib/address.ts): a UUID address, or a code
 * typed another way, is replaced in place by the short ID once the place has one. */
function PlacePage() {
  const { id: param } = Route.useParams();
  const { t } = useLingui();
  const address = useAddress('place', param);
  if (address.status === 'error')
    return (
      <Page title={t`Place`} back="/">
        <ErrorState error={address.error} onRetry={address.retry} />
      </Page>
    );
  if (address.status === 'pending')
    return (
      <Page title={t`Place`} back="/">
        <LoadingRows />
      </Page>
    );
  return <PlaceScreen key={address.id} id={address.id} param={param} />;
}

function PlaceScreen({ id, param }: { id: string; param: string }) {
  const { t } = useLingui();
  const place = usePlace(id);
  useCanonicalAddress('place', param, place.data);
  const location = useLocation(place.data?.locationId ?? '');
  // Offline, or the server out of reach: the phone's copy, "as of last sync" (T28).
  const offline = useOfflinePage(place);
  if (offline) return <OfflinePlacePage id={id} />;
  if (place.error)
    return (
      <Page title={t`Place`} back="/">
        <ErrorState error={place.error} onRetry={() => void place.refetch()} />
      </Page>
    );
  if (place.isPending || location.isPending)
    return (
      <Page title={t`Place`} back="/">
        <LoadingRows />
      </Page>
    );
  if (location.error)
    return (
      <Page title={t`Place`} back="/">
        <ErrorState error={location.error} onRetry={() => void location.refetch()} />
      </Page>
    );
  return <PlaceBody key={place.data.id} place={place.data} location={location.data} />;
}

type Open = 'rename' | 'move' | 'merge' | 'convert' | 'trash' | 'sort' | null;

function PlaceBody({ place, location }: { place: PlaceView; location: LocationDetail }) {
  const navigate = useNavigate();
  const nameOf = usePlaceName();
  const kindName = usePlaceKindName();
  const locationName = useLocationName()(location);
  const [open, setOpen] = useState<Open>(null);
  const role = location.role;
  const canEdit = role !== 'viewer';
  const admin = role === 'owner' || role === 'admin';
  const name = nameOf(place);
  const parentStep = place.path.at(-2);
  const back = parentStep
    ? { to: '/p/$id' as const, params: { id: parentStep.id } }
    : { to: '/loc/$id' as const, params: { id: location.id } };
  const close = () => setOpen(null);
  const toParent = () => void navigate(back);
  const invalidateBrowse = useInvalidateBrowse();
  // D155: a room's documents, while Paperwork is on (never on the Unplaced area).
  const paperwork =
    !place.isUnplaced && (location.effectiveModules ?? location.modules).includes('paperwork');

  return (
    <Page title={name} back={back} eyebrow={<bdi>{locationName}</bdi>} wide>
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <IdChip code={place.shortCode} size="large" />
          <Breadcrumb
            location={{ id: location.id, name: locationName }}
            path={place.path.slice(0, -1)}
            current={name}
          />
        </div>
        <div className="flex items-center gap-2 text-small text-ink-2">
          <TypeIcon icon={placeIcon(place)} className="size-4 text-ink-3" />
          {place.isUnplaced ? (
            <Trans>Things captured with no place yet</Trans>
          ) : (
            <>
              {kindName(place.kindKey)}
              {sep()}
              <PlaceCounts
                place={{ thingCount: place.counts.things, childCount: place.counts.places }}
              />
            </>
          )}
        </div>
      </div>

      {canEdit ? (
        <AddHere
          locationId={location.id}
          thingTarget={{ placeId: place.id }}
          {...(place.isUnplaced ? {} : { placeParentId: place.id })}
          hereName={name}
        />
      ) : null}

      {place.isUnplaced && canEdit && place.counts.things > 0 ? (
        <Notice
          tone="info"
          title={<Trans>Give these a place</Trans>}
          action={
            <Button size="small" variant="secondary" onPress={() => setOpen('sort')}>
              <Trans>Sort them</Trans>
            </Button>
          }
        >
          <Trans>
            One at a time with the move picker, or use Select below to move several at once.
          </Trans>
        </Notice>
      ) : null}

      <PlaceFields place={place} canEdit={canEdit} />

      {place.isUnplaced ? null : (
        <OwnCodesSection kind="place" id={place.id} locationId={location.id} canEdit={canEdit} />
      )}

      <ContentsList
        parent={{ kind: 'place', id: place.id, locationId: location.id, name }}
        canEdit={canEdit}
        empty={
          <EmptyState icon={<BoxIcon />} title={<Trans>Nothing here yet</Trans>}>
            {canEdit ? (
              <Trans>
                Use Add here to put the first thing in <bdi>{name}</bdi>.
              </Trans>
            ) : null}
          </EmptyState>
        }
      />

      {paperwork ? (
        <SubjectPaperwork
          subject={{ type: 'place', locationId: location.id, placeId: place.id, name }}
          role={role}
          onChanged={() => void invalidateBrowse()}
        />
      ) : null}

      <Attachments place={place} paperwork={paperwork} />

      {canEdit && !place.isUnplaced ? (
        <Section title={<Trans>Manage</Trans>}>
          <List>
            <ActionRow
              icon={<PencilIcon />}
              title={<Trans>Rename</Trans>}
              subtitle={<Trans>Change the name or the kind of place</Trans>}
              onPress={() => setOpen('rename')}
            />
            <ActionRow
              icon={<ChevronEndIcon />}
              title={<Trans>Move</Trans>}
              subtitle={<Trans>Put it inside another place in {locationName}</Trans>}
              onPress={() => setOpen('move')}
            />
            {admin ? (
              <ActionRow
                icon={<LinkIcon />}
                title={<Trans>Merge into another place</Trans>}
                subtitle={<Trans>When two places are really the same one</Trans>}
                onPress={() => setOpen('merge')}
              />
            ) : null}
            {place.counts.places === 0 ? (
              <ActionRow
                icon={<BoxIcon />}
                title={<Trans>Turn into a box</Trans>}
                subtitle={<Trans>So it can be carried, with what's in it, as one thing</Trans>}
                onPress={() => setOpen('convert')}
              />
            ) : null}
            <LabelRow place={place} location={location} />
            <ActionRow
              icon={<TrashIcon />}
              title={<Trans>Move to trash</Trans>}
              subtitle={<Trans>Choose what happens to what's inside</Trans>}
              danger
              onPress={() => setOpen('trash')}
            />
          </List>
        </Section>
      ) : null}

      <RenameSheet place={place} isOpen={open === 'rename'} onClose={close} />
      <ReparentSheet place={place} isOpen={open === 'move'} onClose={close} />
      <MergePlaceDialog
        place={place}
        isOpen={open === 'merge'}
        onOpenChange={(o) => !o && close()}
        onMerged={(targetId) => void navigate({ to: '/p/$id', params: { id: targetId } })}
      />
      <ConvertToContainerDialog
        place={place}
        isOpen={open === 'convert'}
        onOpenChange={(o) => !o && close()}
        onConverted={(thingId) => void navigate({ to: '/t/$id', params: { id: thingId } })}
      />
      <TrashPlaceDialog
        place={place}
        isOpen={open === 'trash'}
        onOpenChange={(o) => !o && close()}
        onTrashed={toParent}
      />
      {open === 'sort' ? (
        <SortUnplaced unplacedId={place.id} locationId={location.id} onClose={close} />
      ) : null}
    </Page>
  );
}

function ActionRow({
  icon,
  title,
  subtitle,
  onPress,
  danger = false,
  trailing,
}: {
  icon: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  onPress?: () => void;
  danger?: boolean;
  trailing?: ReactNode;
}) {
  const row = (
    <Row
      leading={
        <span
          aria-hidden="true"
          className={`grid size-10 shrink-0 place-items-center rounded-[10px] bg-sunken [&_svg]:size-5 ${danger ? 'text-danger' : 'text-ink-2'}`}
        >
          {icon}
        </span>
      }
      title={<span className={danger ? 'text-danger' : undefined}>{title}</span>}
      subtitle={subtitle}
      trailing={trailing}
    />
  );
  return (
    <li>
      {onPress ? (
        <button
          type="button"
          onClick={onPress}
          className="block w-full cursor-pointer bg-transparent p-0 text-start outline-none hover:bg-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-info"
        >
          {row}
        </button>
      ) : (
        row
      )}
    </li>
  );
}

/**
 * The label actions (D120, D137, `labels` module): give the place a short ID, print its label,
 * and "Label everything here" that has never been printed (the batch builder, plan T28). Off in
 * this location → says so, with "Turn on" for admins (§3).
 */
function LabelRow({ place, location }: { place: PlaceView; location: LocationDetail }) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const invalidate = useInvalidateBrowse();
  const navigate = useNavigate();
  const on = (location.effectiveModules ?? location.modules).includes('labels');
  const admin = location.role === 'owner' || location.role === 'admin';
  const label = useMutation({
    mutationFn: () => placeApi.label(place.id),
    onSuccess: async ({ code }) => {
      await invalidate();
      toast({ title: t`Label ID ${code} is ready`, tone: 'ok' });
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });
  if (!on)
    return (
      <ActionRow
        icon={<QrIcon />}
        title={<Trans>Label</Trans>}
        subtitle={<Trans>Off in this location</Trans>}
        trailing={
          admin ? (
            <Link
              to="/settings/location/$id/track"
              params={{ id: location.id }}
              className="shrink-0 text-small font-semibold text-ink underline underline-offset-2 outline-none focus-visible:outline-2 focus-visible:outline-info"
            >
              <Trans>Turn on</Trans>
            </Link>
          ) : (
            <span className="shrink-0 text-small text-ink-3">
              <Trans>Ask an admin</Trans>
            </span>
          )
        }
      />
    );
  const everything = (
    <ActionRow
      icon={<PrinterIcon />}
      title={<Trans>Label everything here</Trans>}
      subtitle={<Trans>Print labels for what's in here that never had one printed</Trans>}
      onPress={() =>
        void navigate({
          to: '/labels',
          search: { loc: location.id, unprinted: 1, place: place.id },
        })
      }
    />
  );
  if (place.shortCode)
    return (
      <>
        <ActionRow
          icon={<QrIcon />}
          title={<Trans>Print its label</Trans>}
          subtitle={<Trans>For the shelf or door; a reprint has the same code</Trans>}
          trailing={<IdChip code={place.shortCode} />}
          onPress={() =>
            void navigate({ to: '/labels', search: { loc: location.id, places: place.id } })
          }
        />
        {everything}
      </>
    );
  return (
    <>
      <ActionRow
        icon={<QrIcon />}
        title={<Trans>Give it a label ID</Trans>}
        subtitle={<Trans>A short code for the printed label on the shelf or door</Trans>}
        onPress={() => label.mutate()}
      />
      {everything}
    </>
  );
}

/** The roles the Paperwork section lists (the paperwork library's), so they aren't shown twice. */
const PAPERWORK_ROLES: ReadonlySet<string> = new Set([
  'receipt',
  'invoice',
  'manual',
  'warranty_doc',
  'registration',
  'document',
]);

function Attachments({ place, paperwork }: { place: PlaceView; paperwork: boolean }) {
  const shown = paperwork
    ? place.attachments.filter((a) => !PAPERWORK_ROLES.has(a.role))
    : place.attachments;
  if (shown.length === 0) return null;
  return (
    <Section title={<Trans>Attachments</Trans>}>
      <List>
        {shown.map((a) => (
          <PlaceAttachment key={a.id} attachment={a} />
        ))}
      </List>
    </Section>
  );
}

/** A link opens; a file opens its original, shared instead on the installed iPhone app. */
function PlaceAttachment({ attachment: a }: { attachment: PlaceView['attachments'][number] }) {
  const { t } = useLingui();
  const file = useOriginalFile(
    a.file && !a.url
      ? { fileId: a.file.id, mime: a.file.mime, role: a.role, variant: 'original' }
      : null,
  );
  const title = a.url ?? a.file?.mime ?? t`File`;
  const url = a.url;
  return (
    <ActionRow
      icon={url ? <LinkIcon /> : <DocumentIcon />}
      title={<bdi>{title}</bdi>}
      subtitle={a.createdBy.displayName}
      {...(file.mode === 'share' ? { trailing: <ShareIcon className="size-5 text-ink-2" /> } : {})}
      {...(url
        ? { onPress: () => window.open(url, '_blank', 'noopener') }
        : a.file
          ? { onPress: file.press }
          : {})}
    />
  );
}

function RenameSheet({
  place,
  isOpen,
  onClose,
}: {
  place: PlaceView;
  isOpen: boolean;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const current = place.name;
  return (
    <Sheet isOpen={isOpen} onOpenChange={(o) => !o && onClose()} title={t`Rename ${current}`}>
      {({ close }) => <RenameForm place={place} onDone={close} />}
    </Sheet>
  );
}

function RenameForm({ place, onDone }: { place: PlaceView; onDone: () => void }) {
  const { t } = useLingui();
  const offerUndo = useOfferUndo();
  const errorText = useErrorText();
  const invalidate = useInvalidateBrowse();
  const kinds = usePlaceKindLabels();
  const [name, setName] = useState(place.name);
  const builtin = (PLACE_KINDS as readonly string[]).includes(place.kindKey);
  const [kind, setKind] = useState(place.kindKey);
  const [error, setError] = useState<string>();
  const save = useMutation({
    mutationFn: () =>
      inventoryApi.updatePlace(
        place.id,
        {
          ...(name.trim() !== place.name ? { name: name.trim() } : {}),
          ...(kind !== place.kindKey ? { kindKey: kind } : {}),
        },
        place.rowVersion,
      ),
    onSuccess: async ({ auditEvents }) => {
      await invalidate();
      offerUndo({ title: t`Saved` }, auditEvents);
      onDone();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return setError(t`Give it a name, like Shelf A or Balcony.`);
    if (n.length > 120) return setError(t`Keep the name under 120 characters.`);
    if (n === place.name && kind === place.kindKey) return onDone();
    save.mutate();
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
      {builtin ? (
        <Segmented
          label={t`Kind`}
          value={kind as BuiltinPlaceKind}
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
      ) : null}
      {save.error ? <Notice tone="danger">{errorText(save.error)}</Notice> : null}
      <DialogFooter>
        <Button variant="secondary" onPress={onDone}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" isPending={save.isPending}>
          <Trans>Save</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Re-parent within the location (D160): the move picker, places only, never into itself. */
function ReparentSheet({
  place,
  isOpen,
  onClose,
}: {
  place: PlaceView;
  isOpen: boolean;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const name = place.name;
  return (
    <Sheet isOpen={isOpen} onOpenChange={(o) => !o && onClose()} wide title={t`Move ${name} into…`}>
      {({ close }) => <ReparentForm place={place} onDone={close} />}
    </Sheet>
  );
}

function ReparentForm({ place, onDone }: { place: PlaceView; onDone: () => void }) {
  const { t } = useLingui();
  const offerUndo = useOfferUndo();
  const errorText = useErrorText();
  const invalidate = useInvalidateBrowse();
  const tree = usePlaceTree(place.locationId);
  const [to, setTo] = useState<PickedPlace | null>(null);
  // `null` is the top level of the location (T25 decision 2).
  const move = useMutation({
    mutationFn: (target: PickedPlace | null) =>
      inventoryApi.updatePlace(place.id, { parentId: target?.placeId ?? null }, place.rowVersion),
    onSuccess: async ({ auditEvents }, target) => {
      await invalidate();
      const where = target?.name ?? '';
      offerUndo(
        { title: target ? t`Moved into ${where}` : t`Moved to the top level` },
        auditEvents,
      );
      onDone();
    },
  });
  return (
    <div className="grid gap-4">
      <PlacePicker
        label={t`Move into`}
        locationIds={[place.locationId]}
        exclude={subtreeOf(tree.data?.places ?? [], place.id)}
        includeUnplaced={false}
        value={to}
        onChange={setTo}
      />
      {place.parentId !== null ? (
        <Button
          variant="secondary"
          className="justify-self-start"
          isDisabled={move.isPending}
          onPress={() => move.mutate(null)}
        >
          <Trans>Move to the top level</Trans>
        </Button>
      ) : null}
      {move.error ? <Notice tone="danger">{errorText(move.error)}</Notice> : null}
      <DialogFooter>
        <Button variant="secondary" onPress={onDone}>
          <Trans>Cancel</Trans>
        </Button>
        <Button
          isDisabled={!to || to.placeId === place.parentId}
          isPending={move.isPending}
          onPress={() => to && move.mutate(to)}
        >
          <Trans>Move here</Trans>
        </Button>
      </DialogFooter>
    </div>
  );
}
