/**
 * Mock handlers for the inventory report (task 32, D201), after apps/server/src/reports: a run
 * is queued, then advances each time it is read (a third of the way at a time) until it is done
 * with a download link. Five runs an hour, like the server's rate limit; a scope you can't see is
 * a 404. The PDF is a blank page: the mock has no renderer.
 */
import type { MockState } from '../../mock/fixtures';
import { err, type MockRoute, notFound, reply, route, sessionGate } from '../../mock/kit';
import { inventoryPaths as p } from '../paths';
import type { InventoryReportBody, ReportRun } from '../types';
import { accessOf, newId, type StoredThing } from './db';

const RATE_LIMIT = 5;
const HOUR_MS = 3_600_000;
const KEEP_MS = 24 * HOUR_MS;

/** A one-page blank PDF, for the demo's Download. */
const BLANK_PDF = `data:application/pdf;base64,${btoa(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\n' +
    'trailer<</Root 1 0 R>>\n%%EOF\n',
)}`;

type StoredRun = ReportRun & { userId: string };
const RUNS = new WeakMap<MockState, Map<string, StoredRun>>();

function runsOf(state: MockState): Map<string, StoredRun> {
  let map = RUNS.get(state);
  if (!map) {
    map = new Map();
    RUNS.set(state, map);
  }
  return map;
}

/**
 * A queued run of another kind (the step-4 insurance report, T18), read back through the same
 * `GET /reports/:id` as the inventory report's; `total` things, plus the render.
 */
export function queueReportRun(
  state: MockState,
  scope: ReportRun['scope'],
  total: number,
): Pick<ReportRun, 'id' | 'status' | 'expiresAt'> {
  const createdAt = new Date().toISOString();
  const run: StoredRun = {
    id: newId(),
    status: 'queued',
    scope,
    progress: { done: 0, total: total + 1 },
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + KEEP_MS).toISOString(),
    userId: state.me.user.id,
  };
  runsOf(state).set(run.id, run);
  return { id: run.id, status: run.status, expiresAt: run.expiresAt };
}

export function reportsRoutes(state: MockState): MockRoute[] {
  const runs = () => runsOf(state);
  const inv = () => state.inventory;

  /** The locations a scope covers, as the caller sees them; null for a scope they can't see. */
  const covered = (scope: InventoryReportBody['scope'] | undefined): string[] | null => {
    const access = accessOf(state);
    if (scope && 'locationId' in scope)
      return access.visible(scope.locationId) ? [scope.locationId] : null;
    if (scope && 'accountId' in scope) {
      const ids = state.locations
        .filter((l) => inv().accountOf[l.id] === scope.accountId)
        .map((l) => l.id);
      return ids.length > 0 ? ids : null;
    }
    return null;
  };

  /** What the report holds: the things, then one step for the render (the server's count). */
  const total = (locationIds: string[], body: InventoryReportBody): number => {
    const f = body.filters ?? {};
    const inPlaces = (t: StoredThing) =>
      !f.placeIds?.length || (t.placeId !== null && f.placeIds.includes(t.placeId));
    return (
      inv().things.filter(
        (t) =>
          locationIds.includes(t.locationId) &&
          (f.includeTrashed || !t.deletedAt) &&
          (f.includeEnded || t.lifecycle === 'in_use') &&
          inPlaces(t) &&
          (!f.typeIds?.length || (t.type !== null && f.typeIds.includes(t.type.id))) &&
          (!f.tagIds?.length || t.tags.some((g) => f.tagIds?.includes(g.id))),
      ).length + 1
    );
  };

  return [
    route('POST', p.reportsInventory, ({ body }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const b = body as InventoryReportBody;
      const locationIds = covered(b?.scope);
      if (!locationIds) return notFound();
      const me = state.me.user.id;
      const recent = [...runs().values()].filter(
        (r) => r.userId === me && Date.now() - Date.parse(r.createdAt) < HOUR_MS,
      );
      if (recent.length >= RATE_LIMIT)
        return err(
          429,
          'rate_limited',
          `At most ${RATE_LIMIT} reports an hour. Try again later.`,
          undefined,
          {
            retryAfter: 600,
          },
        );
      const createdAt = new Date().toISOString();
      const run: StoredRun = {
        id: newId(),
        status: 'queued',
        scope: b.scope,
        progress: { done: 0, total: total(locationIds, b) },
        createdAt,
        expiresAt: new Date(Date.parse(createdAt) + KEEP_MS).toISOString(),
        userId: me,
      };
      runs().set(run.id, run);
      return reply(202, { id: run.id, status: run.status, expiresAt: run.expiresAt });
    }),

    route('GET', p.report(':id'), ({ params }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const run = runs().get(params.id ?? '');
      if (!run || run.userId !== state.me.user.id) return notFound();
      // Each read moves the run on: queued → running → … → done.
      if (run.status === 'queued') run.status = 'running';
      else if (run.status === 'running') {
        const { done, total: all } = run.progress;
        run.progress = { done: Math.min(all, done + Math.ceil(all / 3)), total: all };
        if (run.progress.done >= all) {
          run.status = 'done';
          run.bytes = 1024;
        }
      }
      const { userId: _u, ...view } = run;
      return run.status === 'done' ? { ...view, fileUrl: BLANK_PDF, viewUrl: BLANK_PDF } : view;
    }),
  ];
}
