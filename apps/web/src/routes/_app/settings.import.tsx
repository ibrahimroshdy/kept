/**
 * Settings → Import (plan T30; screens §6 "Import stepper"; D73; step-7 T19): the import stepper
 * for a CSV, a Homebox export or a Kept export (components/import/stepper.tsx). The URL holds the
 * location (`?location=`), an export chosen as the source (`?source=`), the import once it exists
 * (`?run=`), and the lists' state (search, the report's Status and Column filters, the Homebox
 * types' Match), so a reload keeps the report, the progress and Resume.
 */
import type { ArchiveSource } from '@kept/shared';
import { useLingui } from '@lingui/react/macro';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import * as z from 'zod/mini';
import { ImportStepper } from '@/components/import/stepper';
import { ImportRouteError } from '@/components/on-demand-route-error';
import { Page } from '@/components/page';
import { SettingsTabs } from '@/components/settings-tabs';
import { listSearch } from '@/lib/url-state';

export const Route = createFileRoute('/_app/settings/import')({
  validateSearch: listSearch(['status', 'column', 'typeMatch'], {
    location: z.optional(z.string()),
    run: z.optional(z.string()),
    source: z.optional(z.catch(z.optional(z.enum(['homebox_zip', 'kept_zip'])), undefined)),
  }),
  component: ImportPage,
  errorComponent: ImportRouteError,
});

function ImportPage() {
  const { t } = useLingui();
  const search = Route.useSearch() as {
    location?: string;
    run?: string;
    source?: ArchiveSource;
  };
  const navigate = useNavigate();
  return (
    <Page title={t`Import`}>
      <SettingsTabs />
      <ImportStepper
        locationParam={search.location}
        runId={search.run}
        sourceParam={search.source}
        go={(next) =>
          void navigate({
            to: '/settings/import',
            search: {
              ...(next.location ? { location: next.location } : {}),
              ...(next.run ? { run: next.run } : {}),
              ...(next.source ? { source: next.source } : {}),
            },
          })
        }
      />
    </Page>
  );
}
