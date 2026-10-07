/**
 * Reports (plan T26; D158, D201, screens §2 `/reports/<kind>`): `insurance` (the insurance
 * report, PDF and CSV, for a location or an incident) and `claim-pack` (a ZIP behind an expiring
 * download link). Other kinds (vehicle history) arrive with their steps.
 *
 * The search says what it's for: `?incident=` an incident; `?loc=` a location (and `&things=a,b`
 * the claim pack's selection); `?run=` a report or pack already made (a notification's link). The
 * screens load on demand (components/incidents/lazy.tsx).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { createFileRoute } from '@tanstack/react-router';
import * as z from 'zod/mini';
import { ComingLater } from '@/components/coming-later';
import { PrinterIcon } from '@/components/icons';
import { ClaimPackScreen, InsuranceReportScreen } from '@/components/incidents/lazy';
import { ReportRouteError } from '@/components/incidents/route-error';
import { Page } from '@/components/page';

const id = z.optional(z.string().check(z.maxLength(200)));

export const Route = createFileRoute('/_app/reports/$kind')({
  validateSearch: z.catch(
    z.object({
      loc: id,
      incident: id,
      things: z.optional(z.string().check(z.maxLength(20_000))),
      run: id,
    }),
    {},
  ),
  component: ReportPage,
  errorComponent: ReportRouteError,
});

function ReportPage() {
  const { kind } = Route.useParams();
  const search = Route.useSearch();
  if (kind === 'insurance') return <InsuranceReportScreen search={search} />;
  if (kind === 'claim-pack') return <ClaimPackScreen search={search} />;
  return <LaterPage />;
}

function LaterPage() {
  const { t } = useLingui();
  return (
    <Page title={t`Report`}>
      <ComingLater icon={<PrinterIcon />} title={<Trans>What your insurer asks for</Trans>}>
        <Trans>
          A report of your things with their prices, values and receipts, and a pack of the
          originals to send with a claim.
        </Trans>
      </ComingLater>
    </Page>
  );
}
