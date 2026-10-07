/**
 * The box check (plan T26; D40, screens §6): tick what's in the box, count what's short. The
 * screen is components/boxcheck/box-check-screen.tsx; this route gives it the offline store and
 * goes back to the box when it is done.
 */
import { useLingui } from '@lingui/react/macro';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { BoxCheckScreen } from '@/components/boxcheck/box-check-screen';
import { LoadingRows } from '@/components/page';
import { useKick, useScanStore } from '@/components/scan/use-scan-store';

export const Route = createFileRoute('/_app/box-check/$id')({ component: BoxCheckPage });

function BoxCheckPage() {
  const { t } = useLingui();
  const { id } = Route.useParams();
  const store = useScanStore();
  const kick = useKick();
  const navigate = useNavigate();
  if (!store) return <LoadingRows rows={4} label={t`Loading the box`} />;
  return (
    <BoxCheckScreen
      key={id}
      containerId={id}
      store={store}
      onQueued={kick}
      onExit={() => void navigate({ to: '/t/$id', params: { id } })}
    />
  );
}
