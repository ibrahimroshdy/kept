/**
 * Location settings → Paperless-ngx (1.x, D248): the location's Paperless server, whose documents
 * members link to things and places. Owners and admins only. The API token is write-only: the
 * form leaves it empty once saved, and an empty field keeps it. Saving signs in first and says
 * why it failed; "Test connection" shows Paperless's version.
 */
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { isApiError } from '@/api/client';
import { paperlessApi, paperlessKeys, usePaperlessConnection } from '@/api/paperless/queries';
import type { PaperlessConnection } from '@/api/paperless/types';
import { ErrorState, List, LoadingRows, Notice, Section, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { PasswordField } from '@/components/ui/password-field';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { useFormat } from '@/lib/format';
import { isPlainHttp, usePaperlessErrorWords } from './words';

export function PaperlessSettings({ locationId }: { locationId: string }) {
  const query = usePaperlessConnection(locationId);
  if (query.isPending) return <LoadingRows rows={3} />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const { connection } = query.data;
  return (
    <div className="grid gap-5">
      {connection ? <Status locationId={locationId} connection={connection} /> : null}
      <ConnectionForm locationId={locationId} connection={connection} />
    </div>
  );
}

function Status({
  locationId,
  connection: c,
}: {
  locationId: string;
  connection: PaperlessConnection;
}) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const fmt = useFormat();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const words = usePaperlessErrorWords();
  const check = useMutation({
    mutationFn: () => paperlessApi.check(locationId),
    onSuccess: ({ ok, version, error }) => {
      void qc.invalidateQueries({ queryKey: paperlessKeys.status(locationId) });
      toast(
        ok
          ? { title: t`Paperless answers: version ${version ?? '?'}`, tone: 'ok' }
          : { title: words(error) ?? t`Paperless couldn't answer.`, tone: 'danger' },
      );
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });
  const remove = useMutation({
    mutationFn: () => paperlessApi.disconnect(locationId),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: paperlessKeys.all });
      toast({ title: t`Paperless disconnected`, tone: 'ok' });
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });
  const onRemove = async () => {
    const links = c.links;
    const yes = await confirm({
      title: t`Disconnect Paperless?`,
      body:
        links > 0
          ? t`The ${links} links to its documents go too. Documents copied into Kept stay.`
          : t`Members can no longer link its documents.`,
      confirmLabel: t`Disconnect`,
      destructive: true,
    });
    if (yes) remove.mutate();
  };
  return (
    <Section title={<Trans>Paperless-ngx</Trans>}>
      {isPlainHttp(c.url) ? (
        <Notice tone="warn" title={<Trans>Not encrypted</Trans>}>
          <Trans>
            This address is plain http, so the token travels unencrypted on your network. Use https
            if Paperless has it.
          </Trans>
        </Notice>
      ) : null}
      <List>
        <li className="grid gap-1 px-3.5 py-3">
          <span className="font-semibold [overflow-wrap:anywhere]">
            <bdi>{c.url}</bdi>
          </span>
          <span className="text-small text-ink-3">
            {c.version ? <Trans>Version {c.version}</Trans> : <Trans>Version unknown</Trans>}
            {fmt.sep}
            <Plural value={c.links} one="# linked document" other="# linked documents" />
          </span>
          <span className="text-small text-ink-3">
            <Trans>
              Connected by {c.createdBy.displayName}, changed {fmt.relative(c.updatedAt)}
            </Trans>
          </span>
          <div className="flex flex-wrap gap-2 pt-1.5">
            <Button
              variant="secondary"
              size="small"
              isPending={check.isPending}
              onPress={() => check.mutate()}
            >
              <Trans>Test connection</Trans>
            </Button>
            <Button
              variant="ghost"
              size="small"
              isPending={remove.isPending}
              onPress={() => void onRemove()}
            >
              <Trans>Disconnect</Trans>
            </Button>
          </div>
        </li>
      </List>
    </Section>
  );
}

function ConnectionForm({
  locationId,
  connection,
}: {
  locationId: string;
  connection: PaperlessConnection | null;
}) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const errorText = useErrorText();
  const words = usePaperlessErrorWords();
  const [url, setUrl] = useState(connection?.url ?? '');
  const [token, setToken] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      paperlessApi.save(locationId, { url: url.trim(), ...(token ? { token: token.trim() } : {}) }),
    onSuccess: async (saved) => {
      setToken('');
      setProblem(null);
      await qc.invalidateQueries({ queryKey: paperlessKeys.all });
      toast({
        title: connection
          ? t`Paperless saved`
          : t`Paperless connected: version ${saved.version ?? '?'}`,
        tone: 'ok',
      });
    },
    onError: (e) => {
      const code = isApiError(e) ? (e.details.paperlessError as string | undefined) : undefined;
      setProblem(code ? words(code) : errorText(e));
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  const ready = url.trim() && (connection || token.trim());
  return (
    <Section
      title={
        connection ? <Trans>Change the connection</Trans> : <Trans>Connect Paperless-ngx</Trans>
      }
    >
      {connection ? null : (
        <p className="m-0 text-ink-2">
          <Trans>
            Members can then link a thing or a place to its receipts, manuals and warranty cards in
            Paperless, without uploading them twice. Kept stores the document's number and title,
            not the file, unless someone copies it into Kept.
          </Trans>
        </p>
      )}
      <form
        onSubmit={submit}
        className="grid gap-3 rounded-[10px] border border-line bg-surface p-3.5"
      >
        <TextField
          label={t`Paperless address`}
          description={t`The address you open Paperless at, for example https://paperless.example.com.`}
          value={url}
          onChange={setUrl}
          inputMode="url"
          autoComplete="off"
          isRequired
        />
        {isPlainHttp(url) ? (
          <Notice tone="warn" title={<Trans>Plain http</Trans>}>
            <Trans>
              Kept accepts http only for an address on your own network, and only when an instance
              admin allows private addresses. The token travels unencrypted there.
            </Trans>
          </Notice>
        ) : null}
        <PasswordField
          label={t`API token`}
          description={
            connection
              ? t`Saved. Leave it empty to keep it.`
              : t`In Paperless, open My Profile and press the circular arrow by the API token. Kept sees what that user sees.`
          }
          value={token}
          onChange={setToken}
          autoComplete="new-password"
          isRequired={!connection}
        />
        {problem ? (
          <Notice tone="danger" title={<Trans>Kept couldn't connect</Trans>}>
            {problem}
          </Notice>
        ) : null}
        <div>
          <Button type="submit" isPending={save.isPending} isDisabled={!ready}>
            {connection ? <Trans>Save</Trans> : <Trans>Connect</Trans>}
          </Button>
        </div>
      </form>
    </Section>
  );
}
