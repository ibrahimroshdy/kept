/**
 * Instance admin (screens §5 Settings → Admin, D164): users, admins, settings, failed jobs,
 * alerts, the status page and backups (step 8). Only for instance admins; the server refuses everyone else anyway.
 * Step 8 (T21, D65): the update line, "Kept 1.3.0 is available", above every admin tab while the
 * opt-in check found a newer release.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { createFileRoute, Outlet } from '@tanstack/react-router';
import { useMe } from '@/api/queries';
import { LinkTabs } from '@/components/link-tabs';
import { AdminRouteError } from '@/components/on-demand-route-error';
import { UpdateLine } from '@/components/ops/update-line';
import { Notice, Page } from '@/components/page';
import { SettingsTabs } from '@/components/settings-tabs';
import { servedOverHttp } from '@/lib/https';

export const Route = createFileRoute('/_app/admin')({
  component: AdminLayout,
  errorComponent: AdminRouteError,
});

function AdminLayout() {
  const { t } = useLingui();
  const me = useMe();
  const admin = me.data?.user.instanceAdmin ?? false;
  return (
    <Page title={t`Instance admin`} wide>
      <SettingsTabs />
      {admin ? (
        <>
          <LinkTabs
            label={t`Instance admin`}
            tabs={[
              { key: 'users', label: <Trans>Users</Trans>, link: { to: '/admin/users' } },
              {
                key: 'admins',
                label: <Trans context="instance admins tab">Admins</Trans>,
                link: { to: '/admin/admins' },
              },
              { key: 'status', label: <Trans>Status</Trans>, link: { to: '/admin/status' } },
              { key: 'backups', label: <Trans>Backups</Trans>, link: { to: '/admin/backups' } },
              { key: 'jobs', label: <Trans>Failed jobs</Trans>, link: { to: '/admin/jobs' } },
              { key: 'alerts', label: <Trans>Alerts</Trans>, link: { to: '/admin/alerts' } },
              { key: 'settings', label: <Trans>Sign-up</Trans>, link: { to: '/admin/settings' } },
              {
                key: 'currencies',
                label: <Trans>Currencies</Trans>,
                link: { to: '/admin/currencies' },
              },
              { key: 'ai', label: <Trans>AI</Trans>, link: { to: '/admin/ai' } },
            ]}
          />
          <UpdateLine />
          {servedOverHttp() ? (
            <Notice tone="warn" title={<Trans>This page is on plain HTTP</Trans>}>
              <Trans>
                Kept limits admin actions over HTTP. Put Kept on HTTPS before you rely on them.
              </Trans>
            </Notice>
          ) : null}
          <Outlet />
        </>
      ) : (
        <Notice tone="info" title={<Trans>For instance admins</Trans>}>
          <Trans>
            The people who run this server manage users, sign-up and jobs here. Ask one of them if
            something needs changing.
          </Trans>
        </Notice>
      )}
    </Page>
  );
}
