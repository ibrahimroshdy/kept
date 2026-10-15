/**
 * One move's board (1.x, D251): counts, the boxes still to unpack, every box, and the actions to
 * pack, print and unpack. The parent of /moving/$id/boxes/$boxId. Its box list's state is in the
 * URL (surface `move-boxes`); it works offline from the phone's copy.
 */
import { SURFACE_FILTER_KEYS } from '@kept/shared';
import { createFileRoute, Outlet, useChildMatches } from '@tanstack/react-router';
import { MoveScreen } from '@/components/moving/move-screen';
import { listSearch } from '@/lib/url-state';

export const Route = createFileRoute('/_app/moving/$id')({
  validateSearch: listSearch(SURFACE_FILTER_KEYS['move-boxes']),
  component: MovePage,
});

function MovePage() {
  const { id } = Route.useParams();
  if (useChildMatches().length > 0) return <Outlet />;
  return <MoveScreen key={id} id={id} />;
}
