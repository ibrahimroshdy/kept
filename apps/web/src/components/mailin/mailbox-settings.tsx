/**
 * Location settings → Email-in (1.4, D231): the location's mailbox, which Kept checks every 10
 * minutes for receipts. Each message's photos and PDFs, or its text when it has none, become a
 * draft receipt in the Inbox. Only mail that arrives after connecting is read. The password is
 * write-only: the form leaves it empty once saved, and an empty field keeps it.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { isApiError } from '@/api/client';
import { mailinApi, mailinKeys, useMailbox } from '@/api/mailin/queries';
import type { ImapSecurity, Mailbox, MailError, MailOutcome, RecentMail } from '@/api/mailin/types';
import {
  EmptyState,
  ErrorState,
  LinkButton,
  List,
  LoadingRows,
  Notice,
  Pill,
  type PillTone,
  Section,
  useErrorText,
} from '@/components/page';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { PasswordField } from '@/components/ui/password-field';
import { Segmented } from '@/components/ui/segmented';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { useFormat } from '@/lib/format';

const PORTS: Record<ImapSecurity, number> = { tls: 993, starttls: 143 };

function useMailErrorWords() {
  const { t } = useLingui();
  return (code: string | null): string | null => {
    if (!code) return null;
    const words: Record<MailError, string> = {
      private_address: t`That address is on a private network. An instance admin can allow it in Admin → Settings.`,
      unreachable: t`Kept couldn't reach that server. Check the host and port.`,
      tls_failed: t`The server's encryption didn't check out. Check the host and the security.`,
      auth_failed: t`The mailbox refused the user name or password.`,
      no_folder: t`That folder doesn't exist in the mailbox.`,
      timeout: t`The server took too long to answer.`,
      failed: t`Kept couldn't sign in to the mailbox.`,
      creator_left: t`The person who connected it no longer administers this location.`,
    };
    return words[code as MailError] ?? words.failed;
  };
}

function useOutcomeWords() {
  const { t } = useLingui();
  return (o: MailOutcome): { label: string; tone: PillTone } =>
    ({
      receipt: { label: t`Draft receipt`, tone: 'ok' as const },
      no_receipt: { label: t`No receipt in it`, tone: 'neutral' as const },
      sender_not_allowed: { label: t`Sender not allowed`, tone: 'neutral' as const },
      too_large: { label: t`Too large`, tone: 'warn' as const },
      failed: { label: t`Couldn't be read`, tone: 'danger' as const },
    })[o];
}

export function MailboxSettings({ locationId }: { locationId: string }) {
  const mailbox = useMailbox(locationId);
  if (mailbox.isPending) return <LoadingRows rows={3} />;
  if (mailbox.error)
    return <ErrorState error={mailbox.error} onRetry={() => void mailbox.refetch()} />;
  const { mailbox: box, recent } = mailbox.data;
  return (
    <div className="grid gap-5">
      {box ? <Status locationId={locationId} box={box} /> : null}
      <MailboxForm locationId={locationId} box={box} />
      {box ? <Recent recent={recent} /> : null}
    </div>
  );
}

function Status({ locationId, box }: { locationId: string; box: Mailbox }) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const fmt = useFormat();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const words = useMailErrorWords();
  const check = useMutation({
    mutationFn: () => mailinApi.checkMailbox(locationId),
    onSuccess: ({ ok, error }) =>
      toast(
        ok
          ? { title: t`The mailbox works`, tone: 'ok' }
          : { title: words(error) ?? t`Kept couldn't sign in to the mailbox.`, tone: 'danger' },
      ),
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });
  const remove = useMutation({
    mutationFn: () => mailinApi.removeMailbox(locationId),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: mailinKeys.mailbox(locationId) });
      toast({ title: t`Mailbox removed`, tone: 'ok' });
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });
  const onRemove = async () => {
    const yes = await confirm({
      title: t`Remove this mailbox?`,
      body: t`Kept stops checking it. The receipts it already made stay.`,
      confirmLabel: t`Remove`,
      destructive: true,
    });
    if (yes) remove.mutate();
  };
  return (
    <Section title={<Trans>Mailbox</Trans>}>
      {!box.active ? (
        <Notice tone="warn" title={<Trans>Kept stopped checking this mailbox</Trans>}>
          {words(box.disabledReason)} <Trans>Save it again to turn it back on.</Trans>
        </Notice>
      ) : box.lastError ? (
        <Notice tone="warn" title={<Trans>The last check failed</Trans>}>
          {words(box.lastError)}
        </Notice>
      ) : null}
      <List>
        <li className="grid gap-1 px-3.5 py-3">
          <span className="font-semibold">
            <bdi>{box.username}</bdi>
          </span>
          <span className="text-small text-ink-3">
            <Trans>
              <bdi>{box.host}</bdi> · folder <bdi>{box.folder}</bdi>
            </Trans>
          </span>
          <span className="text-small text-ink-3">
            {box.lastPolledAt ? (
              <Trans>Checked {fmt.relative(box.lastPolledAt)}</Trans>
            ) : (
              <Trans>Not checked yet. Kept checks every 10 minutes.</Trans>
            )}
          </span>
          <span className="text-small text-ink-3">
            <Trans>Connected by {box.createdBy.displayName}</Trans>
          </span>
          <div className="flex flex-wrap gap-2 pt-1.5">
            <Button
              variant="secondary"
              size="small"
              isPending={check.isPending}
              onPress={() => check.mutate()}
            >
              <Trans>Check now</Trans>
            </Button>
            <Button
              variant="ghost"
              size="small"
              isPending={remove.isPending}
              onPress={() => void onRemove()}
            >
              <Trans>Remove</Trans>
            </Button>
          </div>
        </li>
      </List>
    </Section>
  );
}

function MailboxForm({ locationId, box }: { locationId: string; box: Mailbox | null }) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const errorText = useErrorText();
  const words = useMailErrorWords();
  const [host, setHost] = useState(box?.host ?? '');
  const [security, setSecurity] = useState<ImapSecurity>(box?.security ?? 'tls');
  const [port, setPort] = useState(String(box?.port ?? PORTS.tls));
  const [username, setUsername] = useState(box?.username ?? '');
  const [password, setPassword] = useState('');
  const [folder, setFolder] = useState(box?.folder ?? 'Kept');
  const [senders, setSenders] = useState((box?.allowedSenders ?? []).join(', '));
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      mailinApi.saveMailbox(locationId, {
        host: host.trim(),
        security,
        port: Number(port) || PORTS[security],
        username: username.trim(),
        ...(password ? { password } : {}),
        folder: folder.trim(),
        allowedSenders: senders
          .split(/[\s,;]+/)
          .map((s) => s.trim())
          .filter(Boolean),
      }),
    onSuccess: async () => {
      setPassword('');
      setProblem(null);
      await qc.invalidateQueries({ queryKey: mailinKeys.mailbox(locationId) });
      toast({ title: box ? t`Mailbox saved` : t`Mailbox connected`, tone: 'ok' });
    },
    onError: (e) => {
      const code = isApiError(e) ? (e.details.mailError as string | undefined) : undefined;
      setProblem(code ? words(code) : errorText(e));
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  const ready = host.trim() && username.trim() && folder.trim() && (box || password);
  return (
    <Section title={box ? <Trans>Change the mailbox</Trans> : <Trans>Connect a mailbox</Trans>}>
      {box ? null : (
        <p className="m-0 text-ink-2">
          <Trans>
            Kept checks a folder in a mailbox you already have, every 10 minutes. Each message's
            photos and PDFs, or its text when it has none, become a draft receipt in the Inbox. Only
            mail that arrives after you connect is read, and nothing in the mailbox is changed.
          </Trans>
        </p>
      )}
      <form
        onSubmit={submit}
        className="grid gap-3 rounded-[10px] border border-line bg-surface p-3.5"
      >
        <TextField
          label={t`IMAP server`}
          description={t`For example imap.gmail.com or imap.fastmail.com.`}
          value={host}
          onChange={setHost}
          autoComplete="off"
          isRequired
        />
        <Segmented
          label={t`Security`}
          value={security}
          onChange={(v) => {
            setSecurity(v);
            setPort(String(PORTS[v]));
          }}
          options={[
            { id: 'tls', label: t`TLS (993)` },
            { id: 'starttls', label: t`STARTTLS (143)` },
          ]}
        />
        <TextField
          label={t`Port`}
          value={port}
          onChange={setPort}
          inputMode="numeric"
          autoComplete="off"
        />
        <TextField
          label={t`User name`}
          value={username}
          onChange={setUsername}
          autoComplete="off"
          isRequired
        />
        <PasswordField
          label={t`Password`}
          description={
            box
              ? t`Saved. Leave it empty to keep it.`
              : t`An app password, if your provider has them.`
          }
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          isRequired={!box}
        />
        <TextField
          label={t`Folder`}
          description={t`Make a folder for receipts and send them there with a filter.`}
          value={folder}
          onChange={setFolder}
          autoComplete="off"
          isRequired
        />
        <TextField
          label={t`Only from these senders`}
          description={t`Optional, comma-separated. A filter against noise, not a security check: a From address can be forged.`}
          value={senders}
          onChange={setSenders}
          autoComplete="off"
        />
        {problem ? (
          <Notice tone="danger" title={<Trans>Kept couldn't connect</Trans>}>
            {problem}
          </Notice>
        ) : null}
        <div>
          <Button type="submit" isPending={save.isPending} isDisabled={!ready}>
            {box ? <Trans>Save</Trans> : <Trans>Connect</Trans>}
          </Button>
        </div>
      </form>
    </Section>
  );
}

function Recent({ recent }: { recent: RecentMail[] }) {
  const fmt = useFormat();
  const outcome = useOutcomeWords();
  return (
    <Section
      title={<Trans>Recent mail</Trans>}
      action={
        recent.some((r) => r.outcome === 'receipt') ? (
          <LinkButton to="/inbox" size="small" variant="ghost">
            <Trans>Open the Inbox</Trans>
          </LinkButton>
        ) : null
      }
    >
      {recent.length === 0 ? (
        <EmptyState title={<Trans>No mail read yet</Trans>}>
          <Trans>Messages that arrive in the folder show here once Kept has read them.</Trans>
        </EmptyState>
      ) : (
        <List>
          {recent.map((r) => {
            const o = outcome(r.outcome);
            return (
              <li key={r.id} className="grid gap-0.5 px-3.5 py-2.5">
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 font-semibold break-words">
                    <bdi>{r.subject ?? '—'}</bdi>
                  </span>
                  <Pill tone={o.tone}>{o.label}</Pill>
                </div>
                <span className="text-small text-ink-3 break-words">
                  <bdi>{r.from ?? ''}</bdi> · {fmt.relative(r.at)}
                </span>
              </li>
            );
          })}
        </List>
      )}
    </Section>
  );
}
