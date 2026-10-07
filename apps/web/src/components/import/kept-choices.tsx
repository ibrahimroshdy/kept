/**
 * What a Kept export holds (plan T19 steps 3 and 6; T14, Q8, Q9, Q23): the exported location's
 * name, its date and version, its counts and the people to invite (names and roles only). When it
 * carries secrets, the passphrase chosen at the export opens them: checked by decrypting on the
 * server, ten tries an hour. Without it everything else is imported. The passphrase lives only in
 * this field while it's typed: never in the URL, browser storage or the query cache.
 */
import type { Role } from '@kept/shared';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { isApiError } from '@/api/client';
import { portabilityApi } from '@/api/portability/queries';
import type { ArchiveImportRun, ArchiveInspect } from '@/api/portability/types';
import { KeyIcon } from '@/components/icons';
import { List, Notice, Pill, Row, useErrorText } from '@/components/page';
import { Button, buttonClass } from '@/components/ui/button';
import { PasswordField } from '@/components/ui/password-field';
import { useFormat } from '@/lib/format';
import { useRoleLabels } from '@/lib/labels';
import { CountTiles } from './step-chrome';

type KeptInspect = Extract<ArchiveInspect, { source: 'kept_zip' }>['kept'];

export function KeptInspectSummary({ kept }: { kept: KeptInspect }) {
  const f = useFormat();
  const n = (key: string) => kept.counts[key] ?? 0;
  return (
    <div className="grid gap-3">
      <div className="grid gap-0.5">
        <bdi className="font-semibold text-[18px] [overflow-wrap:anywhere]">
          {kept.locationName}
        </bdi>
        <span className="text-small text-ink-2">
          <Trans>
            A Kept <bdi dir="ltr">{kept.keptVersion}</bdi> export{f.sep}
            {f.day(kept.exportedAt)}
          </Trans>
        </span>
      </div>
      <CountTiles
        tiles={[
          {
            n: n('things'),
            value: f.num(n('things')),
            label: <Plural value={n('things')} one="thing in it" other="things in it" />,
          },
          {
            n: n('places'),
            value: f.num(n('places')),
            label: <Plural value={n('places')} one="place in it" other="places in it" />,
          },
          {
            n: n('files'),
            value: f.num(n('files')),
            label: <Plural value={n('files')} one="file in it" other="files in it" />,
          },
          {
            n: n('history'),
            value: f.num(n('history')),
            label: (
              <Plural
                value={n('history')}
                one="event in the history"
                other="events in the history"
              />
            ),
          },
        ]}
      />
    </div>
  );
}

/** The export's secrets: the passphrase field, or "unlocked". */
export function KeptSecrets({
  run,
  onRun,
}: {
  run: ArchiveImportRun;
  onRun: (run: ArchiveImportRun) => void;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const unlock = useMutation({
    mutationFn: () => portabilityApi.importPassphrase(run.id, passphrase),
    onSuccess: (next) => {
      setPassphrase('');
      setError(null);
      onRun(next);
    },
    onError: (e) => {
      if (isApiError(e) && e.code === 'passphrase_wrong')
        setError(t`That passphrase doesn't open this export's secrets.`);
      else if (isApiError(e) && e.status === 429)
        setError(t`Too many tries. Try again in an hour.`);
      else setError(errorText(e));
    },
  });

  if (!run.secrets?.present) return null;
  if (run.secrets.unlocked)
    return (
      <Notice tone="ok" title={<Trans>The secrets will be imported</Trans>}>
        <Trans>The passphrase opened them. They stay encrypted until the import writes them.</Trans>
      </Notice>
    );
  return (
    <form
      className="grid gap-3 rounded-[10px] border border-line bg-surface p-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (passphrase) unlock.mutate();
      }}
    >
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-sunken text-ink-2 [&_svg]:size-5">
          <KeyIcon />
        </span>
        <div className="grid gap-1">
          <h3 className="m-0 font-semibold text-[16px]">
            <Trans>It holds encrypted secrets</Trans>
          </h3>
          <p className="m-0 text-small text-ink-2">
            <Trans>
              Enter the passphrase chosen when it was exported to import them too. Without it,
              everything else is imported.
            </Trans>
          </p>
        </div>
      </div>
      <PasswordField
        label={t`Passphrase`}
        value={passphrase}
        onChange={(v) => {
          setPassphrase(v);
          setError(null);
        }}
        isInvalid={!!error}
        errorMessage={error ?? undefined}
        autoComplete="current-password"
      />
      <Button
        type="submit"
        variant="secondary"
        className="justify-self-start"
        isDisabled={!passphrase}
        isPending={unlock.isPending}
      >
        <Trans>Open the secrets</Trans>
      </Button>
    </form>
  );
}

/** People in the export (names and roles only, Q23), to invite once it's imported. */
export function PeopleToInvite({
  people,
  inviteHref,
}: {
  people: { name: string; role?: Role; email?: string }[];
  /** The new location's Invite page, once it exists. */
  inviteHref?: { to: '/settings/location/$id/invite'; params: { id: string } };
}) {
  const { t } = useLingui();
  const roles = useRoleLabels();
  if (people.length === 0) return null;
  return (
    <section className="grid gap-2" aria-labelledby="import-people">
      <h3 id="import-people" className="m-0 font-semibold text-[17px]">
        <Trans>People to invite</Trans>
      </h3>
      <List aria-label={t`People to invite`}>
        {people.map((p, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: names can repeat; the list never moves
          <li key={i}>
            <Row
              title={<bdi>{p.name}</bdi>}
              subtitle={p.email ? <bdi dir="ltr">{p.email}</bdi> : undefined}
              trailing={
                <span className="flex flex-wrap items-center justify-end gap-2">
                  {p.role ? <Pill>{roles.one[p.role]}</Pill> : null}
                  {inviteHref ? <InviteLink {...inviteHref} /> : null}
                </span>
              }
            />
          </li>
        ))}
      </List>
      <p className="m-0 text-small text-ink-2">
        <Trans>
          Nobody is invited by the import: invite each person yourself, with their email.
        </Trans>
      </p>
    </section>
  );
}

function InviteLink({
  to,
  params,
}: {
  to: '/settings/location/$id/invite';
  params: { id: string };
}) {
  return (
    <Link to={to} params={params} className={buttonClass('secondary', 'small')}>
      <Trans>Invite</Trans>
    </Link>
  );
}
