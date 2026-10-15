/**
 * Moving (1.x, D39 (5), D251): your moves. The parent of /moving/$id: when a child matches, this
 * renders only the child. Precached, not on demand: the board works offline in the middle of a
 * move (components/moving/offline.ts). Its list state is in the URL (surface `moves`).
 */
import { SURFACE_FILTER_KEYS } from '@kept/shared';
import { createFileRoute, Outlet, useChildMatches } from '@tanstack/react-router';
import { MovesScreen } from '@/components/moving/moves-screen';
import { listSearch } from '@/lib/url-state';

export const Route = createFileRoute('/_app/moving')({
  validateSearch: listSearch(SURFACE_FILTER_KEYS.moves),
  component: MovingRoute,
});

function MovingRoute() {
  if (useChildMatches().length > 0) return <Outlet />;
  return <MovesScreen />;
}
