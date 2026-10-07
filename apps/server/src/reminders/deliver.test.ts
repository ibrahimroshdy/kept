import { newId } from '@kept/shared';
import type pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testDb } from '../../test/db.js';
import {
  addMember,
  ownerTx,
  seedTenant,
  seedUser,
  type Tenant,
  userEmail,
} from '../../test/tenancy.js';
import type {
  ChannelMessage,
  ChannelSender,
  ChannelTarget,
  ReminderItem,
  ReminderRecipient,
  SendOutcome,
} from './channel.js';
import { runDelivery } from './deliver.js';
import { runDigests } from './digest.js';
import { runScan } from './scan.js';

// Plan T14: `reminder-deliver` sends one queued delivery once (a duplicate job does nothing, a
// failure is retried, a closed occurrence or a departed member is skipped), and `reminder-digest`
// sends each person's digest once per local day and channel at their own digest time (D29, D122;
// spike V21's Cairo transitions, computed here, not typed in). What the senders get names the
// thing, its path, the location and the local date (L113); the words themselves are T15's
// (notify/words.ts, tested in five languages there).

const db = await testDb();
vi.setConfig({ testTimeout: 60_000 });
const PUBLIC_URL = 'https://kept.example.test';

const own = <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(sql, values)).rows);

type Sent = { target: ChannelTarget; to: ReminderRecipient; message: ChannelMessage };
let sent: Sent[];
let outcome: SendOutcome;
let jobs: { data: object }[];

const sender: ChannelSender = {
  send: async (target, to, message) => {
    sent.push({ target, to, message });
    return outcome;
  },
};
const deps = () => ({
  pools: db.pools,
  publicUrl: PUBLIC_URL,
  channels: { email: sender },
  send: async (_c: pg.ClientBase, _name: string, data: object) => {
    jobs.push({ data });
  },
});

let ibrahim: Tenant;
let bruce: string;
let today: string;
let drill: string;
let murdock: string;
let lent: string;

const plus = (days: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** The day of the last digest sent. */
const lastDigestOn = () => (sent.at(-1)?.message as { digestOn?: string } | undefined)?.digestOn;

const status = (userId: string) =>
  own<{ status: string; error: string | null; sent_at: Date | null }>(
    `SELECT d.status, d.error, d.sent_at FROM public.reminder_deliveries d WHERE d.user_id = $1`,
    [userId],
  );

beforeEach(async () => {
  await db.reset();
  sent = [];
  jobs = [];
  outcome = { status: 'sent' };
  ibrahim = await seedTenant(db, 'deliver-ibrahim', { name: 'Home' });
  bruce = await seedUser(db, 'deliver-bruce');
  await addMember(db, ibrahim.locationId, bruce, 'admin');
  await userEmail(db, ibrahim.userId, true);
  await userEmail(db, bruce, true);
  // Ibrahim alone is reminded here: Bruce opts out of loans, so each test sees one delivery.
  await own(
    `INSERT INTO public.notification_preferences (user_id, location_id, kind, channel, enabled)
     VALUES ($1, $2, 'loan', 'inapp', false), ($1, $2, 'document', 'inapp', false)`,
    [bruce, ibrahim.locationId],
  );
  const [row] = await own<{ today: string }>(
    `SELECT (now() AT TIME ZONE 'Africa/Cairo')::date::text AS today`,
  );
  today = row?.today as string;
  const garage = newId();
  const shelf = newId();
  await own(`INSERT INTO public.places (id, location_id, name) VALUES ($1, $2, 'Garage')`, [
    garage,
    ibrahim.locationId,
  ]);
  await own(
    `INSERT INTO public.places (id, location_id, parent_id, name) VALUES ($1, $2, $3, 'Shelf')`,
    [shelf, ibrahim.locationId, garage],
  );
  drill = newId();
  await own(
    `INSERT INTO public.things (id, location_id, place_id, name) VALUES ($1, $2, $3, 'Drill')`,
    [drill, ibrahim.locationId, shelf],
  );
  murdock = newId();
  await own(
    `INSERT INTO public.people (id, owner_account_id, display_name) VALUES ($1, $2, 'Murdock')`,
    [murdock, ibrahim.accountId],
  );
  lent = newId();
  await own(
    `INSERT INTO public.loans (id, location_id, thing_id, direction, person_id, started_at, due_on,
                               created_by)
     VALUES ($1, $2, $3, 'out', $4, now() - interval '20 days', $5, $6)`,
    [lent, ibrahim.locationId, drill, murdock, plus(-2), ibrahim.userId],
  );
});

describe('reminder-deliver', () => {
  it('sends once, naming the thing, its path, the location and the local date (L113)', async () => {
    await runScan(deps());
    expect(jobs).toHaveLength(1);
    const data = jobs[0]?.data;
    expect(await runDelivery(deps(), data)).toBe('sent');
    // A duplicate job, or pg-boss running it again, finds nothing to claim.
    expect(await runDelivery(deps(), data)).toBe('nothing');
    expect(sent).toHaveLength(1);
    const { target, to, message } = sent[0] as Sent;
    expect(target).toMatchObject({ kind: 'email', userId: ibrahim.userId });
    expect(to).toMatchObject({ userId: ibrahim.userId, locale: 'en' });
    expect(to.email).toMatch(/@example\.test$/);
    expect(message.mode).toBe('immediate');
    const item = (message as { item: ReminderItem }).item;
    expect(item).toMatchObject({
      sourceType: 'loan',
      sourceId: lent,
      kind: 'overdue',
      dueOn: plus(-2),
      loanDirection: 'out',
      subject: { type: 'thing', id: drill, name: 'Drill', path: ['Garage', 'Shelf'] },
      location: { id: ibrahim.locationId, name: 'Home', timezone: 'Africa/Cairo' },
      link: `/t/${drill}?tab=loans`,
      url: `${PUBLIC_URL}/t/${drill}?tab=loans`,
    });
    expect(item.key).toBe(`loan:${lent}:overdue:date:${plus(-2)}`);
    expect(JSON.stringify(item)).not.toMatch(/Murdock/);
    expect(await status(ibrahim.userId)).toEqual([
      { status: 'sent', error: null, sent_at: expect.any(Date) },
    ]);
  });

  it('a failed send fails the job, and the retry claims it again', async () => {
    await runScan(deps());
    const data = jobs[0]?.data;
    outcome = { status: 'failed', error: 'SMTP 421: try later' };
    await expect(runDelivery(deps(), data)).rejects.toThrow(/smtp_421_try_later/);
    expect(await status(ibrahim.userId)).toEqual([
      { status: 'failed', error: 'smtp_421_try_later', sent_at: null },
    ]);
    outcome = { status: 'sent' };
    expect(await runDelivery(deps(), data)).toBe('sent');
  });

  it('a push whose devices are all gone ends skipped; a closed occurrence is skipped, unsent', async () => {
    await runScan(deps());
    outcome = { status: 'skipped', error: 'push_gone' };
    expect(await runDelivery(deps(), jobs[0]?.data)).toBe('skipped');
    expect((await status(ibrahim.userId))[0]).toMatchObject({
      status: 'skipped',
      error: 'push_gone',
    });

    // A second loan, returned before its delivery ran.
    const saw = newId();
    await own(
      `INSERT INTO public.things (id, location_id, place_id, name) VALUES ($1, $2, $3, 'Saw')`,
      [saw, ibrahim.locationId, ibrahim.unplacedId],
    );
    const second = newId();
    await own(
      `INSERT INTO public.loans (id, location_id, thing_id, direction, person_id, started_at,
                                 due_on, created_by)
       VALUES ($1, $2, $3, 'out', $4, now() - interval '20 days', $5, $6)`,
      [second, ibrahim.locationId, saw, murdock, plus(-1), ibrahim.userId],
    );
    await runScan(deps());
    await own('UPDATE public.loans SET returned_at = now() WHERE id = $1', [second]);
    await runScan(deps());
    sent = [];
    outcome = { status: 'sent' };
    expect(await runDelivery(deps(), jobs[1]?.data)).toBe('skipped');
    expect(sent).toEqual([]);
  });

  it('a member who left before it went is skipped; data naming nothing real does nothing', async () => {
    await own(`DELETE FROM public.notification_preferences WHERE user_id = $1 AND kind = 'loan'`, [
      bruce,
    ]);
    await runScan(deps());
    const brucesJob = jobs.find((j) => (j.data as { userId: string }).userId === bruce);
    await own('DELETE FROM public.memberships WHERE user_id = $1', [bruce]);
    expect(await runDelivery(deps(), brucesJob?.data)).toBe('skipped');
    expect((await status(bruce))[0]).toMatchObject({ status: 'skipped', error: 'not_member' });
    expect(
      await runDelivery(deps(), { occurrenceId: newId(), userId: bruce, channelId: newId() }),
    ).toBe('nothing');
    expect(await runDelivery(deps(), { occurrenceId: 'not-a-uuid' })).toBe('nothing');
  });

  it("a channel test goes to the channel's own user", async () => {
    await runScan(deps());
    const [ch] = await own<{ id: string }>(
      `SELECT id FROM public.notification_channels WHERE user_id = $1 AND kind = 'email'`,
      [ibrahim.userId],
    );
    expect(await runDelivery(deps(), { kind: 'test', channelId: ch?.id })).toBe('sent');
    expect(sent.map((s) => [s.to.userId, s.message.mode])).toEqual([[ibrahim.userId, 'test']]);
  });
});

describe('reminder-digest (D29, D122)', () => {
  /** A document expiring soon: a `digest` delivery for Ibrahim. */
  async function expiring(title: string, days: number): Promise<string> {
    const id = newId();
    await own(
      `INSERT INTO public.expiring_documents (id, location_id, thing_id, kind, title, expires_on,
                                              created_by)
       VALUES ($1, $2, $3, 'other', $4, $5, $6)`,
      [id, ibrahim.locationId, drill, title, plus(days), ibrahim.userId],
    );
    return id;
  }

  /** The instant the clock in `zone` reads `wall` (Postgres's reading). */
  const at = async (wall: string, zone: string) =>
    (
      (await own<{ t: Date }>(`SELECT ($1::timestamp AT TIME ZONE $2) AS t`, [wall, zone]))[0] as {
        t: Date;
      }
    ).t;

  const digestsOf = () =>
    own<{ digest_on: string; sent: boolean }>(
      `SELECT digest_on::text, sent_at IS NOT NULL AS sent FROM public.notification_digests
        WHERE user_id = $1 ORDER BY digest_on`,
      [ibrahim.userId],
    );

  it("goes at the person's own 08:00, once, listing every waiting item", async () => {
    await own(`UPDATE public.user_profiles SET timezone = 'Europe/Berlin' WHERE user_id = $1`, [
      ibrahim.userId,
    ]);
    await own('DELETE FROM public.loans');
    await expiring('Gym contract', 10);
    await expiring('Building inspection', 20);
    await runScan(deps());
    expect(sent).toEqual([]);
    // Berlin's clock, whatever Cairo's says (D122).
    expect(
      (await runDigests(deps(), { now: await at('2026-10-05 07:59', 'Europe/Berlin') })).sent,
    ).toBe(0);
    const at8 = await at('2026-10-05 08:00', 'Europe/Berlin');
    expect(await runDigests(deps(), { now: at8 })).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(await runDigests(deps(), { now: at8 })).toEqual({ sent: 0, skipped: 0, failed: 0 });
    expect(sent).toHaveLength(1);
    const message = sent[0]?.message as Extract<ChannelMessage, { mode: 'digest' }>;
    expect(message.digestOn).toBe('2026-10-05');
    expect(message.items.map((i) => i.title)).toEqual(['Gym contract', 'Building inspection']);
    expect(message.items.every((i) => i.location.name === 'Home')).toBe(true);
    expect(await digestsOf()).toEqual([{ digest_on: '2026-10-05', sent: true }]);
    expect((await status(ibrahim.userId)).every((d) => d.status === 'sent')).toBe(true);
  });

  it('a failed digest is sent by a later pass, still once', async () => {
    await own('DELETE FROM public.loans');
    await expiring('Gym contract', 10);
    await runScan(deps());
    const nine = await at('2026-10-05 09:00', 'UTC');
    outcome = { status: 'failed', error: 'smtp_down' };
    expect(await runDigests(deps(), { now: nine })).toEqual({ sent: 0, skipped: 0, failed: 1 });
    expect(await digestsOf()).toEqual([]);
    outcome = { status: 'sent' };
    expect((await runDigests(deps(), { now: nine })).sent).toBe(1);
    expect(sent).toHaveLength(2);
  });

  describe("across Cairo's 2026 changes (V21)", () => {
    /** The instants Cairo's offset changes in 2026, found from the tz data by Postgres. */
    let changes: { at: Date; day: string }[];

    beforeEach(async () => {
      changes = await own<{ at: Date; day: string }>(
        `WITH h AS (
           SELECT t, (t AT TIME ZONE 'Africa/Cairo') - (t AT TIME ZONE 'UTC') AS off
             FROM generate_series('2026-01-01 00:00Z'::timestamptz, '2026-12-31 23:00Z', '1 hour') t),
         c AS (SELECT t, off, lag(off) OVER (ORDER BY t) AS prev FROM h)
         SELECT t AS at, (t AT TIME ZONE 'Africa/Cairo')::date::text AS day
           FROM c WHERE off <> prev ORDER BY t`,
      );
      await own(`UPDATE public.user_profiles SET timezone = 'Africa/Cairo' WHERE user_id = $1`, [
        ibrahim.userId,
      ]);
      await own('DELETE FROM public.loans');
    });

    it('finds the two transitions the spike recorded', () => {
      expect(changes.map((c) => c.at.toISOString())).toEqual([
        '2026-04-23T22:00:00.000Z',
        '2026-10-29T21:00:00.000Z',
      ]);
    });

    it("the location's day turns at its own midnight across the change", async () => {
      const spring = changes[0] as { at: Date };
      const [row] = await own<{ before: string; after: string }>(
        `SELECT (($1::timestamptz - interval '1 second') AT TIME ZONE 'Africa/Cairo')::date::text AS before,
                ($1::timestamptz AT TIME ZONE 'Africa/Cairo')::date::text AS after`,
        [spring.at],
      );
      expect(row).toEqual({ before: '2026-04-23', after: '2026-04-24' });
    });

    it('a digest at 08:00 goes at 08:00 local on both sides of each change', async () => {
      for (const c of changes) {
        for (const offset of [-1, 1]) {
          const d = new Date(`${c.day}T00:00:00Z`);
          d.setUTCDate(d.getUTCDate() + offset);
          const day = d.toISOString().slice(0, 10);
          await expiring(`Contract ${day}`, 3);
          await runScan(deps());
          const eight = await at(`${day} 08:00`, 'Africa/Cairo');
          const before = new Date(eight.getTime() - 60_000);
          expect((await runDigests(deps(), { now: before })).sent, `${day} 07:59`).toBe(0);
          expect((await runDigests(deps(), { now: eight })).sent, `${day} 08:00`).toBe(1);
          expect(lastDigestOn()).toBe(day);
        }
      }
    });

    it('a digest time inside the spring gap goes at the first minute after it, once', async () => {
      await own(`UPDATE public.user_profiles SET digest_time = '00:30' WHERE user_id = $1`, [
        ibrahim.userId,
      ]);
      const spring = changes[0] as { at: Date; day: string };
      // The evening before (23:59:59 EET): that day's digest.
      await expiring('Lease', 3);
      await runScan(deps());
      expect((await runDigests(deps(), { now: new Date(spring.at.getTime() - 1000) })).sent).toBe(
        1,
      );
      // 00:30 on the 24th never happens: the day starts at 01:00 EEST, and its digest goes then.
      await expiring('Insurance', 4);
      await runScan(deps());
      expect((await runDigests(deps(), { now: spring.at })).sent).toBe(1);
      expect(lastDigestOn()).toBe(spring.day);
      // Once.
      expect(
        (await runDigests(deps(), { now: new Date(spring.at.getTime() + 3_600_000) })).sent,
      ).toBe(0);
      expect(await digestsOf()).toEqual([
        { digest_on: '2026-04-23', sent: true },
        { digest_on: spring.day, sent: true },
      ]);
    });

    it('a digest time inside the autumn overlap goes once', async () => {
      await own(`UPDATE public.user_profiles SET digest_time = '23:30' WHERE user_id = $1`, [
        ibrahim.userId,
      ]);
      await expiring('Lease', 3);
      await runScan(deps());
      const autumn = changes[1] as { at: Date; day: string };
      // 23:30 EEST (20:30Z), then 23:30 EET (21:30Z) an hour later: one digest.
      const first = new Date(autumn.at.getTime() - 30 * 60_000);
      const second = new Date(autumn.at.getTime() + 30 * 60_000);
      expect((await runDigests(deps(), { now: new Date(first.getTime() - 60_000) })).sent).toBe(0);
      expect((await runDigests(deps(), { now: first })).sent).toBe(1);
      expect((await runDigests(deps(), { now: second })).sent).toBe(0);
      expect(await digestsOf()).toEqual([{ digest_on: '2026-10-29', sent: true }]);
    });
  });
});
