/**
 * Condition reports (1.x, D171, D174; D235): the move-in and move-out walk-throughs of your
 * locations, newest first. A renter records each room's condition with dated photos, finishes the
 * report to lock it, and prints it for a deposit dispute, beside the other one if they like.
 *
 * The list standard on the filter strip (D205, surface `condition-reports`): search, kind, state
 * (open or finished), location and date (`when`), with saved views; the Display button sorts by
 * date or by kind and groups by location. `GET /condition-reports` takes one location, one kind
 * and one state, so a single value goes to the server and the rest is applied to the loaded rows
 * (components/schedules/list-query.ts).
 *
 * Everyone who sees a location reads its reports; New report is for members and above
 * (`things.edit`) in a location that isn't Personal.
 */
import {
  CONDITION_REPORT_KINDS,
  type ConditionReportKind,
  can,
  MAX_CONDITION_NOTE,
} from '@kept/shared';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useCallback, useState } from 'react';
import { TextArea, TextField as TextFieldPrimitive } from 'react-aria-components';
import { conditionApi, conditionKeys, useConditionReports } from '@/api/condition/queries';
import type { ConditionReportRow, ConditionReportsParams } from '@/api/condition/types';
import { useLocations } from '@/api/queries';
import type { LocationDetail } from '@/api/types';
import { dateBounds } from '@/components/filters/params';
import { useFilterRegistry } from '@/components/filters/registry';
import type { FilterDef } from '@/components/filters/types';
import { CheckCircleIcon, ChevronEndIcon, DocumentIcon, PlusIcon } from '@/components/icons';
import { ListSurface } from '@/components/list-surface';
import { EmptyState, Notice, Page, Pill, useErrorText } from '@/components/page';
import { rowLink, Tile } from '@/components/places/rows';
import { dayIn } from '@/components/schedules/access';
import { oneValue, passes, useOrderedQuery } from '@/components/schedules/list-query';
import { Sheet } from '@/components/things/sheet';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { DialogFooter } from '@/components/ui/dialog';
import { FieldError, inputClass, Label } from '@/components/ui/field';
import { Segmented } from '@/components/ui/segmented';
import { Select, SelectItem } from '@/components/ui/select';
import { sep } from '@/lib/format';
import { useLocationName } from '@/lib/labels';
import { useOnline } from '@/lib/online';
import { useListState } from '@/lib/url-state';
import { useConditionDates, useConditionKindLabels } from './labels';

const STATES = ['open', 'finished'] as const;

/** The locations where you may start a report: members and above, not your Personal one. */
export function useWritableLocations(): LocationDetail[] {
  const locations = useLocations();
  return (locations.data ?? []).filter((l) => l.kind !== 'personal' && can(l.role, 'things.edit'));
}

function ReportRowView({ report }: { report: ConditionReportRow }) {
  const kinds = useConditionKindLabels();
  const dates = useConditionDates();
  const locationName = useLocationName();
  const location = useLocations().data?.find((l) => l.id === report.locationId);
  const title = `${kinds[report.kind]}${sep()}${dates.day(report.heldOn)}`;
  return (
    <article aria-label={title}>
      <Link to="/condition-reports/$id" params={{ id: report.id }} className={rowLink}>
        <Tile>
          <DocumentIcon />
        </Tile>
        <span className="grid min-w-0 flex-1 gap-1">
          <span className="font-semibold text-[15px] leading-snug [overflow-wrap:anywhere]">
            {title}
          </span>
          <span className="text-small text-ink-2 [overflow-wrap:anywhere]">
            {location ? (
              <>
                <bdi>{locationName(location)}</bdi>
                {sep()}
              </>
            ) : null}
            <Plural value={report.roomCount} one="# room" other="# rooms" />
            {sep()}
            <Plural value={report.photoCount} one="# photo" other="# photos" />
          </span>
          <span className="flex flex-wrap gap-1.5">
            {report.finishedAt ? (
              <Pill tone="ok" icon={<CheckCircleIcon />}>
                <Trans>Finished</Trans>
              </Pill>
            ) : (
              <Pill tone="warn">
                <Trans>Not finished</Trans>
              </Pill>
            )}
          </span>
        </span>
        <ChevronEndIcon className="size-5 shrink-0 text-ink-3" />
      </Link>
    </article>
  );
}

export function ConditionReportsScreen() {
  const { t } = useLingui();
  const [list] = useListState();
  const f = useFilterRegistry();
  const kinds = useConditionKindLabels();
  const locations = useLocations();
  const locationName = useLocationName();
  const writable = useWritableLocations();
  const online = useOnline();
  const [starting, setStarting] = useState(false);
  const all = locations.data ?? [];
  const names = new Map(all.map((l) => [l.id, locationName(l)]));
  const stateLabels = { open: t`Not finished`, finished: t`Finished` };

  const location = oneValue(list, 'location');
  const kind = oneValue(list, 'kind');
  const state = oneValue(list, 'state');
  const params: ConditionReportsParams = {
    ...(location ? { locationId: location } : {}),
    ...(kind && (CONDITION_REPORT_KINDS as readonly string[]).includes(kind)
      ? { kind: kind as ConditionReportKind }
      : {}),
    ...(state === 'open' || state === 'finished' ? { state } : {}),
  };
  const query = useConditionReports(params);

  const sort = list.sort === 'kind' ? 'kind' : 'when';
  const dir = list.dir || (sort === 'when' ? 'desc' : 'asc');
  const group = list.group === 'location' ? 'location' : 'none';
  const bounds = dateBounds(list.filters.when?.[0]);
  const q = list.q.trim().toLocaleLowerCase();
  const keep = useCallback(
    (r: ConditionReportRow) => {
      if (!passes(list, 'location', r.locationId) || !passes(list, 'kind', r.kind)) return false;
      if (!passes(list, 'state', r.finishedAt ? 'finished' : 'open')) return false;
      const [y, m, d] = r.heldOn.split('-').map(Number) as [number, number, number];
      const day = new Date(y, m - 1, d).toISOString();
      if (bounds.from && day < bounds.from) return false;
      if (bounds.to && day >= bounds.to) return false;
      if (!q) return true;
      return [kinds[r.kind], names.get(r.locationId) ?? '', r.notes ?? '']
        .join(' ')
        .toLocaleLowerCase()
        .includes(q);
    },
    [list, bounds.from, bounds.to, q, kinds, names],
  );
  const compare = useCallback(
    (a: ConditionReportRow, b: ConditionReportRow) => {
      if (group === 'location') {
        const g = (names.get(a.locationId) ?? '').localeCompare(names.get(b.locationId) ?? '');
        if (g) return g;
      }
      const by =
        sort === 'kind'
          ? kinds[a.kind].localeCompare(kinds[b.kind]) || a.heldOn.localeCompare(b.heldOn)
          : a.heldOn.localeCompare(b.heldOn);
      return dir === 'desc' ? -by : by;
    },
    [group, names, sort, kinds, dir],
  );
  const ordered = useOrderedQuery(query, keep, compare);

  const filters: FilterDef[] = [
    {
      key: 'kind',
      label: t`Kind`,
      icon: <DocumentIcon />,
      kind: 'multi',
      values: {
        from: 'static',
        options: CONDITION_REPORT_KINDS.map((k) => ({ value: k, label: kinds[k] })),
      },
    },
    {
      key: 'state',
      label: t`State`,
      icon: <CheckCircleIcon />,
      kind: 'multi',
      values: {
        from: 'static',
        options: STATES.map((s) => ({ value: s, label: stateLabels[s] })),
      },
    },
    ...(all.length > 1
      ? [
          {
            ...f.location(),
            values: {
              from: 'static' as const,
              options: all.map((l) => ({ value: l.id, label: locationName(l) })),
            },
          },
        ]
      : []),
    f.date('when', t`When`),
  ];

  return (
    <Page
      title={t`Condition reports`}
      wide
      actions={
        writable.length ? (
          <Button size="small" isDisabled={!online} onPress={() => setStarting(true)}>
            <PlusIcon className="size-4" />
            <Trans>New report</Trans>
          </Button>
        ) : null
      }
    >
      {!online && writable.length ? (
        <Notice tone="warn">
          <Trans>Needs a connection: starting a report waits until you're back online.</Trans>
        </Notice>
      ) : null}
      <ListSurface<ConditionReportRow>
        label={t`Condition reports`}
        search={{ label: t`Search condition reports`, placeholder: t`Kind, location or notes` }}
        filters={filters}
        surface="condition-reports"
        sorts={[
          { value: 'when', label: t`When`, kind: 'date' },
          { value: 'kind', label: t`Kind` },
        ]}
        groups={[
          { value: 'none', label: t`None` },
          ...(all.length > 1
            ? [{ value: 'location', label: t`Location`, short: t`by location` }]
            : []),
        ]}
        query={ordered}
        getKey={(r) => r.id}
        groupOf={(r, by) =>
          by === 'location'
            ? { key: r.locationId, label: <bdi>{names.get(r.locationId) ?? ''}</bdi> }
            : null
        }
        renderRow={(r) => <ReportRowView report={r} />}
        empty={
          <EmptyState icon={<DocumentIcon />} title={<Trans>No condition reports</Trans>}>
            <Trans>
              Renting? When you move in, walk through each room and record how you found it, with
              photos. Do the same when you move out, and print both side by side if the deposit is
              disputed.
            </Trans>
          </EmptyState>
        }
      />
      <StartReportSheet
        isOpen={starting}
        onClose={() => setStarting(false)}
        defaultLocationId={location}
      />
    </Page>
  );
}

/** New report: the location, move-in or move-out, the day, and optional notes. */
export function StartReportSheet({
  isOpen,
  onClose,
  defaultLocationId,
}: {
  isOpen: boolean;
  onClose: () => void;
  defaultLocationId?: string | undefined;
}) {
  const { t } = useLingui();
  return (
    <Sheet isOpen={isOpen} onOpenChange={(o) => !o && onClose()} title={t`New condition report`}>
      {isOpen ? <StartForm onClose={onClose} defaultLocationId={defaultLocationId} /> : null}
    </Sheet>
  );
}

function StartForm({
  onClose,
  defaultLocationId,
}: {
  onClose: () => void;
  defaultLocationId?: string | undefined;
}) {
  const { t } = useLingui();
  const writable = useWritableLocations();
  const locationName = useLocationName();
  const kinds = useConditionKindLabels();
  const errorText = useErrorText();
  const online = useOnline();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [locationId, setLocationId] = useState(
    writable.find((l) => l.id === defaultLocationId)?.id ?? writable[0]?.id ?? '',
  );
  const location = writable.find((l) => l.id === locationId);
  const today = dayIn(location?.timezone);
  const [kind, setKind] = useState<ConditionReportKind>('move_in');
  const [heldOn, setHeldOn] = useState<string | null>(today);
  const [notes, setNotes] = useState('');
  const [dayError, setDayError] = useState<string | null>(null);

  const start = useMutation({
    mutationFn: () =>
      conditionApi.start(locationId, {
        kind,
        heldOn: heldOn ?? today,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      }),
    onSuccess: async (report) => {
      await qc.invalidateQueries({ queryKey: conditionKeys.all });
      onClose();
      await navigate({ to: '/condition-reports/$id', params: { id: report.id } });
    },
  });

  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!heldOn) {
          setDayError(t`Pick the day of the walk-through.`);
          return;
        }
        setDayError(null);
        start.mutate();
      }}
    >
      <p className="m-0 text-small text-ink-2">
        <Trans>
          It starts with the location's rooms. Add any it missed, and record each one with photos.
        </Trans>
      </p>
      {writable.length > 1 ? (
        <Select<{ id: string; name: string }>
          label={t`Location`}
          items={writable.map((l) => ({ id: l.id, name: locationName(l) }))}
          value={locationId}
          onChange={(key) => key != null && setLocationId(String(key))}
        >
          {(item) => (
            <SelectItem id={item.id} textValue={item.name}>
              <bdi>{item.name}</bdi>
            </SelectItem>
          )}
        </Select>
      ) : null}
      <Segmented<ConditionReportKind>
        label={t`Kind`}
        value={kind}
        onChange={setKind}
        options={CONDITION_REPORT_KINDS.map((k) => ({ id: k, label: kinds[k] }))}
      />
      <DatePicker
        label={t`Day of the walk-through`}
        value={heldOn}
        onChange={(v) => {
          setHeldOn(v);
          setDayError(null);
        }}
        {...(dayError ? { errorMessage: dayError } : {})}
      />
      <TextFieldPrimitive
        value={notes}
        onChange={setNotes}
        maxLength={MAX_CONDITION_NOTE}
        className="grid gap-1"
      >
        <Label>
          <Trans>Notes (optional)</Trans>
        </Label>
        <TextArea dir="auto" rows={3} className={inputClass} />
        <FieldError />
      </TextFieldPrimitive>
      {start.error ? <Notice tone="danger">{errorText(start.error)}</Notice> : null}
      {online ? null : (
        <p className="m-0 text-small text-ink-2">
          <Trans>Needs a connection</Trans>
        </p>
      )}
      <DialogFooter>
        <Button variant="secondary" onPress={onClose}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" isPending={start.isPending} isDisabled={!online || !locationId}>
          <Trans>Start</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
}
