/**
 * One condition report (1.x, D235): its rooms, their condition, notes and dated photos; Finish,
 * the PDF, and `?compare=<id>` to put a report of the other kind beside it, room by room. It reads
 * the server, so it loads on demand (vite.config.ts).
 */
import { createFileRoute } from '@tanstack/react-router';
import * as z from 'zod/mini';
import { ConditionReportScreen } from '@/components/condition/report-screen';
import { ConditionRouteError } from '@/components/on-demand-route-error';

export const Route = createFileRoute('/_app/condition-reports/$id')({
  validateSearch: z.catch(
    z.object({ compare: z.optional(z.string().check(z.maxLength(200))) }),
    {},
  ),
  component: ConditionReportPage,
  errorComponent: ConditionRouteError,
});

function ConditionReportPage() {
  const { id } = Route.useParams();
  const { compare } = Route.useSearch();
  return <ConditionReportScreen id={id} {...(compare ? { compare } : {})} />;
}
