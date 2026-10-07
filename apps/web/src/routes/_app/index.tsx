/**
 * Home (screens §5 Home, §8, §9; frame 01 · Home): what needs you, then where things are.
 *
 * In order: the Get-started checklist (D138, computed by the server), the attention panel
 * "Needs you" (D185; zero rows hidden), recent activity (3 on the phone, 5 on desktop), the
 * location cards with their Unplaced counts, and an "Invite people" card for a location that has
 * nobody else yet (D194). On desktop the checklist and the locations sit beside the rest, as in
 * the frame. First run (only the Personal location): the Personal card plus "Create your first
 * home", with no checklist, since its first step would repeat the main button (§8).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useHome } from '@/api/inventory/queries';
import { useLocations, useMe } from '@/api/queries';
import type { LocationSummary, Me } from '@/api/types';
import type { HomeResponseV5 } from '@/api/vehicles/types';
import { AiPausedAttention } from '@/components/ai/ai-attention';
import { AttentionPanel, attentionCounts } from '@/components/home/attention';
import {
  GetStarted,
  HttpsNotice,
  openStepCount,
  ShowGetStarted,
  useChecklistDismissed,
  useChecklistSync,
} from '@/components/home/checklist';
import { LocationCard, type LocationCounts } from '@/components/home/location-card';
import { QuickLog } from '@/components/home/quick-log';
import { RecentActivity } from '@/components/home/recent-activity';
import { LinkIcon, PeopleIcon, PlusIcon } from '@/components/icons';
import { PendingPrompt } from '@/components/labels/pending-prompt';
import { ErrorState, IconTile, LinkButton, LoadingRows, Page, Section } from '@/components/page';
import { toast } from '@/components/ui/toast';
import { useFormat } from '@/lib/format';
import { servedOverHttp } from '@/lib/https';

export const Route = createFileRoute('/_app/')({
  component: Home,
});

const canManage = (l: LocationSummary) => l.role === 'owner' || l.role === 'admin';

function Home() {
  const { t } = useLingui();
  const me = useMe();
  const locations = useLocations();
  const home = useHome();
  const setDismissed = useChecklistDismissed();
  const f = useFormat();
  useChecklistSync(home.data);

  if (locations.isPending || !me.data) {
    return (
      <Page title={t`Home`}>
        <LoadingRows rows={3} label={t`Loading your locations`} />
      </Page>
    );
  }
  // A failed refetch keeps the list it had (offline, the phone's last-known copy).
  if (locations.error && !locations.data) {
    return (
      <Page title={t`Home`}>
        <ErrorState error={locations.error} onRetry={() => void locations.refetch()} />
      </Page>
    );
  }

  const all = locations.data;
  const shared = all.filter((l) => l.kind !== 'personal');
  const counts = new Map<string, LocationCounts>(
    (home.data?.locations ?? []).map((l) => [l.id, l]),
  );
  const firstRun = shared.length === 0;
  const inviteFor = shared.filter(
    (l) => canManage(l) && l.memberCount <= 1 && l.pendingInviteCount === 0,
  );
  const open = home.data ? openStepCount(home.data, me.data, all) : 0;
  const dismissed = home.data?.checklist.dismissed ?? false;
  const hide = () => {
    setDismissed(true);
    toast({
      title: t`Get started hidden`,
      action: { label: t`Undo`, onAction: () => setDismissed(false) },
    });
  };

  return (
    <Page title={t`Home`} wide>
      <div className="text-[13.5px] font-medium text-ink-2">{f.today()}</div>
      {firstRun ? (
        <FirstRun me={me.data} locations={all} counts={counts} />
      ) : (
        // Phone: one column in the order above. Desktop: "Needs you" and recent activity on
        // the left across every row; the checklist, locations and invite cards on the right.
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_360px] lg:grid-rows-[auto_auto_1fr]">
          {home.data && !dismissed && open > 0 ? (
            <GetStarted
              home={home.data}
              me={me.data}
              locations={all}
              onHide={hide}
              className="lg:col-start-2"
            />
          ) : null}
          <div className="grid content-start gap-5 lg:col-start-1 lg:row-span-3 lg:row-start-1">
            <AiPausedAttention locations={all} />
            <PendingPrompt />
            {/* Quick log (screens §6, T19): Home's count of metered things you can log on. */}
            <QuickLog meteredThings={(home.data as HomeResponseV5 | undefined)?.meteredThings} />
            {home.isPending ? (
              // Waiting for a connection (a cold start offline): the sync line says so.
              home.fetchStatus === 'paused' ? null : (
                <LoadingRows rows={3} label={t`Loading what needs you`} />
              )
            ) : home.error ? (
              <ErrorState error={home.error} onRetry={() => void home.refetch()} />
            ) : (
              <AttentionPanel
                counts={attentionCounts(home.data.attention)}
                inbox={home.data.counts?.inbox ?? 0}
                home={home.data}
              />
            )}
            <RecentActivity />
          </div>
          <Section
            title={<Trans>Locations</Trans>}
            className="lg:col-start-2"
            action={
              <Link
                to="/locations/new"
                className="inline-flex min-h-11 items-center gap-1 text-[13px] font-semibold text-ink-2 outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-info"
              >
                <PlusIcon className="size-4" />
                <Trans>New location</Trans>
              </Link>
            }
          >
            <div className="grid gap-2.5">
              {all.map((l) => (
                <LocationCard key={l.id} location={l} counts={counts.get(l.id)} />
              ))}
            </div>
            {dismissed && open > 0 ? <ShowGetStarted onShow={() => setDismissed(false)} /> : null}
          </Section>
          {inviteFor.length > 0 ? (
            <div className="grid content-start gap-2.5 lg:col-start-2">
              {inviteFor.map((l) => (
                <InviteCard key={l.id} location={l} />
              ))}
            </div>
          ) : null}
        </div>
      )}
    </Page>
  );
}

// ----- first run -------------------------------------------------------------------------------

function BoxArt() {
  return (
    <svg viewBox="0 0 140 110" width="140" height="110" aria-hidden="true" className="text-ink-2">
      <path
        d="M20 38 70 18l50 20v50L70 106 20 88Z"
        fill="var(--surface)"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <path
        d="M20 38l50 20 50-20M70 58v48M20 38 6 22l50-18 14 14M120 38l14-16-50-18-14 14"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <rect
        x="34"
        y="66"
        width="30"
        height="11"
        rx="2"
        fill="#F0B03A"
        transform="rotate(20 49 71)"
      />
    </svg>
  );
}

function FirstRun({
  me,
  locations,
  counts,
}: {
  me: Me;
  locations: LocationSummary[];
  counts: Map<string, LocationCounts>;
}) {
  const name = me.user.displayName;
  return (
    <div className="mx-auto grid w-full max-w-xl gap-5">
      {me.user.instanceAdmin && servedOverHttp() ? <HttpsNotice /> : null}
      <div className="grid justify-items-center gap-3 px-2 pt-2 text-center">
        <BoxArt />
        <h2 className="m-0 font-semibold text-[24px] leading-tight text-ink">
          <Trans>Welcome, {name}</Trans>
        </h2>
        <p className="m-0 max-w-md text-ink-2">
          <Trans>
            Your Personal location is ready for what's on you: keys, wallet, phone. Now add the
            place you live. It comes with the usual rooms, and you can change them.
          </Trans>
        </p>
        <LinkButton to="/locations/new" variant="primary" className="w-full sm:w-auto sm:px-8">
          <PlusIcon />
          <Trans>Create your first home</Trans>
        </LinkButton>
      </div>
      <Section title={<Trans>Locations</Trans>}>
        {locations.map((l) => (
          <LocationCard key={l.id} location={l} counts={counts.get(l.id)} />
        ))}
      </Section>
      <Section title={<Trans>Or</Trans>}>
        <div className="flex items-start gap-3 rounded-[10px] border border-line bg-surface p-3.5">
          <IconTile>
            <LinkIcon />
          </IconTile>
          <div className="grid gap-0.5">
            <div className="font-semibold text-[15px]">
              <Trans>Joining someone's Kept?</Trans>
            </div>
            <div className="text-small text-ink-2">
              <Trans>
                Open the invite link they sent you, or scan its QR code with this phone's camera.
              </Trans>
            </div>
          </div>
        </div>
      </Section>
    </div>
  );
}

// ----- cards -----------------------------------------------------------------------------------

function InviteCard({ location }: { location: LocationSummary }) {
  const name = location.name;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-[10px] border border-line bg-surface p-3.5">
      <IconTile>
        <PeopleIcon />
      </IconTile>
      <div className="grid min-w-0 flex-1 gap-0.5">
        <div className="font-semibold text-[15px]">
          <Trans>Invite people to {name}</Trans>
        </div>
        <div className="text-small text-ink-2">
          <Trans>Share a link or a QR code. Choose what they can do and for how long.</Trans>
        </div>
      </div>
      <LinkButton
        to="/settings/location/$id/invite"
        params={{ id: location.id }}
        variant="primary"
        size="small"
      >
        <Trans>Invite</Trans>
      </LinkButton>
    </div>
  );
}
