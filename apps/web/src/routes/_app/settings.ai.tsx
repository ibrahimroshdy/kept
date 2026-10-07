/**
 * AI settings (plan T29; screens §5 "AI settings"; D191, D202, D206): the account's key, for
 * owners; a read-only view for everyone else (components/ai/settings-page.tsx). Also the parent of
 * /settings/ai/usage (settings.ai.usage.tsx): when a child matches, this renders only the child,
 * so the two pages keep the plan's file names without sharing a frame.
 */
import { useLingui } from '@lingui/react/macro';
import { createFileRoute, Outlet, useChildMatches } from '@tanstack/react-router';
import { AiSettings } from '@/components/ai/settings-page';
import { AiRouteError } from '@/components/on-demand-route-error';
import { Page } from '@/components/page';
import { SettingsTabs } from '@/components/settings-tabs';

export const Route = createFileRoute('/_app/settings/ai')({
  component: AiSettingsRoute,
  errorComponent: AiRouteError,
});

function AiSettingsRoute() {
  const { t } = useLingui();
  if (useChildMatches().length > 0) return <Outlet />;
  return (
    <Page title={t`AI`}>
      <SettingsTabs />
      <AiSettings scope="account" />
    </Page>
  );
}
