/**
 * Admin → Admins (D164, D180): who runs this server, making someone an instance admin, and
 * removing one. Kept always keeps at least one: the last admin's Remove is disabled with the
 * reason, and the server's 409 (another admin removed at the same moment) says the same.
 * Managed and disabled accounts can't be admins (the server answers 409), so they aren't offered.
 * Each change mails the person (D180) and is audited.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import type { Key } from 'react-aria-components';
import { grantInstanceAdmin, revokeInstanceAdmin } from '@/api/admin';
import { isApiError } from '@/api/client';
import { keys, useAdminUsers, useMe } from '@/api/queries';
import type { AdminUser } from '@/api/types';
import {
  Avatar,
  ErrorState,
  List,
  LoadingRows,
  Notice,
  Section,
  useErrorText,
} from '@/components/page';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { useConfirm } from '@/components/ui/confirm';
import { toast } from '@/components/ui/toast';

export const Route = createFileRoute('/_app/admin/admins')({ component: AdminsPage });

function AdminsPage() {
  const users = useAdminUsers();
  const me = useMe();
  if (users.isPending) return <LoadingRows rows={3} />;
  if (users.error) return <ErrorState error={users.error} onRetry={() => void users.refetch()} />;
  const admins = users.data.filter((u) => u.instanceAdmin);
  const eligible = users.data.filter((u) => !u.instanceAdmin && !u.managed && !u.disabled);
  const last = admins.length <= 1;
  return (
    <div className="grid gap-5">
      <p className="m-0 text-ink-2">
        <Trans>
          Instance admins run this server: users, sign-up, jobs and alerts. Being one doesn't open
          anyone's locations; they see only the locations they are members of.
        </Trans>
      </p>
      <Section title={<Trans>Instance admins</Trans>}>
        <List>
          {admins.map((u) => (
            <li key={u.id}>
              <AdminRow user={u} self={u.id === me.data?.user.id} last={last} />
            </li>
          ))}
        </List>
        {last ? (
          <p className="m-0 text-small text-ink-3">
            <Trans>Kept needs at least one instance admin, so the last one can't be removed.</Trans>
          </p>
        ) : null}
      </Section>
      <Section title={<Trans>Make someone an admin</Trans>}>
        <Grant eligible={eligible} />
      </Section>
    </div>
  );
}

function AdminRow({ user, self, last }: { user: AdminUser; self: boolean; last: boolean }) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const who = user.displayName;
  const revoke = useMutation({
    mutationFn: () => revokeInstanceAdmin(user.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.admin.users });
      if (self) await qc.invalidateQueries({ queryKey: keys.me });
      toast({ title: t`${who} is no longer an instance admin`, tone: 'ok' });
    },
    onError: (e) =>
      isApiError(e) && e.status === 409
        ? toast({
            title: t`Kept needs at least one instance admin`,
            description: t`Make someone else an admin first, then remove ${who}.`,
            tone: 'danger',
          })
        : toast({ title: errorText(e), tone: 'danger' }),
  });
  const ask = async () => {
    const ok = await confirm(
      self
        ? {
            title: t`Stop being an instance admin?`,
            body: t`You lose this admin area straight away. Your own locations and things stay. Another admin can make you one again.`,
            confirmLabel: t`Remove as admin`,
            destructive: true,
          }
        : {
            title: t`Remove ${who} as an instance admin?`,
            body: t`${who} keeps their own locations and things, and loses this admin area. They get an email about it.`,
            confirmLabel: t`Remove as admin`,
            destructive: true,
          },
    );
    if (ok) revoke.mutate();
  };
  return (
    <div className="flex flex-wrap items-center gap-3 px-3.5 py-3">
      <Avatar name={who} you={self} />
      <div className="grid min-w-0 flex-1 basis-40 gap-0.5">
        <div className="font-semibold text-[15px]">{self ? <Trans>{who} (you)</Trans> : who}</div>
        <div className="ltr text-start text-small text-ink-2 [overflow-wrap:anywhere]">
          {user.email ?? user.username}
        </div>
      </div>
      <Button
        size="small"
        variant="ghost"
        className="text-danger"
        aria-label={t`Remove ${who} as admin`}
        isDisabled={last}
        isPending={revoke.isPending}
        onPress={() => void ask()}
      >
        <Trans>Remove</Trans>
      </Button>
    </div>
  );
}

function Grant({ eligible }: { eligible: AdminUser[] }) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const [picked, setPicked] = useState<Key | null>(null);
  const person = eligible.find((u) => u.id === picked) ?? null;
  const grant = useMutation({
    mutationFn: (u: AdminUser) => grantInstanceAdmin(u.id),
    onSuccess: async (_r, u) => {
      setPicked(null);
      await qc.invalidateQueries({ queryKey: keys.admin.users });
      const who = u.displayName;
      toast({ title: t`${who} is now an instance admin. They get an email about it.`, tone: 'ok' });
    },
    onError: (e) =>
      toast({
        title:
          isApiError(e) && e.status === 409
            ? t`That account can't be made an admin now. Reload and try again.`
            : errorText(e),
        tone: 'danger',
      }),
  });
  if (eligible.length === 0)
    return (
      <Notice tone="info">
        <Trans>
          Everyone who could be an admin already is. Managed and disabled accounts can't be admins.
        </Trans>
      </Notice>
    );
  return (
    <div className="grid gap-3 rounded-[10px] border border-line bg-surface p-3.5">
      <Combobox
        label={t`Person`}
        description={t`Managed and disabled accounts can't be admins.`}
        items={eligible.map((u) => ({
          id: u.id,
          label: u.displayName,
          description: u.email ?? u.username ?? undefined,
        }))}
        selectedKey={picked}
        onSelectionChange={setPicked}
      />
      <div>
        <Button
          isDisabled={!person}
          isPending={grant.isPending}
          onPress={async () => {
            if (!person) return;
            const who = person.displayName;
            const ok = await confirm({
              title: t`Make ${who} an instance admin?`,
              body: t`${who} can disable accounts, change sign-up and see failed jobs and alerts, but not other people's locations. They get an email about it.`,
              confirmLabel: t`Make admin`,
            });
            if (ok) grant.mutate(person);
          }}
        >
          <Trans>Make admin</Trans>
        </Button>
      </div>
    </div>
  );
}
