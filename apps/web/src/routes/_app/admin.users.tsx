/**
 * Admin → Users (D164, D165, D180): disable, reset two-factor, sign out everywhere. Each action
 * on someone else's account is emailed to them and audited (D180), and the confirm says so.
 */
import type { Role } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { adminUserAction } from '@/api/admin';
import type { AdminUserAction } from '@/api/paths';
import { keys, useAdminUsers, useMe } from '@/api/queries';
import type { AdminUser } from '@/api/types';
import { PeopleIcon } from '@/components/icons';
import { OverflowActions } from '@/components/inbox/overflow-actions';
import {
  Avatar,
  EmptyState,
  ErrorState,
  List,
  LoadingRows,
  Pill,
  useErrorText,
} from '@/components/page';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { toast } from '@/components/ui/toast';
import { sep, useFormat } from '@/lib/format';

export const Route = createFileRoute('/_app/admin/users')({ component: UsersPage });

function UsersPage() {
  const users = useAdminUsers();
  const me = useMe();
  if (users.isPending) return <LoadingRows rows={4} />;
  if (users.error) return <ErrorState error={users.error} onRetry={() => void users.refetch()} />;
  if (users.data.length === 0)
    return <EmptyState icon={<PeopleIcon />} title={<Trans>No users yet</Trans>} />;
  return (
    <List>
      {users.data.map((u) => (
        <li key={u.id}>
          <UserRow user={u} self={u.id === me.data?.user.id} />
        </li>
      ))}
    </List>
  );
}

function RoleSummary({ roles }: { roles: AdminUser['roles'] }) {
  const f = useFormat();
  const parts: React.ReactNode[] = [];
  const add = (role: Role, node: (n: string) => React.ReactNode) => {
    const n = roles[role];
    if (n) parts.push(node(f.num(n)));
  };
  add('owner', (n) => <Trans key="o">owns {n}</Trans>);
  add('admin', (n) => <Trans key="a">admin in {n}</Trans>);
  add('member', (n) => <Trans key="m">member of {n}</Trans>);
  add('viewer', (n) => <Trans key="v">viewer in {n}</Trans>);
  return (
    <>
      {parts.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed order
        <span key={i}>
          {i > 0 ? sep() : null}
          {p}
        </span>
      ))}
    </>
  );
}

function UserRow({ user, self }: { user: AdminUser; self: boolean }) {
  const { t } = useLingui();
  const f = useFormat();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const who = user.displayName;
  const act = useMutation({
    mutationFn: (action: AdminUserAction) => adminUserAction(user.id, action),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.admin.users });
      toast({ title: t`Done. ${who} gets an email about it.`, tone: 'ok' });
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });
  const ask = async (action: AdminUserAction) => {
    const copy: Record<AdminUserAction, { title: string; body: string; label: string }> = {
      disable: {
        title: t`Disable ${who}?`,
        body: t`${who} is signed out everywhere and can't sign in until you enable the account again. Their locations and things stay. They get an email about it.`,
        label: t`Disable`,
      },
      enable: {
        title: t`Enable ${who}?`,
        body: t`${who} can sign in again. They get an email about it.`,
        label: t`Enable`,
      },
      'reset-2fa': {
        title: t`Reset two-factor for ${who}?`,
        body: t`Their authenticator and backup codes stop working, and they set two-factor up again at their next sign-in. They get an email about it.`,
        label: t`Reset two-factor`,
      },
      'sign-out-everywhere': {
        title: t`Sign ${who} out everywhere?`,
        body: t`Every device ${who} is signed in on is signed out. They get an email about it.`,
        label: t`Sign out everywhere`,
      },
    };
    const c = copy[action];
    const ok = await confirm({
      title: c.title,
      body: c.body,
      confirmLabel: c.label,
      destructive: action !== 'enable',
    });
    if (ok) act.mutate(action);
  };
  const joined = f.day(user.createdAt);
  return (
    <div className="flex flex-wrap items-center gap-3 px-3.5 py-3">
      <Avatar name={user.displayName} you={self} />
      <div className="grid min-w-0 flex-1 basis-48 gap-1">
        <div className="font-semibold text-[15px]">{self ? <Trans>{who} (you)</Trans> : who}</div>
        <div className="ltr text-start text-small text-ink-2 [overflow-wrap:anywhere]">
          {user.email ?? user.username}
        </div>
        <div className="text-small text-ink-3">
          <RoleSummary roles={user.roles} />
          {Object.values(user.roles).some(Boolean) ? sep() : null}
          <Trans>joined {joined}</Trans>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {user.instanceAdmin ? (
            <Pill tone="info">
              <Trans>Instance admin</Trans>
            </Pill>
          ) : null}
          {user.managed ? (
            <Pill>
              <Trans>Managed account</Trans>
            </Pill>
          ) : null}
          {user.disabled ? (
            <Pill tone="danger">
              <Trans>Disabled</Trans>
            </Pill>
          ) : null}
          {user.twoFactorEnabled ? null : (
            <Pill tone="warn">
              <Trans>No two-factor</Trans>
            </Pill>
          )}
        </div>
      </div>
      {self ? null : (
        <div className="flex flex-wrap gap-2">
          {user.disabled ? (
            <Button size="small" variant="secondary" onPress={() => void ask('enable')}>
              <Trans>Enable</Trans>
            </Button>
          ) : (
            <>
              <Button
                size="small"
                variant="secondary"
                onPress={() => void ask('sign-out-everywhere')}
              >
                <Trans>Sign out everywhere</Trans>
              </Button>
              {/* On a phone Reset two-factor and Disable fold into More, so Disable no longer
                  wraps alone onto a row of its own (the phone pass); from md they're buttons. */}
              {user.twoFactorEnabled ? (
                <OverflowActions
                  title={who}
                  actions={[
                    {
                      id: 'reset-2fa',
                      label: t`Reset two-factor`,
                      onAction: () => void ask('reset-2fa'),
                    },
                    {
                      id: 'disable',
                      label: t`Disable`,
                      danger: true,
                      onAction: () => void ask('disable'),
                    },
                  ]}
                />
              ) : (
                <Button
                  size="small"
                  variant="ghost"
                  className="text-danger"
                  onPress={() => void ask('disable')}
                >
                  <Trans>Disable</Trans>
                </Button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
