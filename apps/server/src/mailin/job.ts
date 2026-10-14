import { defineJob, type JobDefinition } from '../jobs/boss.js';
import { JOB_POLICIES } from '../jobs/policies.js';
import type { SystemJobDeps } from '../jobs/system.js';
import { MAIL_IN_JOB, runMailIn } from './poll.js';
import { imapSource } from './source.js';

// The `mail-in` system job (1.4, D231), every 10 minutes: see poll.ts. It needs the app pool
// (each capture runs as the mailbox's creator), the file storage and the keyring; a worker
// without them logs once a run and reads nothing.
export function mailInJobs(deps: SystemJobDeps): JobDefinition[] {
  return [
    defineJob({
      name: MAIL_IN_JOB,
      kind: 'system',
      schedule: '*/10 * * * *',
      policy: JOB_POLICIES[MAIL_IN_JOB],
      handler: async () => {
        const app = deps.pools.app;
        if (!app || !deps.files) {
          deps.log.info({}, 'mail-in: this worker has no kept_app pool or file storage');
          return;
        }
        const outcomes = await runMailIn({
          pools: { app, system: deps.pools.system },
          files: deps.files,
          keyring: deps.secretKeys?.get().keyring ?? null,
          source: imapSource(),
          ...(deps.sendTenant ? { sendTenant: deps.sendTenant } : {}),
          log: deps.log,
        });
        const read = outcomes.reduce((n, o) => n + o.read, 0);
        if (read > 0 || outcomes.some((o) => o.error)) deps.log.info({ outcomes }, 'mail-in ran');
      },
    }),
  ];
}
