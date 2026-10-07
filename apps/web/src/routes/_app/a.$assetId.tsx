/**
 * `/a/<assetId>`, a Homebox label's asset ID (`000-001`): opened in Kept when the old Homebox
 * hostname points here (D146; plan T20). The page is components/legacy/legacy-resolve.tsx, one per
 * label (keyed), and it stays in the precache: a label opens offline.
 */
import { createFileRoute } from '@tanstack/react-router';
import { LegacyResolve } from '@/components/legacy/legacy-resolve';

export const Route = createFileRoute('/_app/a/$assetId')({ component: OldLabel });

function OldLabel() {
  const { assetId } = Route.useParams();
  return <LegacyResolve key={assetId} />;
}
