/**
 * What AI is doing with a thing's photo, on the thing's header (D19, D206, screens §5 Capture and
 * Thing detail): "Naming…" while it runs, "Waiting: AI paused until 1 Oct" while a cap holds it,
 * "Waiting for Groq · about 20 s" while the provider paces it, why it failed, and, once it read
 * the photo, the AI line (what read it, the tokens, ≈ cost and who paid). Writers get "Re-run
 * extraction" (explicit only, D19, L58): never automatic.
 *
 * Nothing shows for a thing AI never touched.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { captureApi, captureKeys, useAiStatus, useExtractions } from '@/api/capture/queries';
import type { ExtractionAttempt } from '@/api/capture/types';
import { RetryIcon } from '@/components/icons';
import { useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { AiLine } from './ai-line';
import { useFailureReason } from './labels';
import { usePausedUntil } from './paused-banner';
import { useWaitingText, WaitingForProvider } from './status-line';

export function ExtractionStatus({
  thingId,
  locationId,
  canRerun,
  className,
}: {
  thingId: string;
  locationId: string;
  /** The caller may ask AI again here (`ai.capture`, with the module on). */
  canRerun: boolean;
  className?: string;
}) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const errorText = useErrorText();
  const q = useExtractions(thingId);
  const latest: ExtractionAttempt | undefined = q.data?.items[0];
  const status = useAiStatus(locationId);
  const waitingText = useWaitingText();
  const pausedUntil = usePausedUntil();
  const why = useFailureReason();
  const rerun = useMutation({
    mutationFn: () => captureApi.extract(thingId),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: captureKeys.extractions(thingId) });
      toast({ tone: 'ok', title: t`AI will read the photo again` });
    },
    onError: (e) => toast({ tone: 'danger', title: errorText(e) }),
  });
  if (!latest || latest.status === 'superseded' || latest.status === 'no_provider') return null;

  let line: ReactNode = null;
  switch (latest.status) {
    case 'queued':
    case 'running':
      line = <Trans>Naming…</Trans>;
      break;
    case 'paused_budget':
      line = latest.pausedUntil ? (
        <Trans>Waiting: {pausedUntil(latest.pausedUntil)}</Trans>
      ) : (
        <Trans>Waiting: AI is paused</Trans>
      );
      break;
    case 'waiting_provider':
      // Captured while no provider resolved: it waits for one (the inbox says the same).
      if (latest.statusReason === 'no_provider')
        return (
          <div className={className}>
            <WaitingForProvider canManage={status.data?.canManage ?? false} />
          </div>
        );
      line = (status.data && waitingText(status.data)) ?? (
        <Trans>Waiting for the AI provider</Trans>
      );
      break;
    case 'failed':
      line = latest.call ? null : (
        <Trans>Couldn't read this photo · {why('provider_error', latest.statusReason)}</Trans>
      );
      break;
    default:
      line = null;
  }
  const done = latest.status === 'succeeded' || latest.status === 'failed';
  return (
    <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1', className)}>
      {latest.call ? <AiLine call={latest.call} /> : null}
      {line ? (
        <p role="status" className="m-0 text-small text-ink-2">
          {line}
        </p>
      ) : null}
      {canRerun && done ? (
        <Button
          size="small"
          variant="ghost"
          isPending={rerun.isPending}
          onPress={() => rerun.mutate()}
          className="[&_svg]:size-4"
        >
          <RetryIcon />
          <Trans>Re-run extraction</Trans>
        </Button>
      ) : null}
    </div>
  );
}
