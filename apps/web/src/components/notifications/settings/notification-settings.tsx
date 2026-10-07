/**
 * Me → Notifications (plan T25; D29, D30, D139, D142, D206; screens §5 Settings; frame "Settings ·
 * Me · phone · light", the notifications part): the channels (email, push on this device and the
 * others, webhooks), what each location tells you and how, the digest time and quiet hours (in
 * your time zone), the calendar feed, and the AI monthly summary. Loaded on demand into
 * assets/household/ (components/notifications/lazy.tsx): it reads the server.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { householdApi, householdKeys, useNotificationSettings } from '@/api/household/queries';
import type { NotificationSettings as Settings } from '@/api/household/types';
import { ErrorState, LoadingRows, Section, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { TimeField } from '@/components/ui/time-field';
import { toast } from '@/components/ui/toast';
import { useOnline } from '@/lib/online';
import { CalendarFeeds } from './calendar';
import { Channels } from './channels';
import { KindsByLocation } from './kinds';

export function NotificationSettings() {
  const settings = useNotificationSettings();
  if (settings.isPending) return <LoadingRows rows={4} />;
  if (settings.error)
    return <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />;
  const s = settings.data;
  return (
    <>
      <Section title={<Trans>How Kept reaches you</Trans>}>
        <p className="m-0 text-small text-ink-2 [text-wrap:pretty]">
          <Trans>
            Everything lands in the notification centre. These reach you outside Kept as well.
          </Trans>
        </p>
        <Channels settings={s} />
      </Section>
      <Section title={<Trans>What each location tells you</Trans>}>
        <KindsByLocation settings={s} />
      </Section>
      <Section title={<Trans>Digest and quiet hours</Trans>}>
        <Timing key={`${s.digestTime}|${s.quietFrom}|${s.quietTo}`} settings={s} />
      </Section>
      <Section title={<Trans>Calendar feed</Trans>}>
        <CalendarFeeds />
      </Section>
      <Section title={<Trans>Account</Trans>}>
        <AiSummary settings={s} />
      </Section>
    </>
  );
}

/** The digest time and quiet hours, both ends or neither, saved together (T15's rule). */
function Timing({ settings }: { settings: Settings }) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const errorText = useErrorText();
  const online = useOnline();
  const [digest, setDigest] = useState(settings.digestTime);
  const [quiet, setQuiet] = useState(settings.quietFrom !== null);
  const [from, setFrom] = useState(settings.quietFrom ?? '23:00');
  const [to, setTo] = useState(settings.quietTo ?? '07:00');
  const [busy, setBusy] = useState(false);
  const zone = settings.timezone;

  const next = {
    digestTime: digest,
    quietFrom: quiet ? from : null,
    quietTo: quiet ? to : null,
  };
  const changed =
    next.digestTime !== settings.digestTime ||
    next.quietFrom !== settings.quietFrom ||
    next.quietTo !== settings.quietTo;
  // The server refuses quiet hours that start and end at the same time.
  const complete = !quiet || from !== to;

  const save = async () => {
    setBusy(true);
    try {
      const r = await householdApi.putNotificationSettings({
        digestTime: digest,
        quietFrom: next.quietFrom,
        quietTo: next.quietTo,
      });
      qc.setQueryData(householdKeys.notificationSettings, r);
      toast({ title: t`Saved`, tone: 'ok' });
    } catch (e) {
      toast({ title: t`Couldn't save that`, description: errorText(e), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4 rounded-[10px] border border-line bg-surface p-3.5">
      <p className="m-0 text-small text-ink-2">
        <Trans>
          Times are in <bdi>{zone}</bdi>, your time zone.
        </Trans>
      </p>
      <TimeField
        label={t`Daily digest`}
        description={t`What's coming up arrives together, once a day.`}
        value={digest}
        onChange={setDigest}
      />
      <Switch isSelected={quiet} onChange={setQuiet}>
        <Trans>Quiet hours</Trans>
      </Switch>
      {quiet ? (
        <div className="flex flex-wrap gap-4">
          <TimeField label={t`From`} value={from} onChange={setFrom} />
          <TimeField label={t`To`} value={to} onChange={setTo} />
          <p className="m-0 basis-full text-small text-ink-2">
            {complete ? (
              <Trans>Nothing is pushed or emailed in these hours; it waits until they end.</Trans>
            ) : (
              <span className="text-danger">
                <Trans>Quiet hours can't start and end at the same time.</Trans>
              </span>
            )}
          </p>
        </div>
      ) : null}
      <div>
        <Button
          variant="primary"
          isPending={busy}
          isDisabled={!online || !changed || !complete}
          onPress={() => void save()}
        >
          <Trans>Save</Trans>
        </Button>
      </div>
    </div>
  );
}

/** The AI monthly summary by email: account-level, on unless you turn it off (Q35, D206). */
function AiSummary({ settings }: { settings: Settings }) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const errorText = useErrorText();
  const online = useOnline();
  const set = async (enabled: boolean) => {
    try {
      const r = await householdApi.putPreferences({
        items: [{ locationId: null, kind: 'ai_summary', channel: 'email', enabled }],
      });
      qc.setQueryData(householdKeys.notificationSettings, r);
    } catch (e) {
      toast({ title: t`Couldn't save that`, description: errorText(e), tone: 'danger' });
    }
  };
  return (
    <div className="grid gap-1 rounded-[10px] border border-line bg-surface p-3.5">
      <Switch
        isSelected={settings.account.aiSummary.email}
        isDisabled={!online}
        onChange={(on) => void set(on)}
      >
        <Trans>AI monthly summary by email</Trans>
      </Switch>
      <p className="m-0 text-small text-ink-2">
        <Trans>Once a month: what AI did for you and what it used.</Trans>
      </p>
    </div>
  );
}
