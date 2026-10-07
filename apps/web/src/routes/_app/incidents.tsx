/**
 * Incidents (plan T26; D158, screens §5): burglaries, fires, floods and losses, each grouping the
 * things it affected, with the insurance report and a claim pack. The parent of /incidents/$id
 * (incidents.$id.tsx): when a child matches, this renders only the child. The screen loads on
 * demand (components/incidents/lazy.tsx); its list state is in the URL (surface `incidents`).
 */
import { SURFACE_FILTER_KEYS } from '@kept/shared';
import { createFileRoute, Outlet, useChildMatches } from '@tanstack/react-router';
import { IncidentsScreen } from '@/components/incidents/lazy';
import { IncidentsRouteError } from '@/components/incidents/route-error';
import { listSearch } from '@/lib/url-state';

export const Route = createFileRoute('/_app/incidents')({
  validateSearch: listSearch(SURFACE_FILTER_KEYS.incidents),
  component: IncidentsRoute,
  errorComponent: IncidentsRouteError,
});

function IncidentsRoute() {
  if (useChildMatches().length > 0) return <Outlet />;
  return <IncidentsScreen />;
}
