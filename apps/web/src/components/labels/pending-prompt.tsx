/**
 * "Print pending labels (N)" (screens §8): things captured offline on this phone have no code
 * until they sync (D112); when the sync engine records the code the server allocated, the thing
 * joins this phone's pending list (offline meta `printPending`). This lists their codes and
 * opens the batch builder for them, one location at a time (a batch belongs to one location).
 * A confirmed print ("Printed OK?") takes them off the list.
 */
import type { SnapThing } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { useLocations } from '@/api/queries';
import { PrinterIcon } from '@/components/icons';
import { IdChip } from '@/components/id-chip';
import { LinkButton } from '@/components/page';
import { useLocationName } from '@/lib/labels';
import type { Offline } from '@/offline/open';
import { useOffline, useSyncStatus } from '@/offline/provider';

async function pendingIds(offline: Offline): Promise<string[]> {
  const list = await offline.store.meta('printPending');
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
}

/** Takes printed things off this phone's pending list, and updates the count. */
export async function forgetPrintPending(offline: Offline | null, thingIds: readonly string[]) {
  if (!offline || thingIds.length === 0) return;
  const list = await pendingIds(offline);
  const next = list.filter((id) => !thingIds.includes(id));
  if (next.length === list.length) return;
  await offline.store.setMeta('printPending', next);
  await offline.engine.refresh();
}

export function PendingPrompt() {
  const { t } = useLingui();
  const offline = useOffline();
  const status = useSyncStatus();
  const locationName = useLocationName();
  const locations = useLocations();
  const count = status?.printPending ?? 0;
  const things = useQuery({
    queryKey: ['labels', 'pending', count],
    queryFn: async () => {
      if (!offline) return [];
      const rows = await Promise.all(
        (await pendingIds(offline)).map((id) => offline.store.thing(id)),
      );
      return rows.filter((r): r is SnapThing => !!r?.shortCode);
    },
    enabled: count > 0 && !!offline,
  });
  const rows = things.data ?? [];
  if (count === 0 || rows.length === 0) return null;
  const byLocation = new Map<string, SnapThing[]>();
  for (const r of rows) byLocation.set(r.locationId, [...(byLocation.get(r.locationId) ?? []), r]);
  const n = rows.length;
  return (
    <section
      aria-labelledby="print-pending"
      className="grid gap-3 rounded-[10px] border border-line bg-surface p-3.5"
    >
      <h2 id="print-pending" className="m-0 flex items-center gap-2 font-semibold text-[15px]">
        <PrinterIcon className="size-5 shrink-0 text-ink-2" />
        <Trans>Print pending labels ({n})</Trans>
      </h2>
      <p className="m-0 text-small text-ink-2">
        <Trans>
          Things captured on this phone got their IDs when it synced. Print their labels now.
        </Trans>
      </p>
      {[...byLocation].map(([locationId, list]) => {
        const loc = locations.data?.find((l) => l.id === locationId);
        const where = loc ? locationName(loc) : '';
        return (
          <div key={locationId} className="grid gap-2">
            {byLocation.size > 1 ? <div className="text-small font-semibold">{where}</div> : null}
            <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
              {list.map((r) => (
                <li key={r.id} className="flex items-center gap-1.5 text-small">
                  <IdChip code={r.shortCode} />
                  <bdi className="text-ink-2">{r.name ?? t`Unnamed`}</bdi>
                </li>
              ))}
            </ul>
            <LinkButton
              to="/labels"
              search={{ loc: locationId, things: list.map((r) => r.id).join(',') }}
              size="small"
              className="justify-self-start"
            >
              <Trans>Print these</Trans>
            </LinkButton>
          </div>
        );
      })}
    </section>
  );
}
