/**
 * A location's webhooks (D63, D110, D180; screens §5 Location settings): owners and admins only.
 * On the list standard: search by address, a filter for working, off or failing, grouped by
 * state, with "Load more" (`GET /locations/:id/webhooks` answers the whole list; the paging is
 * done here). Each row: the address, its events, its state ("Failing since 12 Oct", or off because
 * its maker lost the role), the last delivery, and Test, Deliveries, Change, a new secret, Turn
 * off or on, and Delete (an in-app confirm).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import {
  type InfiniteData,
  type UseInfiniteQueryResult,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { useState } from 'react';
import { connectionsApi, connectionsKeys, useWebhooks } from '@/api/connections/queries';
import type { WebhookRow, WebhooksResponse } from '@/api/connections/types';
import type { Page } from '@/api/inventory/types';
import { useNameList } from '@/components/connections/words';
import { LinkIcon, PlusIcon } from '@/components/icons';
import { ListSurface } from '@/components/list-surface';
import { EmptyState, Pill, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { useFormat } from '@/lib/format';
import { useOnline } from '@/lib/online';
import { firstOf, useListState } from '@/lib/url-state';
import { DeliveriesSheet } from './deliveries';
import { WebhookSheet, type WebhookSheetState } from './edit';
import { useDeliveryWords, useDisabledWords, useEventWords } from './words';

/** The URL filter keys this list owns (the route's `listSearch`). */
export const WEBHOOK_FILTERS = ['state'] as const;
const PAGE = 20;

type State = 'working' | 'failing' | 'off';
const stateOf = (w: WebhookRow): State =>
  !w.active ? 'off' : w.failingSince ? 'failing' : 'working';

/** The whole list as the list surface's pages, `PAGE` at a time. */
function usePaged(
  query: ReturnType<typeof useWebhooks>,
  items: WebhookRow[],
): UseInfiniteQueryResult<InfiniteData<Page<WebhookRow>>> {
  const [pages, setPages] = useState(1);
  const shown = items.slice(0, pages * PAGE);
  return {
    ...query,
    data: query.data
      ? {
          pages: [{ items: shown, next_cursor: shown.length < items.length ? 'more' : null }],
          pageParams: [undefined],
        }
      : undefined,
    hasNextPage: shown.length < items.length,
    isFetchingNextPage: false,
    fetchNextPage: async () => {
      setPages((n) => n + 1);
      return undefined as never;
    },
  } as unknown as UseInfiniteQueryResult<InfiniteData<Page<WebhookRow>>>;
}

export function WebhooksList({ locationId }: { locationId: string }) {
  const { t } = useLingui();
  const [list] = useListState();
  const online = useOnline();
  const query = useWebhooks(locationId);
  const [sheet, setSheet] = useState<WebhookSheetState>({ kind: 'closed' });
  const [deliveriesOf, setDeliveriesOf] = useState<WebhookRow | null>(null);
  const q = list.q.trim().toLocaleLowerCase();
  const state = firstOf(list, 'state');
  const items = ((query.data as WebhooksResponse | undefined)?.items ?? [])
    .filter((w) => !q || w.url.toLocaleLowerCase().includes(q))
    .filter((w) => !state || stateOf(w) === state);
  const by = list.group ?? 'none';
  const order: State[] = ['failing', 'working', 'off'];
  const sorted =
    by === 'state'
      ? [...items].sort((a, b) => order.indexOf(stateOf(a)) - order.indexOf(stateOf(b)))
      : items;
  const paged = usePaged(query, sorted);
  const stateLabel = (s: State) =>
    s === 'failing' ? t`Failing` : s === 'off' ? t`Off` : t`Working`;
  return (
    <div className="grid gap-3">
      <p className="m-0 text-ink-2">
        <Trans>
          A signed message to your own server when things change here. It carries ids and the names
          of changed fields, never names, places or values.
        </Trans>
      </p>
      <ListSurface<WebhookRow>
        label={t`Webhooks`}
        search={{
          label: t`Search webhooks`,
          placeholder: t`Search by address`,
          end: (
            <Button size="small" isDisabled={!online} onPress={() => setSheet({ kind: 'add' })}>
              <PlusIcon />
              <Trans>Add webhook</Trans>
            </Button>
          ),
        }}
        filters={[
          {
            key: 'state',
            label: t`State`,
            kind: 'single',
            values: {
              from: 'static',
              options: order.map((s) => ({ value: s, label: stateLabel(s) })),
            },
          },
        ]}
        groups={[
          { value: 'none', label: t`None` },
          { value: 'state', label: t`State`, short: t`by state` },
        ]}
        groupOf={(w, g) =>
          g === 'state' ? { key: stateOf(w), label: stateLabel(stateOf(w)) } : null
        }
        query={paged}
        getKey={(w) => w.id}
        renderRow={(w) => (
          <WebhookRowView
            webhook={w}
            locationId={locationId}
            onEdit={() => setSheet({ kind: 'edit', webhook: w })}
            onSecret={(secret) => setSheet({ kind: 'secret', secret, rotated: true })}
            onDeliveries={() => setDeliveriesOf(w)}
          />
        )}
        empty={
          <EmptyState icon={<LinkIcon />} title={<Trans>No webhooks here</Trans>}>
            <Trans>
              Add one to tell a home server, Home Assistant or a script when a thing is added, moved
              or changed in this location.
            </Trans>
          </EmptyState>
        }
      />
      {!online ? (
        <p className="m-0 text-ink-2 text-small">
          <Trans>Needs a connection</Trans>
        </p>
      ) : null}
      <WebhookSheet locationId={locationId} state={sheet} onChange={setSheet} />
      <DeliveriesSheet webhook={deliveriesOf} onClose={() => setDeliveriesOf(null)} />
    </div>
  );
}

function WebhookRowView({
  webhook: w,
  locationId,
  onEdit,
  onSecret,
  onDeliveries,
}: {
  webhook: WebhookRow;
  locationId: string;
  onEdit: () => void;
  onSecret: (secret: string) => void;
  onDeliveries: () => void;
}) {
  const { t } = useLingui();
  const f = useFormat();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const online = useOnline();
  const errorText = useErrorText();
  const eventWords = useEventWords();
  const delivery = useDeliveryWords();
  const disabled = useDisabledWords();
  const names = useNameList();
  const refresh = () => qc.invalidateQueries({ queryKey: connectionsKeys.webhooks(locationId) });
  const fail = (e: unknown) => toast({ title: errorText(e), tone: 'danger' });

  const test = useMutation({
    mutationFn: () => connectionsApi.testWebhook(w.id),
    onSuccess: async ({ httpStatus }) => {
      await Promise.all([
        refresh(),
        qc.invalidateQueries({ queryKey: connectionsKeys.deliveries(w.id) }),
      ]);
      const code = String(httpStatus ?? '');
      if (httpStatus === null) toast({ title: t`Your server didn't answer`, tone: 'danger' });
      else if (httpStatus >= 200 && httpStatus < 300)
        toast({ title: t`Test sent: your server answered ${code}`, tone: 'ok' });
      else toast({ title: t`Test sent: your server answered ${code}`, tone: 'danger' });
    },
    onError: fail,
  });
  const toggle = useMutation({
    mutationFn: (active: boolean) => connectionsApi.updateWebhook(w.id, { active }, w.rowVersion),
    onSuccess: async (row) => {
      await refresh();
      toast({ title: row.active ? t`Webhook on` : t`Webhook off`, tone: 'ok' });
    },
    onError: async (e) => {
      await refresh();
      fail(e);
    },
  });
  const rotate = useMutation({
    mutationFn: () => connectionsApi.rotateWebhookSecret(w.id),
    onSuccess: ({ secret }) => onSecret(secret),
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: () => connectionsApi.deleteWebhook(w.id),
    onSuccess: async () => {
      await refresh();
      toast({ title: t`Webhook deleted`, tone: 'ok' });
    },
    onError: fail,
  });

  const events = names(w.events.map((e) => eventWords(e)));
  const last = w.lastDelivery;
  const lastAt = last ? f.relative(last.at) : null;
  const lastWords = last ? delivery(last.status) : null;
  const failingSince = w.failingSince ? f.day(w.failingSince) : null;
  return (
    <div className="grid gap-2 px-3.5 py-3">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="grid min-w-0 flex-1 basis-56 gap-1">
          <span dir="ltr" className="break-all text-start font-mono text-[14px] text-ink">
            {w.url}
          </span>
          <span className="text-small text-ink-2">{events}</span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-ink-2">
            {w.disabledReason ? (
              <Pill tone="warn">{disabled(w.disabledReason)}</Pill>
            ) : !w.active ? (
              <Pill>
                <Trans>Off</Trans>
              </Pill>
            ) : failingSince ? (
              <Pill tone="danger">
                <Trans>Failing since {failingSince}</Trans>
              </Pill>
            ) : (
              <Pill tone="ok">
                <Trans>Working</Trans>
              </Pill>
            )}
            {last && lastAt ? (
              last.httpStatus !== null ? (
                <span>
                  <Trans>
                    Last: {lastWords} {lastAt} · HTTP <span dir="ltr">{last.httpStatus}</span>
                  </Trans>
                </span>
              ) : (
                <span>
                  <Trans>
                    Last: {lastWords} {lastAt}
                  </Trans>
                </span>
              )
            ) : null}
          </span>
          <span className="text-small text-ink-3">
            <Trans>
              Added by <bdi>{w.createdBy.displayName}</bdi>
            </Trans>
          </span>
        </div>
        <Switch
          isSelected={w.active}
          isDisabled={!online || toggle.isPending}
          onChange={(on) => toggle.mutate(on)}
          aria-label={t`Send to ${w.url}`}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="small"
          variant="secondary"
          isDisabled={!online || !w.active}
          isPending={test.isPending}
          onPress={() => test.mutate()}
        >
          <Trans>Send a test</Trans>
        </Button>
        <Button size="small" variant="secondary" onPress={onDeliveries}>
          <Trans>Deliveries</Trans>
        </Button>
        <Button size="small" variant="secondary" isDisabled={!online} onPress={onEdit}>
          <Trans>Change</Trans>
        </Button>
        <Button
          size="small"
          variant="secondary"
          isDisabled={!online}
          isPending={rotate.isPending}
          onPress={async () => {
            const ok = await confirm({
              title: t`Make a new signing secret?`,
              body: t`The current secret stops working at once. Deliveries fail to verify until your server has the new one.`,
              confirmLabel: t`New secret`,
            });
            if (ok) rotate.mutate();
          }}
        >
          <Trans>New secret</Trans>
        </Button>
        <Button
          size="small"
          variant="ghost"
          isDisabled={!online}
          isPending={remove.isPending}
          onPress={async () => {
            const ok = await confirm({
              title: t`Delete this webhook?`,
              body: t`Kept stops sending to it, and its deliveries are forgotten.`,
              confirmLabel: t`Delete`,
              destructive: true,
            });
            if (ok) remove.mutate();
          }}
        >
          <Trans>Delete</Trans>
        </Button>
      </div>
    </div>
  );
}
