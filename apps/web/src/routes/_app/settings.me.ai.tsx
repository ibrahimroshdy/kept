/**
 * Me → Personal AI key (plan T29; D121, D167, D206): the note "Used for Personal, your private
 * threads, and questions that span owners", the key box, the personal cap, and My AI usage.
 */
import { useLingui } from '@lingui/react/macro';
import { createFileRoute } from '@tanstack/react-router';
import { AiSettings } from '@/components/ai/settings-page';
import { PersonalAiRouteError } from '@/components/on-demand-route-error';
import { Page } from '@/components/page';

export const Route = createFileRoute('/_app/settings/me/ai')({
  component: PersonalAiPage,
  errorComponent: PersonalAiRouteError,
});

function PersonalAiPage() {
  const { t } = useLingui();
  return (
    <Page title={t`Personal AI key`} back="/settings">
      <AiSettings scope="me" />
    </Page>
  );
}
