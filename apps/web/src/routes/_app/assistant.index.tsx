/**
 * Your assistant threads (D23; screens §5 "Assistant", §2 `/assistant`): your own only, private
 * even from admins, under the list standard (L88): search over your questions and the answers,
 * filters by location and by when you last used one, grouped by when or by location, "Load more",
 * all in the URL. Each opens at `/assistant/<thread>`; each can be deleted at once, asked first.
 * "Ask a question" opens the sheet or the docked panel on a new thread.
 *
 * Its chunk loads on demand from assets/household/ (vite.config.ts); its error screen stays
 * precached, so offline it says "Needs a connection".
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { createFileRoute, type ErrorComponentProps } from '@tanstack/react-router';
import { useThreads } from '@/api/assistant/queries';
import type { ThreadSummary, ThreadsParams } from '@/api/assistant/types';
import { useLocations } from '@/api/queries';
import { showThread } from '@/assistant/store';
import { RetentionNote, ThreadRow } from '@/assistant/threads-list';
import { dateBounds, filterParams } from '@/components/filters/params';
import { useFilterRegistry } from '@/components/filters/registry';
import type { FilterDef } from '@/components/filters/types';
import { AssistantIcon } from '@/components/icons';
import { type GroupDef, ListSurface } from '@/components/list-surface';
import { HouseholdRouteError } from '@/components/notifications/route-error';
import { EmptyState, Page } from '@/components/page';
import { Button } from '@/components/ui/button';
import { useLocationName } from '@/lib/labels';
import { useOnline } from '@/lib/online';
import { firstOf, listSearch, useListState } from '@/lib/url-state';

export const Route = createFileRoute('/_app/assistant/')({
  validateSearch: listSearch(['location', 'when']),
  component: AssistantPage,
  errorComponent: RouteError,
});

/** "Today", "Earlier this week", "Earlier": by the day it was last used. */
function useWhenGroup() {
  const { t } = useLingui();
  return (iso: string): { key: string; label: string } => {
    const at = new Date(iso);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (at >= today) return { key: 'today', label: t`Today` };
    const week = new Date(today);
    week.setDate(week.getDate() - 6);
    if (at >= week) return { key: 'week', label: t`Earlier this week` };
    return { key: 'older', label: t`Earlier` };
  };
}

function AssistantPage() {
  const { t } = useLingui();
  const [list] = useListState();
  const online = useOnline();
  const locations = useLocations();
  const locationName = useLocationName();
  const f = useFilterRegistry();
  const whenGroup = useWhenGroup();
  const all = locations.data ?? [];
  const params: ThreadsParams = {
    ...(list.q ? { q: list.q } : {}),
    ...filterParams(list, { location: 'locationId' }),
    ...dateBounds(firstOf(list, 'when')),
  };
  const query = useThreads(params);
  const filters: FilterDef[] = [
    ...(all.length > 1 ? [f.location()] : []),
    f.date('when', t`Last used`),
  ];
  const groups: GroupDef[] = [
    { value: 'when', label: t`When`, short: t`by when` },
    { value: 'location', label: t`Location`, short: t`by location` },
    { value: 'none', label: t`None`, short: t`ungrouped` },
  ];
  const groupOf = (thread: ThreadSummary, by: string) => {
    if (by === 'when') return whenGroup(thread.updatedAt);
    const l = all.find((x) => x.id === thread.context.locationId);
    return l ? { key: l.id, label: locationName(l) } : { key: '', label: t`No location` };
  };

  return (
    <Page
      title={t`Assistant`}
      fill
      actions={
        <Button variant="primary" isDisabled={!online} onPress={() => showThread(null)}>
          <Trans>Ask a question</Trans>
        </Button>
      }
    >
      <RetentionNote />
      <ListSurface<ThreadSummary>
        label={t`Your threads`}
        search={{
          label: t`Search your threads`,
          placeholder: t`Search your questions and answers`,
        }}
        filters={filters}
        groups={groups}
        defaultGroup="when"
        groupOf={groupOf}
        query={query}
        getKey={(thread) => thread.id}
        renderRow={(thread) => <ThreadRow thread={thread} />}
        empty={
          <EmptyState icon={<AssistantIcon />} title={<Trans>Ask about your things</Trans>}>
            <Trans>
              Ask where something is or what's due, or ask for a change you confirm before it's
              made. Your conversations are private to you.
            </Trans>
          </EmptyState>
        }
      />
    </Page>
  );
}

/** Offline before the page's first load: "Needs a connection", in the page's frame. */
function RouteError(props: ErrorComponentProps) {
  const { t } = useLingui();
  return <HouseholdRouteError {...props} title={t`Assistant`} />;
}
