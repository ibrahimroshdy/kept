/**
 * Location settings → "AI here" (D206, screens §5 Settings → Location): beside the AI capture and
 * assistant switch, who pays for AI in this location, its monthly cap inside the account's (the
 * owner sets it; its admins read it), and a link to its usage. There is no per-location key.
 */
import { Trans } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';
import { useAiStatus } from '@/api/capture/queries';
import { useAccounts } from '@/api/inventory/queries';
import type { LocationDetail } from '@/api/types';
import { ChartIcon } from '@/components/icons';
import { useLocationName } from '@/lib/labels';
import { Caps } from './caps';
import { PausedBanner } from './paused-banner';
import { PaidByLine } from './status-line';

export function AiHere({ location }: { location: LocationDetail }) {
  const status = useAiStatus(location.id);
  const accounts = useAccounts();
  const name = useLocationName()(location);
  const owner =
    accounts.data?.accounts.find((a) => a.id === location.ownerAccountId)?.ownerDisplayName ?? null;
  const admin = location.role === 'owner' || location.role === 'admin';
  return (
    <div className="grid gap-3">
      {status.data?.pausedUntil ? <PausedBanner status={status.data} /> : null}
      {status.data ? (
        <p className="m-0 text-small text-ink-2">
          <PaidByLine status={status.data} owner={owner} locationName={name} />
        </p>
      ) : null}
      {admin ? (
        <>
          <Caps
            scope="location"
            locationId={location.id}
            locations={[{ id: location.id, name }]}
            canPause={false}
          />
          <Link
            to="/settings/ai/usage"
            search={{ scope: 'location', location: location.id }}
            className="inline-flex items-center gap-1.5 justify-self-start font-semibold text-ink underline underline-offset-2 outline-none focus-visible:outline-2 focus-visible:outline-info [&_svg]:size-4"
          >
            <ChartIcon aria-hidden="true" />
            <Trans>AI usage in {name}</Trans>
          </Link>
        </>
      ) : null}
    </div>
  );
}
