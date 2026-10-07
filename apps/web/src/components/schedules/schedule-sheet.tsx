/**
 * New and edit schedule (plan T21; D29, D39, D52, screens §7): on a thing or a place, every so
 * many months and/or every so many units on one of the thing's meters, whichever comes first, or
 * a one-off date; with how long before to remind. At least one of the three is required (the
 * server's `schedule_interval_required`, said here first). "Last done" starts the count (default
 * today, the server's).
 *
 * The subject is given by the page it's opened from (a thing's or a place's), or chosen here:
 * the Schedules screen's "New schedule" asks for a location with Schedules on, then a room, spot
 * or thing in it.
 *
 *   <ScheduleSheet open subject={{ thingId }} onClose={…} />          (new, on a thing)
 *   <ScheduleSheet open schedule={s} onClose={…} />                   (edit, undoable)
 */
import { newId } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { isApiError } from '@/api/client';
import { householdApi } from '@/api/household/queries';
import type { CreateScheduleBody, Schedule, UpdateScheduleBody } from '@/api/household/types';
import { inventoryApi, inventoryKeys, nextCursor } from '@/api/inventory/queries';
import { useLocations } from '@/api/queries';
import { useOfferUndo } from '@/components/history/undo';
import { useErrorText } from '@/components/page';
import { decimalOf } from '@/components/services/fields';
import { useMeterName } from '@/components/things/meters-section';
import { Sheet } from '@/components/things/sheet';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { DatePicker } from '@/components/ui/date-picker';
import { DialogFooter } from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/segmented';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { sep } from '@/lib/format';
import { useLocationName } from '@/lib/labels';
import { useOnline } from '@/lib/online';
import { useMeterUnit, useTypedNumber } from '@/lib/units';
import { accessOf, useInvalidateHousehold, useLocationAccess } from './access';

export type ScheduleSubjectInput = { thingId: string } | { placeId: string };

export function ScheduleSheet({
  open,
  schedule,
  subject,
  locationId,
  onClose,
}: {
  open: boolean;
  /** Edit this one. */
  schedule?: Schedule | null;
  /** New, on this thing or place; without it (and without `schedule`) the sheet asks. */
  subject?: ScheduleSubjectInput;
  /** The subject's location, when `subject` is given. */
  locationId?: string;
  onClose: () => void;
}) {
  const { t } = useLingui();
  return (
    <Sheet
      isOpen={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={schedule ? t`Edit ${schedule.name}` : t`New schedule`}
    >
      {open ? (
        <ScheduleForm
          key={schedule?.id ?? 'new'}
          schedule={schedule ?? null}
          subject={subject ?? null}
          locationId={locationId ?? schedule?.locationId ?? null}
          onClose={onClose}
        />
      ) : null}
    </Sheet>
  );
}

type Kind = 'repeat' | 'once';

const intOf = (s: string): number | null | undefined => {
  const d = decimalOf(s);
  if (d === '') return undefined;
  if (d === null || !/^\d+$/.test(d) || Number(d) < 1) return null;
  return Number(d);
};

function ScheduleForm({
  schedule,
  subject: given,
  locationId: givenLocation,
  onClose,
}: {
  schedule: Schedule | null;
  subject: ScheduleSubjectInput | null;
  locationId: string | null;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const unitOf = useMeterUnit();
  const meterName = useMeterName();
  const errorText = useErrorText();
  const offerUndo = useOfferUndo();
  const invalidate = useInvalidateHousehold();
  const online = useOnline();
  const accessIn = useLocationAccess();
  const editing = !!schedule;
  const typed = useTypedNumber();

  const [locationId, setLocationId] = useState<string | null>(givenLocation);
  const [subject, setSubject] = useState<ScheduleSubjectInput | null>(
    schedule
      ? schedule.subject.type === 'thing'
        ? { thingId: schedule.subject.id }
        : { placeId: schedule.subject.id }
      : given,
  );
  const [name, setName] = useState(schedule?.name ?? '');
  const [kind, setKind] = useState<Kind>(
    schedule && schedule.everyMonths == null && schedule.everyUnits == null ? 'once' : 'repeat',
  );
  const [months, setMonths] = useState(() =>
    schedule?.everyMonths == null ? '' : typed(schedule.everyMonths),
  );
  const [meterId, setMeterId] = useState<string | null>(schedule?.meter?.id ?? null);
  const [everyUnits, setEveryUnits] = useState(() => typed(schedule?.everyUnits ?? ''));
  const [dueOn, setDueOn] = useState<string | null>(schedule?.dueOn ?? null);
  const [leadDays, setLeadDays] = useState(() => typed(schedule?.leadDays ?? 14));
  const [anchorOn, setAnchorOn] = useState<string | null>(schedule?.anchorOn ?? null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const thingId = subject && 'thingId' in subject ? subject.thingId : '';
  const thing = useQuery({
    queryKey: inventoryKeys.things.detail(thingId),
    queryFn: () => inventoryApi.thing(thingId),
    enabled: !!thingId,
  });
  const meters = thingId ? (thing.data?.meters ?? []) : [];
  const meter = meters.find((m) => m.id === meterId) ?? schedule?.meter ?? null;
  const access = accessIn(locationId ?? '');
  const clear = (key: string) => setErrors(({ [key]: _, ...rest }) => rest);

  const save = async () => {
    const next: Record<string, string> = {};
    if (!subject) next.subject = t`Choose what it's for.`;
    if (!name.trim()) next.name = t`Give it a name, like "Boiler service".`;
    else if (name.trim().length > 200) next.name = t`At most 200 characters.`;
    const m = kind === 'repeat' ? intOf(months) : undefined;
    if (m === null) next.months = t`A whole number of months, 1 or more.`;
    const u = kind === 'repeat' && meter ? decimalOf(everyUnits) : '';
    if (u === null || u === '0') next.units = t`Enter a number, like 10000.`;
    const lead = intOf(leadDays);
    if (lead === null && leadDays.trim() !== '0') next.lead = t`A whole number of days.`;
    if (kind === 'once' && !dueOn) next.dueOn = t`Pick the day it's due.`;
    if (kind === 'repeat' && m === undefined && !u && !next.months && !next.units)
      next.interval = t`Set how often: every so many months or units, or a date.`;
    setErrors(next);
    if (Object.keys(next).length || !subject) return;
    const leadValue = leadDays.trim() === '0' ? 0 : (lead ?? undefined);
    setBusy(true);
    try {
      if (schedule) {
        const body: UpdateScheduleBody = {
          name: name.trim(),
          everyMonths: kind === 'repeat' ? (m ?? null) : null,
          everyUnits: kind === 'repeat' && u ? u : null,
          meterId: kind === 'repeat' && u && meter ? meter.id : null,
          dueOn: kind === 'once' ? dueOn : null,
          ...(leadValue !== undefined ? { leadDays: leadValue } : {}),
          ...(anchorOn && anchorOn !== schedule.anchorOn ? { anchorOn } : {}),
        };
        const { auditEvents } = await householdApi.updateSchedule(
          schedule.id,
          body,
          schedule.rowVersion,
        );
        offerUndo({ title: t`Saved ${name.trim()}` }, auditEvents);
      } else {
        const body: CreateScheduleBody = {
          id: newId(),
          subject,
          name: name.trim(),
          ...(kind === 'repeat' && m ? { everyMonths: m } : {}),
          ...(kind === 'repeat' && u && meter ? { everyUnits: u, meterId: meter.id } : {}),
          ...(kind === 'once' && dueOn ? { dueOn } : {}),
          ...(leadValue !== undefined ? { leadDays: leadValue } : {}),
          ...(kind === 'repeat' && anchorOn ? { anchorOn } : {}),
        };
        await householdApi.createSchedule(body);
        toast({ title: t`Added ${name.trim()}`, tone: 'ok' });
      }
      await invalidate();
      onClose();
    } catch (e) {
      if (isApiError(e) && e.code === 'schedule_interval_required')
        setErrors({ interval: t`Set how often: every so many months or units, or a date.` });
      else toast({ title: t`Couldn't save it`, description: errorText(e), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      noValidate
      className="grid gap-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {editing || given ? (
        schedule ? (
          <p className="m-0 text-small text-ink-2 [overflow-wrap:anywhere]">
            <bdi>{schedule.subject.name}</bdi>
            {schedule.subject.path ? (
              <>
                {sep()}
                <bdi>{schedule.subject.path}</bdi>
              </>
            ) : null}
          </p>
        ) : null
      ) : (
        <SubjectPicker
          locationId={locationId}
          onLocation={(id) => {
            setLocationId(id);
            setSubject(null);
            setMeterId(null);
          }}
          subject={subject}
          onSubject={(s) => {
            setSubject(s);
            setMeterId(null);
            clear('subject');
          }}
          error={errors.subject}
        />
      )}
      <TextField
        label={t`Name`}
        value={name}
        onChange={(v) => {
          setName(v);
          clear('name');
        }}
        placeholder={t`Boiler service`}
        inputProps={{ dir: 'auto' }}
        {...(errors.name ? { errorMessage: errors.name, isInvalid: true } : {})}
      />
      <Segmented
        label={t`When`}
        value={kind}
        onChange={(k) => {
          setKind(k);
          setErrors({});
        }}
        options={[
          { id: 'repeat', label: t`Repeats` },
          { id: 'once', label: t`Once` },
        ]}
      />
      {kind === 'repeat' ? (
        <>
          <TextField
            label={t`Every … months`}
            value={months}
            onChange={(v) => {
              setMonths(v);
              clear('months');
              clear('interval');
            }}
            inputProps={{ inputMode: 'numeric', dir: 'ltr' }}
            {...(errors.months ? { errorMessage: errors.months, isInvalid: true } : {})}
          />
          {meters.length > 0 ? (
            <>
              <Combobox
                label={t`Meter`}
                description={t`Optional: count on a meter too, whichever comes first.`}
                items={meters.map((x) => ({
                  id: x.id,
                  label: `${meterName(x)} (${unitOf(x.unit)})`,
                }))}
                selectedKey={meterId}
                onSelectionChange={(k) => {
                  setMeterId(k ? String(k) : null);
                  clear('interval');
                }}
              />
              {meter ? (
                <TextField
                  label={t`Every … ${unitOf(meter.unit)}`}
                  value={everyUnits}
                  onChange={(v) => {
                    setEveryUnits(v);
                    clear('units');
                    clear('interval');
                  }}
                  inputProps={{ inputMode: 'decimal', dir: 'ltr' }}
                  {...(errors.units ? { errorMessage: errors.units, isInvalid: true } : {})}
                />
              ) : null}
            </>
          ) : null}
          <DatePicker
            label={t`Last done`}
            description={t`Optional. The count starts here; today if you leave it.`}
            value={anchorOn}
            onChange={setAnchorOn}
            maxValue={access.today}
          />
        </>
      ) : (
        <DatePicker
          label={t`Due on`}
          value={dueOn}
          onChange={(v) => {
            setDueOn(v);
            clear('dueOn');
          }}
          {...(errors.dueOn ? { errorMessage: errors.dueOn } : {})}
        />
      )}
      <TextField
        label={t`Remind me, days before`}
        value={leadDays}
        onChange={(v) => {
          setLeadDays(v);
          clear('lead');
        }}
        inputProps={{ inputMode: 'numeric', dir: 'ltr' }}
        {...(errors.lead ? { errorMessage: errors.lead, isInvalid: true } : {})}
      />
      {errors.interval ? (
        <p role="alert" className="m-0 text-small text-danger">
          {errors.interval}
        </p>
      ) : null}
      {!online ? (
        <p className="m-0 text-small text-ink-2">
          <Trans>Needs a connection</Trans>
        </p>
      ) : null}
      <DialogFooter>
        <Button variant="secondary" onPress={onClose}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" isPending={busy} isDisabled={!online}>
          <Trans>Save</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * What a new schedule is for: a location with Schedules on where you may manage schedules, then a
 * room, spot or thing in it (D39: a place's schedule, like the boiler's in the kitchen).
 */
function SubjectPicker({
  locationId,
  onLocation,
  subject,
  onSubject,
  error,
}: {
  locationId: string | null;
  onLocation: (id: string) => void;
  subject: ScheduleSubjectInput | null;
  onSubject: (s: ScheduleSubjectInput) => void;
  error?: string | undefined;
}) {
  const { t } = useLingui();
  const locationName = useLocationName();
  const locations = useLocations();
  const usable = (locations.data ?? []).filter((l) => {
    const a = accessOf(l);
    return a.moduleOn('schedules') && a.can('schedules-claims.manage');
  });
  const current = locationId ?? (usable.length === 1 ? (usable[0]?.id ?? null) : null);
  const places = useQuery({
    queryKey: inventoryKeys.places.tree(current ?? ''),
    queryFn: () => inventoryApi.places(current ?? ''),
    enabled: !!current,
  });
  const thingParams = { locationId: current ?? '', limit: 200 };
  const things = useInfiniteQuery({
    queryKey: inventoryKeys.things.list(thingParams),
    queryFn: ({ pageParam }) =>
      inventoryApi.things({ ...thingParams, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
    enabled: !!current,
  });
  const tree = places.data?.places ?? [];
  const byId = new Map(tree.map((p) => [p.id, p]));
  const pathOf = (id: string | null): string => {
    const out: string[] = [];
    let cur = id ? byId.get(id) : undefined;
    while (cur) {
      out.unshift(cur.name);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return out.join(' › ');
  };
  const items = [
    ...tree
      .filter((p) => !p.isUnplaced)
      .map((p) => ({
        id: `p:${p.id}`,
        label: p.name,
        ...(p.parentId ? { description: pathOf(p.parentId) } : {}),
      })),
    ...(current ? (things.data?.pages.flatMap((pg) => pg.items) ?? []) : [])
      .filter((th) => th.name)
      .map((th) => ({
        id: `t:${th.id}`,
        label: th.name ?? '',
        description: th.path.map((s) => (s.isUnplaced ? t`Unplaced` : s.name)).join(' › '),
      })),
  ];
  const key = subject
    ? 'thingId' in subject
      ? `t:${subject.thingId}`
      : `p:${subject.placeId}`
    : null;
  return (
    <div className="grid gap-3">
      {usable.length > 1 ? (
        <Combobox
          label={t`Location`}
          items={usable.map((l) => ({ id: l.id, label: locationName(l) }))}
          selectedKey={current}
          onSelectionChange={(k) => {
            if (k && String(k) !== current) onLocation(String(k));
          }}
        />
      ) : null}
      <Combobox
        label={t`For`}
        description={t`A room or spot, like the kitchen for its boiler, or a thing.`}
        items={items}
        selectedKey={key}
        isDisabled={!current}
        onSelectionChange={(k) => {
          if (!k) return;
          if (!locationId && current) onLocation(current);
          const s = String(k);
          onSubject(s.startsWith('t:') ? { thingId: s.slice(2) } : { placeId: s.slice(2) });
        }}
        placeholder={t`Search rooms, spots and things`}
        {...(error ? { errorMessage: error, isInvalid: true } : {})}
      />
    </div>
  );
}
