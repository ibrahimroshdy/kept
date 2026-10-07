/**
 * AI's state in one line (D206, screens §3 and §5 "AI paused and waiting"):
 *
 * - `useWaitingText(status)`: the progress line's words while work waits on the provider, never a
 *   banner: "Waiting for Groq · about 20 s", "Groq isn't answering · retrying at 14:05", and "Groq
 *   rejected the key · Replace key" (managers) or "AI isn't working here · ask Alfred" (others).
 * - `<KeyTrouble>`: the same for a rejected key or a provider that's down, as a notice on AI
 *   settings, with "Replace key" for managers.
 * - `<PaidByLine>`: who pays for AI in a location, for members and viewers ("AI here is paid by
 *   Ibrahim's account"), with no key and no money in it.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { AiStatus } from '@/api/capture/types';
import { Notice } from '@/components/page';
import { useFormat } from '@/lib/format';
import { useProviderName } from './labels';
import { useClock } from './paused-banner';

/** Seconds from now to `iso`, at least 1. */
const secondsUntil = (iso: string, now = Date.now()) =>
  Math.max(1, Math.round((new Date(iso).getTime() - now) / 1000));

/**
 * The progress line for work held by the provider (`status.waitingProvider`), or null when
 * nothing waits. A rate limit is "Waiting for Groq · about 20 s"; it is not a pause (§8a).
 */
export function useWaitingText(): (status: AiStatus) => string | null {
  const { t } = useLingui();
  const fmt = useFormat();
  const clock = useClock();
  const providerName = useProviderName();
  return (s) => {
    const w = s.waitingProvider;
    if (!w) return null;
    const provider = providerName(s.providerKind);
    switch (w.reason) {
      case 'rate_limited':
      case 'limits': {
        const secs = fmt.num(secondsUntil(w.until));
        return t`Waiting for ${provider} · about ${secs} s`;
      }
      case 'provider_down': {
        const at = clock(w.until);
        return t`${provider} isn't answering · retrying at ${at}`;
      }
      case 'auth': {
        if (s.canManage) return t`${provider} rejected the key · Replace key`;
        const who = s.manager?.displayName;
        return who ? t`AI isn't working here · ask ${who}` : t`AI isn't working here`;
      }
    }
  };
}

/** A rejected key or a provider that's down, on AI settings (the rate limit alone is not shown). */
export function KeyTrouble({ status, action }: { status: AiStatus; action?: ReactNode }) {
  const text = useWaitingText();
  const w = status.waitingProvider;
  if (!w || (w.reason !== 'auth' && w.reason !== 'provider_down')) return null;
  return (
    <Notice tone={w.reason === 'auth' ? 'danger' : 'warn'} title={text(status)} action={action} />
  );
}

/** "AI here is paid by Ibrahim's account": the line members and viewers get (screens §5). */
export function PaidByLine({
  status,
  owner,
  locationName,
}: {
  status: AiStatus;
  /** The location's owner, for "paid by Ibrahim's account". */
  owner: string | null;
  locationName: string;
}) {
  if (!status.resolved)
    return (
      <Trans>
        AI is off in <bdi>{locationName}</bdi>: no AI provider is connected.
      </Trans>
    );
  if (status.source === 'instance')
    return (
      <Trans>
        AI in <bdi>{locationName}</bdi> uses this server's key.
      </Trans>
    );
  if (status.source === 'user')
    return (
      <Trans>
        AI in <bdi>{locationName}</bdi> uses a personal key.
      </Trans>
    );
  return owner ? (
    <Trans>
      AI in <bdi>{locationName}</bdi> is paid by <bdi>{owner}</bdi>'s account.
    </Trans>
  ) : (
    <Trans>
      AI in <bdi>{locationName}</bdi> is paid by its owner's account.
    </Trans>
  );
}

/** "Waiting for an AI provider · Connect one in Settings → AI" (or who to ask). */
export function WaitingForProvider({ canManage }: { canManage: boolean }) {
  return (
    <p className="m-0 text-small text-ink-2 [text-wrap:pretty]">
      {canManage ? (
        <Trans>
          Waiting for an AI provider ·{' '}
          <Link
            to="/settings/ai"
            className="font-semibold text-ink underline underline-offset-2 outline-none focus-visible:outline-2 focus-visible:outline-info"
          >
            Connect one in Settings → AI
          </Link>
        </Trans>
      ) : (
        <Trans>Waiting for an AI provider · ask an admin to connect one</Trans>
      )}
    </p>
  );
}
