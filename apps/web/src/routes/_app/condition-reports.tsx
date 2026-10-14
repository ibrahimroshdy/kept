/**
 * Condition reports (1.x, D171, D174; D235): the move-in and move-out walk-throughs of your
 * locations. The parent of /condition-reports/$id: when a child matches, this renders only the
 * child. It reads the server, so it loads on demand (vite.config.ts); its list state is in the URL
 * (surface `condition-reports`).
 */
import { SURFACE_FILTER_KEYS } from '@kept/shared';
import { createFileRoute, Outlet, useChildMatches } from '@tanstack/react-router';
import { ConditionReportsScreen } from '@/components/condition/reports-screen';
import { ConditionRouteError } from '@/components/on-demand-route-error';
import { listSearch } from '@/lib/url-state';

export const Route = createFileRoute('/_app/condition-reports')({
  validateSearch: listSearch(SURFACE_FILTER_KEYS['condition-reports']),
  component: ConditionReportsRoute,
  errorComponent: ConditionRouteError,
});

function ConditionReportsRoute() {
  if (useChildMatches().length > 0) return <Outlet />;
  return <ConditionReportsScreen />;
}
