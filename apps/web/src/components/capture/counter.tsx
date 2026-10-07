/**
 * "12 captured", and where the queue is: "Offline · 8 waiting to sync" (D17, D36). Each shutter
 * press is announced politely: "Captured. 8 waiting to sync" (screens §4); once the queue has
 * synced the live region empties, so it never keeps saying something that's no longer true (T28).
 */
import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { CloudOffIcon } from '@/components/icons';

export function Counter({
  captured,
  waiting,
  online,
  announce,
}: {
  captured: number;
  waiting: number;
  online: boolean;
  /** Bumped after each capture, so the live region speaks again. */
  announce: number;
}) {
  const { t } = useLingui();
  const count = plural(captured, { one: '# captured', other: '# captured' });
  const queue = plural(waiting, { one: '# waiting to sync', other: '# waiting to sync' });
  // The capture whose announcement the synced queue has emptied.
  const [synced, setSynced] = useState(0);
  useEffect(() => {
    if (waiting === 0) setSynced(announce);
  }, [waiting, announce]);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="font-semibold text-[14px] tabular-nums">{count}</span>
      {!online || waiting > 0 ? (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[#34302A] bg-[#26231F] px-2.5 py-[7px] font-medium text-[12.5px] leading-none [&_svg]:size-[15px]">
          {online ? null : <CloudOffIcon />}
          {online ? queue : t`Offline · ${queue}`}
        </span>
      ) : null}
      <span role="status" aria-live="polite" className="sr-only">
        {announce > 0 && synced !== announce ? `${t`Captured.`} ${queue}` : ''}
        <span hidden>{announce}</span>
      </span>
    </div>
  );
}
