/**
 * Mock handlers for the Kept export (T12; D68, D159, D180; Q7, Q14, Q17). An owner or admin
 * exports a location, anyone exports their own data (`me`); "Include secrets" is the owner's and
 * needs the passphrase twice. Five an hour, one running per location. A run moves on each read:
 * queued → running → done; a done run hands out a fresh `fileUrl` on each read while unexpired,
 * and only while the caller is still an owner or admin there (D180); one past its seven days
 * reads as `expired`, as the server reports it before the purge reaches it.
 */
import { EXPORT_LIMITS, PASSPHRASE_MIN } from '@kept/shared';
import { accessOf, newId, now, paginate, roleIn } from '../../inventory/mock/db';
import type { MockState } from '../../mock/fixtures';
import {
  err,
  forbidden,
  type MockRoute,
  notFound,
  reply,
  route,
  sessionGate,
} from '../../mock/kit';
import { paths } from '../../paths';
import { portabilityPaths as p } from '../paths';
import type { CreateExportBody, ExportRun } from '../types';
import { DEFAULT_EXPORT_OPTIONS, pt } from './state';

const DAY = 86_400_000;

export function exportRoutes(state: MockState): MockRoute[] {
  const s = () => pt(state);
  const access = () => accessOf(state);
  /** The caller may still read this run: their own `me` export, or an owner or admin there. */
  const readable = (run: ExportRun) =>
    run.scope === 'me' || (!!run.locationId && access().isAdmin(run.locationId));
  const expired = (run: ExportRun) =>
    run.status === 'done' && !!run.expiresAt && Date.parse(run.expiresAt) <= Date.now();
  const tick = (run: ExportRun) => {
    if (run.status === 'queued') {
      run.status = 'running';
      run.progress = { done: 0, total: 23 };
    } else if (run.status === 'running') {
      const done = Math.min(run.progress.total, run.progress.done + 8);
      run.progress = { ...run.progress, done };
      if (done >= run.progress.total) {
        run.status = 'done';
        run.finishedAt = now();
        run.expiresAt = new Date(Date.now() + EXPORT_LIMITS.keepDays * DAY).toISOString();
        run.bytes = 12_582_912;
        run.sha256 = 'd'.repeat(64);
      }
    }
  };
  const view = (run: ExportRun): ExportRun => {
    const { fileUrl: _f, ...rest } = run;
    if (expired(run)) return { ...rest, status: 'expired' };
    return run.status === 'done' ? { ...rest, fileUrl: `/f/mock-export-${run.id}` } : rest;
  };

  return [
    route('POST', p.exports, ({ body }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const b = body as CreateExportBody;
      const scope = 'me' in b.scope ? 'me' : 'location';
      const locationId =
        'locationId' in b.scope ? b.scope.locationId : (state.me.personalLocationId ?? '');
      if (scope === 'location') {
        if (!access().visible(locationId)) return notFound();
        if (!access().isAdmin(locationId)) return forbidden();
      }
      if (b.includeSecrets) {
        if (roleIn(state.locations, locationId) !== 'owner')
          return err(403, 'forbidden', 'Only the owner can include secrets.');
        if (state.me.instance.recoveryKitAcknowledged === false)
          return err(409, 'recovery_kit_required', 'Save the recovery kit first.');
        const pass = b.passphrase ?? '';
        if (pass.length < PASSPHRASE_MIN || pass !== b.passphraseAgain)
          return err(
            400,
            'passphrase_weak',
            'Use a passphrase of at least 12 characters, the same both times.',
          );
      }
      const hourAgo = Date.now() - 3_600_000;
      if (
        s().exports.filter((r) => Date.parse(r.createdAt) > hourAgo).length >= EXPORT_LIMITS.perHour
      )
        return err(429, 'rate_limited', 'Too many exports this hour. Try again later.', undefined, {
          retryAfter: 600,
        });
      if (
        s().exports.some(
          (r) => r.locationId === locationId && (r.status === 'queued' || r.status === 'running'),
        )
      )
        return err(409, 'export_running', 'An export of this location is already running.');
      const run: ExportRun = {
        id: b.id ?? newId(),
        scope,
        locationId,
        status: 'queued',
        progress: { done: 0, total: 0 },
        includesSecrets: !!b.includeSecrets,
        options: { ...DEFAULT_EXPORT_OPTIONS, ...b.options },
        createdAt: now(),
      };
      s().exports.unshift(run);
      return reply(202, view(run));
    }),

    route('GET', p.exports, ({ query }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const locationId = query.get('locationId');
      const items = s()
        .exports.filter(readable)
        .filter((r) => !locationId || r.locationId === locationId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(view);
      return paginate(items, query);
    }),

    route('GET', p.exportRun(':id'), ({ params }) => {
      const run = s().exports.find((r) => r.id === params.id);
      if (!run || !readable(run)) return notFound();
      tick(run);
      return view(run);
    }),

    // The delete-location sheet (T21, D149): no web caller of DELETE /locations/:id existed
    // before it, so its mock lives here rather than in api/mock/server.ts. Owner only; Personal
    // is 409; the location leaves the lists, restorable for 30 days.
    route('DELETE', paths.location(':id'), ({ params }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const loc = state.locations.find((l) => l.id === params.id);
      if (!loc || !access().visible(loc.id)) return notFound();
      if (loc.role !== 'owner') return forbidden();
      if (loc.kind === 'personal') return err(409, 'conflict', "Personal can't be deleted.");
      state.locations = state.locations.filter((l) => l.id !== loc.id);
      return { id: loc.id, purgeAfter: new Date(Date.now() + 30 * DAY).toISOString() };
    }),

    route('POST', p.exportCancel(':id'), ({ params }) => {
      const run = s().exports.find((r) => r.id === params.id);
      if (!run || !readable(run)) return notFound();
      if (run.status === 'queued' || run.status === 'running') {
        run.status = 'cancelled';
        run.finishedAt = now();
      }
      return view(run);
    }),
  ];
}
