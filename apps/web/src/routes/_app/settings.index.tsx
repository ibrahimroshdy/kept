/**
 * Settings → Me (screens §5 Settings): who you are, how Kept looks on this device, how Kept
 * reaches you (Notifications, step 4), Export my data (step-7 T21, on the Export page), and Security: two-factor and sessions and devices (task
 * 17's device list, with revoke), and This device (step-8 T23: the app lock, keep offline).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { revokeMySession } from '@/api/account';
import { keys, useMe, useMySessions } from '@/api/queries';
import type { DeviceSession } from '@/api/types';
import { ChangeEmail } from '@/components/change-email';
import { DisplayPrefs } from '@/components/display-prefs';
import {
  BellIcon,
  CheckCircleIcon,
  LaptopIcon,
  LockIcon,
  PhoneIcon,
  ShareIcon,
  ShieldCheckIcon,
  ShieldIcon,
} from '@/components/icons';
import {
  Avatar,
  ErrorState,
  IconTile,
  LinkButton,
  List,
  LoadingRows,
  Page,
  Pill,
  Row,
  Section,
  useErrorText,
} from '@/components/page';
import { SettingsTabs } from '@/components/settings-tabs';
import { SignOutButton } from '@/components/sign-out';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { toast } from '@/components/ui/toast';
import { sep, useFormat } from '@/lib/format';
import { describeUserAgent } from '@/lib/user-agent';

export const Route = createFileRoute('/_app/settings/')({ component: MePage });

function MePage() {
  const { t } = useLingui();
  const me = useMe();
  const user = me.data?.user;
  return (
    <Page title={t`Settings`}>
      <SettingsTabs />
      {user ? (
        <div className="flex items-center gap-3 rounded-[10px] border border-line bg-surface p-3.5">
          <Avatar name={user.displayName} />
          <div className="grid min-w-0 flex-1 gap-0.5">
            <div className="font-semibold text-[16px]">{user.displayName}</div>
            <div className="ltr text-start text-small text-ink-2 [overflow-wrap:anywhere]">
              {user.email ?? user.username}
            </div>
          </div>
          {/* A managed account signs in with a username and has no email to change (D47). */}
          {user.email && !user.managed ? <ChangeEmail current={user.email} /> : null}
        </div>
      ) : null}

      <Section title={<Trans>Display</Trans>}>
        <div className="rounded-[10px] border border-line bg-surface p-3.5">
          <DisplayPrefs />
        </div>
      </Section>

      <Section title={<Trans>Notifications</Trans>}>
        <List>
          <li>
            <Row
              leading={
                <IconTile>
                  <BellIcon />
                </IconTile>
              }
              title={<Trans>Reminders and alerts</Trans>}
              subtitle={<Trans>What each location tells you, by email or on this device.</Trans>}
              trailing={
                <LinkButton to="/settings/me/notifications" size="small">
                  <Trans>Open</Trans>
                </LinkButton>
              }
            />
          </li>
        </List>
      </Section>

      <Section title={<Trans>Your data</Trans>}>
        <List>
          <li>
            <Row
              leading={
                <IconTile>
                  <ShareIcon />
                </IconTile>
              }
              title={<Trans>Export my data</Trans>}
              subtitle={
                <Trans>
                  Your Personal location, profile and preferences, and your AI calls, as one file.
                </Trans>
              }
              trailing={
                <LinkButton to="/settings/export" search={{ sheet: 'me' }} size="small">
                  <Trans>Export</Trans>
                </LinkButton>
              }
            />
          </li>
        </List>
      </Section>

      <Section title={<Trans>Security</Trans>}>
        <List>
          <li className="flex items-center gap-3 px-3.5 py-3">
            <IconTile>{user?.twoFactorEnabled ? <ShieldCheckIcon /> : <ShieldIcon />}</IconTile>
            <div className="grid min-w-0 flex-1 gap-0.5">
              <div className="font-semibold text-[15px]">
                <Trans>Two-factor</Trans>
              </div>
              <div className="text-small text-ink-2">
                {user?.twoFactorEnabled ? (
                  <Trans>On. Signing in asks for a code from your authenticator app.</Trans>
                ) : (
                  <Trans>
                    Off. Some locations ask for it; until you turn it on they stay hidden for you.
                  </Trans>
                )}
              </div>
            </div>
            {user?.twoFactorEnabled ? (
              <Pill tone="ok" icon={<CheckCircleIcon />}>
                <Trans>On</Trans>
              </Pill>
            ) : (
              <LinkButton to="/settings/two-factor" size="small" variant="primary">
                <Trans>Turn on</Trans>
              </LinkButton>
            )}
          </li>
          {/* Step 8 (T23; D159, D181): the app lock and the locations kept offline. */}
          <li>
            <Row
              leading={
                <IconTile>
                  <LockIcon />
                </IconTile>
              }
              title={<Trans>This device</Trans>}
              subtitle={<Trans>Lock Kept with a PIN, and keep a location available offline.</Trans>}
              trailing={
                <LinkButton to="/settings/device" size="small">
                  <Trans>Open</Trans>
                </LinkButton>
              }
            />
          </li>
        </List>
      </Section>

      <Section title={<Trans>Sessions and devices</Trans>}>
        <Sessions />
      </Section>

      <Section title={<Trans>Check this device</Trans>}>
        <List>
          <li>
            <Row
              leading={
                <IconTile>
                  <PhoneIcon />
                </IconTile>
              }
              title={<Trans>Diagnostics</Trans>}
              subtitle={
                <Trans>Check the camera, offline support and storage, and copy a report.</Trans>
              }
              trailing={
                <LinkButton to="/settings/diagnostics" size="small">
                  <Trans>Open</Trans>
                </LinkButton>
              }
            />
          </li>
        </List>
      </Section>

      <SignOutButton />
    </Page>
  );
}

function Sessions() {
  const { t } = useLingui();
  const sessions = useMySessions();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const others = sessions.data?.filter((s) => !s.current) ?? [];
  const revokeOthers = useMutation({
    mutationFn: async () => {
      for (const s of others) await revokeMySession(s.id);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.sessions });
      toast({ title: t`Signed out of your other devices`, tone: 'ok' });
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });

  if (sessions.isPending) return <LoadingRows rows={2} label={t`Loading your devices`} />;
  if (sessions.error)
    return <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} />;

  return (
    <div className="grid gap-2.5">
      <List>
        {sessions.data.map((s) => (
          <li key={s.id}>
            <SessionRow session={s} />
          </li>
        ))}
      </List>
      {others.length > 0 ? (
        <Button
          variant="secondary"
          className="w-full"
          isPending={revokeOthers.isPending}
          onPress={async () => {
            const ok = await confirm({
              title: t`Sign out of every other device?`,
              body: t`This device stays signed in. The others need your password or passkey again.`,
              confirmLabel: t`Sign out others`,
              destructive: true,
            });
            if (ok) revokeOthers.mutate();
          }}
        >
          <Trans>Sign out of all other devices</Trans>
        </Button>
      ) : null}
    </div>
  );
}

function SessionRow({ session }: { session: DeviceSession }) {
  const { t } = useLingui();
  const f = useFormat();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const { browser, os, kind } = describeUserAgent(session.userAgent);
  const where = os ?? t`Unknown device`;
  const title = browser ? t`${browser} on ${where}` : where;
  const active = f.relative(session.lastActiveAt);
  const since = f.day(session.createdAt);
  const revoke = useMutation({
    mutationFn: () => revokeMySession(session.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.sessions });
      toast({ title: t`Signed out ${title}`, tone: 'ok' });
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });
  return (
    <div className="flex items-center gap-3 px-3.5 py-3">
      <IconTile>{kind === 'phone' ? <PhoneIcon /> : <LaptopIcon />}</IconTile>
      <div className="grid min-w-0 flex-1 gap-1">
        <div className="font-semibold text-[15px]">{title}</div>
        <div className="text-small text-ink-2">
          {session.current ? (
            <Trans>Signed in {since}</Trans>
          ) : (
            <Trans>
              Active {active} · signed in {since}
            </Trans>
          )}
          {session.ipAddress ? (
            <>
              {sep()}
              <span className="ltr">{session.ipAddress}</span>
            </>
          ) : null}
        </div>
        {session.current ? (
          <Pill tone="ok">
            <Trans>This device</Trans>
          </Pill>
        ) : null}
      </div>
      {session.current ? null : (
        <Button
          size="small"
          variant="secondary"
          isPending={revoke.isPending}
          onPress={async () => {
            const ok = await confirm({
              title: t`Sign out ${title}?`,
              body: t`It will need your password or passkey to get back in.`,
              confirmLabel: t`Sign out`,
              destructive: true,
            });
            if (ok) revoke.mutate();
          }}
        >
          <Trans>Sign out</Trans>
        </Button>
      )}
    </div>
  );
}
