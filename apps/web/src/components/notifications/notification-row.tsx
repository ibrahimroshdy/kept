/**
 * One notification in the centre (plan T24; D29, D39, D57, step-4 Q32; frame "7 · Notification
 * centre · phone · light"): what it's about, where (the thing or place and its path, which starts
 * with the location), the local date it's due or runs out, and its next step inline:
 *
 * - a schedule: **Complete** (T21's sheet, a reading or cost may be wanted) and **Snooze** (to a
 *   date or a reading, T21's sheet);
 * - a loan: **Mark returned**, one tap with Undo, and for a loan out **Copy a reminder** (D57: in
 *   the reader's language, to the clipboard; Kept never sends it);
 * - a document: **Renew** (T23's sheet);
 * - anything else: **Open** the thing, place or location.
 *
 * Every action goes through the source's own route (Q32) and marks the notification read. A
 * reminder whose source moved on reads Done, Replaced or No longer due, without actions. Actions
 * follow screens §3: the server leaves out the ones the role can't take, and offline they're
 * disabled. Notices (a member joined or left, an AI cap, the AI summary, a download ready) link
 * to where they're dealt with.
 */
import type { ActiveSourceType, DocumentKind, OccurrenceKind } from '@kept/shared';
import { DOCUMENT_KINDS } from '@kept/shared';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { Link, type LinkProps } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { householdApi, useThingLoans } from '@/api/household/queries';
import type { Notification } from '@/api/household/types';
import { useLocations } from '@/api/queries';
import { STATE_TONE, useAgendaStateLabels } from '@/components/agenda/agenda-row';
import { noonOf, useDocumentKindLabels } from '@/components/documents/labels';
import { useOfferUndo } from '@/components/history/undo';
import {
  ActivityIcon,
  AlertIcon,
  AssistantIcon,
  BoxIcon,
  CheckIcon,
  ClockIcon,
  DocumentIcon,
  HandoffIcon,
  PeopleIcon,
  PrinterIcon,
  ScheduleIcon,
  ShieldCheckIcon,
} from '@/components/icons';
import { usePoliteReminder } from '@/components/lending/polite-reminder';
import { IconTile, Pill, type PillTone, useErrorText } from '@/components/page';
import { SubjectLink } from '@/components/paperwork/rows';
import {
  daysBetween,
  useInvalidateHousehold,
  useLocationAccess,
} from '@/components/schedules/access';
import { Button, buttonClass } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { isolate } from '@/lib/bidi';
import { sep, useFormat } from '@/lib/format';
import { useLocationName, useRoleLabels } from '@/lib/labels';
import { useOnline } from '@/lib/online';
import { cn } from '@/lib/utils';
import { SourceGone, useReminderSources } from './sources';

type Reminder = NonNullable<Notification['reminder']>;

/** A link that looks like a small secondary button (LinkButton, with a click handler). */
const small = buttonClass('secondary', 'small');

const SOURCE_ICON: Record<ActiveSourceType, ReactNode> = {
  warranty: <ShieldCheckIcon />,
  registration: <ShieldCheckIcon />,
  document: <DocumentIcon />,
  thing_expiry: <ClockIcon />,
  schedule: <ScheduleIcon />,
  loan: <HandoffIcon />,
  reading_stale: <ActivityIcon />,
  stock: <BoxIcon />,
};

/** An occurrence's kind as the agenda's state, for its pill (overdue, due, runs out soon). */
const KIND_STATE: Record<OccurrenceKind, 'overdue' | 'due' | 'expiring'> = {
  overdue: 'overdue',
  due: 'due',
  expiring: 'expiring',
};

export type RowActions = {
  onComplete: (n: Notification) => void;
  onSnooze: (n: Notification) => void;
  onRenew: (n: Notification, name: string) => void;
  /** Marks it read (an action taken, a link followed). */
  onRead: (n: Notification) => void;
};

/** The reminder's name in the reader's words: a document's kind or a warranty's is translated. */
function useReminderTitle() {
  const { t } = useLingui();
  const docs = useDocumentKindLabels();
  // The subject's name is isolated: in one bdi with the translated title, a Latin name ending
  // in a neutral (Samsung TV, 55″) takes the line's RTL direction and the ″ jumps sides.
  return (r: Reminder): string => {
    const on = isolate(r.subject.name);
    switch (r.sourceType) {
      case 'warranty':
        return t`Warranty · ${on}`;
      case 'registration':
        return t`Warranty registration · ${on}`;
      case 'loan':
      case 'thing_expiry':
      case 'stock':
        return on;
      case 'document': {
        const title = (DOCUMENT_KINDS as readonly string[]).includes(r.title)
          ? docs[r.title as DocumentKind]
          : r.title;
        return r.subject.type === 'location' || title === on ? title : `${title}${sep()}${on}`;
      }
      case 'schedule':
        return r.title === on ? r.title : `${r.title}${sep()}${on}`;
      // A stale reading (step 5): its meter's label, or none.
      case 'reading_stale':
        return r.title ? `${r.title}${sep()}${on}` : t`Reading needed · ${on}`;
    }
  };
}

/** "Due Wed 21 Oct", "Was due back 17 Oct", "Runs out 20 Oct", "Due at ٦٠٬٠٠٠"… */
function When({ r, today }: { r: Reminder; today: string }) {
  const f = useFormat();
  if (!r.dueOn) {
    if (r.dueValue === null) return null;
    const n = Number(r.dueValue);
    const value = Number.isFinite(n) ? f.num(n) : r.dueValue;
    return <Trans>Due at {value}</Trans>;
  }
  const day = f.day(noonOf(r.dueOn));
  const late = r.kind === 'overdue';
  switch (r.sourceType) {
    case 'warranty':
      return <Trans>Warranty ends {day}</Trans>;
    case 'registration':
      return <Trans>Register the warranty by {day}</Trans>;
    case 'document':
      return late ? <Trans>Ran out {day}</Trans> : <Trans>Runs out {day}</Trans>;
    case 'thing_expiry':
      return late ? <Trans>Expired {day}</Trans> : <Trans>Expires {day}</Trans>;
    case 'loan':
      return <Trans>Was due back {day}</Trans>;
    case 'schedule': {
      // Overdue by the meter while its day is still ahead (T29): the reading passed it.
      if (late && r.dueValue !== null && r.dueOn >= today) {
        const n = Number(r.dueValue);
        const at = Number.isFinite(n) ? f.num(n) : r.dueValue;
        return <Trans>Past {at}</Trans>;
      }
      return late ? <Trans>Was due {day}</Trans> : <Trans>Due {day}</Trans>;
    }
    case 'reading_stale':
      return <Trans>Reading due {day}</Trans>;
    case 'stock':
      return <Trans>Low since {day}</Trans>;
  }
}

/** The subject, and the path under it when it adds anything ("Kitchen · Home › Kitchen"). */
function Where({ r, onFollow }: { r: Reminder; onFollow: () => void }) {
  const path = r.subject.path && r.subject.path !== r.subject.name ? r.subject.path : null;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: it only notes that the link was followed.
    // biome-ignore lint/a11y/useKeyWithClickEvents: the link inside is the keyboard's target.
    <span onClick={onFollow}>
      <SubjectLink subject={r.subject} />
      {path ? (
        <span className="text-ink-3">
          {sep()}
          <bdi>{path}</bdi>
        </span>
      ) : null}
    </span>
  );
}

function StatePill({ r, today }: { r: Reminder; today: string }) {
  const states = useAgendaStateLabels();
  if (r.state === 'done')
    return (
      <Pill tone="ok" icon={<CheckIcon />}>
        <Trans>Done</Trans>
      </Pill>
    );
  if (r.state === 'superseded')
    return (
      <Pill>
        <Trans>Replaced</Trans>
      </Pill>
    );
  if (r.state === 'cancelled')
    return (
      <Pill>
        <Trans>No longer due</Trans>
      </Pill>
    );
  if (r.sourceType === 'loan' && r.dueOn) {
    const late = daysBetween(r.dueOn, today);
    if (late > 0)
      return (
        <Pill tone="danger" icon={<AlertIcon />}>
          <Plural value={late} one="# day overdue" other="# days overdue" />
        </Pill>
      );
  }
  const state = KIND_STATE[r.kind];
  return <Pill tone={STATE_TONE[state] as PillTone}>{states[state]}</Pill>;
}

/** The row's frame: icon (with the unread dot), heading, lines, then the actions. */
function Frame({
  n,
  icon,
  heading,
  children,
  actions,
}: {
  n: Notification;
  icon: ReactNode;
  heading: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const f = useFormat();
  const unread = !n.readAt;
  return (
    <article
      aria-label={heading}
      data-notification={n.id}
      data-unread={unread ? '' : undefined}
      className="grid gap-2 px-3.5 py-3 md:flex md:items-center md:gap-3"
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className="relative shrink-0">
          <IconTile>{icon}</IconTile>
          {unread ? (
            <span
              aria-hidden="true"
              className="absolute -top-0.5 -end-0.5 size-2.5 rounded-full bg-amber ring-2 ring-surface"
            />
          ) : null}
        </span>
        <div className="grid min-w-0 flex-1 gap-1">
          <div
            className={cn(
              'text-[15px] leading-snug text-ink [overflow-wrap:anywhere]',
              unread ? 'font-semibold' : 'font-medium',
            )}
          >
            {unread ? (
              <span className="sr-only">
                <Trans>Unread:</Trans>{' '}
              </span>
            ) : null}
            <bdi>{heading}</bdi>
          </div>
          {children}
          <div className="text-[12.5px] text-ink-3">{f.relative(n.createdAt)}</div>
        </div>
      </div>
      {actions ? <div className="flex flex-wrap gap-2 ps-13 md:ps-0">{actions}</div> : null}
    </article>
  );
}

function ReminderRow({ n, r, actions }: { n: Notification; r: Reminder; actions: RowActions }) {
  const { t } = useLingui();
  const titleOf = useReminderTitle();
  const access = useLocationAccess()(n.locationId ?? '');
  const online = useOnline();
  const heading = titleOf(r);
  const open = r.state === 'open';
  const has = (a: Reminder['actions'][number]) => open && r.actions.includes(a);
  const read = () => {
    if (!n.readAt) actions.onRead(n);
  };
  const primary = has('complete') || has('mark_returned') || has('renew');
  return (
    <Frame
      n={n}
      icon={SOURCE_ICON[r.sourceType]}
      heading={heading}
      actions={
        open ? (
          <>
            {has('complete') ? (
              <Button
                size="small"
                variant="secondary"
                isDisabled={!online}
                aria-label={t`Complete ${heading}`}
                onPress={() => {
                  read();
                  actions.onComplete(n);
                }}
              >
                <CheckIcon />
                <Trans context="schedule action">Complete</Trans>
              </Button>
            ) : null}
            {has('snooze') && r.sourceType === 'schedule' ? (
              <Button
                size="small"
                variant="secondary"
                isDisabled={!online}
                aria-label={t`Snooze ${heading}`}
                onPress={() => {
                  read();
                  actions.onSnooze(n);
                }}
              >
                <ClockIcon />
                <Trans>Snooze</Trans>
              </Button>
            ) : null}
            {has('mark_returned') && r.subject.type === 'thing' ? (
              <LoanActions n={n} r={r} heading={heading} onRead={read} />
            ) : null}
            {has('renew') ? (
              <Button
                size="small"
                variant="secondary"
                isDisabled={!online}
                aria-label={t`Renew ${heading}`}
                onPress={() => {
                  read();
                  actions.onRenew(n, heading);
                }}
              >
                <Trans>Renew</Trans>
              </Button>
            ) : null}
            {!primary && has('open') ? <OpenSubject r={r} heading={heading} onRead={read} /> : null}
          </>
        ) : null
      }
    >
      <div className="text-small text-ink-2 [overflow-wrap:anywhere]">
        <Where r={r} onFollow={read} />
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-ink-2">
        <StatePill r={r} today={access.today} />
        <span>
          <When r={r} today={access.today} />
        </span>
      </div>
    </Frame>
  );
}

function OpenSubject({ r, heading, onRead }: { r: Reminder; heading: string; onRead: () => void }) {
  const { t } = useLingui();
  const to: LinkProps =
    r.subject.type === 'thing'
      ? { to: '/t/$id', params: { id: r.subject.id } }
      : r.subject.type === 'place'
        ? { to: '/p/$id', params: { id: r.subject.id } }
        : { to: '/loc/$id', params: { id: r.subject.id } };
  return (
    <Link {...to} className={small} aria-label={t`Open ${heading}`} onClick={onRead}>
      <Trans>Open</Trans>
    </Link>
  );
}

/** Mark returned and, for a loan out, Copy a reminder: they read the loan from its thing. */
function LoanActions({
  n,
  r,
  heading,
  onRead,
}: {
  n: Notification;
  r: Reminder;
  heading: string;
  onRead: () => void;
}) {
  const { t } = useLingui();
  const loans = useThingLoans(r.subject.id);
  const sources = useReminderSources();
  const offerUndo = useOfferUndo();
  const invalidate = useInvalidateHousehold();
  const errorText = useErrorText();
  const reminder = usePoliteReminder();
  const online = useOnline();
  const loan = loans.data?.items.find((l) => l.id === r.sourceId);
  const name = r.subject.name;

  const failed = (title: string, e: unknown) =>
    toast({
      title,
      description: e instanceof SourceGone ? t`It's no longer there.` : errorText(e),
      tone: 'danger',
    });

  const markReturned = async () => {
    onRead();
    try {
      const current = await sources.loan(r);
      const { auditEvents } = await householdApi.returnLoan(current.id, {}, current.rowVersion);
      const person = current.person.name;
      offerUndo(
        {
          title:
            current.direction === 'out'
              ? t`${isolate(name)} is back`
              : t`${isolate(name)} went back to ${isolate(person)}`,
        },
        auditEvents,
        { thingId: current.thingId },
      );
      await invalidate();
    } catch (e) {
      failed(t`Couldn't mark it returned`, e);
    }
  };

  const copyReminder = async () => {
    onRead();
    if (!loan) return;
    const text = reminder({ ...loan, thing: { name } });
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

  return (
    <>
      <Button
        size="small"
        variant="secondary"
        isDisabled={!online}
        aria-label={t`Mark ${isolate(name)} returned`}
        onPress={() => void markReturned()}
      >
        <HandoffIcon />
        <Trans>Mark returned</Trans>
      </Button>
      {loan?.direction === 'out' ? (
        <Button
          size="small"
          variant="secondary"
          aria-label={t`Copy a reminder for ${heading}`}
          data-notification-action={n.id}
          onPress={() => void copyReminder()}
        >
          <Trans>Copy a reminder</Trans>
        </Button>
      ) : null}
    </>
  );
}

function NoticeRow({ n, actions }: { n: Notification; actions: RowActions }) {
  const { t } = useLingui();
  const roles = useRoleLabels().one;
  const locations = useLocations();
  const nameOf = useLocationName();
  const location = (locations.data ?? []).find((l) => l.id === n.locationId);
  const here = location ? nameOf(location) : null;
  const read = () => {
    if (!n.readAt) actions.onRead(n);
  };
  const members =
    n.locationId && location && (location.role === 'owner' || location.role === 'admin') ? (
      <Link
        className={small}
        to="/settings/location/$id/members"
        params={{ id: n.locationId }}
        onClick={read}
      >
        <Trans>Members</Trans>
      </Link>
    ) : null;

  if (n.kind === 'membership_added' || n.kind === 'membership_ended') {
    const m = n.membership;
    const who = m?.userName ?? '';
    const where = m?.locationName ?? here ?? '';
    const heading =
      n.kind === 'membership_added'
        ? t`${who} joined ${where}`
        : t`${who} no longer has access to ${where}`;
    const role = m ? roles[m.role] : null;
    return (
      <Frame n={n} icon={<PeopleIcon />} heading={heading} actions={members}>
        {role ? (
          <div className="text-small text-ink-2">
            {n.kind === 'membership_added' ? (
              <Trans>Role: {role}</Trans>
            ) : (
              <Trans>Was: {role}</Trans>
            )}
          </div>
        ) : null}
      </Frame>
    );
  }

  if (n.kind === 'ai_cap' || n.kind === 'ai_summary') {
    const cap = n.aiCap;
    const heading =
      n.kind === 'ai_summary'
        ? t`Your monthly AI summary`
        : cap?.level === 100
          ? t`AI reached this month's cap`
          : t`AI used 80% of this month's cap`;
    const scope = cap?.scope ?? 'me';
    const usage =
      scope === 'instance' ? (
        <Link className={small} to="/admin/ai/usage" onClick={read}>
          <Trans>AI usage</Trans>
        </Link>
      ) : (
        <Link
          className={small}
          to="/settings/ai/usage"
          search={
            scope === 'location' && n.locationId
              ? { scope: 'location', location: n.locationId }
              : { scope }
          }
          onClick={read}
        >
          <Trans>AI usage</Trans>
        </Link>
      );
    const whose =
      n.kind === 'ai_summary'
        ? t`Last month's AI use, sent to your email.`
        : scope === 'location'
          ? (here ?? '')
          : scope === 'me'
            ? t`Your personal AI`
            : scope === 'account'
              ? t`Your account`
              : t`This server`;
    return (
      <Frame n={n} icon={<AssistantIcon />} heading={heading} actions={usage}>
        {whose ? (
          <div className="text-small text-ink-2 [overflow-wrap:anywhere]">
            <bdi>{whose}</bdi>
          </div>
        ) : null}
      </Frame>
    );
  }

  // export_ready
  const kind = n.exportReady?.kind ?? 'claim_pack';
  const where = here ? (
    <div className="text-small text-ink-2 [overflow-wrap:anywhere]">
      <bdi>{here}</bdi>
    </div>
  ) : null;
  if (kind === 'location' || kind === 'me') {
    // A Kept export (step 7): its download is on Settings → Export, with the run's other details.
    return (
      <Frame
        n={n}
        icon={<PrinterIcon />}
        heading={kind === 'me' ? t`Your data export is ready` : t`Your export is ready`}
        actions={
          <Link className={small} to="/settings/export" onClick={read}>
            <Trans>Open</Trans>
          </Link>
        }
      >
        {kind === 'location' ? where : null}
      </Frame>
    );
  }
  const heading =
    kind === 'claim_pack' ? t`Your claim pack is ready` : t`Your insurance report is ready`;
  return (
    <Frame
      n={n}
      icon={<PrinterIcon />}
      heading={heading}
      actions={
        <Link
          className={small}
          to="/reports/$kind"
          params={{ kind: kind === 'claim_pack' ? 'claim-pack' : 'insurance' }}
          // The screen resumes the run it names (T26's `?run=`).
          search={n.exportReady ? { run: n.exportReady.runId } : {}}
          onClick={read}
        >
          <Trans>Open</Trans>
        </Link>
      }
    >
      {where}
    </Frame>
  );
}

export function NotificationRow({ n, actions }: { n: Notification; actions: RowActions }) {
  if (n.kind === 'reminder' && n.reminder)
    return <ReminderRow n={n} r={n.reminder} actions={actions} />;
  return <NoticeRow n={n} actions={actions} />;
}
