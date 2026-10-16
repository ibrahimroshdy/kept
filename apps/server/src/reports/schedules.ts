import { ErrorCode, REPORT_CADENCES, SCHEDULED_REPORT_KINDS } from '@kept/shared';
import { z } from 'zod';
import { isUndeliverableEmail } from '../auth/emails.js';
import { withScope, withSystem } from '../db/scope.js';
import type { KeptApp } from '../http/app.js';
import { AppError, notFound } from '../http/errors.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import { defineJob, type JobDefinition } from '../jobs/boss.js';
import { JOB_POLICIES } from '../jobs/policies.js';
import type { JobQueue } from '../jobs/queue.js';
import type { SystemJobDeps } from '../jobs/system.js';
import { requireMembership } from '../locations/access.js';
import { auditMine } from '../notify/prefs.js';
import {
  createInsuranceRun,
  createInventoryRun,
  insuranceScope,
  requireInsuranceReader,
} from './service.js';

// Scheduled reports (1.3, D228; D97: "server-generated PDFs, emailed, scheduled or shared").
//
// GET    /api/v1/me/report-schedules  → {schedules: [{id, locationId, locationName, kind, cadence,
//                                        lastRunOn, lastError}]}
// PUT    /api/v1/me/report-schedules  {locationId, kind, cadence} → 200 the schedule (one per
//                                       location and kind: a second PUT changes the cadence)
// DELETE /api/v1/me/report-schedules/:id → 204
// A person's own, for a location they can see, and only a report they could ask for now: the
// inventory for any member, the insurance report for whoever may read its money (D158). Audited
// on the person's account (`report.schedule`, `report.unschedule`).
//
// A schedule is refused (409 `mail_not_configured` / `no_email_address`, requireMail) when the
// report could never reach the person (1.10.5, #141).
//
// The hourly `report-schedules` job (kept_system) finds the schedules due (Mondays or the 1st,
// from 08:00 in the location's time zone, once that local day) and requests each run in its
// owner's scope with `email: true`, exactly as the person would: their rights, the location's
// modules and the 5-an-hour limit all apply. A refusal is kept as `last_error` (`not_found`,
// `forbidden`, `module_off`, `rate_limited`) and shown in Settings; the run is not retried that
// day. The `report` job renders it and mails the PDF (reports/service.ts mailReport).

const Schedule = z.object({
  id: z.uuid(),
  locationId: z.uuid(),
  locationName: z.string(),
  kind: z.enum(SCHEDULED_REPORT_KINDS),
  cadence: z.enum(REPORT_CADENCES),
  lastRunOn: z.iso.date().nullable(),
  lastError: z.string().nullable(),
});
type Schedule = z.infer<typeof Schedule>;

const PutBody = z
  .object({
    locationId: z.uuid(),
    kind: z.enum(SCHEDULED_REPORT_KINDS),
    cadence: z.enum(REPORT_CADENCES),
  })
  .strict();

type Row = {
  id: string;
  location_id: string;
  name: string;
  kind: Schedule['kind'];
  cadence: Schedule['cadence'];
  last_run_on: string | null;
  last_error: string | null;
};

const SELECT = `SELECT s.id, s.location_id, l.name, s.kind, s.cadence,
                       to_char(s.last_run_on, 'YYYY-MM-DD') AS last_run_on, s.last_error
                  FROM public.report_schedules s JOIN public.locations l ON l.id = s.location_id`;

const view = (r: Row): Schedule => ({
  id: r.id,
  locationId: r.location_id,
  locationName: r.name,
  kind: r.kind,
  cadence: r.cadence,
  lastRunOn: r.last_run_on,
  lastError: r.last_error,
});

export async function reportScheduleRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;

  app.get(
    '/api/v1/me/report-schedules',
    { schema: { response: { 200: z.object({ schedules: z.array(Schedule) }) } } },
    (req) =>
      scopedRead(pools, req, async (_tx, client) => {
        const { rows } = await client.query<Row>(
          `${SELECT} WHERE s.user_id = kept.current_user_id() ORDER BY lower(l.name), s.kind`,
        );
        return { schedules: rows.map(view) };
      }),
  );

  app.put(
    '/api/v1/me/report-schedules',
    { schema: { body: PutBody, response: { 200: Schedule } } },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => {
        const { locationId, kind, cadence } = req.body;
        // Only what the person could ask for by hand (404 for a location they can't see).
        await requireMembership(client, locationId);
        // A schedule only ever mails (#141).
        await requireMail(deps, scope.userId);
        if (kind === 'insurance') {
          await requireInsuranceReader(
            tx,
            client,
            scope,
            await insuranceScope(client, { locationId }),
          );
        }
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO public.report_schedules (user_id, location_id, kind, cadence)
           VALUES (kept.current_user_id(), $1, $2, $3)
           ON CONFLICT (user_id, location_id, kind) DO UPDATE SET cadence = EXCLUDED.cadence
           RETURNING id`,
          [locationId, kind, cadence],
        );
        const id = rows[0]?.id as string;
        await auditMine(tx, scope.userId, {
          action: 'report.schedule',
          entity: { type: 'report_schedule', id },
          after: { locationId, kind, cadence },
          requestId: req.id,
        });
        const out = await client.query<Row>(`${SELECT} WHERE s.id = $1`, [id]);
        return { status: 200, body: view(out.rows[0] as Row) };
      }),
  );

  app.delete(
    '/api/v1/me/report-schedules/:id',
    { schema: { params: z.object({ id: z.uuid() }) } },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => {
        const { rows } = await client.query<{ location_id: string; kind: string }>(
          `DELETE FROM public.report_schedules WHERE id = $1 AND user_id = kept.current_user_id()
           RETURNING location_id, kind`,
          [req.params.id],
        );
        const gone = rows[0];
        if (!gone) throw notFound();
        await auditMine(tx, scope.userId, {
          action: 'report.unschedule',
          entity: { type: 'report_schedule', id: req.params.id },
          before: { locationId: gone.location_id, kind: gone.kind },
          after: null,
          requestId: req.id,
        });
        return { status: 204, body: undefined };
      }),
  );
}

/**
 * 1.10.5 (#141): refuse a request that asks for an email Kept can't send, instead of accepting it
 * and dropping the mail: 409 `mail_not_configured` on a server without KEPT_SMTP_URL, 409
 * `no_email_address` for an account with no address to send to (a managed one, D47). An address
 * that isn't verified yet is still accepted: verifying it is the person's next step, and the mail
 * waits for nothing (mailReport skips it).
 */
export async function requireMail(
  deps: Pick<InventoryDeps, 'pools' | 'notify'>,
  userId: string,
): Promise<void> {
  if (!deps.notify?.mailConfigured) throw new AppError(ErrorCode.mail_not_configured, 409);
  const { rows } = await deps.pools.auth.query<{ email: string | null }>(
    'SELECT email FROM auth."user" WHERE id = $1',
    [userId],
  );
  const email = rows[0]?.email;
  if (!email || isUndeliverableEmail(email)) throw new AppError(ErrorCode.no_email_address, 409);
}

/** A person's deliverable address and language, as the report mail needs it; null for a managed,
 * unverified, disabled or leaving account (none of them is mailed a report). */
export async function mailAddressOf(
  deps: Pick<SystemJobDeps, 'pools'>,
  userId: string,
): Promise<{ email: string; locale: string | null } | null> {
  const { rows } = await deps.pools.auth.query<{
    email: string;
    email_verified: boolean;
    banned: boolean | null;
  }>('SELECT email, email_verified, banned FROM auth."user" WHERE id = $1', [userId]);
  const u = rows[0];
  if (!u || !u.email_verified || u.banned || isUndeliverableEmail(u.email)) return null;
  const profile = await withSystem(deps.pools.system, async (_tx, c) => {
    const r = await c.query<{ locale: string; managed: boolean }>(
      'SELECT locale, managed FROM public.user_profiles WHERE user_id = $1',
      [userId],
    );
    return r.rows[0] ?? null;
  });
  if (profile?.managed) return null;
  return { email: u.email, locale: profile?.locale ?? null };
}

type Due = {
  id: string;
  user_id: string;
  location_id: string;
  kind: Schedule['kind'];
  today: string;
};

/** One pass of the `report-schedules` job. Returns how many runs it requested and refused. */
export async function runReportSchedules(
  deps: Pick<SystemJobDeps, 'pools' | 'sendTenant' | 'log'>,
  at: Date = new Date(),
): Promise<{ requested: number; refused: number }> {
  const app = deps.pools.app;
  const sendTenant = deps.sendTenant;
  if (!app || !sendTenant) {
    deps.log.info({}, 'report-schedules: this worker has no kept_app pool or job sender');
    return { requested: 0, refused: 0 };
  }
  const queue: JobQueue = {
    send: async () => {
      throw new Error('report-schedules sends only the report job');
    },
    sendTenant: (client, name, data) => sendTenant(client, name, data, { startAfter: new Date() }),
  } as JobQueue;
  const due = await withSystem(deps.pools.system, async (_tx, c) => {
    const { rows } = await c.query<Due>(
      `SELECT s.id, s.user_id, s.location_id, s.kind,
              to_char(($1::timestamptz AT TIME ZONE l.timezone)::date, 'YYYY-MM-DD') AS today
         FROM public.report_schedules s JOIN public.locations l ON l.id = s.location_id
        WHERE l.deleted_at IS NULL
          AND extract(hour FROM $1::timestamptz AT TIME ZONE l.timezone) >= 8
          AND (s.last_run_on IS NULL OR s.last_run_on < ($1::timestamptz AT TIME ZONE l.timezone)::date)
          AND CASE s.cadence
                WHEN 'weekly' THEN extract(isodow FROM $1::timestamptz AT TIME ZONE l.timezone) = 1
                ELSE extract(day FROM $1::timestamptz AT TIME ZONE l.timezone) = 1
              END
        ORDER BY s.created_at, s.id
        LIMIT 500`,
      [at.toISOString()],
    );
    return rows;
  });
  let requested = 0;
  let refused = 0;
  for (const s of due) {
    let error: string | null = null;
    try {
      // As the person: their own rights, modules and limit (a schedule never widens them).
      await withScope(app, { userId: s.user_id, mfa: false }, (tx, client) => {
        const scope = { userId: s.user_id, mfa: false };
        const requestId = `schedule-${s.id}`;
        return s.kind === 'insurance'
          ? createInsuranceRun(
              tx,
              client,
              scope,
              queue,
              { scope: { locationId: s.location_id }, email: true },
              requestId,
            )
          : createInventoryRun(
              tx,
              client,
              scope,
              queue,
              { scope: { locationId: s.location_id }, email: true },
              requestId,
            );
      });
      requested += 1;
    } catch (err) {
      refused += 1;
      error = err instanceof AppError && /^[a-z_]{1,32}$/.test(err.code) ? err.code : 'internal';
      if (error === 'internal') deps.log.error({ err, schedule: s.id }, 'scheduled report failed');
    }
    await withSystem(deps.pools.system, (_tx, c) =>
      c.query(
        `UPDATE public.report_schedules SET last_run_on = $2::date, last_error = $3 WHERE id = $1`,
        [s.id, s.today, error],
      ),
    );
  }
  return { requested, refused };
}

export function reportScheduleJobs(deps: SystemJobDeps): JobDefinition[] {
  return [
    defineJob({
      name: 'report-schedules',
      kind: 'system',
      schedule: '27 * * * *',
      policy: JOB_POLICIES['report-schedules'],
      handler: async () => {
        const out = await runReportSchedules(deps);
        if (out.requested + out.refused > 0) deps.log.info(out, 'scheduled reports requested');
      },
    }),
  ];
}
