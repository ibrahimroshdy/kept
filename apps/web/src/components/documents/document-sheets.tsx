/**
 * Expiring documents on a location or a place (plan T23; D155, D172, Q31): "Add expiring
 * document" (a lease, the home insurance, an inspection: its kind, a title, the day it runs out
 * and how many days before to remind), and Renew, which makes a new term and keeps the old one in
 * the history (D172), with Undo for 10 seconds (D150).
 *
 * Both are online only (the step-4 offline matrix has no document write): offline the Save button
 * is off with "Needs a connection" (screens §3). A date is picked on Kept's own calendar, never
 * the OS picker, and a number accepts Arabic digits.
 *
 * Step 5 (plan T22, Q5): with `costs`, both sheets also ask for the issue date and the cost (a
 * vehicle's licence or insurance, which count on its Costs tab); the cost only where the reader
 * sees money in the location, in its currency by default.
 */
import { DOCUMENT_KINDS, type DocumentKind, HOUSEHOLD_LIMITS, LEAD_DEFAULTS } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { householdApi, householdKeys } from '@/api/household/queries';
import type { ExpiringDocument, SubjectInput } from '@/api/household/types';
import { vehiclesApi } from '@/api/vehicles/queries';
import type { DocumentCostFields } from '@/api/vehicles/types';
import { useOfferUndo } from '@/components/history/undo';
import { LoadingRows, Notice, useErrorText } from '@/components/page';
import { Sheet } from '@/components/places/sheet';
import { useLocationAccess } from '@/components/schedules/access';
import { amountOf, MoneyFields } from '@/components/services/fields';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { DialogFooter } from '@/components/ui/dialog';
import { Select, SelectItem } from '@/components/ui/select';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { isolate } from '@/lib/bidi';
import { useOnline } from '@/lib/online';
import { useTypedNumber } from '@/lib/units';
import { useDocumentKindLabels, useDocumentName } from './labels';

/** Everything that lists documents or reads the agenda, refetched after a document write. */
export function useInvalidateDocuments() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: householdKeys.documents.all }),
      qc.invalidateQueries({ queryKey: householdKeys.paperwork.all }),
      qc.invalidateQueries({ queryKey: householdKeys.agenda.all }),
      qc.invalidateQueries({ queryKey: householdKeys.notifications.all }),
    ]);
}

/** "٣٠" or "30" → 30; `undefined` when empty, `null` when not a whole number in range. */
export function daysOf(input: string): number | null | undefined {
  const s = input
    .trim()
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  if (s === '') return undefined;
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  const { min, max } = HOUSEHOLD_LIMITS.documentLeadDays;
  return n < min || n > max ? null : n;
}

function useLeadError() {
  const { t } = useLingui();
  const { max } = HOUSEHOLD_LIMITS.documentLeadDays;
  return t`A whole number of days, from 0 to ${max}.`;
}

function OfflineNote() {
  return (
    <p className="m-0 text-small text-ink-2">
      <Trans>Needs a connection</Trans>
    </p>
  );
}

/** Step 5's issue date and cost (`costs`): the fields, their check, and what the write sends. */
export type DocumentCosts = { locationId: string };

function useCostFields(costs: DocumentCosts | undefined) {
  const { t } = useLingui();
  const access = useLocationAccess()(costs?.locationId ?? '');
  const [issuedOn, setIssuedOn] = useState<string | null>(null);
  const [cost, setCost] = useState('');
  // The location's currency until one is picked (the locations may still be loading).
  const [picked, setCurrency] = useState<string | null>(null);
  const currency = picked ?? access.location?.currency ?? null;
  const [errors, setErrors] = useState<{ issuedOn?: string; cost?: string }>({});
  const money = !!costs && access.money;
  /** The body's fields, or null when one is wrong (its message is shown). */
  const check = (expiresOn: string | null): DocumentCostFields | null => {
    if (!costs) return {};
    const next: { issuedOn?: string; cost?: string } = {};
    if (issuedOn && issuedOn > access.today) next.issuedOn = t`Not in the future.`;
    else if (issuedOn && expiresOn && issuedOn > expiresOn)
      next.issuedOn = t`Issued on or before the day it runs out.`;
    const c = money ? amountOf(cost) : '';
    if (c === null) next.cost = t`Enter an amount, like 1250 or 1250.50.`;
    else if (c && !currency) next.cost = t`A price needs a currency.`;
    setErrors(next);
    if (next.issuedOn || next.cost) return null;
    return {
      ...(issuedOn ? { issuedOn } : {}),
      ...(c && currency ? { cost: c, currency } : {}),
    };
  };
  const fields = costs ? (
    <>
      <DatePicker
        label={t`Issued on (optional)`}
        value={issuedOn}
        maxValue={access.today}
        onChange={(v) => {
          setIssuedOn(v);
          setErrors(({ issuedOn: _, ...rest }) => rest);
        }}
        {...(errors.issuedOn ? { errorMessage: errors.issuedOn } : {})}
      />
      {money ? (
        <MoneyFields
          label={t`Cost (optional)`}
          amount={cost}
          onAmount={(v) => {
            setCost(v);
            setErrors(({ cost: _, ...rest }) => rest);
          }}
          currency={currency}
          onCurrency={setCurrency}
          error={errors.cost}
        />
      ) : null}
    </>
  ) : null;
  return { fields, check };
}

// ----- add ----------------------------------------------------------------------------------------

export function AddDocumentSheet({
  isOpen,
  onClose,
  subject,
  subjectName: rawName,
  costs,
  defaultKind,
}: {
  isOpen: boolean;
  onClose: () => void;
  subject: SubjectInput;
  /** The location's or place's name, for the title. */
  subjectName: string;
  /** Step 5: ask for the issue date and the cost too (a vehicle's documents). */
  costs?: DocumentCosts;
  /** The kind the sheet starts on (insurance unless said). */
  defaultKind?: DocumentKind;
}) {
  const { t } = useLingui();
  // The name isolated in the title, so a Latin name keeps its place in Arabic (UI step-5 L).
  const subjectName = isolate(rawName);
  return (
    <Sheet
      isOpen={isOpen}
      onOpenChange={(o) => !o && onClose()}
      title={t`Expiring document for ${subjectName}`}
    >
      {({ close }) => (
        <AddDocumentForm
          subject={subject}
          onDone={close}
          {...(costs ? { costs } : {})}
          {...(defaultKind ? { defaultKind } : {})}
        />
      )}
    </Sheet>
  );
}

function AddDocumentForm({
  subject,
  onDone,
  costs,
  defaultKind = 'insurance',
}: {
  subject: SubjectInput;
  onDone: () => void;
  costs?: DocumentCosts;
  defaultKind?: DocumentKind;
}) {
  const { t } = useLingui();
  const kinds = useDocumentKindLabels();
  const errorText = useErrorText();
  const invalidate = useInvalidateDocuments();
  const online = useOnline();
  const leadError = useLeadError();
  const extra = useCostFields(costs);
  const typed = useTypedNumber();
  const [kind, setKind] = useState<DocumentKind>(defaultKind);
  const [title, setTitle] = useState('');
  const [expiresOn, setExpiresOn] = useState<string | null>(null);
  const [lead, setLead] = useState(() => typed(LEAD_DEFAULTS.document));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const clear = (k: string) => setErrors(({ [k]: _, ...rest }) => rest);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    const name = title.trim();
    if (kind === 'other' && !name) next.title = t`Name it, like Building inspection.`;
    if (name.length > HOUSEHOLD_LIMITS.documentTitleLength)
      next.title = t`Keep the name under ${HOUSEHOLD_LIMITS.documentTitleLength} characters.`;
    if (!expiresOn) next.expiresOn = t`Pick the day it runs out.`;
    const days = daysOf(lead);
    if (days === null) next.lead = leadError;
    setErrors(next);
    const more = extra.check(expiresOn);
    if (Object.keys(next).length || !expiresOn || !more) return;
    setBusy(true);
    setFailed(null);
    try {
      const body = {
        subject,
        kind,
        ...(name ? { title: name } : {}),
        expiresOn,
        ...(typeof days === 'number' ? { leadDays: days } : {}),
      };
      const doc = costs
        ? await vehiclesApi.createDocument({ ...body, ...more })
        : await householdApi.createDocument(body);
      await invalidate();
      toast({ title: t`Added ${name || kinds[doc.kind]}`, tone: 'ok' });
      onDone();
    } catch (err) {
      setFailed(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="grid gap-4">
      <Select<{ id: DocumentKind; name: string }>
        label={t`Kind`}
        items={DOCUMENT_KINDS.map((k) => ({ id: k, name: kinds[k] }))}
        value={kind}
        onChange={(key) => {
          if (key != null) setKind(key as DocumentKind);
          clear('title');
        }}
      >
        {(item) => (
          <SelectItem id={item.id} textValue={item.name}>
            {item.name}
          </SelectItem>
        )}
      </Select>
      <TextField
        label={kind === 'other' ? t`Name` : t`Name (optional)`}
        description={t`Like Home insurance, or the flat's lease`}
        value={title}
        onChange={(v) => {
          setTitle(v);
          clear('title');
        }}
        maxLength={HOUSEHOLD_LIMITS.documentTitleLength}
        inputProps={{ dir: 'auto' }}
        {...(errors.title ? { errorMessage: errors.title, isInvalid: true } : {})}
      />
      <DatePicker
        label={t`Runs out on`}
        value={expiresOn}
        onChange={(v) => {
          setExpiresOn(v);
          clear('expiresOn');
        }}
        {...(errors.expiresOn ? { errorMessage: errors.expiresOn } : {})}
      />
      {extra.fields}
      <TextField
        label={t`Remind me, days before`}
        value={lead}
        onChange={(v) => {
          setLead(v);
          clear('lead');
        }}
        inputProps={{ inputMode: 'numeric', dir: 'ltr' }}
        {...(errors.lead ? { errorMessage: errors.lead, isInvalid: true } : {})}
      />
      {failed ? <Notice tone="danger">{errorText(failed)}</Notice> : null}
      {online ? null : <OfflineNote />}
      <DialogFooter>
        <Button variant="secondary" onPress={onDone}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" isPending={busy} isDisabled={!online}>
          <Trans>Add</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
}

// ----- renew --------------------------------------------------------------------------------------

/**
 * A document by id, for Renew from a list that only knows its id (the agenda): the location's
 * current documents, page by page until it turns up. `GET /documents` has no id filter.
 */
function useDocumentById(id: string, locationId: string, enabled: boolean) {
  return useQuery({
    queryKey: [...householdKeys.documents.all, 'one', id],
    enabled,
    queryFn: async (): Promise<ExpiringDocument | null> => {
      let cursor: string | undefined;
      for (let i = 0; i < 20; i++) {
        const page = await householdApi.documents({ locationId, ...(cursor ? { cursor } : {}) });
        const found = page.items.find((d) => d.id === id);
        if (found) return found;
        if (!page.next_cursor) return null;
        cursor = page.next_cursor;
      }
      return null;
    },
  });
}

export type RenewTarget = ExpiringDocument | { id: string; locationId: string; name: string };

export function RenewSheet({
  target,
  onClose,
  costs,
}: {
  /** The document to renew; null keeps the sheet closed. */
  target: RenewTarget | null;
  onClose: () => void;
  /** Step 5: the new term's issue date and cost too (a vehicle's documents). */
  costs?: DocumentCosts;
}) {
  const { t } = useLingui();
  const nameOf = useDocumentName();
  const full = target && 'rowVersion' in target ? target : null;
  const loaded = useDocumentById(target?.id ?? '', target?.locationId ?? '', !!target && !full);
  const doc = full ?? loaded.data ?? null;
  const name = full ? nameOf(full) : target && 'name' in target ? target.name : '';
  return (
    <Sheet isOpen={!!target} onOpenChange={(o) => !o && onClose()} title={t`Renew ${name}`}>
      {({ close }) =>
        doc ? (
          <RenewForm document={doc} onDone={close} {...(costs ? { costs } : {})} />
        ) : loaded.isPending ? (
          <LoadingRows rows={2} />
        ) : (
          <Notice tone="warn">
            <Trans>This document was renewed or removed since. Refresh to see it now.</Trans>
          </Notice>
        )
      }
    </Sheet>
  );
}

/** The day after `day`, so a renewal runs past the term it replaces. */
function dayAfter(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return next.toISOString().slice(0, 10);
}

function RenewForm({
  document: doc,
  onDone,
  costs,
}: {
  document: ExpiringDocument;
  onDone: () => void;
  costs?: DocumentCosts;
}) {
  const { t } = useLingui();
  const nameOf = useDocumentName();
  const errorText = useErrorText();
  const offerUndo = useOfferUndo();
  const invalidate = useInvalidateDocuments();
  const online = useOnline();
  const leadError = useLeadError();
  const typed = useTypedNumber();
  const [expiresOn, setExpiresOn] = useState<string | null>(null);
  const [lead, setLead] = useState(() => typed(doc.leadDays));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const name = nameOf(doc);
  const min = dayAfter(doc.expiresOn);
  const extra = useCostFields(costs);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!expiresOn) next.expiresOn = t`Pick the day the new term runs out.`;
    else if (expiresOn < min) next.expiresOn = t`The new term has to end after the current one.`;
    const days = daysOf(lead);
    if (days === null) next.lead = leadError;
    setErrors(next);
    const more = extra.check(expiresOn);
    if (Object.keys(next).length || !expiresOn || !more) return;
    setBusy(true);
    setFailed(null);
    try {
      const body = { expiresOn, ...(typeof days === 'number' ? { leadDays: days } : {}) };
      const { auditEvents } = costs
        ? await vehiclesApi.renewDocument(doc.id, { ...body, ...more }, doc.rowVersion)
        : await householdApi.renewDocument(doc.id, body, doc.rowVersion);
      await invalidate();
      offerUndo(
        { title: t`Renewed ${name}`, description: t`The old term stays in its history.` },
        auditEvents,
      );
      onDone();
    } catch (err) {
      setFailed(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="grid gap-4">
      <DatePicker
        label={t`New term runs out on`}
        value={expiresOn}
        minValue={min}
        onChange={(v) => {
          setExpiresOn(v);
          setErrors(({ expiresOn: _, ...rest }) => rest);
        }}
        {...(errors.expiresOn ? { errorMessage: errors.expiresOn } : {})}
      />
      {extra.fields}
      <TextField
        label={t`Remind me, days before`}
        value={lead}
        onChange={(v) => {
          setLead(v);
          setErrors(({ lead: _, ...rest }) => rest);
        }}
        inputProps={{ inputMode: 'numeric', dir: 'ltr' }}
        {...(errors.lead ? { errorMessage: errors.lead, isInvalid: true } : {})}
      />
      {failed ? <Notice tone="danger">{errorText(failed)}</Notice> : null}
      {online ? null : <OfflineNote />}
      <DialogFooter>
        <Button variant="secondary" onPress={onDone}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" isPending={busy} isDisabled={!online}>
          <Trans>Renew</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
}
