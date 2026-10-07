/**
 * Me → Notifications → Channels (plan T25; D30, D139, D193; step-4 Q6, Q13): how Kept reaches you
 * besides the notification centre, which everyone has.
 *
 * - **Email:** your address; "Mail isn't configured on this server" when SMTP is off; a Test.
 *   A managed account has no email, so no email channel (Q13).
 * - **This device:** Enable asks for the notification permission **only on that tap** (D139).
 *   On an iPhone or iPad in the browser it says plainly that notifications work only from the
 *   installed app, offers the install sheet, and email instead (D139, V8). Over plain HTTP: "Push
 *   needs HTTPS" (D193). Once on: Test and Turn off.
 * - **Other devices** with push on: Test and Remove.
 * - **Webhooks** (Q6: a personal channel; the §2.6 envelope, event `reminder.due`, ids and dates,
 *   no names): add with a URL and a label, then the signing secret **shown once** with Copy; Test
 *   and Remove. Its URL is never shown again, only its host.
 */
import { MAX_WEBHOOK_CHANNELS } from '@kept/shared';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '@/api/client';
import { householdApi, householdKeys } from '@/api/household/queries';
import type { Channel, ChannelTestResult, NotificationSettings } from '@/api/household/types';
import { useMe } from '@/api/queries';
import { InstallSheet } from '@/components/home/install-sheet';
import {
  AlertIcon,
  CheckCircleIcon,
  CodeIcon,
  LaptopIcon,
  MailIcon,
  PhoneIcon,
  PlusIcon,
} from '@/components/icons';
import { IconTile, List, Notice, Pill, useErrorText } from '@/components/page';
import { Sheet } from '@/components/things/sheet';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { CopyButton } from '@/components/ui/copy-button';
import { DialogFooter } from '@/components/ui/dialog';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { useFormat } from '@/lib/format';
import { useOnline } from '@/lib/online';
import { describeUserAgent } from '@/lib/user-agent';
import {
  disablePush,
  enablePush,
  PushDenied,
  pushBlocker,
  thisDeviceSubscriptionId,
} from '@/pwa/push';

function Item({
  icon,
  title,
  children,
  actions,
}: {
  icon: React.ReactNode;
  title: React.ReactNode;
  children?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <li className="grid gap-2 px-3.5 py-3 md:flex md:items-center md:gap-3">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <IconTile>{icon}</IconTile>
        <div className="grid min-w-0 flex-1 gap-1">
          <div className="font-semibold text-[15px] leading-snug [overflow-wrap:anywhere]">
            {title}
          </div>
          {children ? (
            <div className="grid gap-1 text-small text-ink-2 [overflow-wrap:anywhere]">
              {children}
            </div>
          ) : null}
        </div>
      </div>
      {actions ? <div className="flex flex-wrap gap-2 ps-13 md:ps-0">{actions}</div> : null}
    </li>
  );
}

/** Test a channel or a device and say how it went (T15's error codes in the reader's words). */
function useTest() {
  const { t } = useLingui();
  const errorText = useErrorText();
  const why = (r: ChannelTestResult): string => {
    const code = r.status;
    switch (r.error) {
      case 'no_address':
        return t`Your account has no email address.`;
      case 'mail_not_configured':
        return t`Mail isn't configured on this server.`;
      case 'mail_failed':
        return t`The mail server didn't take it. Try again later.`;
      case undefined:
        return code ? t`It answered ${code}.` : '';
      default:
        return code ? t`It answered ${code}.` : t`It couldn't be reached.`;
    }
  };
  return async (run: () => Promise<ChannelTestResult>) => {
    try {
      const r = await run();
      if (r.ok) toast({ title: t`Test sent`, tone: 'ok' });
      else toast({ title: t`The test didn't arrive`, description: why(r), tone: 'danger' });
    } catch (e) {
      // Tests share one allowance: 5 an hour, every channel and device together (T15).
      const limited = e instanceof ApiError && e.code === 'rate_limited';
      toast({
        title: t`Couldn't send a test`,
        description: limited
          ? t`Kept sends at most 5 tests an hour, across all your channels and devices. Try again later.`
          : errorText(e),
        tone: 'danger',
      });
    }
  };
}

export function Channels({ settings }: { settings: NotificationSettings }) {
  return (
    <List>
      <EmailChannel settings={settings} />
      <ThisDevice settings={settings} />
      <OtherDevices settings={settings} />
      <Webhooks settings={settings} />
    </List>
  );
}

function EmailChannel({ settings }: { settings: NotificationSettings }) {
  const { t } = useLingui();
  const me = useMe();
  const test = useTest();
  const online = useOnline();
  const user = me.data?.user;
  const channel = settings.channels.find((c) => c.kind === 'email');
  if (user?.managed || !user?.email)
    return (
      <Item icon={<MailIcon />} title={<Trans>Email</Trans>}>
        <span>
          <Trans>Your account has no email address, so Kept tells you here, in the app.</Trans>
        </span>
      </Item>
    );
  return (
    <Item
      icon={<MailIcon />}
      title={<Trans>Email</Trans>}
      actions={
        settings.smtpConfigured && channel ? (
          <Button
            size="small"
            variant="secondary"
            isDisabled={!online}
            aria-label={t`Send a test email`}
            onPress={() => void test(() => householdApi.testChannel(channel.id))}
          >
            <Trans>Test</Trans>
          </Button>
        ) : null
      }
    >
      <span className="ltr text-start">{user.email}</span>
      {settings.smtpConfigured ? null : (
        <span className="flex items-center gap-1.5 text-warn">
          <AlertIcon aria-hidden="true" className="size-4 shrink-0" />
          <Trans>Mail isn't configured on this server, so no email goes out yet.</Trans>
        </span>
      )}
    </Item>
  );
}

function ThisDevice({ settings }: { settings: NotificationSettings }) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const errorText = useErrorText();
  const confirm = useConfirm();
  const test = useTest();
  const online = useOnline();
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [, rerender] = useState(0);
  const subscriptions = settings.channels.find((c) => c.kind === 'webpush')?.subscriptions ?? [];
  const mine = thisDeviceSubscriptionId();
  const on = !!mine && subscriptions.some((s) => s.id === mine);
  const blocker = on ? null : pushBlocker(settings.push);
  const ua = describeUserAgent(typeof navigator === 'undefined' ? null : navigator.userAgent);
  const icon = ua.kind === 'phone' ? <PhoneIcon /> : <LaptopIcon />;
  const refresh = () => qc.invalidateQueries({ queryKey: householdKeys.notificationSettings });

  const enable = async () => {
    const key = settings.push.publicKey;
    if (!key) return;
    setBusy(true);
    try {
      const { browser, os } = ua;
      const label = browser && os ? t`${browser} on ${os}` : (os ?? browser ?? t`Browser`);
      await enablePush(key, label);
      toast({ title: t`Notifications are on for this device`, tone: 'ok' });
      await refresh();
    } catch (e) {
      toast(
        e instanceof PushDenied
          ? {
              title: t`Notifications are blocked`,
              description: t`Allow notifications for Kept in this browser's settings, then try again.`,
              tone: 'danger',
            }
          : { title: t`Couldn't turn notifications on`, description: errorText(e), tone: 'danger' },
      );
      rerender((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    if (!mine) return;
    const ok = await confirm({
      title: t`Turn off notifications on this device?`,
      body: t`Email and the notification centre still reach you.`,
      confirmLabel: t`Turn off`,
      destructive: true,
    });
    if (!ok) return;
    try {
      await disablePush(mine);
      await refresh();
    } catch (e) {
      toast({ title: t`Couldn't turn them off`, description: errorText(e), tone: 'danger' });
    }
  };

  const title = <Trans>This device</Trans>;
  if (on)
    return (
      <Item
        icon={icon}
        title={title}
        actions={
          <>
            <Button
              size="small"
              variant="secondary"
              isDisabled={!online}
              aria-label={t`Send a test notification to this device`}
              onPress={() => void test(() => householdApi.testPushSubscription(mine))}
            >
              <Trans>Test</Trans>
            </Button>
            <Button
              size="small"
              variant="secondary"
              isDisabled={!online}
              onPress={() => void turnOff()}
            >
              <Trans>Turn off</Trans>
            </Button>
          </>
        }
      >
        <span>
          <Pill tone="ok" icon={<CheckCircleIcon />}>
            <Trans>Push is on</Trans>
          </Pill>
        </span>
      </Item>
    );

  if (blocker === 'ios_not_installed')
    return (
      <Item
        icon={icon}
        title={title}
        actions={
          <Button size="small" variant="primary" onPress={() => setInstalling(true)}>
            <Trans>How to install</Trans>
          </Button>
        }
      >
        <span data-push-blocker={blocker}>
          <Trans>
            On iPhone and iPad, notifications work only from the installed app. Add Kept to your
            Home Screen, open it from there and turn them on. Until then, email reaches you.
          </Trans>
        </span>
        <InstallSheet isOpen={installing} onClose={() => setInstalling(false)} />
      </Item>
    );

  const why =
    blocker === 'no_https' ? (
      <Trans>
        Push needs HTTPS. Over plain HTTP, email and the notification centre still work.
      </Trans>
    ) : blocker === 'server' ? (
      <Trans>Push isn't set up on this server. Email and the notification centre still work.</Trans>
    ) : blocker === 'unsupported' ? (
      <Trans>This browser can't receive notifications from Kept. Email still reaches you.</Trans>
    ) : blocker === 'denied' ? (
      <Trans>
        Notifications are blocked for Kept in this browser's settings. Allow them there, then come
        back.
      </Trans>
    ) : null;

  return (
    <Item
      icon={icon}
      title={title}
      actions={
        blocker ? null : (
          <Button
            size="small"
            variant="primary"
            isPending={busy}
            isDisabled={!online}
            onPress={() => void enable()}
          >
            <Trans>Enable</Trans>
          </Button>
        )
      }
    >
      {why ? (
        <span data-push-blocker={blocker}>{why}</span>
      ) : (
        <span>
          <Trans>Reminders pop up here even when Kept is closed. Your browser asks first.</Trans>
        </span>
      )}
    </Item>
  );
}

function OtherDevices({ settings }: { settings: NotificationSettings }) {
  const { t } = useLingui();
  const f = useFormat();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const test = useTest();
  const online = useOnline();
  const mine = thisDeviceSubscriptionId();
  const others = (settings.channels.find((c) => c.kind === 'webpush')?.subscriptions ?? []).filter(
    (s) => s.id !== mine,
  );
  if (others.length === 0) return null;

  const remove = async (id: string, name: string) => {
    const ok = await confirm({
      title: t`Stop notifications on ${name}?`,
      body: t`That device stops receiving push from Kept. Turn it on again from the device itself.`,
      confirmLabel: t`Remove`,
      destructive: true,
    });
    if (!ok) return;
    try {
      await householdApi.deletePushSubscription(id);
      await qc.invalidateQueries({ queryKey: householdKeys.notificationSettings });
    } catch (e) {
      toast({ title: t`Couldn't remove it`, description: errorText(e), tone: 'danger' });
    }
  };

  return (
    <>
      {others.map((s) => {
        const name = s.label ?? t`A device`;
        const added = f.day(s.createdAt);
        const last = s.lastSuccessAt ? f.relative(s.lastSuccessAt) : null;
        return (
          <Item
            key={s.id}
            icon={<PhoneIcon />}
            title={<bdi>{name}</bdi>}
            actions={
              <>
                <Button
                  size="small"
                  variant="secondary"
                  isDisabled={!online}
                  aria-label={t`Send a test notification to ${name}`}
                  onPress={() => void test(() => householdApi.testPushSubscription(s.id))}
                >
                  <Trans>Test</Trans>
                </Button>
                <Button
                  size="small"
                  variant="secondary"
                  isDisabled={!online}
                  aria-label={t`Remove ${name}`}
                  onPress={() => void remove(s.id, name)}
                >
                  <Trans>Remove</Trans>
                </Button>
              </>
            }
          >
            <span>
              {last ? (
                <Trans>
                  Push on since {added} · last delivered {last}
                </Trans>
              ) : (
                <Trans>Push on since {added}</Trans>
              )}
            </span>
          </Item>
        );
      })}
    </>
  );
}

function Webhooks({ settings }: { settings: NotificationSettings }) {
  const { t } = useLingui();
  const f = useFormat();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const test = useTest();
  const online = useOnline();
  const [adding, setAdding] = useState(false);
  const hooks = settings.channels.filter((c) => c.kind === 'webhook');
  const full = hooks.length >= MAX_WEBHOOK_CHANNELS;

  const remove = async (c: Channel, name: string) => {
    const ok = await confirm({
      title: t`Remove the webhook ${name}?`,
      body: t`Kept stops posting to it. Its secret can't be used again.`,
      confirmLabel: t`Remove`,
      destructive: true,
    });
    if (!ok) return;
    try {
      await householdApi.deleteChannel(c.id);
      await qc.invalidateQueries({ queryKey: householdKeys.notificationSettings });
    } catch (e) {
      toast({ title: t`Couldn't remove it`, description: errorText(e), tone: 'danger' });
    }
  };

  return (
    <>
      {hooks.map((c) => {
        const name = c.label ?? c.displayHost ?? t`Webhook`;
        const since = c.failingSince ? f.day(c.failingSince) : null;
        return (
          <Item
            key={c.id}
            icon={<CodeIcon />}
            title={<bdi>{name}</bdi>}
            actions={
              <>
                <Button
                  size="small"
                  variant="secondary"
                  isDisabled={!online}
                  aria-label={t`Send a test to ${name}`}
                  onPress={() => void test(() => householdApi.testChannel(c.id))}
                >
                  <Trans>Test</Trans>
                </Button>
                <Button
                  size="small"
                  variant="secondary"
                  isDisabled={!online}
                  aria-label={t`Remove ${name}`}
                  onPress={() => void remove(c, name)}
                >
                  <Trans>Remove</Trans>
                </Button>
              </>
            }
          >
            {c.displayHost && c.label ? (
              <span className="ltr text-start">{c.displayHost}</span>
            ) : null}
            {since ? (
              <span className="flex items-center gap-1.5 text-danger">
                <AlertIcon aria-hidden="true" className="size-4 shrink-0" />
                <Trans>Failing since {since}</Trans>
              </span>
            ) : null}
          </Item>
        );
      })}
      <Item
        icon={<CodeIcon />}
        title={<Trans>Webhooks</Trans>}
        actions={
          <Button
            size="small"
            variant="secondary"
            isDisabled={!online || full}
            onPress={() => setAdding(true)}
          >
            <PlusIcon />
            <Trans>Add a webhook</Trans>
          </Button>
        }
      >
        <span>
          {full ? (
            <Plural
              value={MAX_WEBHOOK_CHANNELS}
              one="You have # webhook, the most Kept allows."
              other="You have # webhooks, the most Kept allows."
            />
          ) : (
            <Trans>
              For your own automations: Kept posts a signed message when something is due, with ids
              and dates only, never names.
            </Trans>
          )}
        </span>
      </Item>
      <AddWebhookSheet isOpen={adding} onClose={() => setAdding(false)} />
    </>
  );
}

function AddWebhookSheet({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { t } = useLingui();
  return (
    <Sheet isOpen={isOpen} onOpenChange={(o) => !o && onClose()} title={t`Add a webhook`}>
      {({ close }) => <AddWebhookForm onDone={close} />}
    </Sheet>
  );
}

function AddWebhookForm({ onDone }: { onDone: () => void }) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const errorText = useErrorText();
  const online = useOnline();
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);

  const validUrl = (() => {
    try {
      const u = new URL(url.trim());
      return u.protocol === 'https:' || u.protocol === 'http:';
    } catch {
      return false;
    }
  })();

  const save = async () => {
    if (!validUrl) {
      setError(t`Enter the full address, starting with https://`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await householdApi.createChannel({
        kind: 'webhook',
        url: url.trim(),
        ...(label.trim() ? { label: label.trim() } : {}),
      });
      setSecret(created.secret);
      await qc.invalidateQueries({ queryKey: householdKeys.notificationSettings });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (secret)
    return (
      <div className="grid gap-4">
        <Notice tone="warn" title={<Trans>Copy the signing secret now</Trans>}>
          <Trans>
            Kept shows it only this once. Your receiver checks each message's Kept-Signature header
            with it.
          </Trans>
        </Notice>
        <code className="ltr block rounded-lg border border-line bg-sunken p-3 text-start font-mono text-small break-all">
          {secret}
        </code>
        <DialogFooter>
          <CopyButton text={secret} label={t`Copy the secret`} />
          <Button variant="primary" onPress={onDone}>
            <Trans>Done</Trans>
          </Button>
        </DialogFooter>
      </div>
    );

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <TextField
        label={t`Address`}
        value={url}
        onChange={setUrl}
        autoComplete="off"
        inputProps={{ inputMode: 'url', dir: 'ltr' }}
        isInvalid={!!error}
        {...(error ? { errorMessage: error } : {})}
        description={t`Where Kept posts. Only its host is shown after this.`}
      />
      <TextField
        label={t`Label`}
        value={label}
        onChange={setLabel}
        maxLength={60}
        description={t`Optional, to tell your webhooks apart.`}
      />
      <DialogFooter>
        <Button variant="secondary" onPress={onDone}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" variant="primary" isPending={busy} isDisabled={!online}>
          <Trans>Add</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
}
