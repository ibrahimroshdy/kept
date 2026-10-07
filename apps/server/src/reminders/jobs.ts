import { defineJob, type JobDefinition } from '../jobs/boss.js';
import { JOB_POLICIES } from '../jobs/policies.js';
import type { SystemJobDeps } from '../jobs/system.js';
import { runDelivery } from './deliver.js';
import { runDigests } from './digest.js';
import { runScan } from './scan.js';

// The reminder engine's jobs (D29, D111, D113; plan T14), aggregated by jobs/household.ts; the
// names, schedules and policies (jobs/policies.ts) were fixed by T2.
// - `reminder-scan`, every 15 minutes, kept_system: reads agenda_items for every location,
//   writes each occurrence once and fans it out to notifications and deliveries (scan.ts).
// - `reminder-digest`, every 15 minutes, kept_system: the digests whose local time has come
//   (digest.ts).
// - `reminder-deliver`, one delivery per job (an email, a push or a webhook), sent by the scan,
//   and a channel's test from T15's routes (deliver.ts). The senders are T15's
//   (reminders/channel.ts, SystemJobDeps.channels).

export function reminderJobs(deps: SystemJobDeps): JobDefinition[] {
  return [
    defineJob({
      name: 'reminder-scan',
      kind: 'system',
      schedule: '*/15 * * * *',
      policy: JOB_POLICIES['reminder-scan'],
      handler: async () => {
        const done = await runScan(deps);
        if (done.occurrences > 0 || done.reopened > 0) {
          deps.log.info({ ...done }, 'reminder scan wrote occurrences');
        }
      },
    }),
    defineJob({
      name: 'reminder-digest',
      kind: 'system',
      schedule: '*/15 * * * *',
      policy: JOB_POLICIES['reminder-digest'],
      handler: async () => {
        const done = await runDigests(deps);
        if (done.sent > 0 || done.skipped > 0) deps.log.info(done, 'reminder digests sent');
        // Those that failed are tried again by the next pass; the retry says it failed.
        if (done.failed > 0) throw new Error(`${done.failed} reminder digests not sent`);
      },
    }),
    defineJob({
      name: 'reminder-deliver',
      kind: 'system',
      policy: JOB_POLICIES['reminder-deliver'],
      handler: async (data) => {
        await runDelivery(deps, data);
      },
    }),
  ];
}
