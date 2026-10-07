import { newId } from '@kept/shared';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { type TestFiles, testFiles, uniqueJpeg, upload } from '../../test/files.js';
import { type Person, peopleApp, person } from '../../test/people.js';
import { createLocation, type Loc, own } from '../../test/things.js';
import { withScope } from '../db/scope.js';
import { createBoss } from '../jobs/boss.js';
import { JOB_POLICIES, queueOptions } from '../jobs/policies.js';
import { bossQueue } from '../jobs/queue.js';
import { capture } from './service.js';

// D94: a capture's extraction job is sent on the capture's own transaction. A capture that rolls
// back leaves no job behind; one that commits leaves exactly one, in the capturer's scope.

let db: TestDb;
let t: TestApp;
let files: TestFiles;
let boss: PgBoss;
let ibrahim: Person;
let home: Loc;

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  files = await testFiles();
  t = await peopleApp(db, { files });
  ibrahim = await person(t, db, 'ibrahim');
  home = await createLocation(t, db, ibrahim, 'household');
  await own(
    db,
    `INSERT INTO public.ai_providers (id, scope, owner_account_id, kind, key_ciphertext,
                                      key_version, models, created_by)
     VALUES ($1, 'account', $2, 'groq', '{"v": 1}', 1, $3, $4)`,
    [newId(), home.accountId, JSON.stringify({ vision: 'qwen/qwen3.8-27b' }), ibrahim.userId],
  );
  boss = createBoss({
    connectionString: db.urls.system,
    supervise: false,
    schedule: false,
    max: 2,
  });
  boss.on('error', (err) => {
    throw err;
  });
  await boss.start();
  await boss.createQueue('extract', queueOptions(JOB_POLICIES.extract));
});

afterAll(async () => {
  await boss.stop({ graceful: false });
  await t.app.close();
  await files.cleanup();
});

async function uploaded(): Promise<string> {
  const res = await upload(t, ibrahim, home.id, await uniqueJpeg());
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { id: string }).id;
}

const jobsFor = async (extractionId: string) => {
  const { rows } = await db.pools.system.query<{ user_id: string }>(
    `SELECT data->>'userId' AS user_id FROM pgboss.job
      WHERE name = 'extract' AND data->'data'->>'extractionId' = $1`,
    [extractionId],
  );
  return rows;
};

function run(fileId: string, rollback: boolean) {
  const scope = { userId: ibrahim.userId, mfa: false };
  let extractionId = '';
  const done = withScope(db.pools.app, scope, async (tx, client) => {
    const out = await capture(
      { tx, client, scope, requestId: newId(), jobs: bossQueue(boss), files },
      {
        id: newId(),
        locationId: home.id,
        target: { unplaced: true },
        mode: 'thing',
        batchId: newId(),
        files: [{ fileId, role: 'photo' }],
      },
      { via: 'online' },
    );
    extractionId = out.extraction?.id ?? '';
    if (rollback) throw new Error('rolled back on purpose');
  });
  return { done, extractionId: () => extractionId };
}

describe('the extraction job goes with the capture', () => {
  it("leaves no job when the capture rolls back, and one in the capturer's scope when it commits", async () => {
    const failed = run(await uploaded(), true);
    await expect(failed.done).rejects.toThrow('rolled back on purpose');
    expect(failed.extractionId()).not.toBe('');
    expect(await jobsFor(failed.extractionId())).toEqual([]);

    const kept = run(await uploaded(), false);
    await kept.done;
    expect(await jobsFor(kept.extractionId())).toEqual([{ user_id: ibrahim.userId }]);
  });
});
