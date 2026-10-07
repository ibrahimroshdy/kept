// Every job type's policy (D166, engineering spec §3.1b): how many attempts, how long one may
// run, and how long to wait between them. The §3.1b table names the later steps' jobs
// (extraction, reminders, import/export, webhooks, backup); step 1's are set here in the same
// spirit: maintenance retries a couple of times with backoff, mail a few more because an SMTP
// server is often briefly away, and nothing runs for long. A job that exhausts its retries lands
// in pg-boss's `failed` state, which the admin's failed-jobs list shows (jobs/failed.ts).

export type JobPolicy = {
  /** Retries after the first attempt (pg-boss `retryLimit`). */
  retryLimit: number;
  /** Seconds before the first retry; with `retryBackoff` it roughly doubles each time. */
  retryDelay: number;
  retryBackoff: boolean;
  /** How long one attempt may run before pg-boss fails it (and retries, if any are left). */
  expireInSeconds: number;
};

const MAINTENANCE: JobPolicy = {
  retryLimit: 2,
  retryDelay: 60,
  retryBackoff: true,
  expireInSeconds: 300,
};
const MAIL: JobPolicy = { retryLimit: 5, retryDelay: 30, retryBackoff: true, expireInSeconds: 60 };

export const JOB_POLICIES = {
  'repair-orphans': MAINTENANCE,
  'expire-memberships': { ...MAINTENANCE, retryDelay: 30, expireInSeconds: 120 },
  'audit-partitions': { ...MAINTENANCE, retryLimit: 3, expireInSeconds: 60 },
  'prune-stale-rows': MAINTENANCE,
  // Runs every 15 minutes anyway: one retry, then the next run.
  'check-admin-alerts': {
    retryLimit: 1,
    retryDelay: 30,
    retryBackoff: false,
    expireInSeconds: 120,
  },
  // Step 2 (T20): rebuilds search and path caches for a location, sent by requests (a type
  // rename, a registry merge) and by `kept admin`; large locations take a while.
  reindex: { ...MAINTENANCE, expireInSeconds: 900 },
  // Step 2 (T21): empties the trash and purges deleted locations and unattached files, daily;
  // a big backlog takes a while, and the next day's run carries on where it stopped.
  purge: { ...MAINTENANCE, expireInSeconds: 1800 },
  'notify-owner-new-member': MAIL,
  'send-invite-mail': MAIL,
  // Step 3 (§3.1b; plan T2). Extraction: two retries for a provider's brief outage, and 90 s,
  // enough for one model call (callModel's own timeout is shorter) but short enough that a hung
  // provider frees the slot.
  extract: { retryLimit: 2, retryDelay: 20, retryBackoff: true, expireInSeconds: 90 },
  // A CSV import is resumable (Q18): a failure is shown and resumed by the person, never retried
  // behind their back; 10,000 rows take a while.
  'import-csv': { retryLimit: 0, retryDelay: 0, retryBackoff: false, expireInSeconds: 7200 },
  // PDF text runs in a limited child process with a 20 s limit (Q19); one retry.
  'pdf-text': { retryLimit: 1, retryDelay: 30, retryBackoff: true, expireInSeconds: 60 },
  // Daily: llm_calls partitions ahead, old partitions rolled up and dropped, counters pruned (T6).
  'ai-maintenance': MAINTENANCE,
  // Step 3 (T9, D206): a cap crossed 80% or 100%, or the instance key was rejected; mail, so
  // retried like mail (5 attempts).
  'ai-notice': MAIL,
  // Daily at 00:05 UTC: ended day and month pauses are cleared (3 attempts).
  'ai-rollover': MAINTENANCE,
  // Step 2 (T32, D201): one inventory report, rendered in a child process limited to 60 s
  // (reports/render/render.ts); gathering and thumbnails come first. Never retried behind the
  // person's back: the run shows `failed` with its reason and they ask again.
  report: { retryLimit: 0, retryDelay: 0, retryBackoff: false, expireInSeconds: 180 },
  // Hourly: reports past their 24 hours, and their files.
  'purge-reports': { ...MAINTENANCE, expireInSeconds: 600 },
  // Step 3, alpha safety (T31c; §3.1b "backup: 2 attempts, 4 h"): the nightly backup. One retry
  // after 15 minutes (a target briefly away); each attempt is audited and recorded.
  backup: { retryLimit: 1, retryDelay: 900, retryBackoff: false, expireInSeconds: 14_400 },
  // Step 4 (plan T2; §3.1b "reminders scan: 5 attempts, 60 s"): every 15 minutes, writing each
  // occurrence exactly once, so a retry or the next run simply carries on.
  'reminder-scan': { retryLimit: 4, retryDelay: 30, retryBackoff: true, expireInSeconds: 60 },
  // One delivery per job (an email or a push): retried like mail.
  'reminder-deliver': MAIL,
  // Every 15 minutes: the digests whose local time has come.
  'reminder-digest': { retryLimit: 2, retryDelay: 60, retryBackoff: true, expireInSeconds: 120 },
  // §3.1b, §2.6: a webhook is tried 10 times over about 24 hours. pg-boss 12.34.0 (dist/plans.js,
  // failJobsBody) schedules the retry after a failure at retry_count c (0 for the first attempt)
  // `retryDelay × (2^(c+1)/2) × (1 + random())` seconds later, i.e. d·2^c·(1+U), U in [0, 1).
  // Nine retries (c = 0…8) wait d·(2^9 − 1)·(1+U) = 511·d·(1+U) in all: 511·d to 1022·d, on
  // average 766.5·d. d = 113 puts the tenth attempt about 24.1 h after the first on average
  // (16.0 h at the soonest, 32.1 h at the latest). One send is a single HTTP request.
  'channel-webhook': { retryLimit: 9, retryDelay: 113, retryBackoff: true, expireInSeconds: 60 },
  // D158, D201: a claim pack, like a report: never retried behind the person's back (the run
  // shows `failed`); zipping the report and every file takes a while.
  'claim-pack': { retryLimit: 0, retryDelay: 0, retryBackoff: false, expireInSeconds: 1800 },
  // Hourly: export runs past their expiry, and their blobs (§3.3).
  'purge-exports': MAINTENANCE,
  // Step 7 (plan T2; §3.1b "import/export: 1 attempt, 2 h, resumable"): a location export and
  // the two archive imports. Never retried behind the person's back: a failed run shows `failed`,
  // and an import is resumed by the person (its source ids make a re-run safe).
  export: { retryLimit: 0, retryDelay: 0, retryBackoff: false, expireInSeconds: 7200 },
  'import-homebox': { retryLimit: 0, retryDelay: 0, retryBackoff: false, expireInSeconds: 7200 },
  'import-kept': { retryLimit: 0, retryDelay: 0, retryBackoff: false, expireInSeconds: 7200 },
  // Alias enrichment after an import (T15): model calls like extraction's, so its policy.
  'enrich-aliases': { retryLimit: 2, retryDelay: 20, retryBackoff: true, expireInSeconds: 90 },
  // Daily: abandoned import runs and their archives, after 7 days (T8, plan Q18).
  'prune-imports': MAINTENANCE,
  // Step 6 (plan T2). An assistant turn: one retry, resuming after the last stored step so a
  // paid call is never repeated (T13); 200 s covers the turn's 180 s bound (TURN_LIMITS).
  'assistant-turn': { retryLimit: 1, retryDelay: 5, retryBackoff: false, expireInSeconds: 200 },
  // A thing's embedding: one provider request, like an extraction's.
  'embed-thing': { retryLimit: 3, retryDelay: 30, retryBackoff: true, expireInSeconds: 90 },
  // Hourly and on demand: the backlog of things without a current vector, in batches.
  'embed-backfill': { retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 3600 },
  // A write's fan-out to the location's webhooks: rows and jobs only, no HTTP.
  'webhook-fanout': { retryLimit: 2, retryDelay: 10, retryBackoff: true, expireInSeconds: 60 },
  // §3.1b, §2.6: one delivery, 10 attempts over about 24 hours, as step 4's channel webhook.
  'webhook-deliver': { retryLimit: 9, retryDelay: 113, retryBackoff: true, expireInSeconds: 60 },
  // Daily: expired threads and proposals (D23, D22; kept.prune_assistant, T5, T13).
  'assistant-maintenance': MAINTENANCE,
  // D180 (T16): mails every active user about one configuration change. Never retried: a retry
  // would mail everyone already told a second time (one failed address is logged, not thrown).
  'transparency-notice': {
    retryLimit: 0,
    retryDelay: 0,
    retryBackoff: false,
    expireInSeconds: 900,
  },
  // Step 8 (plan T2). Hourly: disk space, a stale backup, bucket versioning and the drill's nudge
  // (backup/watch.ts, T10). Runs again within the hour, so maintenance's few retries.
  'ops-watch': MAINTENANCE,
  // Hourly, opt-in (D65): about once a day, at this instance's hour, one request to GitHub's
  // latest-release endpoint (updates/check.ts, T11); off, it reads one row and stops. Never
  // retried: a failure (a rate limit included) waits for the next day.
  'update-check': { retryLimit: 0, retryDelay: 0, retryBackoff: false, expireInSeconds: 60 },
  // Weekly: `restic check` and, with S3 file storage, the manifest against the bucket (T7). Long
  // like the backup itself (§3.1b "backup: 2 attempts, 4 h").
  'backup-verify': { retryLimit: 1, retryDelay: 900, retryBackoff: false, expireInSeconds: 14_400 },
} as const satisfies Record<string, JobPolicy>;

export type JobName = keyof typeof JOB_POLICIES;

/** The queue options pg-boss takes for a policy. */
export function queueOptions(policy: JobPolicy) {
  return {
    retryLimit: policy.retryLimit,
    retryDelay: policy.retryDelay,
    retryBackoff: policy.retryBackoff,
    expireInSeconds: policy.expireInSeconds,
  };
}
