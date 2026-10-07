import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, type Person, peopleApp, person } from '../../test/people.js';
import { asOwner, ownerTx } from '../../test/tenancy.js';
import { UPDATE_CHECK_ENABLED_KEY } from './check.js';

// "Check now" (D65; plan T11) through the front door. The test app has no KEPT_SOURCE_URL, so
// the check can't be a GitHub one and nothing leaves the machine; updates/check.test.ts drives
// the GitHub answers against a local stub.

let db: TestDb;
let t: TestApp;
let ibrahim: Person;
let louis: Person;

// One app and two people for the file (signing up is the slow part); each case starts with the
// switch off, and reads only its own audit rows.
beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db);
  ibrahim = await person(t, db, 'ibrahim');
  louis = await person(t, db, 'louis');
  await ownerTx(db, (c) =>
    c.query('INSERT INTO public.instance_admins (user_id) VALUES ($1)', [ibrahim.userId]),
  );
});
afterAll(async () => {
  await t.app.close();
});
let since = new Date();
beforeEach(async () => {
  since = new Date();
  await ownerTx(db, (c) =>
    c.query(`DELETE FROM public.instance_settings WHERE key LIKE 'update_check%'`),
  );
});

const enable = () =>
  ownerTx(db, (c) =>
    c.query(
      `INSERT INTO public.instance_settings (key, value) VALUES ($1, 'true'::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      [UPDATE_CHECK_ENABLED_KEY],
    ),
  );
const checkNow = (as: Person) =>
  call(t, '/api/v1/admin/updates/check', { as, method: 'POST', body: {} });
const auditOf = () =>
  asOwner(db, async (c) => {
    const { rows } = await c.query<{ action: string; diff: unknown }>(
      `SELECT action, diff FROM public.audit_events
        WHERE action = 'instance.update_check' AND at >= $1`,
      [since],
    );
    return rows;
  });

describe('POST /api/v1/admin/updates/check', () => {
  it('is 404 for anyone but an instance admin', async () => {
    await enable();
    expect((await checkNow(louis)).statusCode).toBe(404);
    expect(await auditOf()).toEqual([]);
  });

  it('is refused while the switch is off (the default): nothing is asked', async () => {
    const res = await checkNow(ibrahim);
    expect(res.statusCode).toBe(409);
    expect(await auditOf()).toEqual([]);
  });

  // catalogue: POST /api/v1/admin/updates/check
  it('on: asks, stores the answer and audits the outcome (not_github without a GitHub source)', async () => {
    await enable();
    const res = await checkNow(ibrahim);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      enabled: true,
      locked: false,
      lastCheckedAt: expect.any(String),
      latest: null,
      error: 'not_github',
    });
    expect(await auditOf()).toMatchObject([
      { action: 'instance.update_check', diff: { error: { after: 'not_github' } } },
    ]);
  });
});

describe('"Check for new versions" in Admin → Settings', () => {
  it('is off by default; an instance admin turns it on, audited, and Check now then asks', async () => {
    const settings = await call(t, '/api/v1/admin/settings', { as: ibrahim });
    expect(settings.json()).toMatchObject({ updateCheck: { value: false, locked: false } });
    const on = await call(t, '/api/v1/admin/settings', {
      as: ibrahim,
      method: 'PUT',
      body: { updateCheck: true },
    });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json()).toMatchObject({ updateCheck: { value: true, locked: false } });
    const audit = await asOwner(db, async (c) => {
      const { rows } = await c.query<{ diff: unknown }>(
        `SELECT diff FROM public.audit_events
          WHERE action = 'instance.settings_update' AND at >= $1`,
        [since],
      );
      return rows;
    });
    expect(audit).toMatchObject([{ diff: { update_check: { before: false, after: true } } }]);
    expect((await checkNow(ibrahim)).statusCode).toBe(200);
  });
});
