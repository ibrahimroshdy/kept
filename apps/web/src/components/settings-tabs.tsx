import { Trans, useLingui } from '@lingui/react/macro';
import { useMe } from '@/api/queries';
import { LinkTabs } from '@/components/link-tabs';

/** Settings sections: Me, Locations, Account (step 2), AI (step 3), Connections (step 6), Import (step 3), Export (step 7), and Admin for instance admins. */
export function SettingsTabs() {
  const { t } = useLingui();
  const me = useMe();
  return (
    <LinkTabs
      label={t`Settings`}
      tabs={[
        {
          key: 'me',
          label: <Trans>Me</Trans>,
          link: { to: '/settings', activeOptions: { exact: true } },
        },
        { key: 'locations', label: <Trans>Locations</Trans>, link: { to: '/settings/locations' } },
        { key: 'account', label: <Trans>Account</Trans>, link: { to: '/settings/account' } },
        { key: 'ai', label: <Trans>AI</Trans>, link: { to: '/settings/ai' } },
        {
          key: 'connections',
          label: <Trans>Connections</Trans>,
          link: { to: '/settings/connections' },
        },
        { key: 'import', label: <Trans>Import</Trans>, link: { to: '/settings/import' } },
        { key: 'export', label: <Trans>Export</Trans>, link: { to: '/settings/export' } },
        ...(me.data?.user.instanceAdmin
          ? [
              {
                key: 'admin',
                label: <Trans context="settings section">Admin</Trans>,
                link: { to: '/admin' as const },
              },
            ]
          : []),
      ]}
    />
  );
}
