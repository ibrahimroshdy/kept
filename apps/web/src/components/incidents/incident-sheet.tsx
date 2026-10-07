/**
 * Recording an incident (D158, plan T26, screens §5 "Incidents and claims"): its kind, the day it
 * happened, the police and insurer references and notes. Three ways in:
 *
 * - **New incident** on /incidents: the location (one you manage), then the fields;
 * - **Edit** on the incident's page: the same fields, If-Match, with Undo (`incident.update`);
 * - **Add to incident** from a location's selection (multi-select things → "Add to incident"):
 *   an incident of that location, or a new one, and "Mark these stolen" (destroyed, lost), which
 *   ends the chosen things with it. Adding is undoable (`incident.things`); a new incident is a
 *   create, which isn't (§7.7).
 *
 * Owners and admins only (`incidents.manage`); the callers hide the way in for anyone else.
 * Online only (the step-4 offline matrix has no incident write): offline, Save is off with
 * "Needs a connection" (screens §3).
 */
import { can, INCIDENT_KINDS, type IncidentKind } from '@kept/shared';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { type FormEvent, type ReactNode, useState } from 'react';
import { Checkbox, TextArea, TextField as TextFieldPrimitive } from 'react-aria-components';
import { householdApi, householdKeys, useIncidents } from '@/api/household/queries';
import type { Incident, IncidentLifecycle, IncidentRow } from '@/api/household/types';
import { inventoryKeys } from '@/api/inventory/queries';
import { useLocations } from '@/api/queries';
import { useOfferUndo } from '@/components/history/undo';
import { CheckIcon } from '@/components/icons';
import { LoadingRows, Notice, useErrorText } from '@/components/page';
import { Sheet } from '@/components/places/sheet';
import { accessOf, dayIn } from '@/components/schedules/access';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { DialogFooter } from '@/components/ui/dialog';
import { FieldError, inputClass, Label } from '@/components/ui/field';
import { ChoiceCards } from '@/components/ui/segmented';
import { Select, SelectItem } from '@/components/ui/select';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { useLocationName } from '@/lib/labels';
import { useOnline } from '@/lib/online';
import { cn } from '@/lib/utils';
import { lifecycleFor, useIncidentKindLabels, useIncidentName, useMarkLabels } from './labels';

/** Notes and references keep to the server's lengths (the incident's CHECKs, T4). */
const NOTES_MAX = 2000;
const REFERENCE_MAX = 200;

/** Everything that shows incidents or the things they ended, refetched after a write. */
export function useInvalidateIncidents() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: householdKeys.incidents.all }),
      qc.invalidateQueries({ queryKey: ['household'] }),
      qc.invalidateQueries({ queryKey: inventoryKeys.things.all }),
      qc.invalidateQueries({ queryKey: inventoryKeys.places.all }),
    ]).then(() => undefined);
}

/** The locations where you may record incidents: Warranties & claims on, owner or admin. */
export function useManagedLocations() {
  const locations = useLocations();
  return (locations.data ?? []).filter(
    (l) => accessOf(l).moduleOn('warranties') && can(l.role, 'incidents.manage'),
  );
}

function NotesField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useLingui();
  const tooLong = value.length > NOTES_MAX;
  return (
    <TextFieldPrimitive
      value={value}
      onChange={onChange}
      isInvalid={tooLong}
      className="grid gap-1"
    >
      <Label>
        <Trans>Notes (optional)</Trans>
      </Label>
      <TextArea dir="auto" rows={3} className={inputClass} />
      <FieldError>{tooLong ? t`Keep the notes under ${NOTES_MAX} characters.` : null}</FieldError>
    </TextFieldPrimitive>
  );
}

function OfflineNote() {
  return (
    <p className="m-0 text-small text-ink-2">
      <Trans>Needs a connection</Trans>
    </p>
  );
}

type Fields = {
  kind: IncidentKind;
  occurredOn: string | null;
  police: string;
  insurer: string;
  notes: string;
};

/** Kind, day, references and notes: the fields a create and an edit share. */
function IncidentFields({
  value,
  onChange,
  today,
  errors,
}: {
  value: Fields;
  onChange: (next: Partial<Fields>) => void;
  today: string;
  errors: Record<string, string>;
}) {
  const { t } = useLingui();
  const kinds = useIncidentKindLabels();
  return (
    <>
      <Select<{ id: IncidentKind; name: string }>
        label={t`What happened`}
        items={INCIDENT_KINDS.map((k) => ({ id: k, name: kinds[k] }))}
        value={value.kind}
        onChange={(key) => key != null && onChange({ kind: key as IncidentKind })}
      >
        {(item) => (
          <SelectItem id={item.id} textValue={item.name}>
            {item.name}
          </SelectItem>
        )}
      </Select>
      <DatePicker
        label={t`When`}
        value={value.occurredOn}
        maxValue={today}
        onChange={(v) => onChange({ occurredOn: v })}
        {...(errors.occurredOn ? { errorMessage: errors.occurredOn } : {})}
      />
      <TextField
        label={t`Police reference (optional)`}
        value={value.police}
        onChange={(v) => onChange({ police: v })}
        maxLength={REFERENCE_MAX}
        inputProps={{ dir: 'auto' }}
      />
      <TextField
        label={t`Insurer's reference (optional)`}
        value={value.insurer}
        onChange={(v) => onChange({ insurer: v })}
        maxLength={REFERENCE_MAX}
        inputProps={{ dir: 'auto' }}
      />
      <NotesField value={value.notes} onChange={(notes) => onChange({ notes })} />
    </>
  );
}

function useFieldErrors() {
  const { t } = useLingui();
  return (f: Fields, today: string): Record<string, string> => {
    const next: Record<string, string> = {};
    if (!f.occurredOn) next.occurredOn = t`Pick the day it happened.`;
    else if (f.occurredOn > today) next.occurredOn = t`It can't be in the future.`;
    if (f.notes.length > NOTES_MAX) next.notes = 'notes';
    return next;
  };
}

/** A tick box drawn as the kit's, around React Aria's Checkbox. */
export function TickBox({
  isSelected,
  onChange,
  children,
  className,
}: {
  isSelected: boolean;
  onChange: (v: boolean) => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Checkbox
      isSelected={isSelected}
      onChange={onChange}
      className={cn(
        'group flex min-h-11 cursor-pointer items-start gap-3 py-2 outline-none data-focus-visible:outline-2 data-focus-visible:outline-offset-2 data-focus-visible:outline-info',
        className,
      )}
    >
      {({ isSelected: on }) => (
        <>
          <span
            aria-hidden="true"
            className={cn(
              'mt-0.5 grid size-5 shrink-0 place-items-center rounded-[5px] border-2 [&_svg]:size-3.5',
              on ? 'border-ink bg-ink text-paper' : 'border-ink-3 bg-surface',
            )}
          >
            {on ? <CheckIcon strokeWidth="3" /> : null}
          </span>
          <span className="min-w-0 flex-1">{children}</span>
        </>
      )}
    </Checkbox>
  );
}

// ----- new incident -----------------------------------------------------------------------------

/**
 * A new incident, optionally with things (the selection's "Add to incident"). Afterwards it opens
 * the incident's page.
 */
function NewIncidentForm({
  locationId: fixedLocation,
  thingIds = [],
  onDone,
}: {
  /** Fixed when the things come from one location's selection. */
  locationId?: string;
  thingIds?: string[];
  onDone: () => void;
}) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const errorText = useErrorText();
  const online = useOnline();
  const invalidate = useInvalidateIncidents();
  const marks = useMarkLabels();
  const nameOf = useLocationName();
  const nameIncident = useIncidentName();
  const managed = useManagedLocations();
  const fieldErrors = useFieldErrors();
  const [locationId, setLocationId] = useState(fixedLocation ?? managed[0]?.id ?? '');
  const location = managed.find((l) => l.id === locationId);
  const today = dayIn(location?.timezone);
  const [fields, setFields] = useState<Fields>({
    kind: 'burglary',
    occurredOn: today,
    police: '',
    insurer: '',
    notes: '',
  });
  const [mark, setMark] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const lifecycle: IncidentLifecycle = lifecycleFor(fields.kind);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next = fieldErrors(fields, today);
    if (!locationId) next.location = t`Choose a location.`;
    setErrors(next);
    if (Object.keys(next).length || !fields.occurredOn) return;
    setBusy(true);
    setFailed(null);
    try {
      const incident = await householdApi.createIncident(locationId, {
        kind: fields.kind,
        occurredOn: fields.occurredOn,
        ...(fields.police.trim() ? { policeReference: fields.police.trim() } : {}),
        ...(fields.insurer.trim() ? { insurerReference: fields.insurer.trim() } : {}),
        ...(fields.notes.trim() ? { notes: fields.notes.trim() } : {}),
        ...(thingIds.length ? { thingIds } : {}),
        ...(thingIds.length && mark ? { lifecycle } : {}),
      });
      await invalidate();
      const name = nameIncident(incident);
      toast({ title: t`Recorded ${name}`, tone: 'ok' });
      onDone();
      void navigate({ to: '/incidents/$id', params: { id: incident.id } });
    } catch (err) {
      setFailed(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="grid gap-4">
      {fixedLocation || managed.length < 2 ? null : (
        <Select<{ id: string; name: string }>
          label={t`Location`}
          items={managed.map((l) => ({ id: l.id, name: nameOf(l) }))}
          value={locationId}
          onChange={(key) => key != null && setLocationId(String(key))}
        >
          {(item) => (
            <SelectItem id={item.id} textValue={item.name}>
              <bdi>{item.name}</bdi>
            </SelectItem>
          )}
        </Select>
      )}
      <IncidentFields
        value={fields}
        onChange={(p) => setFields((f) => ({ ...f, ...p }))}
        today={today}
        errors={errors}
      />
      {thingIds.length ? (
        <TickBox isSelected={mark} onChange={setMark}>
          <span className="grid gap-0.5">
            <span className="font-medium">{marks[lifecycle]}</span>
            <span className="text-small text-ink-2">
              {plural(thingIds.length, {
                one: 'The thing you chose leaves your counts and totals, and stays in the history.',
                other:
                  'The # things you chose leave your counts and totals, and stay in the history.',
              })}
            </span>
          </span>
        </TickBox>
      ) : null}
      {failed ? <Notice tone="danger">{errorText(failed)}</Notice> : null}
      {online ? null : <OfflineNote />}
      <DialogFooter>
        <Button variant="secondary" onPress={onDone}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" isPending={busy} isDisabled={!online || !locationId}>
          <Trans>Record</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
}

export function NewIncidentSheet({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { t } = useLingui();
  return (
    <Sheet isOpen={isOpen} onOpenChange={(o) => !o && onClose()} title={t`New incident`}>
      {({ close }) => <NewIncidentForm onDone={close} />}
    </Sheet>
  );
}

// ----- edit -------------------------------------------------------------------------------------

function EditIncidentForm({ incident, onDone }: { incident: Incident; onDone: () => void }) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const online = useOnline();
  const offerUndo = useOfferUndo();
  const invalidate = useInvalidateIncidents();
  const fieldErrors = useFieldErrors();
  const nameIncident = useIncidentName();
  const location = useLocations().data?.find((l) => l.id === incident.locationId);
  const today = dayIn(location?.timezone);
  const [fields, setFields] = useState<Fields>({
    kind: incident.kind,
    occurredOn: incident.occurredOn,
    police: incident.policeReference ?? '',
    insurer: incident.insurerReference ?? '',
    notes: incident.notes ?? '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next = fieldErrors(fields, today);
    setErrors(next);
    if (Object.keys(next).length || !fields.occurredOn) return;
    const text = (s: string) => s.trim() || null;
    const body = {
      ...(fields.kind !== incident.kind ? { kind: fields.kind } : {}),
      ...(fields.occurredOn !== incident.occurredOn ? { occurredOn: fields.occurredOn } : {}),
      ...(text(fields.police) !== incident.policeReference
        ? { policeReference: text(fields.police) }
        : {}),
      ...(text(fields.insurer) !== incident.insurerReference
        ? { insurerReference: text(fields.insurer) }
        : {}),
      ...(text(fields.notes) !== incident.notes ? { notes: text(fields.notes) } : {}),
    };
    if (Object.keys(body).length === 0) {
      onDone();
      return;
    }
    setBusy(true);
    setFailed(null);
    try {
      const { body: data, auditEvents } = await householdApi.updateIncident(
        incident.id,
        body,
        incident.rowVersion,
      );
      await invalidate();
      const name = nameIncident(data);
      offerUndo({ title: t`Saved ${name}` }, auditEvents);
      onDone();
    } catch (err) {
      setFailed(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="grid gap-4">
      <IncidentFields
        value={fields}
        onChange={(p) => setFields((f) => ({ ...f, ...p }))}
        today={today}
        errors={errors}
      />
      {failed ? <Notice tone="danger">{errorText(failed)}</Notice> : null}
      {online ? null : <OfflineNote />}
      <DialogFooter>
        <Button variant="secondary" onPress={onDone}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" isPending={busy} isDisabled={!online}>
          <Trans>Save</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
}

export function EditIncidentSheet({
  incident,
  onClose,
}: {
  incident: Incident | null;
  onClose: () => void;
}) {
  const { t } = useLingui();
  return (
    <Sheet isOpen={!!incident} onOpenChange={(o) => !o && onClose()} title={t`Edit the incident`}>
      {({ close }) => (incident ? <EditIncidentForm incident={incident} onDone={close} /> : null)}
    </Sheet>
  );
}

// ----- add to incident --------------------------------------------------------------------------

const NEW = '__new';

/** The selection's "Add to incident": one of the location's incidents, or a new one. */
function AddToIncidentForm({
  locationId,
  thingIds,
  onDone,
}: {
  locationId: string;
  thingIds: string[];
  onDone: () => void;
}) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const errorText = useErrorText();
  const online = useOnline();
  const offerUndo = useOfferUndo();
  const invalidate = useInvalidateIncidents();
  const marks = useMarkLabels();
  const nameIncident = useIncidentName();
  const query = useIncidents({ locationId });
  const incidents: IncidentRow[] = query.data?.pages.flatMap((p) => p.items) ?? [];
  const [choice, setChoice] = useState<string | null>(null);
  const [mark, setMark] = useState(false);
  const [failed, setFailed] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const chosen = choice ?? incidents[0]?.id ?? NEW;
  const target = incidents.find((i) => i.id === chosen);

  if (query.isPending) return <LoadingRows rows={2} />;
  if (chosen === NEW && (incidents.length === 0 || choice === NEW))
    return (
      <div className="grid gap-4">
        {incidents.length ? (
          <Button variant="ghost" size="small" onPress={() => setChoice(incidents[0]?.id ?? null)}>
            <Trans>Back to this location's incidents</Trans>
          </Button>
        ) : null}
        <NewIncidentForm locationId={locationId} thingIds={thingIds} onDone={onDone} />
      </div>
    );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!target) return;
    setBusy(true);
    setFailed(null);
    try {
      const { body: data, auditEvents } = await householdApi.incidentThings(
        target.id,
        { add: thingIds, ...(mark ? { lifecycle: lifecycleFor(target.kind) } : {}) },
        target.rowVersion,
      );
      await invalidate();
      const name = nameIncident(data);
      offerUndo(
        {
          title: plural(thingIds.length, {
            one: `Added # thing to ${name}`,
            other: `Added # things to ${name}`,
          }),
        },
        auditEvents,
      );
      onDone();
      void navigate({ to: '/incidents/$id', params: { id: data.id } });
    } catch (err) {
      setFailed(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="grid gap-4">
      <ChoiceCards<string>
        label={t`Add them to`}
        value={chosen}
        onChange={setChoice}
        options={[
          ...incidents.map((i) => ({
            id: i.id,
            title: nameIncident(i),
            body: plural(i.thingCount, { one: '# thing', other: '# things' }),
          })),
          { id: NEW, title: t`A new incident` },
        ]}
      />
      {target ? (
        <TickBox isSelected={mark} onChange={setMark}>
          <span className="font-medium">{marks[lifecycleFor(target.kind)]}</span>
        </TickBox>
      ) : null}
      {failed ? <Notice tone="danger">{errorText(failed)}</Notice> : null}
      {online ? null : <OfflineNote />}
      <DialogFooter>
        <Button variant="secondary" onPress={onDone}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" isPending={busy} isDisabled={!online || !target}>
          <Trans>Add</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
}

export function AddToIncidentSheet({
  locationId,
  thingIds,
  onClose,
  onAdded,
}: {
  locationId: string;
  /** The selection; empty keeps the sheet closed. */
  thingIds: string[];
  onClose: () => void;
  /** After the things went into an incident (the selection ends). */
  onAdded?: () => void;
}) {
  const n = thingIds.length;
  return (
    <Sheet
      isOpen={n > 0}
      onOpenChange={(o) => !o && onClose()}
      title={plural(n, { one: 'Add # thing to an incident', other: 'Add # things to an incident' })}
    >
      {({ close }) => (
        <AddToIncidentForm
          locationId={locationId}
          thingIds={thingIds}
          onDone={() => {
            close();
            onAdded?.();
          }}
        />
      )}
    </Sheet>
  );
}
