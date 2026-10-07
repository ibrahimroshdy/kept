import pg from 'pg';
import { z } from 'zod';
import { CliError } from '../admin/cli.js';
import { EnvError } from '../config/env.js';
import { reportConnectionLoss } from '../db/pools.js';
import {
  BACKFILL_BATCH_DEFAULT,
  BACKFILL_BATCH_MAX,
  backfillPdfText,
} from '../files/pdf-backfill.js';
import { safeErrorForLog } from '../http/errors.js';
import { createBoss } from '../jobs/boss.js';
import { bossQueue, createRequestQueues } from '../jobs/queue.js';

// `kept admin backfill-pdf-text [--batch <n>] [--dry-run]` (T21 follow-up): queues the
// `pdf-text` job for PDFs uploaded before the upload sent it (files/pdf-backfill.ts). A running
// worker reads them. Three logins, and nothing else:
// - KEPT_OWNER_DATABASE_URL, to find the PDFs across every location;
// - KEPT_DATABASE_URL (kept_app), to send each job in the scope of someone who may write there,
//   as the upload does;
// - KEPT_SYSTEM_DATABASE_URL, for the pg-boss instance a sender must start (jobs/boss.ts).

type Source = Record<string, string | undefined>;

const postgresUrl = () => z.url({ protocol: /^postgres(ql)?$/ });
const envSchema = z.object({
  KEPT_OWNER_DATABASE_URL: postgresUrl(),
  KEPT_DATABASE_URL: postgresUrl(),
  KEPT_SYSTEM_DATABASE_URL: postgresUrl(),
});

function loadBackfillEnv(source: Source) {
  const parsed = envSchema.safeParse(
    Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== '')),
  );
  if (!parsed.success) {
    const missing = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))].join(', ');
    throw new EnvError(
      `backfill-pdf-text needs KEPT_OWNER_DATABASE_URL, KEPT_DATABASE_URL and KEPT_SYSTEM_DATABASE_URL (postgres:// URLs): ${missing}`,
      'invalid_env',
    );
  }
  return parsed.data;
}

/** Parses `--batch`: a whole number from 1 to BACKFILL_BATCH_MAX. */
export function batchOf(raw: string | undefined): number {
  if (raw === undefined) return BACKFILL_BATCH_DEFAULT;
  if (!/^[1-9]\d{0,5}$/.test(raw) || Number(raw) > BACKFILL_BATCH_MAX) {
    throw new CliError(`--batch takes a whole number from 1 to ${BACKFILL_BATCH_MAX}`);
  }
  return Number(raw);
}

export async function backfillPdfTextCommand(
  source: Source,
  opts: { batch?: string; dryRun?: boolean },
  print: (line: string) => void,
): Promise<number> {
  const batch = batchOf(opts.batch);
  const env = loadBackfillEnv(source);
  const owner = new pg.Pool({
    connectionString: env.KEPT_OWNER_DATABASE_URL,
    application_name: 'kept-admin',
    max: 1,
  });
  const app = new pg.Pool({
    connectionString: env.KEPT_DATABASE_URL,
    application_name: 'kept-admin',
    max: 2,
  });
  const boss = createBoss({
    connectionString: env.KEPT_SYSTEM_DATABASE_URL,
    application_name: 'kept-admin',
    supervise: false,
    schedule: false,
    max: 2,
  });
  for (const [name, pool] of [
    ['owner', owner],
    ['app', app],
  ] as const) {
    reportConnectionLoss(pool, (err, inUse) =>
      print(`database connection lost (${name}${inUse ? ', in use' : ''}): ${err.message}`),
    );
  }
  boss.on('error', (err) => {
    const e = safeErrorForLog(err);
    print(`pg-boss: ${String(e.message ?? e.code ?? e.type)}`);
  });
  try {
    await boss.start();
    await createRequestQueues(boss);
    const report = await backfillPdfText(
      { owner, app, queue: bossQueue(boss) },
      { batch, dryRun: opts.dryRun === true },
      print,
    );
    if (opts.dryRun) {
      print(`${report.found} PDFs have no text and no job; nothing was queued (dry run).`);
    } else {
      print(`Queued ${report.queued} PDFs for their text; a running worker reads them.`);
    }
    if (report.noWriter > 0) {
      print(
        `${report.noWriter} PDFs were left: unattached, and their uploader may no longer write where they are.`,
      );
    }
    return 0;
  } finally {
    await boss.stop({ graceful: false });
    await Promise.all([owner.end(), app.end()]);
  }
}
