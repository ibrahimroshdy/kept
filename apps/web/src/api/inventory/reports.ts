/**
 * The inventory report (task 32, D201): start a run, then poll it until the PDF is ready. The
 * server's routes are apps/server/src/reports/routes.ts; the paths come from ./paths.ts only.
 *
 * A run is `queued`, then `running` with `{done, total}` progress, then `done` with five-minute
 * signed URLs (`fileUrl` an attachment, `viewUrl` the same PDF inline), or `failed` with an
 * `error` code. It is kept for 24 hours, then `expired`
 * (and a 404 once purged). Viewers may make one too; money in it follows the server's gates.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '../client';
import { inventoryPaths as p } from './paths';
import type { InventoryReportBody, ReportCreated, ReportRun } from './types';

export const reportsApi = {
  start: (body: InventoryReportBody) => api.post<ReportCreated>(p.reportsInventory, body),
  run: (id: string) => api.get<ReportRun>(p.report(id)),
};

export const reportKeys = {
  run: (id: string) => ['reports', 'run', id] as const,
};

/** How often a run is read: every second while it's being made. */
export const POLL_MS = 1000;
/** A signed link lives five minutes (the server's SIGNED_URL_TTL_SECONDS). The sheet uses one
 * for at most four minutes after reading it, then reads the run again for a new one. */
export const LINK_USABLE_MS = 4 * 60 * 1000;
/** Once done, a new link well before the one in hand is past LINK_USABLE_MS. */
export const REFRESH_DONE_MS = 3 * 60 * 1000;

/** A run, read every second until it finishes; a done run keeps its link fresh. */
export function useReportRun(id: string | null) {
  return useQuery({
    queryKey: reportKeys.run(id ?? ''),
    queryFn: () => reportsApi.run(id ?? ''),
    enabled: !!id,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (query.state.error) return false;
      if (status === 'done') return REFRESH_DONE_MS;
      if (status === 'failed' || status === 'expired') return false;
      return POLL_MS;
    },
    // Back from the background (an iPhone freezes timers there), a done run's links are read
    // again at once.
    refetchOnWindowFocus: true,
    // A run changes by the second; nothing to keep between sheets.
    gcTime: 0,
  });
}
