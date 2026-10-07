import { beforeEach, describe, expect, it } from 'vitest';
import { type TestDb, testDb } from '../../test/db.js';
import { addMember, ownerTx, seedTenant, seedUser } from '../../test/tenancy.js';
import { systemJobs } from '../jobs/system.js';
import type { Mail } from '../mail/mailer.js';
import { expireMemberships, notifyOwnerNewMember } from './membership-jobs.js';

// Task 19: the membership jobs, as kept_system (D46, D180).

let db: TestDb;

beforeEach(async () => {
  db = await testDb();
  await db.reset();
});

async function events(locationId: string) {
  const { rows } = await ownerTx(db, (c) =>
    c.query(
      `SELECT action, actor_type, owner_account_id, entity_id FROM public.audit_events
        WHERE location_id = $1 ORDER BY at, id`,
      [locationId],
    ),
  );
  return rows;
}

describe('expire-memberships', () => {
  it('removes memberships past their end date, and audits each for the location', async () => {
    const a = await seedTenant(db, 'a');
    const gone = await seedUser(db, 'gone');
    const staying = await seedUser(db, 'staying');
    await addMember(db, a.locationId, gone, 'viewer', new Date(Date.now() - 1000));
    await addMember(db, a.locationId, staying, 'member', new Date(Date.now() + 86_400_000));

    const expired = await expireMemberships(db.pools);
    expect(expired.map((m) => m.userId)).toEqual([gone]);
    const { rows } = await ownerTx(db, (c) =>
      c.query('SELECT user_id, role FROM public.memberships WHERE location_id = $1', [
        a.locationId,
      ]),
    );
    expect(rows.map((r) => r.user_id).sort()).toEqual([a.userId, staying].sort());
    expect(await events(a.locationId)).toEqual([
      {
        action: 'member.expire',
        actor_type: 'system',
        owner_account_id: a.accountId,
        entity_id: expired[0]?.id,
      },
    ]);
    // Nothing left to do.
    expect(await expireMemberships(db.pools)).toEqual([]);
  });

  it('is scheduled every 15 minutes', async () => {
    const jobs = systemJobs({
      pools: db.pools,
      log: { info() {}, error() {} },
      mailer: { send: async () => {} },
      publicUrl: 'http://kept.test',
    });
    const expire = jobs.find((j) => j.name === 'expire-memberships');
    expect(expire?.kind === 'system' ? expire.schedule : null).toBe('*/15 * * * *');
    const notify = jobs.find((j) => j.name === 'notify-owner-new-member');
    expect(notify).toMatchObject({ kind: 'system' });
    expect(notify && 'schedule' in notify).toBe(false);
  });
});

describe('notify-owner-new-member', () => {
  it('audits the notice for the membership named, re-read from the database', async () => {
    const a = await seedTenant(db, 'a');
    const joiner = await seedUser(db, 'joiner');
    await addMember(db, a.locationId, joiner, 'member');
    const logged: object[] = [];
    const ok = await notifyOwnerNewMember(
      db.pools,
      { locationId: a.locationId, userId: joiner },
      { info: (obj) => logged.push(obj) },
    );
    expect(ok).toBe(true);
    expect(await events(a.locationId)).toEqual([
      expect.objectContaining({
        action: 'member.owner_notified',
        actor_type: 'system',
        owner_account_id: a.accountId,
      }),
    ]);
    expect(logged).toEqual([expect.objectContaining({ ownerId: a.userId })]);
  });

  it('does nothing for a membership that is gone, the owner row, or malformed data', async () => {
    const a = await seedTenant(db, 'a');
    const nobody = await seedUser(db, 'nobody');
    for (const data of [
      { locationId: a.locationId, userId: nobody },
      { locationId: a.locationId, userId: a.userId },
      { locationId: 'x', userId: 'y' },
      null,
    ]) {
      expect(await notifyOwnerNewMember(db.pools, data)).toBe(false);
    }
    expect(await events(a.locationId)).toEqual([]);
  });
});

describe('the owner in the centre (step 4, Q30)', () => {
  const noticesOf = (userId: string) =>
    ownerTx(db, async (c) => {
      const { rows } = await c.query(
        `SELECT kind, location_id, occurrence_id, payload, read_at FROM public.notifications
          WHERE user_id = $1 ORDER BY created_at, id`,
        [userId],
      );
      return rows;
    });

  it('a new member and an ended membership each leave the owner a notice, with the mail', async () => {
    const ibrahim = await seedTenant(db, 'Ibrahim');
    const louis = await seedUser(db, 'Louis');
    const talia = await seedUser(db, 'Talia');
    await addMember(db, ibrahim.locationId, louis, 'member');
    await addMember(db, ibrahim.locationId, talia, 'viewer', new Date(Date.now() - 1000));
    const mailed: object[] = [];
    await notifyOwnerNewMember(
      db.pools,
      { locationId: ibrahim.locationId, userId: louis },
      undefined,
      {
        send: async (m) => {
          mailed.push(m);
        },
      },
    );
    await expireMemberships(db.pools);
    expect(mailed).toHaveLength(1);
    expect(await noticesOf(ibrahim.userId)).toEqual([
      {
        kind: 'membership_added',
        location_id: ibrahim.locationId,
        occurrence_id: null,
        payload: { userId: louis, userName: 'Louis', role: 'member', managed: false },
        read_at: null,
      },
      {
        kind: 'membership_ended',
        location_id: ibrahim.locationId,
        occurrence_id: null,
        payload: { userId: talia, userName: 'Talia', role: 'viewer' },
        read_at: null,
      },
    ]);
    // The members themselves are told nothing here.
    expect(await noticesOf(louis)).toEqual([]);
  });

  it('a failed mail rolls the notice back with it, so the retry writes it once', async () => {
    const ibrahim = await seedTenant(db, 'Ibrahim');
    const bruce = await seedUser(db, 'Bruce');
    await addMember(db, ibrahim.locationId, bruce, 'admin');
    await ownerTx(db, (c) =>
      c.query('UPDATE auth."user" SET email = $2 WHERE id = $1', [
        ibrahim.userId,
        'ibrahim@example.test',
      ]),
    );
    const data = { locationId: ibrahim.locationId, userId: bruce };
    await expect(
      notifyOwnerNewMember(db.pools, data, undefined, {
        send: async () => {
          throw new Error('smtp down');
        },
      }),
    ).rejects.toThrow('smtp down');
    expect(await noticesOf(ibrahim.userId)).toEqual([]);
    await notifyOwnerNewMember(db.pools, data, undefined, { send: async () => {} });
    expect(await noticesOf(ibrahim.userId)).toHaveLength(1);
  });

  it('an ended membership mails the owner too, unless email for Membership is off or unverified', async () => {
    const ibrahim = await seedTenant(db, 'Ibrahim');
    const talia = await seedUser(db, 'Talia');
    const louis = await seedUser(db, 'Louis');
    await ownerTx(db, (c) =>
      c.query(`UPDATE auth."user" SET email_verified = true WHERE id = $1`, [ibrahim.userId]),
    );
    const mailed: Mail[] = [];
    const mail = {
      mailer: {
        send: async (m: Mail) => {
          mailed.push(m);
        },
      },
      auth: db.pools.auth,
    };
    await addMember(db, ibrahim.locationId, talia, 'viewer', new Date(Date.now() - 1000));
    await expireMemberships(db.pools, undefined, mail);
    expect(mailed).toEqual([
      expect.objectContaining({
        kind: 'membership-ended',
        locationName: 'Home',
        memberName: 'Talia',
        role: 'viewer',
        endedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      }),
    ]);
    // Email for Membership turned off: the notice, and no mail.
    await ownerTx(db, (c) =>
      c.query(
        `INSERT INTO public.notification_preferences (user_id, location_id, kind, channel, enabled)
         VALUES ($1, $2, 'membership', 'email', false)`,
        [ibrahim.userId, ibrahim.locationId],
      ),
    );
    await addMember(db, ibrahim.locationId, louis, 'member', new Date(Date.now() - 1000));
    await expireMemberships(db.pools, undefined, mail);
    expect(mailed).toHaveLength(1);
    expect(await noticesOf(ibrahim.userId)).toHaveLength(2);
    // An unverified address gets nothing either.
    await ownerTx(db, async (c) => {
      await c.query('DELETE FROM public.notification_preferences');
      await c.query(`UPDATE auth."user" SET email_verified = false WHERE id = $1`, [
        ibrahim.userId,
      ]);
    });
    await addMember(db, ibrahim.locationId, talia, 'viewer', new Date(Date.now() - 1000));
    await expireMemberships(db.pools, undefined, mail);
    expect(mailed).toHaveLength(1);
  });

  it('an owner who turned Membership off in the centre gets no notice', async () => {
    const ibrahim = await seedTenant(db, 'Ibrahim');
    const peter = await seedUser(db, 'Peter');
    await addMember(db, ibrahim.locationId, peter, 'member');
    await ownerTx(db, (c) =>
      c.query(
        `INSERT INTO public.notification_preferences (user_id, location_id, kind, channel, enabled)
         VALUES ($1, $2, 'membership', 'inapp', false)`,
        [ibrahim.userId, ibrahim.locationId],
      ),
    );
    await notifyOwnerNewMember(db.pools, { locationId: ibrahim.locationId, userId: peter });
    expect(await noticesOf(ibrahim.userId)).toEqual([]);
  });
});
