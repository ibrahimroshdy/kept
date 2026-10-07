/**
 * One assistant thread on its own page (D23; screens §2 `/assistant/<thread>`): the same
 * conversation as the sheet and the docked panel (assistant/conversation.tsx), with the thread's
 * title, Delete, and the way back to your threads. A thread that isn't yours, or is gone, is not
 * found (private even from admins, D23). Its chunk loads on demand from assets/household/
 * (vite.config.ts).
 */
import { useLingui } from '@lingui/react/macro';
import { createFileRoute, type ErrorComponentProps, useNavigate } from '@tanstack/react-router';
import { useThread } from '@/api/assistant/queries';
import { Conversation } from '@/assistant/conversation';
import { useDeleteThread } from '@/assistant/threads-list';
import { TrashIcon } from '@/components/icons';
import { HouseholdRouteError } from '@/components/notifications/route-error';
import { ErrorState, Page } from '@/components/page';
import { Button } from '@/components/ui/button';
import { useOnline } from '@/lib/online';

export const Route = createFileRoute('/_app/assistant/$threadId')({
  component: ThreadPage,
  errorComponent: RouteError,
});

function ThreadPage() {
  const { threadId } = Route.useParams();
  const { t } = useLingui();
  const online = useOnline();
  const navigate = useNavigate();
  const thread = useThread(threadId);
  const askDelete = useDeleteThread(() => void navigate({ to: '/assistant' }));
  const summary = thread.data?.thread;
  const title = summary?.title ?? t`Assistant`;
  return (
    <Page
      title={<bdi>{title}</bdi>}
      back="/assistant"
      actions={
        summary ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label={t`Delete this thread`}
            isDisabled={!online}
            onPress={() => void askDelete(summary)}
          >
            <TrashIcon />
          </Button>
        ) : null
      }
    >
      {thread.isError ? (
        <ErrorState error={thread.error} onRetry={() => void thread.refetch()} />
      ) : (
        <div className="flex h-[calc(100dvh-11rem)] min-h-[420px] flex-col overflow-hidden rounded-[10px] border border-line bg-surface md:h-[calc(100dvh-9rem)]">
          <Conversation threadId={threadId} page={null} />
        </div>
      )}
    </Page>
  );
}

/** Offline before the page's first load: "Needs a connection", in the page's frame. */
function RouteError(props: ErrorComponentProps) {
  const { t } = useLingui();
  return <HouseholdRouteError {...props} title={t`Assistant`} />;
}
