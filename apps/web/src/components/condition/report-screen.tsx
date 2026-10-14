/**
 * One condition report (1.x, D171, D235): a move-in or move-out walk-through, room by room. Each
 * room has how it was found (good, fair, poor, damaged), a note, and photos dated by when Kept
 * received them (in the location's time zone); photos are stripped of location data like every
 * photo in Kept (D117).
 *
 * Members and above (`things.edit`) record it while it is open; Finish locks it for good, stamped
 * with who and when. A draft is deleted by whoever can write; a finished one by owners and admins.
 * Everyone who can see the location reads it, viewers too, and may make its PDF.
 *
 * "Compare with" puts a report of the other kind beside it, room by room (paired by place, then
 * by name: @kept/shared pairRooms), the earlier walk-through first; the choice is the URL's
 * `compare`, and the PDF follows it.
 */
import {
  MAX_CONDITION_NOTE,
  MAX_ROOM_NAME,
  MAX_ROOM_PHOTOS,
  pairRooms,
  ROOM_CONDITIONS,
  type RoomCondition,
} from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import { TextArea, TextField as TextFieldPrimitive } from 'react-aria-components';
import { isApiError } from '@/api/client';
import { conditionApi, conditionKeys, useConditionReport } from '@/api/condition/queries';
import type { ConditionPhoto, ConditionReport, ConditionRoom } from '@/api/condition/types';
import { thingApi } from '@/api/inventory/thing-api';
import { useLocations } from '@/api/queries';
import { CheckCircleIcon, PlusIcon, PrinterIcon, TrashIcon } from '@/components/icons';
import { ErrorState, LoadingRows, Notice, Page, Pill, useErrorText } from '@/components/page';
import { accessOf } from '@/components/schedules/access';
import { UploadButton } from '@/components/things/upload';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { inputClass, Label } from '@/components/ui/field';
import { Segmented } from '@/components/ui/segmented';
import { Select, SelectItem } from '@/components/ui/select';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { sep } from '@/lib/format';
import { useLocationName } from '@/lib/labels';
import { useOnline } from '@/lib/online';
import { cn } from '@/lib/utils';
import { useConditionDates, useConditionKindLabels, useRoomConditionLabels } from './labels';
import { ConditionPdfSheet } from './pdf-sheet';

const PILL_TONE = { good: 'ok', fair: 'warn', poor: 'warn', damaged: 'danger' } as const;

/** The report's title: "Move-in · 1 Sept 2026". */
function useTitleOf() {
  const kinds = useConditionKindLabels();
  const dates = useConditionDates();
  return (r: Pick<ConditionReport, 'kind' | 'heldOn'>) =>
    `${kinds[r.kind]}${sep()}${dates.day(r.heldOn)}`;
}

/** After a write: the report, and the lists that count its rooms and photos. A finished report
 * (someone else finished it) reads again and says so. */
function useRefresh(id: string) {
  const qc = useQueryClient();
  const errorText = useErrorText();
  const { t } = useLingui();
  return {
    done: () => qc.invalidateQueries({ queryKey: conditionKeys.all }),
    failed: (e: unknown) => {
      if (isApiError(e) && (e.status === 409 || e.status === 412))
        void qc.invalidateQueries({ queryKey: conditionKeys.one(id) });
      toast({
        title:
          isApiError(e) && e.details?.reason === 'report_finished'
            ? t`This report is finished, so it can't change.`
            : errorText(e),
        tone: 'danger',
      });
    },
  };
}

export function ConditionReportScreen({ id, compare }: { id: string; compare?: string }) {
  const { t } = useLingui();
  const report = useConditionReport(id);
  const other = useConditionReport(compare ?? null);
  const titleOf = useTitleOf();
  const frame = (body: ReactNode) => (
    <Page title={t`Condition report`} back="/condition-reports">
      {body}
    </Page>
  );
  if (report.isPending) return frame(<LoadingRows rows={4} />);
  if (report.error || !report.data)
    return frame(<ErrorState error={report.error} onRetry={() => void report.refetch()} />);
  const r = report.data;
  return (
    <Page title={titleOf(r)} back="/condition-reports" wide>
      <ReportHeader report={r} compare={compare} />
      {compare && other.data ? <Comparison a={r} b={other.data} /> : <Rooms report={r} />}
    </Page>
  );
}

function ReportHeader({ report, compare }: { report: ConditionReport; compare?: string }) {
  const { t } = useLingui();
  const locations = useLocations();
  const locationName = useLocationName();
  const location = locations.data?.find((l) => l.id === report.locationId);
  const access = accessOf(location);
  const open = !report.finishedAt;
  const canWrite = open && access.can('things.edit');
  const canDelete =
    access.can('things.edit') && (open || location?.role === 'owner' || location?.role === 'admin');
  const dates = useConditionDates();
  const titleOf = useTitleOf();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const online = useOnline();
  const refresh = useRefresh(report.id);
  const [printing, setPrinting] = useState(false);

  const finish = useMutation({
    mutationFn: () => conditionApi.finish(report.id, report.rowVersion),
    onSuccess: refresh.done,
    onError: refresh.failed,
  });
  const remove = useMutation({
    mutationFn: () => conditionApi.remove(report.id, report.rowVersion),
    onSuccess: async () => {
      await refresh.done();
      await navigate({ to: '/condition-reports' });
    },
    onError: refresh.failed,
  });

  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        {location ? (
          <div className="text-ink-2">
            <bdi>{locationName(location)}</bdi>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {report.finishedAt ? (
            <Pill tone="ok" icon={<CheckCircleIcon />}>
              <Trans>
                Finished by <bdi>{report.finishedBy?.displayName ?? ''}</bdi>,{' '}
                {dates.at(report.finishedAt, report.timezone)}
              </Trans>
            </Pill>
          ) : (
            <Pill tone="warn">
              <Trans>Not finished</Trans>
            </Pill>
          )}
          <span className="text-small text-ink-3">
            <Trans>
              Started by <bdi>{report.createdBy.displayName}</bdi>
            </Trans>
          </span>
        </div>
      </div>
      <NotesField report={report} canWrite={canWrite} />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="small"
          isDisabled={!online}
          onPress={() => setPrinting(true)}
        >
          <PrinterIcon className="size-4" />
          <Trans>Make the PDF</Trans>
        </Button>
        {canWrite ? (
          <Button
            size="small"
            isDisabled={!online}
            isPending={finish.isPending}
            onPress={async () => {
              const ok = await confirm({
                title: t`Finish this report?`,
                body: t`It is locked once finished: nothing in it can change, and its photos stay as they are.`,
                confirmLabel: t`Finish`,
              });
              if (ok) finish.mutate();
            }}
          >
            <CheckCircleIcon className="size-4" />
            <Trans>Finish</Trans>
          </Button>
        ) : null}
        {canDelete ? (
          <Button
            variant="ghost"
            size="small"
            isDisabled={!online}
            isPending={remove.isPending}
            onPress={async () => {
              const ok = await confirm({
                title: t`Delete this report?`,
                body: t`Its rooms, notes and photos go with it. This can't be undone.`,
                confirmLabel: t`Delete`,
                destructive: true,
              });
              if (ok) remove.mutate();
            }}
          >
            <TrashIcon className="size-4" />
            <Trans>Delete</Trans>
          </Button>
        ) : null}
        {online ? null : (
          <span className="text-small text-ink-3">
            <Trans>Needs a connection</Trans>
          </span>
        )}
      </div>
      {report.others.length > 0 ? (
        <CompareWith report={report} compare={compare} titleOf={titleOf} />
      ) : null}
      <ConditionPdfSheet
        isOpen={printing}
        onClose={() => setPrinting(false)}
        report={report}
        compareWith={compare && report.others.some((o) => o.id === compare) ? compare : undefined}
      />
    </div>
  );
}

function CompareWith({
  report,
  compare,
  titleOf,
}: {
  report: ConditionReport;
  compare?: string | undefined;
  titleOf: (r: Pick<ConditionReport, 'kind' | 'heldOn'>) => string;
}) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const items = [
    { id: '', name: t`None` },
    ...report.others.map((o) => ({ id: o.id, name: titleOf(o) })),
  ];
  return (
    <Select<{ id: string; name: string }>
      label={t`Compare with`}
      items={items}
      value={compare ?? ''}
      onChange={(key) =>
        void navigate({
          to: '/condition-reports/$id',
          params: { id: report.id },
          search: key ? { compare: String(key) } : {},
          replace: true,
        })
      }
      className="max-w-md"
    >
      {(item) => (
        <SelectItem id={item.id} textValue={item.name}>
          {item.name}
        </SelectItem>
      )}
    </Select>
  );
}

function NotesField({ report, canWrite }: { report: ConditionReport; canWrite: boolean }) {
  const { t } = useLingui();
  const refresh = useRefresh(report.id);
  const [value, setValue] = useState(report.notes ?? '');
  const save = useMutation({
    mutationFn: (notes: string) =>
      conditionApi.update(report.id, { notes: notes.trim() || null }, report.rowVersion),
    onSuccess: refresh.done,
    onError: refresh.failed,
  });
  if (!canWrite)
    return report.notes ? (
      <p className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere]" dir="auto">
        {report.notes}
      </p>
    ) : null;
  return (
    <TextFieldPrimitive
      value={value}
      onChange={setValue}
      onBlur={() => {
        if (value.trim() !== (report.notes ?? '')) save.mutate(value);
      }}
      maxLength={MAX_CONDITION_NOTE}
      className="grid max-w-2xl gap-1"
    >
      <Label>
        <Trans>Notes</Trans>
      </Label>
      <TextArea
        dir="auto"
        rows={2}
        className={inputClass}
        placeholder={t`Keys handed over, meter readings, who was there`}
      />
    </TextFieldPrimitive>
  );
}

// ----- recording -------------------------------------------------------------------------------

function Rooms({ report }: { report: ConditionReport }) {
  const locations = useLocations();
  const location = locations.data?.find((l) => l.id === report.locationId);
  const canWrite = !report.finishedAt && accessOf(location).can('things.edit');
  return (
    <section className="grid gap-3">
      <h2 className="m-0 font-semibold text-[17px]">
        <Trans>Rooms</Trans>
      </h2>
      {report.rooms.length === 0 ? (
        <p className="m-0 text-ink-2">
          <Trans>No rooms yet. Add the first one below.</Trans>
        </p>
      ) : null}
      <ul className="m-0 grid list-none gap-3 p-0">
        {report.rooms.map((room) => (
          <li key={room.id}>
            <RoomCard report={report} room={room} canWrite={canWrite} />
          </li>
        ))}
      </ul>
      {canWrite ? <AddRoom report={report} /> : null}
    </section>
  );
}

function RoomCard({
  report,
  room,
  canWrite,
}: {
  report: ConditionReport;
  room: ConditionRoom;
  canWrite: boolean;
}) {
  const { t } = useLingui();
  const labels = useRoomConditionLabels();
  const confirm = useConfirm();
  const online = useOnline();
  const refresh = useRefresh(report.id);
  const [note, setNote] = useState(room.note ?? '');
  const update = useMutation({
    mutationFn: (body: { condition?: RoomCondition | null; note?: string | null }) =>
      conditionApi.updateRoom(room.id, body, room.rowVersion),
    onSuccess: refresh.done,
    onError: refresh.failed,
  });
  const remove = useMutation({
    mutationFn: () => conditionApi.removeRoom(room.id, room.rowVersion),
    onSuccess: refresh.done,
    onError: refresh.failed,
  });
  return (
    <article
      aria-label={room.name}
      className="grid gap-3 rounded-xl border border-line bg-surface p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="m-0 font-semibold text-[16px] [overflow-wrap:anywhere]" dir="auto">
          {room.name}
        </h3>
        {canWrite ? (
          <Button
            variant="ghost"
            size="small"
            isDisabled={!online}
            onPress={async () => {
              const ok = await confirm({
                title: t`Remove ${room.name} from this report?`,
                body: t`Its note and photos go with it.`,
                confirmLabel: t`Remove`,
                destructive: true,
              });
              if (ok) remove.mutate();
            }}
          >
            <TrashIcon className="size-4" />
            <Trans>Remove</Trans>
          </Button>
        ) : null}
      </div>
      {canWrite ? (
        <>
          <Segmented<RoomCondition>
            label={t`Condition`}
            value={(room.condition ?? '') as RoomCondition}
            onChange={(condition) => update.mutate({ condition })}
            isDisabled={!online || update.isPending}
            options={ROOM_CONDITIONS.map((c) => ({ id: c, label: labels[c] }))}
          />
          <TextFieldPrimitive
            value={note}
            onChange={setNote}
            onBlur={() => {
              if (note.trim() !== (room.note ?? '')) update.mutate({ note: note.trim() || null });
            }}
            maxLength={MAX_CONDITION_NOTE}
            className="grid gap-1"
          >
            <Label>
              <Trans>Note</Trans>
            </Label>
            <TextArea
              dir="auto"
              rows={2}
              className={inputClass}
              placeholder={t`Marks, damage, what works and what doesn't`}
            />
          </TextFieldPrimitive>
        </>
      ) : (
        <RoomReading room={room} />
      )}
      <Photos report={report} room={room} canWrite={canWrite} />
    </article>
  );
}

/** A room as it was recorded: its condition and note. */
function RoomReading({ room }: { room: ConditionRoom }) {
  const labels = useRoomConditionLabels();
  return (
    <div className="grid gap-1.5">
      {room.condition ? (
        <Pill tone={PILL_TONE[room.condition]}>{labels[room.condition]}</Pill>
      ) : (
        <span className="text-small text-ink-3">
          <Trans>Condition not recorded</Trans>
        </span>
      )}
      {room.note ? (
        <p className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere]" dir="auto">
          {room.note}
        </p>
      ) : null}
    </div>
  );
}

function Photos({
  report,
  room,
  canWrite,
}: {
  report: ConditionReport;
  room: ConditionRoom;
  canWrite: boolean;
}) {
  const { t } = useLingui();
  const refresh = useRefresh(report.id);
  const online = useOnline();
  const full = room.photos.length >= MAX_ROOM_PHOTOS;
  return (
    <div className="grid gap-2">
      {room.photos.length > 0 ? (
        <PhotoGrid
          photos={room.photos}
          timezone={report.timezone}
          onRemove={canWrite ? refresh.done : null}
          onError={refresh.failed}
        />
      ) : null}
      {canWrite && !full && online ? (
        <UploadButton
          locationId={report.locationId}
          subject={{ conditionRoomId: room.id }}
          attachAs="photo"
          label={t`Add photos`}
          accept={['image/*']}
          onUploaded={() => void refresh.done()}
        />
      ) : null}
      {canWrite && full ? (
        <p className="m-0 text-small text-ink-3">
          <Trans>A room holds {MAX_ROOM_PHOTOS} photos. Remove one to add another.</Trans>
        </p>
      ) : null}
    </div>
  );
}

function PhotoGrid({
  photos,
  timezone,
  onRemove,
  onError,
  small = false,
}: {
  photos: ConditionPhoto[];
  timezone: string;
  onRemove: (() => void) | null;
  onError?: (e: unknown) => void;
  small?: boolean;
}) {
  const { t } = useLingui();
  const dates = useConditionDates();
  const confirm = useConfirm();
  return (
    <ul
      className={cn(
        'm-0 grid list-none gap-2 p-0',
        small ? 'grid-cols-3' : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4',
      )}
    >
      {photos.map((p) => {
        const when = dates.at(p.addedAt, timezone);
        return (
          <li key={p.id} className="grid content-start gap-1">
            {p.file?.thumbUrl ? (
              <a
                href={p.file.displayUrl ?? p.file.thumbUrl}
                target="_blank"
                rel="noopener"
                className="block overflow-hidden rounded-lg border border-line outline-none focus-visible:outline-2 focus-visible:outline-info"
              >
                <img
                  src={p.file.thumbUrl}
                  alt={t`Added ${when}`}
                  className="aspect-[4/3] w-full bg-sunken object-cover"
                  loading="lazy"
                />
              </a>
            ) : (
              <div className="grid aspect-[4/3] place-items-center rounded-lg bg-sunken p-2 text-center text-small text-ink-3">
                <Trans>Preview unavailable</Trans>
              </div>
            )}
            <span className="text-[12.5px] text-ink-3 [overflow-wrap:anywhere]">
              {when}
              {sep()}
              <bdi>{p.createdBy.displayName}</bdi>
            </span>
            {onRemove ? (
              <Button
                variant="ghost"
                size="small"
                className="justify-self-start"
                onPress={async () => {
                  const ok = await confirm({
                    title: t`Remove this photo?`,
                    confirmLabel: t`Remove`,
                    destructive: true,
                  });
                  if (!ok) return;
                  try {
                    await thingApi.deleteAttachment(p.id);
                    onRemove();
                  } catch (e) {
                    onError?.(e);
                  }
                }}
              >
                <TrashIcon className="size-4" />
                <Trans>Remove</Trans>
              </Button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function AddRoom({ report }: { report: ConditionReport }) {
  const { t } = useLingui();
  const online = useOnline();
  const refresh = useRefresh(report.id);
  const [name, setName] = useState('');
  const add = useMutation({
    mutationFn: () => conditionApi.addRoom(report.id, { name: name.trim() }),
    onSuccess: async () => {
      setName('');
      await refresh.done();
    },
    onError: refresh.failed,
  });
  return (
    <form
      noValidate
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) add.mutate();
      }}
    >
      <TextField
        label={t`Another room`}
        value={name}
        onChange={setName}
        maxLength={MAX_ROOM_NAME}
        placeholder={t`Balcony, hallway, storage`}
        inputProps={{ dir: 'auto' }}
        className="min-w-0 flex-1 basis-56"
      />
      <Button
        type="submit"
        variant="secondary"
        isDisabled={!online || !name.trim()}
        isPending={add.isPending}
      >
        <PlusIcon className="size-4" />
        <Trans>Add room</Trans>
      </Button>
    </form>
  );
}

// ----- comparing -------------------------------------------------------------------------------

function Comparison({ a, b }: { a: ConditionReport; b: ConditionReport }) {
  const titleOf = useTitleOf();
  const [first, second] = a.heldOn <= b.heldOn ? [a, b] : [b, a];
  const pairs = pairRooms(first.rooms, second.rooms);
  return (
    <section className="grid gap-3">
      <h2 className="m-0 font-semibold text-[17px]">
        <Trans>Room by room</Trans>
      </h2>
      <ul className="m-0 grid list-none gap-3 p-0">
        {pairs.map((p) => {
          const name = p.a?.name ?? p.b?.name ?? '';
          return (
            <li key={`${p.a?.id ?? ''}-${p.b?.id ?? ''}`}>
              <article
                aria-label={name}
                className="grid gap-3 rounded-xl border border-line bg-surface p-4"
              >
                <h3 className="m-0 font-semibold text-[16px] [overflow-wrap:anywhere]" dir="auto">
                  {name}
                  {p.a && p.b && p.a.name !== p.b.name ? (
                    <span className="font-normal text-ink-3">
                      {sep()}
                      <bdi>{p.b.name}</bdi>
                    </span>
                  ) : null}
                </h3>
                <div className="grid gap-4 md:grid-cols-2">
                  <Side title={titleOf(first)} room={p.a} timezone={first.timezone} />
                  <Side title={titleOf(second)} room={p.b} timezone={second.timezone} />
                </div>
              </article>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Side({
  title,
  room,
  timezone,
}: {
  title: string;
  room: ConditionRoom | null;
  timezone: string;
}) {
  return (
    <div className="grid content-start gap-2">
      <h4 className="m-0 font-medium text-[14px] text-ink-2">{title}</h4>
      {room ? (
        <>
          <RoomReading room={room} />
          {room.photos.length > 0 ? (
            <PhotoGrid photos={room.photos} timezone={timezone} onRemove={null} small />
          ) : null}
        </>
      ) : (
        <Notice tone="info">
          <Trans>Not in this report.</Trans>
        </Notice>
      )}
    </div>
  );
}
