/**
 * Recent changes by connections (D58, D124, screens §5): what your tokens and connected apps
 * changed, newest first, each with Undo while the server says it can be undone (7 days). When an
 * undo is refused, the reason stays on the row in words ("Can't undo: Alfred changed Name since"),
 * with "Open the thing" when something changed since.
 *
 * It is a timeline, like a thing's history, rather than a filtered list: one app at a time
 * (`?changes=<token id>` in the URL, so Back restores it), and "Load more". The page's other list
 * (tokens and apps) owns the list standard's search and filter keys.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { useConnectionChanges, useTokens } from '@/api/connections/queries';
import type { ConnectionChange } from '@/api/connections/types';
import { useLocations } from '@/api/queries';
import { EventRow } from '@/components/history/timeline';
import { type Refusal, undoApi, useUndoRefusal } from '@/components/history/undo';
import { ActivityIcon } from '@/components/icons';
import { EmptyState, ErrorState, LoadingRows, Section } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Select, SelectItem } from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { addressOf } from '@/lib/address';
import { useLocationName } from '@/lib/labels';
import { useOnline } from '@/lib/online';

const ALL = 'all';

export function RecentChanges() {
  const { t } = useLingui();
  const search = useSearch({ strict: false }) as { changes?: string };
  const navigate = useNavigate();
  const tokenId = search.changes || undefined;
  const changes = useConnectionChanges(tokenId);
  const tokens = useTokens();
  const locations = useLocations();
  const nameOf = useLocationName();
  const items = changes.data?.pages.flatMap((p) => p.items) ?? [];
  const options = [
    { id: ALL, name: t`Every token and app` },
    ...(tokens.data?.pages.flatMap((p) => p.items) ?? []).map((r) => ({
      id: r.id,
      name: r.clientName ?? r.name,
    })),
  ];
  const locationName = (id: string | null) => {
    const l = locations.data?.find((x) => x.id === id);
    return l ? nameOf(l) : null;
  };
  return (
    <Section
      title={<Trans>Recent changes by connections</Trans>}
      action={
        <span className="text-small text-ink-3">
          <Trans>Undo for 7 days</Trans>
        </span>
      }
    >
      <Select
        label={t`Made by`}
        items={options}
        value={tokenId ?? ALL}
        onChange={(key) =>
          void navigate({
            to: '.',
            search: ((prev: Record<string, unknown>) => {
              const next = { ...prev, changes: key === ALL ? undefined : String(key) };
              if (next.changes === undefined) delete next.changes;
              return next;
            }) as never,
          })
        }
        className="max-w-sm"
      >
        {(o) => (
          <SelectItem id={o.id} textValue={o.name}>
            <bdi>{o.name}</bdi>
          </SelectItem>
        )}
      </Select>
      {changes.isPending ? (
        <LoadingRows rows={2} label={t`Loading changes`} />
      ) : changes.isError && items.length === 0 ? (
        <ErrorState error={changes.error} onRetry={() => void changes.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState icon={<ActivityIcon />} title={<Trans>No changes by connections</Trans>}>
          <Trans>When an app changes something with one of your tokens, it's listed here.</Trans>
        </EmptyState>
      ) : (
        <ul
          aria-label={t`Recent changes by connections`}
          className="m-0 grid list-none overflow-hidden rounded-[10px] border border-line bg-surface p-0 [&>li+li]:border-line [&>li+li]:border-t"
        >
          {items.map((c) => (
            <li key={c.id}>
              <ChangeRow change={c} locationName={locationName(c.location_id)} />
            </li>
          ))}
        </ul>
      )}
      {changes.hasNextPage ? (
        <Button
          variant="secondary"
          className="justify-self-center"
          isPending={changes.isFetchingNextPage}
          onPress={() => void changes.fetchNextPage()}
        >
          <Trans>Load more</Trans>
        </Button>
      ) : null}
    </Section>
  );
}

function ChangeRow({
  change: c,
  locationName,
}: {
  change: ConnectionChange;
  locationName: string | null;
}) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const online = useOnline();
  const refusal = useUndoRefusal();
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);
  const open = c.undo !== null && Date.parse(c.undo.until) > Date.now();
  const thingId = c.entity.type === 'thing' && c.entity.id ? c.entity.id : null;
  const undo = async () => {
    if (!c.undo) return;
    setBusy(true);
    try {
      await undoApi.undo(c.undo.eventId);
      setRefused(null);
      toast({ title: t`Undone`, tone: 'ok' });
      await qc.invalidateQueries();
    } catch (e) {
      setRefused(refusal(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <EventRow
      // Made by a token or connected app: its name, not "Kept" (the audit actor has no display
      // name of its own; UI review steps 6–8, M4).
      event={c.actor.displayName ? c : { ...c, actor: { ...c.actor, displayName: c.token.name } }}
      linkEntity
      locationName={locationName}
      trailing={
        open && !refused ? (
          <Button
            variant="secondary"
            size="small"
            className="shrink-0"
            isPending={busy}
            isDisabled={!online}
            onPress={() => void undo()}
          >
            <Trans>Undo</Trans>
          </Button>
        ) : null
      }
      footer={
        refused ? (
          <p
            role="status"
            className="m-0 flex flex-wrap items-center gap-x-2 text-small text-ink-2"
          >
            <span>{refused.title}</span>
            {refused.changed && thingId ? (
              <Link
                to="/t/$id"
                params={{ id: addressOf({ id: thingId, shortCode: c.entity.shortCode ?? null }) }}
                className="font-semibold text-ink underline underline-offset-2"
              >
                <Trans>Open the thing</Trans>
              </Link>
            ) : null}
          </p>
        ) : null
      }
    />
  );
}
