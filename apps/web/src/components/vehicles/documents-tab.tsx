/**
 * A vehicle's Documents (plan T22; screens §8, the board's vehicle frames 67 and 68; D26, D52,
 * D155, D172; Q5): the vehicle's expiring documents (step 4's, `GET /documents?thingId`), each
 * with where its term stands ("Due in 23 days", "Valid", "Expired"), its dates, how early it
 * reminds, its files and its cost (money-gated), and Add and Renew through step 4's sheets with
 * the issue date and the cost (step 5). Until the vehicle has a registration card, a row says how
 * to get one in: read it in LABEL mode, which reads the VIN, the plate and the licence's expiry
 * and suggests the document in the Inbox.
 *
 * Controls follow screens §3: Add, Renew and Remove for those who may edit things
 * (`things.edit`); a viewer reads, without the cost unless money shows to viewers. A vehicle's
 * documents count with Paperwork **or** Vehicles on (step 4's Q5); with both off, the section says
 * so. Offline the writes say "Needs a connection".
 *
 * Mounted by the vehicle page inside its ThingProvider.
 */
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { householdApi } from '@/api/household/queries';
import { useVehicleDocuments, vehicleKeys } from '@/api/vehicles/queries';
import type { ExpiringDocumentV5 } from '@/api/vehicles/types';
import {
  AddDocumentSheet,
  RenewSheet,
  useInvalidateDocuments,
} from '@/components/documents/document-sheets';
import {
  DOCUMENT_TONE,
  noonOf,
  useDocumentKindLabels,
  useDocumentName,
} from '@/components/documents/labels';
import { useOfferUndo } from '@/components/history/undo';
import { ClockIcon, DocumentIcon } from '@/components/icons';
import { OverflowActions } from '@/components/inbox/overflow-actions';
import { MoneyHiddenText } from '@/components/money/gated';
import {
  ErrorState,
  IconTile,
  List,
  LoadingRows,
  Pill,
  Row,
  useErrorText,
} from '@/components/page';
import { FileOpenButton } from '@/components/paperwork/rows';
import { accessOf, daysBetween } from '@/components/schedules/access';
import { ModuleOff, useThingCtx } from '@/components/things/context';
import { useMoney } from '@/components/things/values';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { toast } from '@/components/ui/toast';
import { sep, useFormat } from '@/lib/format';
import { useOnline } from '@/lib/online';

/** Where a term stands, in the board's words: "Due in 23 days", "Valid", "Expired". */
function TermPill({ doc, today }: { doc: ExpiringDocumentV5; today: string }) {
  const days = daysBetween(today, doc.expiresOn);
  return (
    <Pill tone={DOCUMENT_TONE[doc.state]} icon={<ClockIcon />}>
      {doc.state === 'expired' ? (
        <Trans>Expired</Trans>
      ) : doc.state === 'expiring' ? (
        days <= 0 ? (
          <Trans>Due today</Trans>
        ) : (
          <Plural value={days} one="Due in # day" other="Due in # days" />
        )
      ) : (
        <Trans>Valid</Trans>
      )}
    </Pill>
  );
}

export function VehicleDocuments({
  readLabel,
}: {
  /**
   * Opens Capture in LABEL mode on this vehicle (the registration card's shortcut). The vehicle
   * page passes it once Capture can take a vehicle to read a label onto; without it the row only
   * says how.
   */
  readLabel?: () => void;
} = {}) {
  const { t } = useLingui();
  const { thing, location, moduleOn, can } = useThingCtx();
  const online = useOnline();
  const kinds = useDocumentKindLabels();
  const docs = useVehicleDocuments(thing.id);
  const [adding, setAdding] = useState(false);
  const [renewing, setRenewing] = useState<ExpiringDocumentV5 | null>(null);
  const qc = useQueryClient();
  // Step 4's sheets refresh the lists they know; this one is keyed under the thing.
  const refetch = () => void qc.invalidateQueries({ queryKey: vehicleKeys.documents(thing.id) });
  if (!moduleOn('paperwork') && !moduleOn('vehicles'))
    return <ModuleOff what={<Trans>Documents</Trans>} />;
  const canEdit = can('things.edit');
  const items = docs.data?.pages.flatMap((p) => p.items) ?? [];
  const hasCard = items.some((d) => d.kind === 'registration');
  const today = accessOf(location).today;
  const costs = { locationId: location.id };
  const name = thing.name ?? '';

  let body: ReactNode;
  if (docs.isPending) body = <LoadingRows rows={2} label={t`Loading the documents`} />;
  else if (docs.error) body = <ErrorState error={docs.error} onRetry={() => void docs.refetch()} />;
  else
    body = (
      <List aria-label={t`Documents of ${name}`}>
        {items.map((d) => (
          <li key={d.id}>
            <DocumentRow
              doc={d}
              today={today}
              canEdit={canEdit}
              original={location.role !== 'viewer'}
              onRenew={() => setRenewing(d)}
            />
          </li>
        ))}
        {hasCard ? null : (
          <li>
            <Row
              className="flex-wrap"
              leading={
                <IconTile>
                  <DocumentIcon />
                </IconTile>
              }
              title={kinds.registration}
              subtitle={<Trans>Read in LABEL mode: VIN, plate and licence expiry</Trans>}
              trailing={
                readLabel && canEdit ? (
                  <Button variant="secondary" size="small" onPress={readLabel}>
                    <Trans>Read the card</Trans>
                  </Button>
                ) : null
              }
            />
          </li>
        )}
      </List>
    );

  return (
    <section aria-label={t`Documents`} className="grid min-w-0 content-start gap-3">
      {canEdit ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="small"
            isDisabled={!online}
            onPress={() => setAdding(true)}
          >
            <ClockIcon className="size-4" />
            <Trans>Add a document</Trans>
          </Button>
          {online ? null : (
            <span className="text-small text-ink-2">
              <Trans>Needs a connection</Trans>
            </span>
          )}
        </div>
      ) : null}
      {body}
      {docs.hasNextPage ? (
        <Button
          variant="secondary"
          size="small"
          className="justify-self-start"
          isPending={docs.isFetchingNextPage}
          onPress={() => void docs.fetchNextPage()}
        >
          <Trans>Load more</Trans>
        </Button>
      ) : null}
      <AddDocumentSheet
        isOpen={adding}
        onClose={() => {
          setAdding(false);
          refetch();
        }}
        subject={{ thingId: thing.id }}
        subjectName={name}
        costs={costs}
        defaultKind={hasCard ? 'insurance' : 'registration'}
      />
      <RenewSheet
        target={renewing}
        onClose={() => {
          setRenewing(null);
          refetch();
        }}
        costs={costs}
      />
    </section>
  );
}

function DocumentRow({
  doc: d,
  today,
  canEdit,
  original,
  onRenew,
}: {
  doc: ExpiringDocumentV5;
  today: string;
  canEdit: boolean;
  original: boolean;
  onRenew: () => void;
}) {
  const { t } = useLingui();
  const f = useFormat();
  const money = useMoney();
  const kinds = useDocumentKindLabels();
  const nameOf = useDocumentName();
  const confirm = useConfirm();
  const offerUndo = useOfferUndo();
  const errorText = useErrorText();
  const invalidate = useInvalidateDocuments();
  const qc = useQueryClient();
  const online = useOnline();
  const name = nameOf(d);
  const day = f.day(noonOf(d.expiresOn));
  const issued = d.issuedOn ? f.day(noonOf(d.issuedOn)) : null;
  const lead = d.leadDays;

  const remove = async () => {
    const ok = await confirm({
      title: t`Remove ${name}?`,
      body: t`Its reminders stop. You can undo this for 7 days.`,
      confirmLabel: t`Remove`,
      destructive: true,
    });
    if (!ok) return;
    try {
      const { auditEvents } = await householdApi.deleteDocument(d.id, d.rowVersion);
      await Promise.all([
        invalidate(),
        qc.invalidateQueries({ queryKey: vehicleKeys.documents(d.subject.id) }),
      ]);
      offerUndo({ title: t`Removed ${name}` }, auditEvents);
    } catch (e) {
      toast({ title: t`Couldn't remove it`, description: errorText(e), tone: 'danger' });
    }
  };

  return (
    <Row
      className="flex-wrap"
      leading={
        <IconTile>
          <ClockIcon />
        </IconTile>
      }
      title={<bdi>{name}</bdi>}
      subtitle={
        <>
          {d.title ? (
            <>
              {kinds[d.kind]}
              {sep()}
            </>
          ) : null}
          {d.state === 'expired' ? <Trans>Ran out {day}</Trans> : <Trans>Runs out {day}</Trans>}
          {issued ? (
            <>
              {sep()}
              <Trans>Issued {issued}</Trans>
            </>
          ) : null}
          {sep()}
          <Plural value={lead} one="Reminds # day before" other="Reminds # days before" />
        </>
      }
      trailing={
        canEdit ? (
          <OverflowActions
            title={name}
            isDisabled={!online}
            actions={[
              { id: 'renew', label: t`Renew`, onAction: onRenew },
              { id: 'remove', label: t`Remove`, danger: true, onAction: () => void remove() },
            ]}
          />
        ) : null
      }
    >
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <TermPill doc={d} today={today} />
        {d.moneyHidden ? (
          <span className="text-small">
            <Trans>Cost:</Trans> <MoneyHiddenText />
          </span>
        ) : d.cost && d.currency ? (
          <bdi className="text-small font-semibold tabular-nums">{money(d.cost, d.currency)}</bdi>
        ) : null}
        {d.history.length ? (
          <span className="text-small text-ink-2">
            <Plural value={d.history.length} one="# earlier term" other="# earlier terms" />
          </span>
        ) : null}
        {d.documents.map((a, i) => (
          <FileOpenButton
            key={a.id}
            attachment={a}
            original={original}
            variant="ghost"
            what={t`${name}, file ${f.num(i + 1)}`}
          >
            {d.documents.length > 1 ? <Trans>File {f.num(i + 1)}</Trans> : undefined}
          </FileOpenButton>
        ))}
      </div>
    </Row>
  );
}
