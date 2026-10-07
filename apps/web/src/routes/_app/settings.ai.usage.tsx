/**
 * AI usage (plan T29a; screens §5 "AI usage"; D206): the scope switch (Me · each location you
 * administer · Account), the period, totals and caps, charts with tables, outcome counts, and the
 * call list on the filter strip with Export CSV (components/ai/usage-page.tsx). All in the URL:
 * `scope`, `location`, `period`, `from`, `to`, and the list's `q`, `f.*`, `not` and `dir`.
 */
import { useLingui } from '@lingui/react/macro';
import { createFileRoute } from '@tanstack/react-router';
import * as z from 'zod/mini';
import { AI_CALL_FILTERS } from '@/components/ai/call-filters';
import { UsagePage } from '@/components/ai/usage-page';
import { Page } from '@/components/page';
import { listSearch } from '@/lib/url-state';

const text = z.optional(z.string());

export const Route = createFileRoute('/_app/settings/ai/usage')({
  validateSearch: listSearch(AI_CALL_FILTERS, {
    scope: text,
    location: text,
    period: text,
    from: text,
    to: text,
  }),
  component: AiUsageRoute,
});

function AiUsageRoute() {
  const { t } = useLingui();
  return (
    <Page title={t`AI usage`} back="/settings/ai" fill>
      <UsagePage />
    </Page>
  );
}
