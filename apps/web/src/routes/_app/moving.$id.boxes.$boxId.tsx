/**
 * One box of a move (1.x, D251): where it is and where it goes, what is inside, its state, and
 * Unpack. Works offline from the phone's copy of the board.
 */
import { createFileRoute } from '@tanstack/react-router';
import { BoxScreen } from '@/components/moving/box-screen';

export const Route = createFileRoute('/_app/moving/$id/boxes/$boxId')({
  component: BoxPage,
});

function BoxPage() {
  const { id, boxId } = Route.useParams();
  return <BoxScreen key={boxId} moveId={id} boxId={boxId} />;
}
