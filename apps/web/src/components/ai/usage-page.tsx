/**
 * AI usage (D206, screens §5 "AI usage"): how much AI was used, what it cost, who paid, and every
 * call. One page per scope: **Me** (everyone) · each **location** you administer · **Account**
 * (its owner) at `/settings/ai/usage?scope=…&location=<id>`, and **Instance** at `/admin/ai/usage`
 * (per-account totals and the calls the instance key paid, with no location detail). The switch
 * shows only the scopes you have.
 *
 * In order: the paused banner; the period (This month "so far" · Last month · Last 3 months ·
 * Custom, on Kept's calendar); totals and the caps; charts with their tables; outcome counts that
 * filter the list; and the call list on the filter strip with Export CSV. Periods are calendar
 * months in UTC, as caps are (D188). Everything is in the URL.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useQueries } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { type ReactNode, useRef } from 'react';
import { captureApi, captureKeys, useAiUsage } from '@/api/capture/queries';
import type { AiScope } from '@/api/capture/types';
import { useLocations } from '@/api/queries';
import type { LocationSummary } from '@/api/types';
import { stripTabClass, tabStripClass, useCurrentTabInView } from '@/components/link-tabs';
import { ErrorState, LoadingRows } from '@/components/page';
import { DatePicker } from '@/components/ui/date-picker';
import { Segmented } from '@/components/ui/segmented';
import { useLocationName } from '@/lib/labels';
import { CallList } from './call-list';
import { PausedBanner } from './paused-banner';
import { DayChart, GroupChart } from './usage-charts';
import { OutcomeCounts, UsageTotals } from './usage-totals';

export type Period = 'month' | 'last' | 'quarter' | 'custom';

const monthStart = (d: Date, plus = 0) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + plus, 1)).toISOString();

/** A period's bounds: `from` inclusive, `to` exclusive, calendar months in UTC (D188). */
export function periodBounds(
  period: Period,
  custom: { from?: string; to?: string },
  now = new Date(),
): { from: string; to: string; soFar: boolean } {
  switch (period) {
    case 'last':
      return { from: monthStart(now, -1), to: monthStart(now), soFar: false };
    case 'quarter':
      return { from: monthStart(now, -2), to: monthStart(now, 1), soFar: true };
    case 'custom': {
      const from = custom.from ? `${custom.from}T00:00:00.000Z` : monthStart(now);
      const to = custom.to
        ? new Date(new Date(`${custom.to}T00:00:00.000Z`).getTime() + 86_400_000).toISOString()
        : monthStart(now, 1);
      return { from, to, soFar: to > now.toISOString() };
    }
    default:
      return { from: monthStart(now), to: monthStart(now, 1), soFar: true };
  }
}

type UsageSearch = {
  scope?: string;
  location?: string;
  period?: string;
  from?: string;
  to?: string;
};

type ScopeTab = { key: string; scope: AiScope; locationId?: string; label: ReactNode };

/** The scopes the caller has: Me; each location they administer; Account if they own a home. */
export function useUsageScopes(locations: LocationSummary[]): ScopeTab[] {
  const nameOf = useLocationName();
  const admin = locations.filter((l) => l.role === 'owner' || l.role === 'admin');
  const owns = locations.some((l) => l.role === 'owner' && l.kind !== 'personal');
  return [
    { key: 'me', scope: 'me', label: <Trans>Me</Trans> },
    ...admin
      .filter((l) => l.kind !== 'personal')
      .map((l) => ({
        key: `location:${l.id}`,
        scope: 'location' as const,
        locationId: l.id,
        label: <bdi>{nameOf(l)}</bdi>,
      })),
    ...(owns ? [{ key: 'account', scope: 'account' as const, label: <Trans>Account</Trans> }] : []),
  ];
}

function ScopeSwitch({ tabs, current }: { tabs: ScopeTab[]; current: string }) {
  const { t } = useLingui();
  const strip = useRef<HTMLDivElement>(null);
  useCurrentTabInView(strip, current);
  return (
    <nav aria-label={t`Whose usage`} className="min-w-0">
      <div ref={strip} className={tabStripClass}>
        {tabs.map((tab) => (
          <Link
            key={tab.key}
            to="/settings/ai/usage"
            search={{
              scope: tab.scope,
              ...(tab.locationId ? { location: tab.locationId } : {}),
            }}
            aria-current={tab.key === current ? 'page' : undefined}
            className={`${stripTabClass} hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-info aria-[current=page]:border-amber aria-[current=page]:text-ink`}
          >
            {tab.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}

function PeriodPicker({ search }: { search: UsageSearch }) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const period = (search.period as Period | undefined) ?? 'month';
  const set = (patch: UsageSearch) =>
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
      replace: true,
    });
  return (
    <div className="grid gap-3">
      <Segmented<Period>
        label={<Trans>Period</Trans>}
        value={period}
        onChange={(p) => set({ period: p === 'month' ? undefined : p })}
        options={[
          { id: 'month', label: t`This month` },
          { id: 'last', label: t`Last month` },
          { id: 'quarter', label: t`Last 3 months` },
          { id: 'custom', label: t`Custom` },
        ]}
      />
      {period === 'custom' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <DatePicker
            label={<Trans>From</Trans>}
            value={search.from ?? null}
            onChange={(from) => set({ from: from ?? undefined })}
          />
          <DatePicker
            label={<Trans>To</Trans>}
            value={search.to ?? null}
            onChange={(to) => set({ to: to ?? undefined })}
          />
        </div>
      ) : null}
    </div>
  );
}

/** The pause state of the locations a scope covers. */
function PausedBanners({ locationIds }: { locationIds: string[] }) {
  const statuses = useQueries({
    queries: locationIds.map((id) => ({
      queryKey: captureKeys.ai.status(id),
      queryFn: () => captureApi.aiStatus(id),
    })),
  });
  const seen = new Set<string>();
  return (
    <>
      {statuses.map((s, i) => {
        const status = s.data;
        if (!status?.pausedUntil) return null;
        // One banner per pausing cap, however many locations it covers.
        const key = `${status.pausedBy?.scope}:${status.pausedBy?.label}`;
        if (seen.has(key)) return null;
        seen.add(key);
        return <PausedBanner key={locationIds[i]} status={status} />;
      })}
    </>
  );
}

function UsageBody({
  scope,
  locationId,
  search,
}: {
  scope: AiScope;
  locationId?: string;
  search: UsageSearch;
}) {
  const { t } = useLingui();
  const period = (search.period as Period | undefined) ?? 'month';
  const { from, to, soFar } = periodBounds(period, {
    ...(search.from ? { from: search.from } : {}),
    ...(search.to ? { to: search.to } : {}),
  });
  const loc = locationId ? { locationId } : {};
  const usage = useAiUsage({ scope, ...loc, from, to, groupBy: 'day' });
  return (
    <div className="grid gap-5">
      <PeriodPicker search={search} />
      {usage.isPending ? (
        <LoadingRows rows={2} />
      ) : usage.isError ? (
        <ErrorState error={usage.error} onRetry={() => void usage.refetch()} />
      ) : (
        <>
          <UsageTotals usage={usage.data} />
          {usage.data.totals.calls > 0 ? (
            <div className="grid gap-3 lg:grid-cols-2">
              <div className="lg:col-span-2">
                <DayChart scope={scope} {...loc} from={from} to={to} soFar={soFar} />
              </div>
              {scope === 'instance' ? (
                <GroupChart
                  scope={scope}
                  from={from}
                  to={to}
                  groupBy="account"
                  title={t`Account`}
                />
              ) : (
                <GroupChart
                  scope={scope}
                  {...loc}
                  from={from}
                  to={to}
                  groupBy="task"
                  title={t`Task`}
                />
              )}
              <GroupChart
                scope={scope}
                {...loc}
                from={from}
                to={to}
                groupBy="model"
                title={t({ message: 'Model', context: 'ai model' })}
              />
              {scope === 'location' || scope === 'account' ? (
                <GroupChart
                  scope={scope}
                  {...loc}
                  from={from}
                  to={to}
                  groupBy="person"
                  title={t`Person`}
                />
              ) : null}
              {scope === 'account' ? (
                <GroupChart
                  scope={scope}
                  from={from}
                  to={to}
                  groupBy="location"
                  title={t`Location`}
                />
              ) : null}
            </div>
          ) : null}
          <OutcomeCounts outcomes={usage.data.totals.outcomes} />
        </>
      )}
      <CallList scope={scope} {...loc} />
    </div>
  );
}

/** Settings → AI usage: Me, each administered location, Account. */
export function UsagePage() {
  const search = useSearch({ strict: false }) as UsageSearch;
  const locations = useLocations();
  const tabs = useUsageScopes(locations.data ?? []);
  if (locations.isPending) return <LoadingRows rows={3} />;
  const wanted =
    search.scope === 'location' && search.location
      ? `location:${search.location}`
      : (search.scope ?? 'me');
  const tab = tabs.find((x) => x.key === wanted) ?? tabs[0];
  if (!tab) return null;
  const all = locations.data ?? [];
  const covered =
    tab.scope === 'location' && tab.locationId
      ? [tab.locationId]
      : tab.scope === 'account'
        ? all.filter((l) => l.role === 'owner' && l.kind !== 'personal').map((l) => l.id)
        : all.filter((l) => l.kind === 'personal').map((l) => l.id);
  return (
    <div className="grid gap-5">
      {tabs.length > 1 ? <ScopeSwitch tabs={tabs} current={tab.key} /> : null}
      <PausedBanners locationIds={covered} />
      <UsageBody
        key={tab.key}
        scope={tab.scope}
        {...(tab.locationId ? { locationId: tab.locationId } : {})}
        search={search}
      />
    </div>
  );
}

/** Admin → AI usage: per-account totals and the instance key's calls. */
export function InstanceUsagePage() {
  const search = useSearch({ strict: false }) as UsageSearch;
  return <UsageBody scope="instance" search={search} />;
}
