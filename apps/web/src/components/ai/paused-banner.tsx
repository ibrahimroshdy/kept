/**
 * The paused banner (D206, screens §5 "AI paused and waiting"): "AI paused until 1 Oct · Home's
 * monthly cap reached", wherever AI would act. Captures still save and their naming waits.
 * Whoever may resume gets a way there; everyone else is told whom to ask. Waiting for the
 * provider (its rate limit) is not a pause and never shows a banner: progress lines say it.
 *
 * Used on the inbox (T27), Capture (T25: under the place chip, with the note "Photos still save;
 * naming waits"), AI settings and usage. "Resume now" opens ResumeSheet for whoever set the cap
 * (`canResume`); a manager who can't resume gets a link to AI settings; others read "Ask
 * <manager> to resume" (`status.manager`).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import type { AiStatus } from '@/api/capture/types';
import { Notice } from '@/components/page';
import { Button } from '@/components/ui/button';
import { sep, useFormat } from '@/lib/format';
import { formatLocale, usePrefs } from '@/lib/prefs';
import { ResumeSheet } from './resume-sheet';

/** "14:05" in the reader's digits. */
export function useClock(): (iso: string) => string {
  const { locale, digits } = usePrefs();
  const clock = new Intl.DateTimeFormat(formatLocale(locale, digits), {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return (iso) => clock.format(new Date(iso));
}

/** Why AI is paused, in words: "Home's monthly cap reached". */
export function usePauseReason(): (status: AiStatus) => string {
  const { t } = useLingui();
  return (s) => {
    // The instance's own caps carry no label (T9): they are this server's.
    const who =
      s.pausedBy?.label ||
      (s.pausedBy?.scope === 'instance' || s.pausedBy?.scope === 'instance_account'
        ? t`This server`
        : '');
    switch (s.reason) {
      case 'cap_money':
        return who ? t`${who}'s monthly cap reached` : t`The monthly cap is reached`;
      case 'cap_tokens':
        return who
          ? t`${who}'s monthly token limit reached`
          : t`The monthly token limit is reached`;
      case 'tokens_day':
        return t`Today's AI budget is used up`;
      case 'manual':
        return t`Paused by hand`;
      default:
        return t`AI is paused`;
    }
  };
}

/**
 * "AI paused until 1 Oct" (a day) or "AI paused until 14:00" (today); a pause by hand has no end
 * (`infinity`), so it reads "AI paused".
 */
export function usePausedUntil(): (until: string) => string {
  const { t } = useLingui();
  const fmt = useFormat();
  const clock = useClock();
  return (until) => {
    if (Number.isNaN(new Date(until).getTime())) return t`AI paused`;
    const sameDay = new Date(until).toDateString() === new Date().toDateString();
    const when = sameDay ? clock(until) : fmt.day(until);
    return t`AI paused until ${when}`;
  };
}

export function PausedBanner({
  status,
  note,
}: {
  status: AiStatus;
  /** What still works here ("Photos still save; naming waits"). */
  note?: string;
}) {
  const reason = usePauseReason();
  const until = usePausedUntil();
  const [resuming, setResuming] = useState(false);
  if (!status.pausedUntil) return null;
  const manager = status.manager?.displayName;
  return (
    <>
      <Notice
        tone="warn"
        title={
          <span role="status">
            {until(status.pausedUntil)}
            {sep()}
            {reason(status)}
          </span>
        }
        action={
          status.canResume ? (
            <Button size="small" variant="secondary" onPress={() => setResuming(true)}>
              <Trans>Resume now</Trans>
            </Button>
          ) : status.canManage ? (
            <Link
              to="/settings/ai"
              className="font-semibold text-ink underline underline-offset-2 outline-none focus-visible:outline-2 focus-visible:outline-info"
            >
              <Trans>AI settings</Trans>
            </Link>
          ) : manager ? (
            <span>
              <Trans>
                Ask <bdi>{manager}</bdi> to resume
              </Trans>
            </span>
          ) : null
        }
      >
        {note}
      </Notice>
      {status.canResume ? (
        <ResumeSheet status={status} isOpen={resuming} onOpenChange={setResuming} />
      ) : null}
    </>
  );
}
