/**
 * What a Homebox archive holds (plan T19 steps 3–4; T8, T11): the counts from its manifest, and
 * the optional connection to the old Homebox server, which reads its version, the collection's
 * currency and its members (the ZIP holds none of these). The address and the API key, or the
 * email and password, are sent once in the request and never kept: not in the URL, not in
 * browser storage, not in the query cache. A private address needs the instance admin's switch.
 */
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { isApiError } from '@/api/client';
import { portabilityApi } from '@/api/portability/queries';
import type { ArchiveInspect, HomeboxConnection } from '@/api/portability/types';
import { Notice, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { PasswordField } from '@/components/ui/password-field';
import { Segmented } from '@/components/ui/segmented';
import { TextField } from '@/components/ui/text-field';
import { useFormat } from '@/lib/format';
import { CountTiles } from './step-chrome';

type HomeboxInspect = Extract<ArchiveInspect, { source: 'homebox_zip' }>;

export function HomeboxInspectSummary({
  inspect,
  connection,
}: {
  inspect: HomeboxInspect;
  connection: HomeboxConnection | null;
}) {
  const f = useFormat();
  const collection = inspect.collections[0];
  if (!collection) return null;
  const c = collection.counts;
  const version = connection?.version ?? inspect.sourceVersion;
  return (
    <div className="grid gap-3">
      <CountTiles
        tiles={[
          {
            n: c.entities,
            value: f.num(c.entities),
            label: <Plural value={c.entities} one="item or location" other="items and locations" />,
          },
          {
            n: c.attachments,
            value: f.num(c.attachments),
            label: (
              <Plural value={c.attachments} one="attachment in it" other="attachments in it" />
            ),
          },
          {
            n: c.tags,
            value: f.num(c.tags),
            label: <Plural value={c.tags} one="tag in it" other="tags in it" />,
          },
          {
            n: c.maintenance,
            value: f.num(c.maintenance),
            label: (
              <Plural value={c.maintenance} one="maintenance entry" other="maintenance entries" />
            ),
          },
        ]}
      />
      <p className="m-0 text-small text-ink-2">
        {collection.name ? (
          <Trans>
            The Homebox collection <bdi className="font-medium text-ink">{collection.name}</bdi>
          </Trans>
        ) : (
          <Trans>One Homebox collection</Trans>
        )}
        {collection.exportedAt ? (
          <>
            {f.sep}
            <Trans>exported {f.day(collection.exportedAt)}</Trans>
          </>
        ) : null}
        {f.sep}
        {version ? (
          <Trans>
            version <bdi dir="ltr">{version}</bdi>
          </Trans>
        ) : (
          <Trans>version unknown</Trans>
        )}
      </p>
    </div>
  );
}

type Auth = 'key' | 'password';

/** The optional connection: an address, then an API key or an email and password. */
export function HomeboxConnect({
  runId,
  connection,
  onConnected,
}: {
  runId: string;
  connection: HomeboxConnection | null;
  onConnected: (c: HomeboxConnection) => void;
}) {
  const { t } = useLingui();
  const f = useFormat();
  const errorText = useErrorText();
  const [open, setOpen] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [auth, setAuth] = useState<Auth>('key');
  const [apiKey, setApiKey] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const connect = useMutation({
    mutationFn: () =>
      portabilityApi.homeboxConnect(
        runId,
        auth === 'key'
          ? { baseUrl: baseUrl.trim(), apiKey }
          : { baseUrl: baseUrl.trim(), username: username.trim(), password },
      ),
    onSuccess: (c) => {
      // Used once: the secrets leave the page's memory as soon as they've been sent.
      setApiKey('');
      setPassword('');
      setError(null);
      setOpen(false);
      onConnected(c);
    },
    onError: (e) => {
      if (isApiError(e) && e.code === 'private_address')
        setError(
          t`That address is on a private network. An instance admin can allow private addresses in Admin → Settings.`,
        );
      else if (isApiError(e) && e.status === 400)
        setError(t`Check the address: it starts with http:// or https://.`);
      else if (isApiError(e) && (e.status === 401 || e.status === 502))
        setError(t`Homebox didn't accept that. Check the address and the sign-in details.`);
      else setError(errorText(e));
    },
  });

  if (connection) {
    const collection = connection.collections[0];
    const members = connection.members?.length ?? 0;
    return (
      <Notice tone="ok" title={<Trans>Connected to Homebox</Trans>}>
        <bdi dir="ltr">{connection.version}</bdi>
        {collection ? (
          <>
            {f.sep}
            <Trans>
              prices in <bdi dir="ltr">{collection.currency}</bdi>
            </Trans>
          </>
        ) : null}
        {members > 0 ? (
          <>
            {f.sep}
            <Plural value={members} one="# member" other="# members" />
          </>
        ) : null}
      </Notice>
    );
  }

  if (!open) {
    return (
      <div className="grid gap-2 rounded-[10px] border border-line bg-surface p-3.5">
        <h3 className="m-0 font-semibold text-[16px]">
          <Trans>Connect to Homebox (optional)</Trans>
        </h3>
        <p className="m-0 text-small text-ink-2">
          <Trans>
            Reads the version, the collection's currency and its members. Used once, never stored.
          </Trans>
        </p>
        <Button variant="secondary" className="justify-self-start" onPress={() => setOpen(true)}>
          <Trans>Connect</Trans>
        </Button>
      </div>
    );
  }

  const ready =
    baseUrl.trim() !== '' &&
    (auth === 'key' ? apiKey !== '' : username.trim() !== '' && password !== '');

  return (
    <form
      className="grid gap-3 rounded-[10px] border border-line bg-surface p-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) connect.mutate();
      }}
    >
      <h3 className="m-0 font-semibold text-[16px]">
        <Trans>Connect to Homebox (optional)</Trans>
      </h3>
      <TextField
        label={t`Homebox address`}
        value={baseUrl}
        onChange={setBaseUrl}
        type="url"
        placeholder="http://192.168.1.20:7745"
        inputProps={{ dir: 'ltr', autoComplete: 'off', spellCheck: false }}
      />
      <Segmented<Auth>
        label={t`Sign in with`}
        value={auth}
        onChange={setAuth}
        options={[
          { id: 'key', label: t`API key` },
          { id: 'password', label: t`Email and password` },
        ]}
      />
      {auth === 'key' ? (
        <PasswordField
          label={t`API key`}
          value={apiKey}
          onChange={setApiKey}
          autoComplete="current-password"
        />
      ) : (
        <>
          <TextField
            label={t`Email`}
            value={username}
            onChange={setUsername}
            type="email"
            inputProps={{ dir: 'ltr', autoComplete: 'off' }}
          />
          <PasswordField label={t`Password`} value={password} onChange={setPassword} />
        </>
      )}
      <p className="m-0 text-small text-ink-2">
        <Trans>Used once to read Homebox, never stored.</Trans>
      </p>
      {error ? (
        <Notice tone="danger" title={<Trans>Couldn't connect</Trans>}>
          {error}
        </Notice>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" isDisabled={!ready} isPending={connect.isPending}>
          <Trans>Connect</Trans>
        </Button>
        <Button
          variant="ghost"
          onPress={() => {
            setApiKey('');
            setPassword('');
            setError(null);
            setOpen(false);
          }}
        >
          <Trans>Skip</Trans>
        </Button>
      </div>
    </form>
  );
}
