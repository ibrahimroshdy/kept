/**
 * Trash (screens §5 Other screens, D162): what was trashed in every location you belong to, newest
 * first, under the list standard (search, cursor pagination and the filter strip, D205: kind,
 * location, deleted by and date, with saved views; all in the URL). Each row says where it was, who trashed it and when, what went with it (a batch), and
 * the day it goes for good (30 days on).
 *
 * Restore is for members and above; Delete permanently for admins and above, confirmed with
 * useConfirm (never window.confirm), and only for things: places have no permanent delete (they
 * purge with the trash). A viewer sees the list and no buttons (screens §3: hidden for the role).
 */
import { can } from '@kept/shared';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useMutation } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { type TrashParams, useTrash } from '@/api/inventory/queries';
import type { TrashItem } from '@/api/inventory/types';
import { useLocations } from '@/api/queries';
import type { LocationSummary } from '@/api/types';
import { dateBounds, filterParams } from '@/components/filters/params';
import { useFilterRegistry } from '@/components/filters/registry';
import type { FilterDef } from '@/components/filters/types';
import { BoxIcon, ClockIcon, TrashIcon } from '@/components/icons';
import { ListSurface } from '@/components/list-surface';
import { TrashRouteError } from '@/components/on-demand-route-error';
import { EmptyState, Notice, Page, useErrorText } from '@/components/page';
import { usePlaceName } from '@/components/places/labels';
import { Tile } from '@/components/places/rows';
import { trashApi, useInvalidateAfterTrash } from '@/components/search/api';
import { TypeIcon } from '@/components/type-icon';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { toast } from '@/components/ui/toast';
import { sep, useFormat } from '@/lib/format';
import { useLocationName } from '@/lib/labels';
import { firstOf, isNot, listSearch, useListState } from '@/lib/url-state';

export const Route = createFileRoute('/_app/trash')({
  validateSearch: listSearch(['location', 'kind', 'by', 'when']),
  component: TrashPage,
  errorComponent: TrashRouteError,
});

function TrashPage() {
  const { t } = useLingui();
  const [list] = useListState();
  const locations = useLocations();
  const f = useFilterRegistry();
  const params: TrashParams = {
    ...(list.q ? { q: list.q } : {}),
    ...filterParams(list, { location: 'locationId', kind: 'kind', by: 'deletedById' }),
    ...dateBounds(firstOf(list, 'when')),
  } as TrashParams;
  const query = useTrash(params);
  const all = locations.data ?? [];
  const chosen = list.filters.location ?? [];
  const byLocations = isNot(list, 'location')
    ? all.filter((l) => !chosen.includes(l.id)).map((l) => l.id)
    : chosen;

  const filters: FilterDef[] = [
    f.kind(),
    ...(all.length > 1 ? [f.location()] : []),
    f.deletedBy(byLocations),
    f.date('when', t`Trashed`),
  ];

  return (
    <Page title={t`Trash`} fill>
      <Notice tone="info">
        <Trans>
          Trashed things and places wait here for 30 days, then go for good. Restore anything
          trashed by mistake.
        </Trans>
      </Notice>
      <ListSurface<TrashItem>
        label={t`Trash`}
        search={{ label: t`Search the trash`, placeholder: t`Search by name` }}
        filters={filters}
        surface="trash"
        query={query}
        getKey={(item) => `${item.kind}:${item.id}`}
        renderRow={(item) => (
          <TrashRow item={item} location={all.find((l) => l.id === item.locationId)} />
        )}
        empty={
          <EmptyState icon={<TrashIcon />} title={<Trans>The trash is empty</Trans>}>
            <Trans>
              What you trash waits here for 30 days, so a slip of the finger is never final.
            </Trans>
          </EmptyState>
        }
      />
    </Page>
  );
}

function TrashRow({ item, location }: { item: TrashItem; location?: LocationSummary }) {
  const { t } = useLingui();
  const f = useFormat();
  const nameOf = useLocationName();
  const placeName = usePlaceName();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const invalidate = useInvalidateAfterTrash();
  const role = location?.role ?? 'viewer';
  const canRestore = can(role, 'things.trash');
  const canDelete = item.kind === 'thing' && can(role, 'things.delete-permanently');
  const name = item.name ?? t`Untitled draft`;
  const others = item.batchSize - 1;

  const restore = useMutation({
    mutationFn: () =>
      item.kind === 'thing' ? trashApi.restoreThing(item.id) : trashApi.restorePlace(item.id),
    onSuccess: async (result) => {
      await invalidate();
      toast({
        title: t`Restored ${name}`,
        tone: 'ok',
        ...(result?.hint
          ? {
              description: t`Where it was is still in the trash, so it's in the Unplaced area now.`,
            }
          : {}),
      });
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });
  const remove = useMutation({
    mutationFn: () => trashApi.deleteThing(item.id),
    onSuccess: async () => {
      await invalidate();
      toast({ title: t`Deleted ${name} for good`, tone: 'ok' });
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });

  const askDelete = async () => {
    const ok = await confirm({
      title: t`Delete ${name} for good?`,
      body: t`It can't be restored afterwards. Its history stays, without it.`,
      confirmLabel: t`Delete permanently`,
      destructive: true,
    });
    if (ok) remove.mutate();
  };

  const where = [location ? nameOf(location) : null, ...item.path.map((s) => placeName(s))].filter(
    (x): x is string => !!x,
  );
  const when = f.relative(item.deletedAt);
  const by = item.deletedBy?.displayName;
  const purge = f.day(item.purgeAfter);

  return (
    <article aria-label={name} className="grid gap-2 px-3.5 py-3 md:flex md:items-center md:gap-3">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <Tile>
          {item.kind === 'place' ? <TypeIcon icon="lucide:square-dashed" /> : <BoxIcon />}
        </Tile>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <div className="font-semibold text-[15px] leading-snug text-ink [overflow-wrap:anywhere]">
            {item.name ? <bdi>{item.name}</bdi> : <Trans>Untitled draft</Trans>}
            <span className="sr-only">
              {' '}
              {item.kind === 'place' ? <Trans>(a place)</Trans> : <Trans>(a thing)</Trans>}
            </span>
          </div>
          {where.length ? (
            <div className="text-small text-ink-2 [overflow-wrap:anywhere]">
              <Trans>Was in</Trans>{' '}
              {where.map((w, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a path, in order
                <span key={i}>
                  {i > 0 ? <span aria-hidden="true"> › </span> : null}
                  <bdi>{w}</bdi>
                </span>
              ))}
            </div>
          ) : null}
          <div className="text-small text-ink-2">
            {by ? (
              <Trans>
                Trashed {when} by <bdi>{by}</bdi>
              </Trans>
            ) : (
              <Trans>Trashed {when}</Trans>
            )}
            {others > 0 ? (
              <>
                {sep()}
                <Plural value={others} one="with # other" other="with # others" />
              </>
            ) : null}
          </div>
          <div className="flex items-center gap-1 text-small text-ink-3 [&_svg]:size-3.5">
            <ClockIcon aria-hidden="true" />
            <Trans>Goes for good on {purge}</Trans>
          </div>
        </div>
      </div>
      {canRestore || canDelete ? (
        <div className="flex flex-wrap gap-2 ps-14 md:ps-0">
          {canRestore ? (
            <Button
              size="small"
              variant="secondary"
              isPending={restore.isPending}
              onPress={() => restore.mutate()}
              aria-label={t`Restore ${name}`}
            >
              <Trans>Restore</Trans>
            </Button>
          ) : null}
          {canDelete ? (
            <Button
              size="small"
              variant="ghost"
              className="text-danger"
              isPending={remove.isPending}
              onPress={() => void askDelete()}
              aria-label={t`Delete ${name} permanently`}
            >
              <Trans>Delete permanently</Trans>
            </Button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
