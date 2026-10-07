/** On-device diagnostics (plan T23; D188, L87, L96): opt-in checks and "Copy report". */
import { useLingui } from '@lingui/react/macro';
import { createFileRoute } from '@tanstack/react-router';
import { Page } from '@/components/page';
import { DiagnosticsPanel } from '@/pwa/diagnostics';

export const Route = createFileRoute('/_app/settings/diagnostics')({ component: DiagnosticsPage });

function DiagnosticsPage() {
  const { t } = useLingui();
  return (
    <Page title={t`Diagnostics`} back="/settings">
      <DiagnosticsPanel />
    </Page>
  );
}
