/**
 * Loans on the thing page (screens §5, D56, D57; frame "Bosch drill on the Loans tab"): the open
 * loan as a panel (who, since when, when it's due, who recorded it, the note, where it returns
 * to, the condition photos) with **Mark returned** and, in More on a phone (buttons from `md`),
 * Copy a polite reminder, Change the due date and Remove; then the earlier loans. Kept never
 * messages the person: the reminder text is yours to send.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { householdApi, useThingLoans } from '@/api/household/queries';
import type { Loan } from '@/api/household/types';
import { useOfferUndo } from '@/components/history/undo';
import { HandoffIcon } from '@/components/icons';
import { OverflowActions } from '@/components/inbox/overflow-actions';
import {
  EmptyState,
  ErrorState,
  List,
  LoadingRows,
  Pill,
  Row,
  Section,
  useErrorText,
} from '@/components/page';
import { useThingCtx } from '@/components/things/context';
import { todayIn, useBlocked, useHouseholdDone } from '@/components/things/household';
import { Sheet } from '@/components/things/sheet';
import { UploadButton } from '@/components/things/upload';
import { Bidi, KeyValues, KV } from '@/components/things/values';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { DatePicker } from '@/components/ui/date-picker';
import { DialogFooter } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { bdi } from '@/lib/bidi';
import { sep, useFormat } from '@/lib/format';
import { useCopyPoliteReminder, useLoanText } from './loan-text';
import { subjectText } from './return-sheet';

export function ThingLoansSection({
  onLend,
  onReturn,
}: {
  onLend: () => void;
  onReturn: () => void;
}) {
  const { thing, can } = useThingCtx();
  const { t } = useLingui();
  const blocked = useBlocked();
  const q = useThingLoans(thing.id);
  const edit = can('things.edit');
  const items = q.data?.items ?? [];
  const open = items.find((l) => !l.returnedAt) ?? null;
  const earlier = items.filter((l) => l.returnedAt);
  const inRepair = thing.derivedState.includes('in_repair');
  return (
    <Section title={<Trans>Loans</Trans>}>
      {q.isPending ? (
        <LoadingRows rows={2} label={t`Loading the loans`} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <>
          {open ? (
            <LoanPanel loan={open} onReturn={onReturn} />
          ) : (
            <EmptyState
              icon={<HandoffIcon />}
              title={<Trans>Not lent out</Trans>}
              action={
                edit && !inRepair ? (
                  <Button variant="secondary" isDisabled={!!blocked} onPress={onLend}>
                    <Trans>Lend</Trans>
                  </Button>
                ) : undefined
              }
            >
              {inRepair ? (
                <Trans>It's in repair: lend it once it's back.</Trans>
              ) : (
                <Trans>Lend it to a member or a contact, with a due date if you like.</Trans>
              )}
              {blocked && edit ? <> {blocked}</> : null}
            </EmptyState>
          )}
          {earlier.length ? (
            <section className="grid gap-2" aria-labelledby="thing-earlier-loans">
              <h3 id="thing-earlier-loans" className="eyebrow m-0">
                <Trans>Earlier loans</Trans>
              </h3>
              <List>
                {earlier.map((l) => (
                  <li key={l.id}>
                    <EarlierLoan loan={l} />
                  </li>
                ))}
              </List>
            </section>
          ) : null}
        </>
      )}
    </Section>
  );
}

function EarlierLoan({ loan: l }: { loan: Loan }) {
  const fmt = useFormat();
  const from = fmt.day(l.startedAt);
  const back = fmt.day(l.returnedAt ?? l.startedAt);
  const late = !!l.dueOn && !!l.returnedAt && l.returnedAt.slice(0, 10) > l.dueOn;
  return (
    <Row
      title={
        <>
          <bdi>{l.person.name}</bdi>
          {sep()}
          {from} – {back}
        </>
      }
      subtitle={
        <>
          {l.direction === 'out' ? <Trans>Lent out</Trans> : <Trans>Borrowed</Trans>}
          {sep()}
          {late ? <Trans>Returned late</Trans> : <Trans context="loan">Returned</Trans>}
          {l.notes ? (
            <>
              {sep()}
              <Bidi>{l.notes}</Bidi>
            </>
          ) : null}
        </>
      }
    />
  );
}

function LoanPanel({ loan, onReturn }: { loan: Loan; onReturn: () => void }) {
  const { thing, location, can } = useThingCtx();
  const { t } = useLingui();
  const fmt = useFormat();
  const text = useLoanText();
  const remind = useCopyPoliteReminder();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const offerUndo = useOfferUndo();
  const done = useHouseholdDone();
  const blocked = useBlocked();
  const [dueOpen, setDueOpen] = useState(false);
  const edit = can('things.edit');
  const out = loan.direction === 'out';
  const today = todayIn(location.timezone);
  const due = text.dueIn(loan.dueOn, today);
  const line = text.line({ ...loan, personName: loan.person.name });
  const person = loan.person.name;

  const remove = async () => {
    const ok = await confirm({
      title: t`Remove this loan?`,
      body: t`For a loan recorded by mistake: it's as if it never happened. You can undo this for 7 days.`,
      confirmLabel: t`Remove`,
      destructive: true,
    });
    if (!ok) return;
    try {
      const { auditEvents } = await householdApi.deleteLoan(loan.id, loan.rowVersion);
      offerUndo({ title: t`Loan removed` }, auditEvents, { thingId: thing.id });
      await done();
    } catch (e) {
      toast({ title: t`Couldn't remove it`, description: errorText(e), tone: 'danger' });
    }
  };

  const more = edit
    ? [
        ...(out
          ? [
              {
                id: 'remind',
                label: t`Copy a polite reminder`,
                onAction: () => void remind({ ...loan, thing }),
              },
            ]
          : []),
        { id: 'due', label: t`Change the due date`, onAction: () => setDueOpen(true) },
        { id: 'remove', label: t`Remove this loan`, danger: true, onAction: () => void remove() },
      ]
    : [];

  return (
    <article className="grid gap-3 rounded-[10px] border border-line bg-surface p-3.5 md:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="eyebrow">{out ? <Trans>On loan</Trans> : <Trans>Borrowed</Trans>}</span>
        {due ? <Pill tone={loan.overdue ? 'danger' : 'info'}>{due}</Pill> : null}
      </div>
      <div className="font-semibold text-[18px] text-ink [overflow-wrap:anywhere]">{line}</div>
      <KeyValues label={t`Loan`}>
        <KV label={out ? t`Lent to` : t`Lent by`}>
          <bdi>{loan.person.name}</bdi>
          {sep()}
          {loan.person.isMember ? <Trans>uses Kept</Trans> : <Trans>contact, no account</Trans>}
        </KV>
        <KV label={t`Recorded by`}>
          <bdi>{loan.createdBy.displayName}</bdi>, {fmt.longDay(loan.startedAt)}
        </KV>
        {loan.quantity !== '1' ? (
          <KV label={t`How many`}>{fmt.num(Number(loan.quantity))}</KV>
        ) : null}
        {loan.notes ? (
          <KV label={t`Note`}>
            <Bidi>{loan.notes}</Bidi>
          </KV>
        ) : null}
        {out && loan.previousPlace ? (
          <KV label={t`Returns to`}>
            <Trans>
              <bdi dir="auto">{subjectText(loan.previousPlace)}</bdi>, where it was
            </Trans>
          </KV>
        ) : null}
      </KeyValues>
      {out ? (
        <div className="grid gap-1.5">
          <span className="eyebrow">
            <Trans>Condition at lending</Trans>
          </span>
          {loan.conditionOut.length ? (
            <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
              {loan.conditionOut.map((a) =>
                a.file?.thumbUrl ? (
                  <li key={a.id}>
                    <img
                      src={a.file.thumbUrl}
                      alt={t`Condition at lending`}
                      className="size-16 rounded-lg object-cover"
                    />
                  </li>
                ) : null,
              )}
            </ul>
          ) : (
            <span className="text-small text-ink-3">
              <Trans>No photos.</Trans>
            </span>
          )}
          {edit && can('attachments.add') && !blocked ? (
            <UploadButton
              locationId={thing.locationId}
              subject={{ loanId: loan.id }}
              attachAs="condition_out"
              label={t`Add a photo`}
              accept={['image/*']}
              onUploaded={() => void done()}
            />
          ) : null}
        </div>
      ) : null}
      {edit ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button isDisabled={!!blocked} onPress={onReturn}>
            <Trans>Mark returned</Trans>
          </Button>
          <OverflowActions actions={more} title={thing.name ?? ''} isDisabled={!!blocked} />
        </div>
      ) : null}
      {blocked && edit ? <p className="m-0 text-small text-ink-3">{blocked}</p> : null}
      {out ? (
        <p className="m-0 text-small text-ink-3">
          {loan.dueOn ? (
            <Trans>
              Kept reminds you on {fmt.day(loan.dueOn)}. It never messages {bdi(person)}; the
              reminder text is yours to send.
            </Trans>
          ) : (
            <Trans>Kept never messages {bdi(person)}; the reminder text is yours to send.</Trans>
          )}
        </p>
      ) : null}
      {edit ? <DueSheet loan={loan} isOpen={dueOpen} onClose={() => setDueOpen(false)} /> : null}
    </article>
  );
}

function DueSheet({ loan, isOpen, onClose }: { loan: Loan; isOpen: boolean; onClose: () => void }) {
  const { thing } = useThingCtx();
  const { t } = useLingui();
  const errorText = useErrorText();
  const offerUndo = useOfferUndo();
  const done = useHouseholdDone();
  const [dueOn, setDueOn] = useState<string | null>(loan.dueOn);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const { auditEvents } = await householdApi.updateLoan(
        loan.id,
        { dueOn: dueOn ?? null },
        loan.rowVersion,
      );
      offerUndo({ title: t`Due date changed` }, auditEvents, { thingId: thing.id });
      await done();
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      isOpen={isOpen}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={t`Due back`}
    >
      <form
        noValidate
        className="grid gap-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <DatePicker
          label={t`Due back`}
          description={t`Clear it for no due date.`}
          value={dueOn}
          onChange={setDueOn}
          minValue={loan.startedAt.slice(0, 10)}
          {...(error ? { errorMessage: error } : {})}
        />
        <DialogFooter>
          <Button variant="secondary" onPress={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" isPending={busy}>
            <Trans>Save</Trans>
          </Button>
        </DialogFooter>
      </form>
    </Sheet>
  );
}
