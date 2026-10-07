/**
 * A webhook's deliveries (the last 30 days, newest first): the event, its state, when, the
 * receiver's HTTP status and the attempts so far; a failed one says when it tries again (10
 * attempts over 24 hours, then it gives up: @kept/shared `WEBHOOK_LIMITS`). "Load more" follows
 * the cursor.
 */
import type { WebhookDeliveryStatus } from '@kept/shared';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useWebhookDeliveries } from '@/api/connections/queries';
import type { WebhookDelivery, WebhookRow } from '@/api/connections/types';
import { EmptyState, ErrorState, LoadingRows, Pill, type PillTone } from '@/components/page';
import { Sheet } from '@/components/places/sheet';
import { Button } from '@/components/ui/button';
import { useFormat } from '@/lib/format';
import { useDeliveryWords, useEventWords } from './words';

const TONE: Record<WebhookDeliveryStatus, PillTone> = {
  delivered: 'ok',
  pending: 'neutral',
  failed: 'warn',
  gave_up: 'danger',
};

export function DeliveriesSheet({
  webhook,
  onClose,
}: {
  webhook: WebhookRow | null;
  onClose: () => void;
}) {
  const { t } = useLingui();
  return (
    <Sheet
      isOpen={webhook !== null}
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={t`Deliveries`}
      wide
    >
      {webhook ? <Deliveries webhook={webhook} /> : null}
    </Sheet>
  );
}

function Deliveries({ webhook }: { webhook: WebhookRow }) {
  const { t } = useLingui();
  const q = useWebhookDeliveries(webhook.id);
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="grid gap-3">
      <p dir="ltr" className="m-0 break-all text-start font-mono text-[13px] text-ink-2">
        {webhook.url}
      </p>
      {q.isPending ? (
        <LoadingRows rows={3} label={t`Loading deliveries`} />
      ) : q.isError && items.length === 0 ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title={<Trans>Nothing sent yet</Trans>}>
          <Trans>Deliveries from the last 30 days appear here. Send a test to try it.</Trans>
        </EmptyState>
      ) : (
        <ul
          aria-label={t`Deliveries`}
          className="m-0 grid list-none overflow-hidden rounded-[10px] border border-line bg-surface p-0 [&>li+li]:border-line [&>li+li]:border-t"
        >
          {items.map((d) => (
            <li key={d.id}>
              <DeliveryRow delivery={d} />
            </li>
          ))}
        </ul>
      )}
      {q.hasNextPage ? (
        <Button
          variant="secondary"
          className="justify-self-center"
          isPending={q.isFetchingNextPage}
          onPress={() => void q.fetchNextPage()}
        >
          <Trans>Load more</Trans>
        </Button>
      ) : null}
    </div>
  );
}

function DeliveryRow({ delivery: d }: { delivery: WebhookDelivery }) {
  const f = useFormat();
  const eventWords = useEventWords();
  const status = useDeliveryWords();
  const at = f.dateTime(d.createdAt);
  const next = d.nextAttemptAt ? f.dateTime(d.nextAttemptAt) : null;
  return (
    <div className="grid gap-1 px-3.5 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-semibold text-[15px] text-ink">{eventWords(d.event)}</span>
        <Pill tone={TONE[d.status]}>{status(d.status)}</Pill>
      </div>
      <div className="text-small text-ink-2">
        {d.httpStatus !== null ? (
          <Trans>
            {at} · HTTP <span dir="ltr">{d.httpStatus}</span> ·{' '}
            <Plural value={d.attempts} one="# attempt" other="# attempts" />
          </Trans>
        ) : (
          <Trans>
            {at} · no answer · <Plural value={d.attempts} one="# attempt" other="# attempts" />
          </Trans>
        )}
      </div>
      {next && d.status === 'failed' ? (
        <div className="text-small text-ink-3">
          <Trans>Trying again {next}</Trans>
        </div>
      ) : null}
    </div>
  );
}
