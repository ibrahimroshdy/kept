/**
 * `/location/<uuid>`, a Homebox location's label: opened in Kept when the old Homebox hostname
 * points here (D146; plan T20). The page is components/legacy/legacy-resolve.tsx, one per label
 * (keyed).
 */
import { createFileRoute } from '@tanstack/react-router';
import { LegacyResolve } from '@/components/legacy/legacy-resolve';

export const Route = createFileRoute('/_app/location/$uuid')({ component: OldLabel });

function OldLabel() {
  const { uuid } = Route.useParams();
  return <LegacyResolve key={uuid} />;
}
