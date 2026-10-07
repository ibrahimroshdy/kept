/**
 * Open or update a claim (D54, D195; screens §5 "A claim prefills the longest active warranty").
 * A new claim starts on the warranty that covers longest, with the brand's claim page and phone
 * and the warranty's claim contact to hand; the vendor comes from the account's list or is typed
 * new (D11). Updating moves the status along `CLAIM_TRANSITIONS` (a closed claim reopens only
 * through Undo, Q18) and records the cost and "what it would have cost", which is what "Warranty
 * saved you" shows; both amounts only where money shows (the money gate).
 *
 * An update and a removal are undoable (the Undo toast); opening a claim isn't (§7.7).
 */
import { CLAIM_TRANSITIONS, type ClaimStatus } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { householdApi, useClaimPrefill, useWarranties } from '@/api/household/queries';
import type { Claim, CreateClaimBody, UpdateClaimBody } from '@/api/household/types';
import { useOfferUndo } from '@/components/history/undo';
import { LinkIcon, PhoneIcon } from '@/components/icons';
import { isMoneyHidden } from '@/components/money/gated';
import { Notice, useErrorText } from '@/components/page';
import { amountOf, MoneyFields } from '@/components/services/fields';
import {
  emptyVendor,
  VendorField,
  type VendorValue,
  vendorInput,
} from '@/components/services/vendor-field';
import { useThingCtx } from '@/components/things/context';
import { todayIn, useHouseholdDone } from '@/components/things/household';
import { PendingFiles, useAttachAll } from '@/components/things/pending-files';
import { useLocationAccountId } from '@/components/things/pickers';
import { Sheet } from '@/components/things/sheet';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { useConfirm } from '@/components/ui/confirm';
import { DatePicker } from '@/components/ui/date-picker';
import { DialogFooter } from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/segmented';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { useWarrantyKindLabels } from '@/components/warranties/labels';
import { sep } from '@/lib/format';
import { useClaimStatusLabels } from './labels';

export function ClaimSheet({
  claim,
  onClose,
}: {
  claim: Claim | 'new' | null;
  onClose: () => void;
}) {
  const { t } = useLingui();
  return (
    <Sheet
      isOpen={claim !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={claim === 'new' ? t`New claim` : t`Update the claim`}
    >
      {claim === 'new' ? (
        <NewClaim onClose={onClose} />
      ) : claim ? (
        <UpdateClaim claim={claim} onClose={onClose} />
      ) : null}
    </Sheet>
  );
}

function useWarrantyOptions() {
  const { thing } = useThingCtx();
  const kinds = useWarrantyKindLabels();
  const q = useWarranties(thing.id);
  return (q.data?.items ?? [])
    .filter((w) => w.state !== 'ended')
    .map((w) => ({
      id: w.id,
      label: w.provider ? `${kinds[w.kind]}${sep()}${w.provider}` : kinds[w.kind],
    }));
}

function NewClaim({ onClose }: { onClose: () => void }) {
  const { thing, location, can } = useThingCtx();
  const { t } = useLingui();
  const errorText = useErrorText();
  const done = useHouseholdDone();
  const attachAll = useAttachAll();
  const accountId = useLocationAccountId(location);
  const prefill = useClaimPrefill(thing.id);
  const warranties = useWarrantyOptions();
  const today = todayIn(location.timezone);
  const [warrantyId, setWarrantyId] = useState<string | null | undefined>(undefined);
  const [openedOn, setOpenedOn] = useState<string | null>(today);
  const [status, setStatus] = useState<'open' | 'in_repair'>('open');
  const [vendor, setVendor] = useState<VendorValue>(emptyVendor);
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  // The longest active warranty, until the person picks another (or none).
  const chosen = warrantyId === undefined ? (prefill.data?.warrantyId ?? null) : warrantyId;
  const p = prefill.data;

  const save = async () => {
    if (!openedOn) {
      setError(t`A claim needs the day it was opened.`);
      return;
    }
    const body: CreateClaimBody = { openedOn, status };
    if (chosen) body.warrantyId = chosen;
    const v = vendorInput(vendor);
    if (v) body.vendor = v;
    if (reference.trim()) body.reference = reference.trim();
    if (notes.trim()) body.notes = notes.trim();
    setBusy(true);
    try {
      const created = await householdApi.createClaim(thing.id, body);
      await attachAll(files, thing.locationId, { claimId: created.id }, 'document');
      toast({ title: t`Claim opened`, tone: 'ok' });
      await done();
      onClose();
    } catch (e) {
      setError(errorText(e));
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
      {p && (p.claimUrl || p.supportPhone || p.claimContact) ? (
        <Notice title={<Trans>Where to claim</Trans>}>
          <span className="flex flex-wrap gap-x-3 gap-y-1">
            {p.claimUrl ? (
              <a
                href={p.claimUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 text-info underline"
              >
                <LinkIcon className="size-4" />
                <Trans>The brand's claim page</Trans>
              </a>
            ) : null}
            {p.supportPhone ? (
              <a
                href={`tel:${p.supportPhone}`}
                className="inline-flex items-center gap-1 text-info underline"
              >
                <PhoneIcon className="size-4" />
                <bdi dir="ltr">{p.supportPhone}</bdi>
              </a>
            ) : null}
            {p.claimContact ? (
              <span>
                <Trans>Warranty contact:</Trans> <bdi dir="auto">{p.claimContact}</bdi>
              </span>
            ) : null}
          </span>
        </Notice>
      ) : null}
      <Combobox
        label={t`Warranty`}
        description={
          chosen && chosen === p?.warrantyId ? t`The one that covers longest.` : undefined
        }
        items={[{ id: 'none', label: t`No warranty` }, ...warranties]}
        selectedKey={chosen ?? 'none'}
        onSelectionChange={(k) => {
          if (k) setWarrantyId(k === 'none' ? null : String(k));
        }}
      />
      <TextField
        label={t`What's wrong`}
        value={notes}
        onChange={setNotes}
        autoFocus
        inputProps={{ dir: 'auto' }}
      />
      <DatePicker label={t`Opened`} value={openedOn} onChange={setOpenedOn} maxValue={today} />
      <Segmented<'open' | 'in_repair'>
        label={t`Where it is now`}
        value={status}
        onChange={setStatus}
        options={[
          { id: 'open', label: t`Still here` },
          { id: 'in_repair', label: t`Gone for repair` },
        ]}
      />
      <VendorField accountId={accountId} value={vendor} onChange={setVendor} />
      <TextField
        label={t`Reference`}
        value={reference}
        onChange={setReference}
        inputProps={{ dir: 'ltr' }}
      />
      {can('attachments.add') ? (
        <PendingFiles files={files} onChange={setFiles} label={t`Attach a job card or photo`} />
      ) : null}
      {error ? (
        <p role="alert" className="m-0 text-small text-danger">
          {error}
        </p>
      ) : null}
      <DialogFooter>
        <Button variant="secondary" onPress={onClose}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" isPending={busy}>
          <Trans>Open the claim</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
}

function UpdateClaim({ claim: c, onClose }: { claim: Claim; onClose: () => void }) {
  const { thing, location, moduleOn, can } = useThingCtx();
  const { t } = useLingui();
  const statuses = useClaimStatusLabels();
  const errorText = useErrorText();
  const offerUndo = useOfferUndo();
  const confirm = useConfirm();
  const done = useHouseholdDone();
  const accountId = useLocationAccountId(location);
  const today = todayIn(location.timezone);
  const showMoney = moduleOn('money') && can('money.view');
  const shownCost = c.cost && !isMoneyHidden(c.cost) ? c.cost : null;
  const shownCovered = c.coveredAmount && !isMoneyHidden(c.coveredAmount) ? c.coveredAmount : null;
  const [status, setStatus] = useState<ClaimStatus>(c.status);
  const [closedOn, setClosedOn] = useState<string | null>(c.closedOn ?? today);
  const [vendor, setVendor] = useState<VendorValue>(
    c.vendor ? { id: c.vendor.id, text: c.vendor.name } : emptyVendor,
  );
  const [reference, setReference] = useState(c.reference ?? '');
  const [notes, setNotes] = useState(c.notes ?? '');
  const [cost, setCost] = useState(shownCost?.amount ?? '');
  const [covered, setCovered] = useState(shownCovered?.amount ?? '');
  const [currency, setCurrency] = useState<string | null>(
    shownCost?.currency ?? shownCovered?.currency ?? location.currency,
  );
  const [error, setError] = useState<{ field: 'cost' | 'covered' | 'form'; text: string }>();
  const [busy, setBusy] = useState(false);
  const closing = status === 'resolved' || status === 'rejected';
  const allowed: ClaimStatus[] = [c.status, ...CLAIM_TRANSITIONS[c.status]];

  const save = async () => {
    const body: UpdateClaimBody = {};
    if (status !== c.status) body.status = status;
    if (closing && closedOn && closedOn !== c.closedOn) body.closedOn = closedOn;
    const v = vendorInput(vendor);
    if ((v && !('id' in v && v.id === c.vendor?.id)) || (!v && c.vendor)) body.vendor = v ?? null;
    if (reference.trim() !== (c.reference ?? '')) body.reference = reference.trim() || null;
    if (notes.trim() !== (c.notes ?? '')) body.notes = notes.trim() || null;
    if (showMoney) {
      const costAmount = amountOf(cost);
      const coveredAmount = amountOf(covered);
      if (costAmount === null || coveredAmount === null) {
        setError({
          field: costAmount === null ? 'cost' : 'covered',
          text: t`Enter an amount, like 1250 or 1250.50.`,
        });
        return;
      }
      if (costAmount !== (shownCost?.amount ?? '')) body.cost = costAmount || null;
      if (coveredAmount !== (shownCovered?.amount ?? ''))
        body.coveredAmount = coveredAmount || null;
      if ((body.cost || body.coveredAmount) && currency) body.currency = currency;
    }
    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      const { auditEvents } = await householdApi.updateClaim(c.id, body, c.rowVersion);
      offerUndo(
        { title: body.status ? t`Claim: ${statuses[status]}` : t`Claim saved` },
        auditEvents,
        { thingId: thing.id },
      );
      await done();
      onClose();
    } catch (e) {
      setError({ field: 'form', text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: t`Remove this claim?`,
      body: t`For a claim recorded by mistake. You can undo this for 7 days.`,
      confirmLabel: t`Remove`,
      destructive: true,
    });
    if (!ok) return;
    try {
      const { auditEvents } = await householdApi.deleteClaim(c.id, c.rowVersion);
      offerUndo({ title: t`Claim removed` }, auditEvents, { thingId: thing.id });
      await done();
      onClose();
    } catch (e) {
      toast({ title: t`Couldn't remove it`, description: errorText(e), tone: 'danger' });
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
      {allowed.length > 1 ? (
        <Combobox
          label={t`Status`}
          items={allowed.map((s) => ({ id: s, label: statuses[s] }))}
          selectedKey={status}
          onSelectionChange={(k) => {
            if (k) setStatus(String(k) as ClaimStatus);
          }}
        />
      ) : (
        <p className="m-0 text-small text-ink-2">
          <Trans>
            {statuses[c.status]}: a closed claim reopens only with Undo, from its history.
          </Trans>
        </p>
      )}
      {closing ? (
        <DatePicker label={t`Closed on`} value={closedOn} onChange={setClosedOn} maxValue={today} />
      ) : null}
      <VendorField accountId={accountId} value={vendor} onChange={setVendor} />
      <TextField
        label={t`Reference`}
        value={reference}
        onChange={setReference}
        inputProps={{ dir: 'ltr' }}
      />
      <TextField
        label={t`What's wrong`}
        value={notes}
        onChange={setNotes}
        inputProps={{ dir: 'auto' }}
      />
      {showMoney ? (
        <>
          <MoneyFields
            label={t`What you paid`}
            amount={cost}
            onAmount={(v) => {
              setCost(v);
              setError(undefined);
            }}
            currency={currency}
            onCurrency={setCurrency}
            error={error?.field === 'cost' ? error.text : undefined}
          />
          <TextField
            label={t`What it would have cost`}
            description={t`Optional. Shown as "Warranty saved you" when the repair cost nothing.`}
            value={covered}
            onChange={(v) => {
              setCovered(v);
              setError(undefined);
            }}
            inputProps={{ inputMode: 'decimal', dir: 'ltr' }}
            {...(error?.field === 'covered' ? { errorMessage: error.text, isInvalid: true } : {})}
          />
        </>
      ) : null}
      {error?.field === 'form' ? (
        <p role="alert" className="m-0 text-small text-danger">
          {error.text}
        </p>
      ) : null}
      <DialogFooter>
        <Button variant="ghost" className="me-auto text-danger" onPress={() => void remove()}>
          <Trans>Remove</Trans>
        </Button>
        <Button variant="secondary" onPress={onClose}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" isPending={busy}>
          <Trans>Save</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
}
