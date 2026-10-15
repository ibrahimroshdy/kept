/**
 * Home (screens §5 Home, §8, §9; frame 01 · Home; D240, the approved Home design): what needs
 * you, then where things are.
 *
 * In order: the date; Get started as one line (D138, computed by the server); the AI-paused and
 * pending-label banners; "Needs you" as count tiles (D185, D240); Shortcuts; the location cards
 * with their map previews, flags and value; an "Invite people" card for a location that has
 * nobody else yet (D194); recent activity with its chips and Photos to review; and the Insights
 * teaser where Money is on (D234).
 *
 * Layout: one column on a phone, in that order, nothing cut off. On a wide Home (the `home`
 * container, 860 px and up) Get started and Needs you span the page; the locations, invites and
 * recent activity fill the main column; Shortcuts and Insights the side column.
 *
 * First run (only the Personal location): the welcome with "Create your first home" and the steps
 * after it, the Personal card, the shortcuts that already work and an empty Recent that says what
 * will show there; no checklist, since its first step would repeat the main button, and no Needs
 * you or Insights until there is something to count (§8).
 *
 * Reads: `/home` (the shell's, shared), `/home/overview` (Home's own), the activity feed, and the
 * inbox's first four items only while some wait.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useHome, useHomeOverview } from '@/api/inventory/queries';
import type { ChecklistKey } from '@/api/inventory/types';
import { useLocations, useMe } from '@/api/queries';
import type { LocationSummary, Me } from '@/api/types';
import type { HomeResponseV5 } from '@/api/vehicles/types';
import { AiPausedAttention } from '@/components/ai/ai-attention';
import { NeedsYou } from '@/components/home/attention';
import {
  GetStarted,
  HttpsNotice,
  openStepCount,
  useChecklistDismissed,
  useChecklistSync,
} from '@/components/home/checklist';
import { InsightsTeaser } from '@/components/home/insights-teaser';
import {
  LocationCard,
  type LocationCounts,
  type LocationOverview,
} from '@/components/home/location-card';
import { RecentActivity } from '@/components/home/recent-activity';
import { HomeSection, SectionLink } from '@/components/home/section';
import { Shortcuts } from '@/components/home/shortcuts';
import { LinkIcon, PeopleIcon, PlusIcon } from '@/components/icons';
import { PendingPrompt } from '@/components/labels/pending-prompt';
import { ErrorState, IconTile, LinkButton, LoadingRows, Page } from '@/components/page';
import { toast } from '@/components/ui/toast';
import { sep, useFormat } from '@/lib/format';
import { servedOverHttp } from '@/lib/https';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/_app/')({
  component: Home,
});

const canManage = (l: LocationSummary) => l.role === 'owner' || l.role === 'admin';

/** On a wide Home: across both columns. */
const FULL = '@min-[860px]/home:col-span-full';
/** A column: on a phone its children join the page's one column, each in its own order. */
const COLUMN =
  'contents @min-[860px]/home:order-9 @min-[860px]/home:grid @min-[860px]/home:content-start @min-[860px]/home:gap-5';

function Home() {
  const { t } = useLingui();
  const me = useMe();
  const locations = useLocations();
  const home = useHome();
  const overview = useHomeOverview();
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
  const cards = new Map<string, LocationOverview>(
    (overview.data?.locations ?? []).map((l) => [l.id, l]),
  );
  const firstRun = shared.length === 0;
  const inviteFor = shared.filter(
    (l) => canManage(l) && l.memberCount <= 1 && l.pendingInviteCount === 0,
  );
  const open = home.data ? openStepCount(home.data, me.data, all) : 0;
  const dismissed = home.data?.checklist.dismissed ?? false;
  const metered = (home.data as HomeResponseV5 | undefined)?.meteredThings;
  const inbox = home.data?.counts?.inbox ?? 0;
  const readings = Math.max(0, (home.data?.attention.toReview ?? 0) - inbox);
  const hide = () => {
    setDismissed(true);
    toast({
      title: t`Get started hidden. Help brings it back.`,
      action: { label: t`Undo`, onAction: () => setDismissed(false) },
    });
  };

  const locationsSection = (
    <HomeSection
      title={<Trans>Locations</Trans>}
      action={
        <SectionLink to="/locations/new">
          <PlusIcon />
          <Trans>New location</Trans>
        </SectionLink>
      }
      className="order-5"
    >
      <div
        className="grid grid-cols-[minmax(0,1fr)] gap-2.5 @min-[600px]/home:grid-cols-2"
        data-tour="home-locations"
      >
        {all.map((l) => (
          <LocationCard
            key={l.id}
            location={l}
            counts={counts.get(l.id)}
            overview={cards.get(l.id)}
          />
        ))}
        {firstRun ? (
          <Link
            to="/locations/new"
            className="flex min-h-[104px] items-center justify-center gap-2 rounded-xl border border-line border-dashed font-semibold text-[14px] text-ink-2 outline-none hover:border-ink-3 hover:text-ink focus-visible:outline-2 focus-visible:outline-info [&_svg]:size-5"
          >
            <PlusIcon />
            <Trans>New location</Trans>
          </Link>
        ) : null}
      </div>
    </HomeSection>
  );

  return (
    <Page title={t`Home`} wide>
      <div className="@container/home">
        <div className="grid items-start gap-5 @min-[860px]/home:grid-cols-[minmax(0,1fr)_316px] @min-[860px]/home:gap-x-6">
          <div className={cn('order-0 -mb-1.5 font-medium text-[13.5px] text-ink-2', FULL)}>
            {f.today()}
          </div>
          {firstRun ? (
            <>
              <FirstRun
                me={me.data}
                steps={home.data?.checklist.items}
                className={cn('order-1', FULL)}
              />
              <div className={COLUMN}>
                {locationsSection}
                <RecentActivity className="order-7" />
              </div>
              <div className={cn(COLUMN, '@min-[860px]/home:col-start-2')}>
                <Shortcuts locations={all} meteredThings={metered} className="order-4" />
              </div>
            </>
          ) : (
            <>
              {home.data && !dismissed && open > 0 ? (
                <GetStarted
                  home={home.data}
                  me={me.data}
                  locations={all}
                  onHide={hide}
                  className={cn('order-1', FULL)}
                />
              ) : null}
              <div className={cn('order-2 grid gap-3 empty:hidden', FULL)}>
                <AiPausedAttention locations={all} />
                <PendingPrompt />
              </div>
              {home.isPending ? (
                // Waiting for a connection (a cold start offline): the sync line says so.
                home.fetchStatus === 'paused' ? null : (
                  <div className={cn('order-3', FULL)}>
                    <LoadingRows rows={2} label={t`Loading what needs you`} />
                  </div>
                )
              ) : home.error ? (
                <div className={cn('order-3', FULL)}>
                  <ErrorState error={home.error} onRetry={() => void home.refetch()} />
                </div>
              ) : (
                <NeedsYou
                  home={home.data}
                  overview={overview.data}
                  className={cn('order-3', FULL)}
                />
              )}
              <div className={COLUMN}>
                {locationsSection}
                {inviteFor.length > 0 ? (
                  <div className="order-6 grid content-start gap-2.5">
                    {inviteFor.map((l) => (
                      <InviteCard key={l.id} location={l} />
                    ))}
                  </div>
                ) : null}
                <RecentActivity inbox={inbox} readings={readings} className="order-7" />
              </div>
              <div className={cn(COLUMN, '@min-[860px]/home:col-start-2')}>
                <Shortcuts locations={all} meteredThings={metered} className="order-4" />
                {overview.data?.insights ? (
                  <InsightsTeaser insights={overview.data.insights} className="order-8" />
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>
    </Page>
  );
}

// ----- first run -------------------------------------------------------------------------------

function BoxArt({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 140 110"
      width="140"
      height="110"
      aria-hidden="true"
      className={cn('text-ink-2', className)}
    >
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

/** The steps after the first home, as the checklist will list them, in a few words each. */
function useThenSteps(): Partial<Record<ChecklistKey, string>> {
  const { t } = useLingui();
  return {
    threeThings: t`add 3 things`,
    labelPrinted: t`print a label`,
    invited: t`invite someone`,
    aiConnected: t`connect AI`,
    installed: t`install on your phone`,
  };
}

function FirstRun({
  me,
  steps,
  className,
}: {
  me: Me;
  /** `/home`'s checklist: what comes after "Create your first home". */
  steps?: { key: ChecklistKey; done: boolean }[] | undefined;
  className?: string;
}) {
  const { t } = useLingui();
  const words = useThenSteps();
  const name = me.user.displayName;
  // Invited members and Essentials have fewer steps; the server knows which (D191).
  const after = (steps ?? [])
    .filter((s) => s.key !== 'locationCreated' && !s.done)
    .flatMap((s) => {
      const w = words[s.key];
      return w ? [w] : [];
    })
    .join(sep());
  return (
    <div className={cn('grid gap-3', className)}>
      {me.user.instanceAdmin && servedOverHttp() ? <HttpsNotice /> : null}
      <section
        aria-labelledby="welcome"
        className={cn(
          'grid grid-cols-[minmax(0,1fr)] justify-items-center gap-3 rounded-xl border border-line bg-surface px-4 py-5 text-center',
          '@min-[860px]/home:grid-cols-[150px_minmax(0,1fr)] @min-[860px]/home:justify-items-start @min-[860px]/home:gap-x-6 @min-[860px]/home:p-6 @min-[860px]/home:text-start',
        )}
      >
        <BoxArt className="@min-[860px]/home:row-span-5 @min-[860px]/home:self-center" />
        <h2 id="welcome" className="m-0 font-semibold text-[22px] leading-tight text-ink">
          <Trans>Welcome, {name}</Trans>
        </h2>
        <p className="m-0 max-w-[34rem] text-ink-2">
          <Trans>
            Your Personal location is ready for what's on you: keys, wallet, phone. Now add the
            place you live. It comes with the usual rooms, and you can change them.
          </Trans>
        </p>
        <LinkButton
          to="/locations/new"
          variant="primary"
          className="w-full @min-[480px]/home:w-auto @min-[480px]/home:px-[22px]"
        >
          <PlusIcon />
          <Trans>Create your first home</Trans>
        </LinkButton>
        {after ? <span className="text-[13px] text-ink-3">{t`Then: ${after}`}</span> : null}
        <div className="mt-1 flex w-full max-w-[34rem] items-start gap-3 border-line border-t pt-3.5 text-start">
          <IconTile>
            <LinkIcon />
          </IconTile>
          <div className="grid gap-0.5">
            <div className="font-semibold text-[14px]">
              <Trans>Joining someone's Kept?</Trans>
            </div>
            <div className="text-[13px] text-ink-2">
              <Trans>
                Open the invite link they sent you, or scan its QR code with this phone's camera.
              </Trans>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

// ----- cards -----------------------------------------------------------------------------------

function InviteCard({ location }: { location: LocationSummary }) {
  const name = location.name;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface p-3.5">
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
