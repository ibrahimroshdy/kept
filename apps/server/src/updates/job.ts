import { KEPT_VERSION } from '@kept/shared';
import { withSystem } from '../db/scope.js';
import { defineJob, type JobDefinition } from '../jobs/boss.js';
import { JOB_POLICIES } from '../jobs/policies.js';
import type { SystemJobDeps } from '../jobs/system.js';
import { type CheckOptions, runScheduledUpdateCheck } from './check.js';

// The opt-in update check (D65; step-8 plan T11), gathered by jobs/operations.ts. Hourly, and
// nothing at all while "Check for new versions" is off (the default). When it is on, the job
// asks GitHub about once a day, at an hour of the day picked at random for this instance and
// kept in instance_settings.update_check, so instances don't all ask together (updates/check.ts
// updateCheckDue). Without `deps.updates` (a worker built without them) it never asks.

export function updateCheckJobs(
  deps: SystemJobDeps,
  test: Pick<CheckOptions, 'fetch' | 'apiBase'> = {},
): JobDefinition[] {
  return [
    defineJob({
      name: 'update-check',
      kind: 'system',
      schedule: '7 * * * *',
      policy: JOB_POLICIES['update-check'],
      handler: async () => {
        const updates = deps.updates;
        if (!updates) return;
        await runScheduledUpdateCheck((fn) => withSystem(deps.pools.system, (_tx, c) => fn(c)), {
          env: { KEPT_UPDATE_CHECK: updates.updateCheck },
          sourceUrl: updates.sourceUrl,
          version: KEPT_VERSION,
          ...test,
        });
      },
    }),
  ];
}
