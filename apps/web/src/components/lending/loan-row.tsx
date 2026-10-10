/**
 * One loan in a list (plan T22; D56, D57, screens §5): the thing, who has it or whom it's from,
 * since when, when it's due back, and an overdue badge; then Mark returned and, for a loan out,
 * "Copy a polite reminder" (D57: the text in the reader's language, copied to the clipboard;
 * **Kept never sends it**, nor messages anyone outside the household).
 *
 * Mark returned is one tap with Undo (step-4 Q32): a loan out goes back where it left from and a
 * split-off part merges back into its row (Q14); a borrowed thing goes back to its owner and
 * leaves the counts (Q15). Choosing another place, or keeping a part separate, is the thing
 * page's return sheet. Actions follow screens §3: hidden without `things.edit`, disabled offline;
 * on a phone the reminder folds into More, so the row keeps one line of controls.
 */
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';
import { householdApi } from '@/api/household/queries';
import type { LoanRow } from '@/api/household/types';
import { useOfferUndo } from '@/components/history/undo';
import { AlertIcon } from '@/components/icons';
import { OverflowActions } from '@/components/inbox/overflow-actions';
import { Pill, useErrorText } from '@/components/page';
import { Tile } from '@/components/places/rows';
import {
  daysBetween,
  useInvalidateHousehold,
  useLocationAccess,
} from '@/components/schedules/access';
import { TypeIcon } from '@/components/type-icon';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { addressOf } from '@/lib/address';
import { isolate } from '@/lib/bidi';
import { useFormat } from '@/lib/format';
import { useOnline } from '@/lib/online';
import { usePoliteReminder } from './polite-reminder';

export function LoanRowView({
  loan,
  hidePerson = false,
}: {
  loan: LoanRow;
  /** On the person's own page, their name is the page. */
  hidePerson?: boolean;
}) {
  const { t } = useLingui();
  const f = useFormat();
  const access = useLocationAccess()(loan.thing.locationId);
  const offerUndo = useOfferUndo();
  const invalidate = useInvalidateHousehold();
  const errorText = useErrorText();
  const reminder = usePoliteReminder();
  const online = useOnline();
  const name = loan.thing.name ?? t`Untitled draft`;
  const person = loan.person.name;
  const open = !loan.returnedAt;
  const canAct = open && access.moduleOn('lending') && access.can('things.edit');
  const since = f.day(loan.startedAt);
  const due = loan.dueOn ? f.day(loan.dueOn) : null;
  const back = f.day(loan.returnedAt ?? loan.startedAt);
  const late = loan.overdue && loan.dueOn ? daysBetween(loan.dueOn, access.today) : 0;

  const markReturned = async () => {
    try {
      const { auditEvents } = await householdApi.returnLoan(loan.id, {}, loan.rowVersion);
      offerUndo(
        {
          title:
            loan.direction === 'out'
              ? t`${isolate(name)} is back`
              : t`${isolate(name)} went back to ${isolate(loan.person.name)}`,
        },
        auditEvents,
        { thingId: loan.thingId },
      );
      await invalidate();
    } catch (e) {
      toast({ title: t`Couldn't mark it returned`, description: errorText(e), tone: 'danger' });
    }
  };

  const copyReminder = async () => {
    const text = reminder(loan);
    try {
      await navigator.clipboard.writeText(text);
      toast({
        title: t`Reminder copied`,
        description: t`Send it however you like. Kept never sends it.`,
        tone: 'ok',
      });
    } catch {
      toast({
        title: t`Couldn't copy it. Here it is to copy by hand:`,
        description: text,
        tone: 'danger',
      });
    }
  };

  const personLink = (
    <Link
      to="/people/$id"
      params={{ id: loan.person.id }}
      className="text-ink underline-offset-2 hover:underline"
    >
      <bdi>{person}</bdi>
    </Link>
  );

  return (
    <article
      aria-label={name}
      data-loan={loan.id}
      className="grid gap-2 px-3.5 py-3 md:flex md:items-center md:gap-3"
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <Tile>
          {loan.thing.thumbUrl ? (
            <img src={loan.thing.thumbUrl} alt="" className="size-full object-cover" />
          ) : (
            <TypeIcon icon={loan.thing.type?.icon} />
          )}
        </Tile>
        <div className="grid min-w-0 flex-1 gap-1">
          <Link
            to="/t/$id"
            params={{ id: addressOf(loan.thing) }}
            className="font-semibold text-[15px] leading-snug text-ink underline-offset-2 [overflow-wrap:anywhere] hover:underline"
          >
            <bdi>{name}</bdi>
            {Number(loan.quantity) > 1 ? (
              <span className="ms-1.5 font-normal text-ink-2 text-small">
                <span aria-hidden="true">× </span>
                <span className="sr-only">
                  <Trans>quantity</Trans>{' '}
                </span>
                {f.num(Number(loan.quantity))}
              </span>
            ) : null}
          </Link>
          {hidePerson ? null : (
            <div className="text-small text-ink-2 [overflow-wrap:anywhere]">
              {loan.direction === 'out' ? (
                <Trans>Lent to {personLink}</Trans>
              ) : (
                <Trans>Borrowed from {personLink}</Trans>
              )}
            </div>
          )}
          <div className="text-small text-ink-2 [overflow-wrap:anywhere]">
            {open ? (
              due ? (
                <Trans>
                  Since {since} · due {due}
                </Trans>
              ) : (
                <Trans>Since {since} · no due date</Trans>
              )
            ) : (
              <Trans>
                {since} to {back} · returned
              </Trans>
            )}
          </div>
          {late > 0 ? (
            <span data-overdue="" className="contents">
              <Pill tone="danger" icon={<AlertIcon />}>
                <Plural value={late} one="# day overdue" other="# days overdue" />
              </Pill>
            </span>
          ) : null}
        </div>
      </div>
      {canAct ? (
        <div className="flex flex-wrap gap-2 ps-13 md:ps-0">
          <Button
            size="small"
            variant="secondary"
            isDisabled={!online}
            onPress={() => void markReturned()}
            aria-label={t`Mark ${isolate(name)} returned`}
          >
            <Trans>Mark returned</Trans>
          </Button>
          {loan.direction === 'out' ? (
            <OverflowActions
              title={name}
              actions={[
                {
                  id: 'remind',
                  label: t`Copy a polite reminder`,
                  onAction: () => void copyReminder(),
                },
              ]}
            />
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
