/**
 * Log a service (plan T21; screens §5 "Log a service", D26, D29, D113; step-4 Q1): record work
 * done on a thing or a place, and close the schedules it completes. In order: the date (today by
 * default, never in the future), the thing's meter reading with a photo-proof slot (checked
 * against its neighbours and refused at entry with the reason, D112), the vendor (created inline,
 * D11), the invoice, the line items (part, labour, fluid, other; quantity and cost) with the total
 * and its currency, **Completes** (the subject's schedules, the ones it was opened for ticked;
 * saving restarts each ticked one's count, D29), and notes.
 *
 * Service records are core (D113): any member can log one, but Completes needs Schedules on in
 * the location. Money fields appear only where money shows (D13). Needs a connection: it carries
 * money (screens §4); a reading alone is logged offline (components/readings/).
 *
 * **The invoice, read by AI (step 5, T20; Q12, Q13).** Where money shows, attaching an invoice
 * makes a **draft** service record (`POST /service-records/drafts`, with an Idempotency-Key),
 * whose pages the server reads where AI capture is on. While it reads, "Reading the invoice…";
 * then its lines, total, currency, vendor and date are suggestions (./invoice-suggestions.tsx),
 * violet and dashed until **Confirm all** or a line's **Edit**. A bare `$` asks USD or CAD with
 * neither chosen (D189). **Save** confirms the draft (`POST /service-records/:id/confirm`,
 * If-Match); Cancel leaves it a draft on the vehicle's Services tab ("Finish logging", or
 * Discard). Without AI the draft has no read, and the typed lines are what's saved.
 *
 * **Completes:** a schedule is pre-ticked when one line (typed, or suggested and not yet taken)
 * holds every significant word of its name (`matchSchedules`, Q13), and says which: "Matches “Oil
 * filter”, was estimated ~14 Nov, restarts at 55,120 km"; the others "no matching line". The
 * person ticks or unticks any; one they touched stays as they left it.
 *
 * Where money is hidden, an invoice can't make a draft (an invoice is money): it is uploaded and
 * attached to the record once it exists, as the record's `invoice`, as step 4 did.
 */
import { matchSchedules, newId, SERVICE_LINE_KINDS, type ServiceLineKind } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Checkbox, CheckboxGroup, FileTrigger, Label } from 'react-aria-components';
import { api } from '@/api/client';
import { householdApi, useSubjectSchedules } from '@/api/household/queries';
import type { CreateServiceRecordBody, ServiceLineInput, SubjectRef } from '@/api/household/types';
import { inventoryPaths } from '@/api/inventory/paths';
import { inventoryApi, inventoryKeys } from '@/api/inventory/queries';
import { useServiceRecord, vehiclesApi } from '@/api/vehicles/queries';
import type { ScheduleV5, ServiceRecordV5, SuggestedLine } from '@/api/vehicles/types';
import { useOfferUndo } from '@/components/history/undo';
import { CameraIcon, CheckIcon, DocumentIcon, PlusIcon, XIcon } from '@/components/icons';
import { useErrorText } from '@/components/page';
import { useInvalidateHousehold, useLocationAccess } from '@/components/schedules/access';
import { useMeterName } from '@/components/things/meters-section';
import { useLocationAccountId } from '@/components/things/pickers';
import { Sheet } from '@/components/things/sheet';
import { putFile, useUploadErrorText } from '@/components/things/upload';
import { useMoney } from '@/components/things/values';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { DatePicker } from '@/components/ui/date-picker';
import { DialogFooter } from '@/components/ui/dialog';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { sep, useFormat } from '@/lib/format';
import { useOnline } from '@/lib/online';
import { useMeterUnit, useTypedNumber } from '@/lib/units';
import { cn } from '@/lib/utils';
import { amountOf, decimalOf, MoneyFields, useReadingRefusal } from './fields';
import {
  DollarQuestion,
  InvoiceReadStatus,
  InvoiceSuggestions,
  invoiceReadOf,
} from './invoice-suggestions';
import { useServiceLineLabels } from './labels';
import { emptyVendor, VendorField, vendorInput } from './vendor-field';

export type LogServiceSubject = { thingId: string } | { placeId: string };

export function LogServiceSheet({
  open,
  subject,
  subjectRef,
  locationId,
  completes = [],
  draft = null,
  onClose,
}: {
  open: boolean;
  subject: LogServiceSubject | null;
  /** Its name and path, for the header. */
  subjectRef?: SubjectRef;
  locationId: string;
  /** Schedules to tick at the start (Complete → "Add line items or an invoice"). */
  completes?: string[];
  /** A draft to finish (the Services tab's "Finish logging", T20). */
  draft?: ServiceRecordV5 | null;
  onClose: () => void;
}) {
  const { t } = useLingui();
  return (
    <Sheet
      isOpen={open && !!subject}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={t`Log a service`}
    >
      {open && subject ? (
        <LogServiceForm
          key={draft?.id ?? 'new'}
          draft={draft}
          subject={subject}
          {...(subjectRef ? { subjectRef } : {})}
          locationId={locationId}
          completes={completes}
          onClose={onClose}
        />
      ) : null}
    </Sheet>
  );
}

type Line = {
  key: string;
  kind: ServiceLineKind;
  description: string;
  quantity: string;
  cost: string;
};
type Upload = {
  key: string;
  name: string;
  fileId: string | null;
  /** One of the draft's invoice pages already (the draft attached it). */
  inDraft?: boolean;
};

const newLine = (): Line => ({
  key: newId(),
  kind: 'part',
  description: '',
  quantity: '',
  cost: '',
});

/** A suggested line, as a typed one to change. */
const lineOf = (l: SuggestedLine): Line => ({
  key: newId(),
  kind: l.kind ?? 'part',
  description: l.description,
  quantity: l.quantity ?? '',
  cost: l.unitCost ?? '',
});

/** The line a schedule matches (`matchSchedules`, Q13), or null. */
function matchingLine(
  s: { id: string; name: string },
  lines: readonly { description: string }[],
): string | null {
  return lines.find((l) => matchSchedules([s], [l]).length > 0)?.description ?? null;
}

function LogServiceForm({
  subject,
  subjectRef,
  locationId,
  completes: initial,
  draft: given,
  onClose,
}: {
  subject: LogServiceSubject;
  subjectRef?: SubjectRef;
  locationId: string;
  completes: string[];
  draft: ServiceRecordV5 | null;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const fmt = useFormat();
  const unitOf = useMeterUnit();
  const meterName = useMeterName();
  const asTyped = useTypedNumber();
  /** A read line into the form, its numbers in the reader's digits. */
  const lineFrom = (l: SuggestedLine): Line => {
    const x = lineOf(l);
    return { ...x, quantity: asTyped(x.quantity), cost: asTyped(x.cost) };
  };
  const access = useLocationAccess()(locationId);
  const accountId = useLocationAccountId(access.location);
  const lineLabels = useServiceLineLabels();
  const errorText = useErrorText();
  const uploadError = useUploadErrorText();
  const offerUndo = useOfferUndo();
  const refusal = useReadingRefusal();
  const invalidate = useInvalidateHousehold();
  const money = useMoney();
  const online = useOnline();
  const schedulesOn = access.moduleOn('schedules');

  const thingId = 'thingId' in subject ? subject.thingId : '';
  const thing = useQuery({
    queryKey: inventoryKeys.things.detail(thingId),
    queryFn: () => inventoryApi.thing(thingId),
    enabled: !!thingId,
  });
  const meters = thing.data?.meters ?? [];
  const schedules = useSubjectSchedules(subject);
  const active = schedulesOn ? (schedules.data?.items ?? []).filter((s) => s.active) : [];

  const [servicedOn, setServicedOn] = useState<string | null>(given?.servicedOn ?? access.today);
  const [meterId, setMeterId] = useState<string | null>(null);
  const meter = meters.find((m) => m.id === meterId) ?? meters[0] ?? null;
  const [reading, setReading] = useState('');
  const [proof, setProof] = useState<Upload | null>(null);
  const [vendor, setVendor] = useState(emptyVendor);
  const [invoices, setInvoices] = useState<Upload[]>(() =>
    (given?.invoices ?? []).map((a, i) => ({
      key: a.id,
      name: t`Invoice page ${i + 1}`,
      fileId: a.file?.id ?? null,
      inDraft: true,
    })),
  );
  const [lines, setLines] = useState<Line[]>([]);
  const [total, setTotal] = useState('');
  const [currency, setCurrency] = useState<string | null>(access.location?.currency ?? null);
  const [ticked, setTicked] = useState<string[]>(initial);
  /** Schedules the person ticked or unticked: a matching line no longer moves them. */
  const touched = useRef(new Set<string>(initial));
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const clear = (key: string) => setErrors(({ [key]: _, ...rest }) => rest);

  // ----- the draft and its invoice's read (T20) -----
  const [draftId] = useState(() => given?.id ?? newId());
  const [draftState, setDraftState] = useState<'none' | 'making' | 'made' | 'failed'>(
    given ? 'made' : 'none',
  );
  const drafting = access.money && draftState !== 'failed';
  const record = useServiceRecord(draftState === 'made' ? draftId : '');
  const rec: ServiceRecordV5 | null = record.data ?? given;
  const read = invoiceReadOf(rec);
  const refetchRecord = record.refetch;
  useEffect(() => {
    if (read.state !== 'reading') return;
    const id = setInterval(() => void refetchRecord(), 2000);
    return () => clearInterval(id);
  }, [read.state, refetchRecord]);
  /** Indexes of the read's lines already taken into the form. */
  const [taken, setTaken] = useState<ReadonlySet<number>>(new Set());
  const pending = read.lines.map((_, i) => i).filter((i) => !taken.has(i));
  const [askDollars, setAskDollars] = useState(false);
  useEffect(() => {
    // A bare $ on the invoice: no currency until the person says which dollars (D189).
    if (read.currencyUnclear && !askDollars) {
      setAskDollars(true);
      setCurrency(null);
    }
  }, [read.currencyUnclear, askDollars]);

  // The first invoice pages make the draft, once they're uploaded.
  useEffect(() => {
    if (!drafting || draftState !== 'none' || !online) return;
    if (invoices.length === 0 || invoices.some((x) => !x.fileId)) return;
    setDraftState('making');
    const fileIds = invoices.map((x) => x.fileId as string).slice(0, 10);
    vehiclesApi
      .createServiceDraft({ id: draftId, subject, invoiceFileIds: fileIds }, `draft:${draftId}`)
      .then(() => {
        setInvoices((xs) =>
          xs.map((x) => (x.fileId && fileIds.includes(x.fileId) ? { ...x, inDraft: true } : x)),
        );
        setDraftState('made');
        void invalidate();
      })
      .catch((e: unknown) => {
        // The invoice still goes on the record when it's saved, as without AI.
        setDraftState('failed');
        toast({ title: t`Couldn't read the invoice`, description: errorText(e), tone: 'danger' });
      });
  }, [drafting, draftState, online, invoices, draftId, subject, invalidate, t, errorText]);

  /** Confirm all (D131): the read's lines, total, currency, vendor and date into the form. */
  const confirmAll = () => {
    const typed = lines.filter((l) => l.description.trim() || l.cost.trim());
    setLines([...typed, ...pending.map((i) => lineFrom(read.lines[i] as SuggestedLine))]);
    setTaken(new Set(read.lines.map((_, i) => i)));
    if (read.total && !total.trim()) setTotal(asTyped(read.total));
    if (read.currency) setCurrency(read.currency);
    if (read.vendor && !vendor.id && !vendor.text.trim())
      setVendor({ id: null, text: read.vendor });
    if (read.servicedOn && read.servicedOn <= access.today) setServicedOn(read.servicedOn);
  };
  /** One suggested line into the typed lines, to change it. */
  const editLine = (i: number) => {
    const l = read.lines[i];
    if (!l) return;
    setLines((ls) => [...ls, lineFrom(l)]);
    setTaken((s) => new Set([...s, i]));
  };

  // Completes: pre-ticked by a matching line (Q13), unless the person decided.
  const matchLines = [
    ...lines.filter((l) => l.description.trim()),
    ...pending.map((i) => read.lines[i] as SuggestedLine),
  ];
  const matchKey = active
    .filter((s) => matchingLine(s, matchLines))
    .map((s) => s.id)
    .join(',');
  useEffect(() => {
    if (!matchKey) return;
    const ids = matchKey.split(',').filter((id) => !touched.current.has(id));
    if (ids.length) setTicked((xs) => [...new Set([...xs, ...ids])]);
  }, [matchKey]);

  const upload = async (file: File, onDone: (fileId: string) => void) => {
    try {
      const f = await putFile({ file, locationId });
      onDone(f.id);
    } catch (e) {
      toast({
        title: t`Couldn't upload ${file.name}`,
        description: uploadError(e),
        tone: 'danger',
      });
      return false;
    }
    return true;
  };

  // The lines' own sum, where every priced line has a number (quantity 1 when left empty).
  const lineSum = (() => {
    if (!access.money) return null;
    let sum = 0;
    let any = false;
    for (const l of lines) {
      const c = amountOf(l.cost);
      const q = l.quantity.trim() ? decimalOf(l.quantity) : '1';
      if (c === null || q === null) return null;
      if (!c) continue;
      any = true;
      sum += Number(c) * Number(q || '1');
    }
    return any ? Math.round(sum * 100) / 100 : null;
  })();
  const typedTotal = access.money ? amountOf(total) : '';
  const mismatch =
    lineSum !== null && typedTotal && Math.abs(Number(typedTotal) - lineSum) > lineSum * 0.01
      ? lineSum
      : null;

  const save = async () => {
    const next: Record<string, string> = {};
    if (!servicedOn) next.date = t`Pick the day it was done.`;
    else if (servicedOn > access.today) next.date = t`Not in the future.`;
    const value = meter ? decimalOf(reading) : '';
    if (value === null) next.reading = t`Enter a number, like 60250.`;
    if (typedTotal === null) next.total = t`Enter an amount, like 1250 or 1250.50.`;
    const body: ServiceLineInput[] = [];
    for (const l of lines) {
      if (!l.description.trim() && !l.cost.trim() && !l.quantity.trim()) continue;
      if (!l.description.trim()) next[`line:${l.key}`] = t`Say what it was.`;
      const q = decimalOf(l.quantity);
      const c = access.money ? amountOf(l.cost) : '';
      if (q === null || c === null) next[`line:${l.key}`] = t`Enter a number, like 2 or 380.`;
      body.push({
        kind: l.kind,
        description: l.description.trim(),
        ...(q ? { quantity: q } : {}),
        ...(c ? { unitCost: c } : {}),
      });
    }
    if (body.length > 50) next.lines = t`At most 50 lines.`;
    const amount = typedTotal || (lineSum !== null ? String(lineSum) : '');
    const priced = !!amount || body.some((l) => l.unitCost);
    if (priced && !currency) next.total = t`A price needs a currency.`;
    setErrors(next);
    if (Object.keys(next).length) return;
    const confirming = draftState === 'made';
    const id = confirming ? draftId : newId();
    const record: CreateServiceRecordBody = {
      id,
      subject,
      servicedOn: servicedOn ?? access.today,
      ...(value && meter
        ? {
            reading: {
              meterId: meter.id,
              value,
              ...(proof?.fileId ? { proofFileId: proof.fileId } : {}),
            },
          }
        : {}),
      ...(vendorInput(vendor) ? { vendor: vendorInput(vendor) } : {}),
      ...(amount ? { total: amount } : {}),
      ...(priced && currency ? { currency } : {}),
      ...(body.length ? { lines: body } : {}),
      ...(ticked.length && schedulesOn ? { completes: ticked } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    };
    setBusy(true);
    // The write's audit events, for the toast's Undo (D150).
    let auditEvents: readonly string[] = [];
    try {
      if (confirming) {
        const { id: _id, subject: _subject, ...rest } = record;
        ({ auditEvents } = await vehiclesApi.confirmService(draftId, rest, rec?.rowVersion ?? 1));
      } else ({ auditEvents } = await householdApi.createServiceRecord(record));
    } catch (e) {
      setBusy(false);
      const why = meter ? refusal(e, meter.unit) : null;
      if (why) setErrors({ reading: why });
      else
        toast({ title: t`Couldn't save the service`, description: errorText(e), tone: 'danger' });
      return;
    }
    // Invoice pages the draft didn't take, attached to the record now that it exists.
    let unattached = 0;
    for (const inv of invoices) {
      if (!inv.fileId || inv.inDraft) continue;
      try {
        await api.post(inventoryPaths.attachments, {
          id: newId(),
          locationId,
          fileId: inv.fileId,
          subject: { serviceRecordId: id },
          role: 'invoice',
        });
      } catch {
        unattached += 1;
      }
    }
    offerUndo(
      {
        title: t`Service logged`,
        ...(unattached
          ? { description: t`The invoice didn't attach. Add it again from the service.` }
          : {}),
      },
      auditEvents,
    );
    await invalidate();
    setBusy(false);
    onClose();
  };

  const setLine = (key: string, patch: Partial<Line>) => {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
    clear(`line:${key}`);
  };

  /** What a schedule's row says under its name: the matching line and what restarts, or why not. */
  const completesText = (s: ScheduleV5, isSelected: boolean): string => {
    const match = matchingLine(s, matchLines);
    const typedValue = decimalOf(reading);
    const parts: string[] = [];
    if (match) parts.push(t`Matches “${match}”`);
    const next = s.next;
    if (next.estimated && next.estimatedOn)
      parts.push(t`was estimated ~${fmt.day(`${next.estimatedOn}T12:00:00`)}`);
    else if (!match && next.dueValue && s.meter)
      parts.push(t`Due at ${fmt.num(Number(next.dueValue))} ${unitOf(s.meter.unit)}`);
    else if (!match && next.dueOn) parts.push(t`Due ${fmt.day(`${next.dueOn}T12:00:00`)}`);
    if (isSelected && s.everyUnits && typedValue && meter)
      parts.push(t`restarts at ${fmt.num(Number(typedValue))} ${unitOf(meter.unit)}`);
    else if (isSelected && !match) parts.push(t`Saving restarts its count`);
    if (!match && matchLines.length > 0) parts.push(t`no matching line`);
    else if (!match && !isSelected) parts.push(t`Not done this time`);
    return parts.join(sep());
  };

  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {subjectRef ? (
        <p className="m-0 grid text-small text-ink-2 [overflow-wrap:anywhere]">
          <bdi className="font-semibold text-[15px] text-ink">{subjectRef.name}</bdi>
          {subjectRef.path ? <bdi>{subjectRef.path}</bdi> : null}
        </p>
      ) : null}

      <DatePicker
        label={t`Date`}
        value={servicedOn}
        onChange={(v) => {
          setServicedOn(v);
          clear('date');
        }}
        maxValue={access.today}
        {...(errors.date ? { errorMessage: errors.date } : {})}
      />

      {meter ? (
        <div className="grid gap-2">
          {meters.length > 1 ? (
            <Combobox
              label={t`Meter`}
              items={meters.map((m) => ({
                id: m.id,
                label: `${meterName(m)} (${unitOf(m.unit)})`,
              }))}
              selectedKey={meter.id}
              onSelectionChange={(k) => k && setMeterId(String(k))}
            />
          ) : null}
          <TextField
            label={t`${meterName(meter)}, ${unitOf(meter.unit)}`}
            description={t`Optional. Checked against the readings before and after it.`}
            value={reading}
            onChange={(v) => {
              setReading(v);
              clear('reading');
            }}
            inputProps={{ inputMode: 'decimal', dir: 'ltr' }}
            {...(errors.reading ? { errorMessage: errors.reading, isInvalid: true } : {})}
          />
          <div className="flex flex-wrap items-center gap-2">
            <FileTrigger
              acceptedFileTypes={['image/*']}
              onSelect={(files) => {
                const file = files?.[0];
                if (!file) return;
                const key = newId();
                setProof({ key, name: file.name, fileId: null });
                void upload(file, (fileId) =>
                  setProof((p) => (p?.key === key ? { ...p, fileId } : p)),
                ).then((ok) => {
                  if (!ok) setProof(null);
                });
              }}
            >
              <Button variant="secondary" size="small">
                <CameraIcon className="size-4" />
                {proof ? <Trans>Replace the photo</Trans> : <Trans>Photo of the meter</Trans>}
              </Button>
            </FileTrigger>
            {proof ? (
              <span className="text-small text-ink-2 [overflow-wrap:anywhere]">
                {proof.fileId ? (
                  <Trans>Photo added. It joins the odometer proof strip.</Trans>
                ) : (
                  <Trans>Uploading…</Trans>
                )}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      <VendorField accountId={accountId} value={vendor} onChange={setVendor} />

      <fieldset className="m-0 grid gap-2 border-0 p-0">
        <legend className="mb-1 p-0 font-medium text-[14px] text-ink">
          <Trans>Invoice</Trans>
        </legend>
        {invoices.length ? (
          <ul className="m-0 grid list-none gap-1.5 p-0">
            {invoices.map((inv) => (
              <li key={inv.key} className="flex items-center gap-2 text-small">
                <DocumentIcon className="size-4 shrink-0 text-ink-2" aria-hidden="true" />
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{inv.name}</span>
                {inv.fileId ? null : (
                  <span className="text-ink-3">
                    <Trans>Uploading…</Trans>
                  </span>
                )}
                {inv.inDraft ? null : (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t`Remove ${inv.name}`}
                    onPress={() => setInvoices((xs) => xs.filter((x) => x.key !== inv.key))}
                  >
                    <XIcon />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : null}
        <InvoiceReadStatus read={read} />
        <FileTrigger
          acceptedFileTypes={['image/*', 'application/pdf']}
          allowsMultiple
          onSelect={(files) => {
            for (const file of Array.from(files ?? [])) {
              const key = newId();
              setInvoices((xs) => [...xs, { key, name: file.name, fileId: null }]);
              void upload(file, (fileId) =>
                setInvoices((xs) => xs.map((x) => (x.key === key ? { ...x, fileId } : x))),
              ).then((ok) => {
                if (!ok) setInvoices((xs) => xs.filter((x) => x.key !== key));
              });
            }
          }}
        >
          <Button variant="secondary" size="small" className="justify-self-start">
            <CameraIcon className="size-4" />
            <Trans>Photo or file</Trans>
          </Button>
        </FileTrigger>
        {draftState === 'made' && !given ? (
          <p className="m-0 text-small text-ink-3">
            <Trans>Kept as a draft on its Services tab until you save it.</Trans>
          </p>
        ) : null}
      </fieldset>

      <InvoiceSuggestions
        read={read}
        pending={pending}
        showMoney={access.money}
        onConfirmAll={confirmAll}
        onEditLine={editLine}
      />

      <fieldset className="m-0 grid gap-2 border-0 p-0">
        <legend className="mb-1 p-0 font-medium text-[14px] text-ink">
          <Trans>Line items</Trans>
        </legend>
        {lines.map((l, i) => (
          <fieldset
            key={l.key}
            aria-label={t`Line ${i + 1}`}
            className="m-0 grid min-w-0 gap-2 rounded-[10px] border border-line p-3"
          >
            <div className="grid gap-2 md:grid-cols-[9rem_1fr]">
              <Combobox
                label={t`Kind`}
                items={SERVICE_LINE_KINDS.map((k) => ({ id: k, label: lineLabels[k] }))}
                selectedKey={l.kind}
                onSelectionChange={(k) =>
                  k && setLine(l.key, { kind: String(k) as ServiceLineKind })
                }
              />
              <TextField
                label={t`What`}
                value={l.description}
                onChange={(v) => setLine(l.key, { description: v })}
                inputProps={{ dir: 'auto' }}
              />
            </div>
            <div className={cn('grid gap-2', access.money ? 'grid-cols-2' : 'grid-cols-1')}>
              <TextField
                label={t`Quantity`}
                value={l.quantity}
                onChange={(v) => setLine(l.key, { quantity: v })}
                inputProps={{ inputMode: 'decimal', dir: 'ltr' }}
              />
              {access.money ? (
                <TextField
                  label={t`Cost each`}
                  value={l.cost}
                  onChange={(v) => setLine(l.key, { cost: v })}
                  inputProps={{ inputMode: 'decimal', dir: 'ltr' }}
                />
              ) : null}
            </div>
            {errors[`line:${l.key}`] ? (
              <p role="alert" className="m-0 text-small text-danger">
                {errors[`line:${l.key}`]}
              </p>
            ) : null}
            <Button
              variant="ghost"
              size="small"
              className="justify-self-end"
              onPress={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
            >
              <Trans>Remove this line</Trans>
            </Button>
          </fieldset>
        ))}
        <Button
          variant="secondary"
          size="small"
          className="justify-self-start"
          isDisabled={lines.length >= 50}
          onPress={() => setLines((ls) => [...ls, newLine()])}
        >
          <PlusIcon className="size-4" />
          <Trans>Add a line</Trans>
        </Button>
        {errors.lines ? (
          <p role="alert" className="m-0 text-small text-danger">
            {errors.lines}
          </p>
        ) : null}
      </fieldset>

      {access.money ? (
        <div className="grid gap-1.5">
          {askDollars ? (
            <DollarQuestion
              value={currency}
              onPick={(code) => {
                setCurrency(code);
                clear('total');
              }}
            />
          ) : null}
          <MoneyFields
            label={t`Total`}
            amount={total}
            onAmount={(v) => {
              setTotal(v);
              clear('total');
            }}
            currency={currency}
            onCurrency={setCurrency}
            error={errors.total}
          />
          {lineSum !== null && !total.trim() && currency ? (
            <p className="m-0 text-small text-ink-2">
              <Trans>
                The lines add up to {money(String(lineSum), currency)}; that's the total unless you
                type one.
              </Trans>
            </p>
          ) : null}
          {mismatch !== null && currency ? (
            <p className="m-0 text-small text-warn">
              <Trans>
                The lines add up to {money(String(mismatch), currency)}. Check the total or the
                lines.
              </Trans>
            </p>
          ) : null}
        </div>
      ) : null}

      {active.length ? (
        <CheckboxGroup
          value={ticked}
          onChange={(next) => {
            for (const id of new Set([...next, ...ticked])) touched.current.add(id);
            setTicked(next);
          }}
          className="grid gap-1.5"
        >
          <Label className="eyebrow">
            <Trans>Completes</Trans>
          </Label>
          <div className="grid overflow-hidden rounded-[10px] border border-line">
            {active.map((s) => (
              <Checkbox
                key={s.id}
                value={s.id}
                className="group flex min-h-12 cursor-pointer items-center gap-3 px-3.5 py-2.5 outline-none not-first:border-t not-first:border-line data-focus-visible:outline-2 data-focus-visible:-outline-offset-2 data-focus-visible:outline-info"
              >
                {({ isSelected }) => (
                  <>
                    <span
                      aria-hidden="true"
                      className={cn(
                        'grid size-5 shrink-0 place-items-center rounded-[5px] border-2 [&_svg]:size-3.5',
                        isSelected ? 'border-ink bg-ink text-paper' : 'border-ink-3 bg-surface',
                      )}
                    >
                      {isSelected ? <CheckIcon strokeWidth="3" /> : null}
                    </span>
                    <span className="grid min-w-0 flex-1 gap-0.5">
                      <span className="font-medium [overflow-wrap:anywhere]">
                        <bdi>{s.name}</bdi>
                      </span>
                      <span className="text-small text-ink-2 [overflow-wrap:anywhere]">
                        {completesText(s as ScheduleV5, isSelected)}
                      </span>
                    </span>
                  </>
                )}
              </Checkbox>
            ))}
          </div>
        </CheckboxGroup>
      ) : null}

      <TextField label={t`Notes`} value={notes} onChange={setNotes} inputProps={{ dir: 'auto' }} />

      {!online ? (
        <p className="m-0 text-small text-ink-2">
          <Trans>Needs a connection: it has money. A reading alone can be logged offline.</Trans>
        </p>
      ) : null}
      <DialogFooter>
        <Button variant="secondary" onPress={onClose}>
          <Trans>Cancel</Trans>
        </Button>
        <Button
          type="submit"
          isPending={busy}
          isDisabled={
            !online ||
            draftState === 'making' ||
            !!(proof && !proof.fileId) ||
            invoices.some((x) => !x.fileId)
          }
        >
          <Trans>Save</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
}
