/**
 * Add or edit a warranty (D53, D55). A new one starts from the defaults: the term set on the
 * brand, else on the nearest type up the chain, and the purchase date; the term field says where
 * it came from ("Samsung: 2 years (from the brand)"). Never an AI guess. The term, an end date or
 * lifetime: exactly one. The registration flag and its deadline, and the documents: picked here
 * for a new warranty and uploaded once it's saved, uploaded at once on an existing one.
 *
 * Editing and removing are undoable (the Undo toast, D150, plan Q25); adding isn't (§7.7).
 */
import { WARRANTY_KINDS, type WarrantyKind } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { householdApi, useWarrantyDefaults } from '@/api/household/queries';
import type {
  AttachmentRef,
  CreateWarrantyBody,
  Warranty,
  WarrantyDefaults,
} from '@/api/household/types';
import { useOfferUndo } from '@/components/history/undo';
import { DocumentIcon, ShareIcon } from '@/components/icons';
import { LoadingRows, useErrorText } from '@/components/page';
import { useThingCtx } from '@/components/things/context';
import { westernNumber } from '@/components/things/form-model';
import { todayIn, useHouseholdDone } from '@/components/things/household';
import { PendingFiles, useAttachAll } from '@/components/things/pending-files';
import { useAttachmentFile } from '@/components/things/purchase-section';
import { Sheet } from '@/components/things/sheet';
import { UploadButton } from '@/components/things/upload';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { useConfirm } from '@/components/ui/confirm';
import { DatePicker } from '@/components/ui/date-picker';
import { DialogFooter } from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { useFormat } from '@/lib/format';
import { useTermText, useWarrantyKindLabels } from './labels';

type Ends = 'term' | 'date' | 'lifetime';

export function WarrantySheet({
  warranty,
  onClose,
}: {
  /** The one to edit, 'new' to add, null when closed. */
  warranty: Warranty | 'new' | null;
  onClose: () => void;
}) {
  const { thing } = useThingCtx();
  const { t } = useLingui();
  const isNew = warranty === 'new';
  const defaults = useWarrantyDefaults(thing.id, isNew);
  return (
    <Sheet
      isOpen={warranty !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={isNew ? t`Add a warranty` : t`Edit the warranty`}
    >
      {warranty === null ? null : isNew && defaults.isPending ? (
        <LoadingRows rows={3} label={t`Loading the defaults`} />
      ) : (
        <WarrantyForm
          warranty={isNew ? null : warranty}
          defaults={defaults.data ?? null}
          onClose={onClose}
        />
      )}
    </Sheet>
  );
}

function WarrantyForm({
  warranty: w,
  defaults,
  onClose,
}: {
  warranty: Warranty | null;
  defaults: WarrantyDefaults | null;
  onClose: () => void;
}) {
  const { thing, location, can } = useThingCtx();
  const { t } = useLingui();
  const kinds = useWarrantyKindLabels();
  const term = useTermText();
  const errorText = useErrorText();
  const offerUndo = useOfferUndo();
  const confirm = useConfirm();
  const done = useHouseholdDone();
  const attachAll = useAttachAll();
  const today = todayIn(location.timezone);

  const [kind, setKind] = useState<WarrantyKind>(w?.kind ?? 'manufacturer');
  const [provider, setProvider] = useState(w?.provider ?? thing.brand?.name ?? '');
  const [startsOn, setStartsOn] = useState<string | null>(
    w?.startsOn ?? defaults?.startsOn ?? thing.purchase?.purchasedOn ?? today,
  );
  const [ends, setEnds] = useState<Ends>(
    w ? (w.lifetime ? 'lifetime' : w.endsOn ? 'date' : 'term') : 'term',
  );
  const [months, setMonths] = useState(
    String(w?.termMonths ?? (w ? '' : (defaults?.termMonths ?? ''))),
  );
  const [endsOn, setEndsOn] = useState<string | null>(w?.endsOn ?? null);
  const [contact, setContact] = useState(w?.claimContact ?? '');
  const [registered, setRegistered] = useState(w?.registered ?? false);
  const [deadline, setDeadline] = useState<string | null>(w?.registrationDeadline ?? null);
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<{ field: 'months' | 'ends' | 'form'; text: string }>();
  const [busy, setBusy] = useState(false);

  const fromText = defaults?.termMonths
    ? defaults.from?.kind === 'brand'
      ? t`${defaults.from.name}: ${term(defaults.termMonths)} (from the brand)`
      : defaults.from
        ? t`${defaults.from.name}: ${term(defaults.termMonths)} (from the type)`
        : null
    : null;

  const save = async () => {
    if (!startsOn) {
      setError({ field: 'form', text: t`A warranty needs a start date.` });
      return;
    }
    const body: CreateWarrantyBody = { kind, startsOn };
    if (ends === 'term') {
      const n = Number(westernNumber(months).trim());
      if (!Number.isInteger(n) || n < 1 || n > 600) {
        setError({ field: 'months', text: t`A whole number of months, from 1 to 600.` });
        return;
      }
      body.termMonths = n;
    } else if (ends === 'date') {
      if (!endsOn || endsOn < startsOn) {
        setError({ field: 'ends', text: t`An end date on or after the start.` });
        return;
      }
      body.endsOn = endsOn;
    } else body.lifetime = true;
    if (provider.trim()) body.provider = provider.trim();
    if (contact.trim()) body.claimContact = contact.trim();
    body.registered = registered;
    if (!registered && deadline) body.registrationDeadline = deadline;
    setBusy(true);
    try {
      if (w) {
        const { auditEvents } = await householdApi.updateWarranty(
          w.id,
          {
            kind,
            startsOn,
            provider: body.provider ?? null,
            claimContact: body.claimContact ?? null,
            registered,
            registrationDeadline: body.registrationDeadline ?? null,
            termMonths: body.termMonths ?? null,
            endsOn: body.endsOn ?? null,
            lifetime: ends === 'lifetime',
          },
          w.rowVersion,
        );
        offerUndo({ title: t`Warranty saved` }, auditEvents, { thingId: thing.id });
      } else {
        const created = await householdApi.createWarranty(thing.id, body);
        await attachAll(files, thing.locationId, { warrantyId: created.id }, 'warranty_doc');
        toast({ title: t`Warranty added`, tone: 'ok' });
      }
      await done();
      onClose();
    } catch (e) {
      setError({ field: 'form', text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!w) return;
    const ok = await confirm({
      title: t`Remove this warranty?`,
      body: t`Its reminders stop. You can undo this for 7 days.`,
      confirmLabel: t`Remove`,
      destructive: true,
    });
    if (!ok) return;
    try {
      const { auditEvents } = await householdApi.deleteWarranty(w.id, w.rowVersion);
      offerUndo({ title: t`Warranty removed` }, auditEvents, { thingId: thing.id });
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
      <Combobox
        label={t`Kind`}
        items={WARRANTY_KINDS.map((k) => ({ id: k, label: kinds[k] }))}
        selectedKey={kind}
        onSelectionChange={(k) => {
          if (k) setKind(String(k) as WarrantyKind);
        }}
      />
      <TextField
        label={t`Provider`}
        description={t`The maker, the shop or the insurer.`}
        value={provider}
        onChange={setProvider}
        inputProps={{ dir: 'auto' }}
      />
      <DatePicker
        label={t`Starts`}
        description={
          !w && defaults?.startsOn
            ? t`From the purchase date; change it if it started later.`
            : undefined
        }
        value={startsOn}
        onChange={setStartsOn}
      />
      <Segmented<Ends>
        label={t`How long`}
        value={ends}
        onChange={(v) => {
          setEnds(v);
          setError(undefined);
        }}
        options={[
          { id: 'term', label: t`A term` },
          { id: 'date', label: t`Until a date` },
          { id: 'lifetime', label: t`Lifetime` },
        ]}
      />
      {ends === 'term' ? (
        <TextField
          label={t`Months`}
          description={fromText ?? t`No default term on this brand or type.`}
          value={months}
          onChange={(v) => {
            setMonths(v);
            setError(undefined);
          }}
          inputProps={{ inputMode: 'numeric', dir: 'ltr' }}
          {...(error?.field === 'months' ? { errorMessage: error.text, isInvalid: true } : {})}
        />
      ) : ends === 'date' ? (
        <DatePicker
          label={t`Covered until`}
          value={endsOn}
          onChange={setEndsOn}
          {...(startsOn ? { minValue: startsOn } : {})}
          {...(error?.field === 'ends' ? { errorMessage: error.text } : {})}
        />
      ) : null}
      <TextField
        label={t`Claim contact`}
        description={t`A phone number, an email or a web page.`}
        value={contact}
        onChange={setContact}
        inputProps={{ dir: 'auto' }}
      />
      <Switch isSelected={registered} onChange={setRegistered}>
        <Trans>Registered with the maker</Trans>
      </Switch>
      {!registered ? (
        <DatePicker
          label={t`Register by`}
          description={t`Optional. Kept reminds you before this day.`}
          value={deadline}
          onChange={setDeadline}
        />
      ) : null}
      {w ? (
        <div className="grid gap-1.5">
          <span className="text-small font-semibold text-ink">
            <Trans>Documents</Trans>
          </span>
          {w.documents.length ? (
            <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
              {w.documents.map((d, i) => (
                <li key={d.id}>
                  <DocumentButton doc={d} n={i + 1} />
                </li>
              ))}
            </ul>
          ) : null}
          {can('attachments.add') ? (
            <UploadButton
              locationId={thing.locationId}
              subject={{ warrantyId: w.id }}
              attachAs="warranty_doc"
              label={t`Attach the card or certificate`}
              onUploaded={() => void done()}
            />
          ) : null}
        </div>
      ) : can('attachments.add') ? (
        <PendingFiles files={files} onChange={setFiles} label={t`Attach the card or certificate`} />
      ) : null}
      {error?.field === 'form' ? (
        <p role="alert" className="m-0 text-small text-danger">
          {error.text}
        </p>
      ) : null}
      <DialogFooter>
        {w ? (
          <Button variant="ghost" className="me-auto text-danger" onPress={() => void remove()}>
            <Trans>Remove</Trans>
          </Button>
        ) : null}
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

/** One of the warranty's documents: opens, or on the installed iPhone app shares (D157). */
function DocumentButton({ doc, n }: { doc: AttachmentRef; n: number }) {
  const file = useAttachmentFile(doc);
  const fmt = useFormat();
  return (
    <Button
      ref={file.ref}
      variant="secondary"
      size="small"
      isPending={file.pending}
      onPress={file.press}
    >
      {file.mode === 'share' ? (
        <ShareIcon className="size-4" />
      ) : (
        <DocumentIcon className="size-4" />
      )}
      <Trans>Document {fmt.num(n)}</Trans>
    </Button>
  );
}
