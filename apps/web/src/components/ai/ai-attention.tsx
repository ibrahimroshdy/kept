/**
 * Home's "AI paused · Resume" row (D206, screens §5 "AI paused and waiting"): for whoever can
 * resume, one row per pausing cap, styled like the attention panel's rows, opening the Resume sheet.
 * Everyone else learns about the pause where AI would act (Capture, the inbox, drafts).
 */
import { Trans } from '@lingui/react/macro';
import { useQueries } from '@tanstack/react-query';
import { useState } from 'react';
import { captureApi, captureKeys } from '@/api/capture/queries';
import type { AiStatus } from '@/api/capture/types';
import type { LocationSummary } from '@/api/types';
import { AlertIcon } from '@/components/icons';
import { IconTile } from '@/components/page';
import { Button } from '@/components/ui/button';
import { usePausedUntil, usePauseReason } from './paused-banner';
import { ResumeSheet } from './resume-sheet';

function PausedRow({ status }: { status: AiStatus }) {
  const [open, setOpen] = useState(false);
  const until = usePausedUntil();
  const reason = usePauseReason();
  return (
    <li className="flex min-h-16 flex-wrap items-center gap-3 px-3.5 py-3">
      <IconTile className="text-warn">
        <AlertIcon />
      </IconTile>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="font-semibold text-[15px] text-ink leading-snug">
          {until(status.pausedUntil ?? '')}
        </span>
        <span className="text-small text-ink-2">{reason(status)}</span>
      </span>
      <Button size="small" variant="secondary" onPress={() => setOpen(true)}>
        <Trans>Resume</Trans>
      </Button>
      <ResumeSheet status={status} isOpen={open} onOpenChange={setOpen} />
    </li>
  );
}

export function AiPausedAttention({ locations }: { locations: LocationSummary[] }) {
  const owned = locations.filter((l) => l.role === 'owner');
  const statuses = useQueries({
    queries: owned.map((l) => ({
      queryKey: captureKeys.ai.status(l.id),
      queryFn: () => captureApi.aiStatus(l.id),
    })),
  });
  const seen = new Set<string>();
  const paused = statuses
    .map((s) => s.data)
    .filter((s): s is AiStatus => !!s?.pausedUntil && s.canResume)
    .filter((s) => {
      const key = `${s.pausedBy?.scope}:${s.pausedBy?.label}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (paused.length === 0) return null;
  return (
    <ul
      aria-live="polite"
      className="m-0 grid list-none overflow-hidden rounded-[10px] border border-warn bg-surface p-0 [&>li+li]:border-line [&>li+li]:border-t"
    >
      {paused.map((s) => (
        <PausedRow key={`${s.pausedBy?.scope}:${s.pausedBy?.label}`} status={s} />
      ))}
    </ul>
  );
}
