import { createHash } from 'node:crypto';
import { newId, randomShortCode } from '@kept/shared';
import type pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testDb } from '../../test/db.js';
import {
  addMember,
  ownerTx,
  pgError,
  seedTenant,
  seedUser,
  type Tenant,
} from '../../test/tenancy.js';
import { withScope, withSystem } from './scope.js';

// Step-4 T7 (0054, 0055): the reminder ledger written exactly once (D111, §7.13), the user-scope
// channels, devices, choices, centre and calendar links, their caps and the calendar feed's door
// (D142, D181), and T19's two carry-over pieces (a moved code resends the thing it left; a past
// membership for location_revoked).

const db = await testDb();
vi.setConfig({ testTimeout: 60_000 });

let ibrahim: Tenant; // owns Home
let bruce: string; // admin of Home
let talia: Tenant; // another household
let drill: string;

const as = <T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  withScope(db.pools.app, { userId, mfa: true }, (_tx, c) => fn(c));
const asSystem = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  withSystem(db.pools.system, (_tx, c) => fn(c));
const own = <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(sql, values)).rows);
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

beforeEach(async () => {
  await db.reset();
  ibrahim = await seedTenant(db, 'rem-ibrahim');
  bruce = await seedUser(db, 'rem-bruce');
  await addMember(db, ibrahim.locationId, bruce, 'admin');
  talia = await seedTenant(db, 'rem-talia');
  drill = newId();
  await own(
    `INSERT INTO public.things (id, location_id, place_id, name) VALUES ($1, $2, $3, 'Drill')`,
    [drill, ibrahim.locationId, ibrahim.unplacedId],
  );
});

describe('occurrences, exactly once (D111)', () => {
  const write = (source: string, thing: string | null) =>
    asSystem(
      async (c) =>
        (
          await c.query(
            `INSERT INTO public.reminder_occurrences (location_id, thing_id, source_type, source_id,
                                                      kind, due_period, due_on)
             VALUES ($1, $2, 'document', $3, 'expiring', 'date:2026-10-20', '2026-10-20')
             ON CONFLICT ON CONSTRAINT reminder_occurrences_key_uq DO NOTHING`,
            [ibrahim.locationId, thing, source],
          )
        ).rowCount,
    );

  it('are written once by two scans, even at once, subject or none', async () => {
    const onThing = newId();
    const onLocation = newId();
    expect(await Promise.all([write(onThing, drill), write(onThing, drill)])).toEqual(
      expect.arrayContaining([1, 0]),
    );
    expect(await write(onLocation, null)).toBe(1);
    // NULLS NOT DISTINCT: a location-level document's key holds too.
    expect(await write(onLocation, null)).toBe(0);
    expect(await own('SELECT count(*)::int AS n FROM public.reminder_occurrences')).toEqual([
      { n: 2 },
    ]);
  });

  it("are the scan's to write; a request only reads them where it sees the location", async () => {
    await write(newId(), drill);
    expect(
      (
        await pgError(
          as(bruce, (c) =>
            c.query(
              `INSERT INTO public.reminder_occurrences (location_id, source_type, source_id, kind,
                                                        due_period)
               VALUES ($1, 'loan', $2, 'overdue', 'date:2026-10-01')`,
              [ibrahim.locationId, newId()],
            ),
          ),
        )
      ).code,
    ).toBe('42501');
    const n = (userId: string) =>
      as(
        userId,
        async (c) => (await c.query('SELECT 1 FROM public.reminder_occurrences')).rowCount,
      );
    expect(await n(bruce)).toBe(1);
    expect(await n(talia.userId)).toBe(0);
    expect(
      (
        await pgError(
          own(
            `INSERT INTO public.reminder_occurrences (location_id, source_type, source_id, kind,
                                                      due_period)
             VALUES ($1, 'loan', $2, 'overdue', 'meter:12,5')`,
            [ibrahim.locationId, newId()],
          ),
        )
      ).constraint,
    ).toBe('reminder_occurrences_due_period_chk');
  });
});

describe("a person's channels, devices, choices and centre (D29, D30, D39)", () => {
  const channel = (userId: string, kind: string) =>
    as(userId, (c) =>
      c.query(
        `INSERT INTO public.notification_channels (user_id, kind, config_ciphertext, key_version)
         VALUES ($1, $2, CASE WHEN $2 = 'webhook' THEN '{"v": 1}'::jsonb END,
                 CASE WHEN $2 = 'webhook' THEN 1 END)`,
        [userId, kind],
      ),
    );

  it('one email, one push channel and at most 5 webhooks each', async () => {
    await channel(bruce, 'email');
    expect((await pgError(channel(bruce, 'email'))).constraint).toBe(
      'notification_channels_email_uq',
    );
    for (let i = 0; i < 5; i++) await channel(bruce, 'webhook');
    expect((await pgError(channel(bruce, 'webhook'))).constraint).toBe(
      'notification_channels_webhook_cap',
    );
    // Someone else's are their own business.
    await channel(ibrahim.userId, 'webhook');
    expect(
      await as(
        ibrahim.userId,
        async (c) => (await c.query('SELECT 1 FROM public.notification_channels')).rowCount,
      ),
    ).toBe(1);
    expect((await pgError(channel(ibrahim.userId, 'ntfy'))).code).toBe('23514');
  });

  it('keeps push endpoints to HTTPS', async () => {
    const add = (endpoint: string) =>
      as(bruce, (c) =>
        c.query(
          `INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth)
           VALUES ($1, $2, 'k', 'a')`,
          [bruce, endpoint],
        ),
      );
    expect((await pgError(add('http://192.168.1.10/push'))).constraint).toBe(
      'push_subscriptions_endpoint_chk',
    );
    await add('https://push.example.test/abc');
  });

  it('takes a choice for a location the person sees, and the AI summary for none (Q35)', async () => {
    const choose = (userId: string, location: string | null, kind: string) =>
      as(userId, (c) =>
        c.query(
          `INSERT INTO public.notification_preferences (user_id, location_id, kind, channel, enabled)
           VALUES ($1, $2, $3, 'email', false)`,
          [userId, location, kind],
        ),
      );
    await choose(bruce, ibrahim.locationId, 'loan');
    expect((await pgError(choose(bruce, talia.locationId, 'loan'))).code).toBe('42501');
    expect((await pgError(choose(bruce, null, 'loan'))).constraint).toBe(
      'notification_preferences_account_chk',
    );
    await choose(bruce, null, 'ai_summary');
    expect((await pgError(choose(bruce, null, 'ai_summary'))).constraint).toBe(
      'notification_preferences_uq',
    );
  });

  it("hides a location's notifications once the person loses it, and lets them mark read only", async () => {
    const [n] = await asSystem(
      async (c) =>
        (
          await c.query<{ id: string }>(
            `INSERT INTO public.notifications (user_id, location_id, kind, payload)
           VALUES ($1, $2, 'membership_added', '{}') RETURNING id`,
            [bruce, ibrahim.locationId],
          )
        ).rows,
    );
    expect(
      await as(
        bruce,
        async (c) =>
          (await c.query('UPDATE public.notifications SET read_at = now() WHERE id = $1', [n?.id]))
            .rowCount,
      ),
    ).toBe(1);
    expect(
      (
        await pgError(
          as(bruce, (c) =>
            c.query(`UPDATE public.notifications SET payload = '{}' WHERE id = $1`, [n?.id]),
          ),
        )
      ).code,
    ).toBe('42501');
    await own('DELETE FROM public.memberships WHERE user_id = $1', [bruce]);
    expect(
      await as(bruce, async (c) => (await c.query('SELECT 1 FROM public.notifications')).rowCount),
    ).toBe(0);
  });
});

describe('calendar feeds (D142, D181)', () => {
  const link = (userId: string, token: string) =>
    as(userId, (c) =>
      c.query('INSERT INTO public.calendar_feeds (user_id, token_hash) VALUES ($1, $2)', [
        userId,
        hash(token),
      ]),
    );
  const fetchFeed = (token: string) =>
    asSystem(async (c) => {
      const { rows } = await c.query<{ u: string | null }>(
        'SELECT kept.calendar_feed_user($1) AS u',
        [hash(token)],
      );
      return rows[0]?.u ?? null;
    });

  it('allow 3 live links a person, and answer a fetch with its user, counted once a minute', async () => {
    for (const t of ['a', 'b', 'c']) await link(bruce, `feed-${t}`);
    expect((await pgError(link(bruce, 'feed-d'))).constraint).toBe('calendar_feeds_cap');
    await as(bruce, (c) =>
      c.query('UPDATE public.calendar_feeds SET revoked_at = now() WHERE token_hash = $1', [
        hash('feed-a'),
      ]),
    );
    await link(bruce, 'feed-d');
    expect(await fetchFeed('feed-b')).toBe(bruce);
    expect(await fetchFeed('feed-b')).toBe(bruce);
    expect(
      await own('SELECT fetches FROM public.calendar_feeds WHERE token_hash = $1', [
        hash('feed-b'),
      ]),
    ).toEqual([{ fetches: 1 }]);
    // Revoked, unknown, or its user banned: nothing, alike.
    expect(await fetchFeed('feed-a')).toBeNull();
    expect(await fetchFeed('no-such-feed')).toBeNull();
    await own('UPDATE auth."user" SET banned = true WHERE id = $1', [bruce]);
    expect(await fetchFeed('feed-b')).toBeNull();
    expect(
      (
        await pgError(
          as(bruce, (c) => c.query('SELECT kept.calendar_feed_user($1)', [hash('feed-b')])),
        )
      ).code,
    ).toBe('42501');
  });
});

describe('admin alerts', () => {
  it('know reminders_not_scanned (D166)', async () => {
    await own(
      `INSERT INTO public.admin_alerts (kind, dedupe_key) VALUES ('reminders_not_scanned', 'scan')`,
    );
  });
});

describe('step-3 carry-over (T19)', () => {
  it("resends the thing a code moved away from (state_version), not the code's new one alone", async () => {
    const kettle = newId();
    await own(
      `INSERT INTO public.things (id, location_id, place_id, name) VALUES ($1, $2, $3, 'Kettle')`,
      [kettle, ibrahim.locationId, ibrahim.unplacedId],
    );
    const code = randomShortCode();
    await own(
      `INSERT INTO public.short_ids (code, location_id, state, thing_id, is_primary)
       VALUES ($1, $2, 'assigned', $3, false)`,
      [code, ibrahim.locationId, drill],
    );
    const version = async (id: string) =>
      (
        await own<{ v: number }>('SELECT state_version AS v FROM public.things WHERE id = $1', [id])
      )[0]?.v;
    const before = await version(drill);
    await own('UPDATE public.short_ids SET thing_id = $2 WHERE code = $1', [code, kettle]);
    expect(await version(drill)).toBe((before ?? 0) + 1);
  });

  it('kept.was_member_of: yes for a removed or expired member, no for a stranger', async () => {
    const louis = await seedUser(db, 'rem-louis');
    await addMember(db, ibrahim.locationId, louis, 'member');
    const was = (userId: string) =>
      as(userId, async (c) => {
        const { rows } = await c.query<{ v: boolean }>('SELECT kept.was_member_of($1) AS v', [
          ibrahim.locationId,
        ]);
        return rows[0]?.v;
      });
    expect(await was(talia.userId)).toBe(false);
    // Removed, with the audit event members.ts writes.
    const membership = (
      await own<{ id: string }>('SELECT id FROM public.memberships WHERE user_id = $1', [louis])
    )[0]?.id;
    await own(
      `INSERT INTO public.audit_events (location_id, owner_account_id, actor_type, actor_id, action,
                                        entity_type, entity_id, diff)
       VALUES ($1, $2, 'user', $3, 'member.remove', 'membership', $4,
               jsonb_build_object('user_id', jsonb_build_object('before', $5::text, 'after', NULL,
                                                                'class', 'normal')))`,
      [ibrahim.locationId, ibrahim.accountId, ibrahim.userId, membership, louis],
    );
    await own('DELETE FROM public.memberships WHERE id = $1', [membership]);
    expect(await was(louis)).toBe(true);
    // Expired, not yet removed.
    await own(
      `UPDATE public.memberships SET expires_at = now() - interval '1 minute' WHERE user_id = $1`,
      [bruce],
    );
    expect(await was(bruce)).toBe(true);
  });
});
