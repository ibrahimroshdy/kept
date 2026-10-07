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
  ReminderRecipient,
  SendOutcome,
} from './channel.js';
import { runScan, type ScanDeps } from './scan.js';

// Plan T14: the scan writes each occurrence exactly once (D111, §7.13), fans it out to the
// centre and the channels by recipients.ts (D29, D57; Q8, Q10, Q13, Q16), closes what the agenda
// dropped (done, superseded, cancelled; D162, §7.6) and never floods on resuming. Rows are
// seeded as kept_owner; the scan runs as kept_system (and the auth pool for addresses), as the
// worker does.

const db = await testDb();
vi.setConfig({ testTimeout: 60_000 });

const own = <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(sql, values)).rows);

type Sent = { target: ChannelTarget; to: ReminderRecipient; message: ChannelMessage };
let sent: Sent[];
let jobs: { name: string; data: object; startAfter: Date | null }[];

function recorder(outcome: SendOutcome = { status: 'sent' }): ChannelSender {
  return {
    send: async (target, to, message) => {
      sent.push({ target, to, message });
      return outcome;
    },
  };
}

const deps = (): ScanDeps => ({
  pools: db.pools,
  channels: { email: recorder(), webpush: recorder(), webhook: recorder() },
  send: async (_client, name, data, options) => {
    jobs.push({ name, data, startAfter: options?.startAfter ?? null });
  },
});

let ibrahim: Tenant; // owns Home
let bruce: string; // admin
let louis: string; // member
let talia: string; // viewer
let peter: string; // managed member
let today: string; // Home's date (Africa/Cairo)
let kitchen: string;
let drill: string;
let murdock: string; // a contact, no Kept account

const plus = (days: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

async function thing(name: string, extra: { expiresOn?: string } = {}): Promise<string> {
  const id = newId();
  await own(
    `INSERT INTO public.things (id, location_id, place_id, name, expires_on)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, ibrahim.locationId, kitchen, name, extra.expiresOn ?? null],
  );
  return id;
}

async function person(name: string, memberUserId: string | null = null): Promise<string> {
  const id = newId();
  await own(
    `INSERT INTO public.people (id, owner_account_id, display_name, member_user_id)
     VALUES ($1, $2, $3, $4)`,
    [id, ibrahim.accountId, name, memberUserId],
  );
  return id;
}

async function loan(thingId: string, by: string, personId: string, dueOn: string): Promise<string> {
  const id = newId();
  await own(
    `INSERT INTO public.loans (id, location_id, thing_id, direction, person_id, started_at, due_on,
                               created_by)
     VALUES ($1, $2, $3, 'out', $4, now() - interval '20 days', $5, $6)`,
    [id, ibrahim.locationId, thingId, personId, dueOn, by],
  );
  return id;
}

async function schedule(thingId: string, name: string, dueOn: string): Promise<string> {
  const id = newId();
  await own(
    `INSERT INTO public.schedules (id, location_id, thing_id, name, due_on, anchor_on, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, ibrahim.locationId, thingId, name, dueOn, today, ibrahim.userId],
  );
  return id;
}

async function warranty(thingId: string, endsOn: string, provider: string): Promise<string> {
  const id = newId();
  await own(
    `INSERT INTO public.warranties (id, location_id, thing_id, kind, provider, starts_on, ends_on,
                                    created_by)
     VALUES ($1, $2, $3, 'manufacturer', $4, $5, $6, $7)`,
    [id, ibrahim.locationId, thingId, provider, plus(-300), endsOn, ibrahim.userId],
  );
  return id;
}

const occurrences = (sourceId: string) =>
  own<{ id: string; kind: string; state: string; due_period: string }>(
    `SELECT id, kind, state, due_period FROM public.reminder_occurrences
      WHERE source_id = $1 ORDER BY created_at, id`,
    [sourceId],
  );

const notifiedUsers = async (sourceId: string) =>
  (
    await own<{ user_id: string }>(
      `SELECT n.user_id FROM public.notifications n
         JOIN public.reminder_occurrences o ON o.id = n.occurrence_id
        WHERE o.source_id = $1 ORDER BY n.user_id`,
      [sourceId],
    )
  ).map((r) => r.user_id);

const deliveries = (sourceId: string) =>
  own<{ user_id: string; kind: string; status: string; not_before: Date | null }>(
    `SELECT d.user_id, c.kind, d.status, d.not_before FROM public.reminder_deliveries d
       JOIN public.reminder_occurrences o ON o.id = d.occurrence_id
       JOIN public.notification_channels c ON c.id = d.channel_id
      WHERE o.source_id = $1 ORDER BY d.user_id, c.kind`,
    [sourceId],
  );

beforeEach(async () => {
  await db.reset();
  sent = [];
  jobs = [];
  ibrahim = await seedTenant(db, 'scan-ibrahim');
  bruce = await seedUser(db, 'scan-bruce');
  louis = await seedUser(db, 'scan-louis');
  talia = await seedUser(db, 'scan-talia');
  peter = await seedUser(db, 'scan-peter');
  await addMember(db, ibrahim.locationId, bruce, 'admin');
  await addMember(db, ibrahim.locationId, louis, 'member');
  await addMember(db, ibrahim.locationId, talia, 'viewer');
  await addMember(db, ibrahim.locationId, peter, 'member');
  for (const u of [ibrahim.userId, bruce, louis, talia]) await userEmail(db, u, true);
  await own(`UPDATE auth."user" SET email = $2, email_verified = true WHERE id = $1`, [
    peter,
    `peter-${newId()}@managed.invalid`,
  ]);
  await own(
    `UPDATE public.user_profiles SET managed = true, created_by_user_id = $2 WHERE user_id = $1`,
    [peter, ibrahim.userId],
  );
  const [{ d }] = (await own<{ d: string }>(
    `SELECT (now() AT TIME ZONE 'Africa/Cairo')::date::text AS d`,
  )) as [{ d: string }];
  today = d;
  kitchen = newId();
  await own('INSERT INTO public.places (id, location_id, name) VALUES ($1, $2, $3)', [
    kitchen,
    ibrahim.locationId,
    'Kitchen',
  ]);
  drill = await thing('Drill');
  murdock = await person('Murdock');
});

describe('exactly once (D111, §7.13)', () => {
  it('two scans in a row, and two at once, write one occurrence and one delivery per user and channel', async () => {
    const lent = await loan(drill, ibrahim.userId, murdock, plus(-2));
    await runScan(deps());
    await runScan(deps());
    await Promise.all([runScan(deps()), runScan(deps())]);
    const occ = await occurrences(lent);
    expect(occ).toEqual([
      expect.objectContaining({ kind: 'overdue', state: 'open', due_period: `date:${plus(-2)}` }),
    ]);
    // Owner and admin get every kind (Q8); both have a verified address, so one email each.
    expect(await notifiedUsers(lent)).toEqual([ibrahim.userId, bruce].sort());
    expect(await deliveries(lent)).toEqual(
      [ibrahim.userId, bruce]
        .sort()
        .map((u) => ({ user_id: u, kind: 'email', status: 'queued', not_before: null })),
    );
    expect(jobs.filter((j) => j.name === 'reminder-deliver')).toHaveLength(2);
  });

  it('two schedules on one thing both remind, and a second warranty on the same thing separately', async () => {
    const tv = await thing('TV');
    const filter = await schedule(tv, 'Clean the filter', plus(3));
    const panel = await schedule(tv, 'Check the panel', plus(5));
    const maker = await warranty(tv, plus(10), 'Samsung');
    const store = await warranty(tv, plus(20), 'Carrefour');
    const done = await runScan(deps());
    expect(done.occurrences).toBe(4);
    for (const id of [filter, panel, maker, store]) {
      expect(await occurrences(id)).toHaveLength(1);
    }
    // Due and expiring wait for the digest.
    expect((await deliveries(filter)).every((d) => d.status === 'digest')).toBe(true);
    expect(jobs).toEqual([]);
  });
});

describe('closing what the agenda dropped', () => {
  it('a snooze supersedes the old occurrence and the new period is open', async () => {
    const filter = await schedule(drill, 'Oil the chuck', plus(4));
    await runScan(deps());
    await own('UPDATE public.schedules SET snoozed_until = $2 WHERE id = $1', [filter, today]);
    const done = await runScan(deps());
    expect(done.closed.superseded).toBe(1);
    expect(await occurrences(filter)).toEqual([
      expect.objectContaining({ due_period: `date:${plus(4)}`, state: 'superseded' }),
      expect.objectContaining({ due_period: `date:${today}`, state: 'open' }),
    ]);
  });

  it('turning Warranties off cancels, and back on reopens the one period: no flood', async () => {
    const maker = await warranty(drill, plus(12), 'Bosch');
    await runScan(deps());
    await own(
      `INSERT INTO public.location_modules (location_id, module, enabled) VALUES ($1, 'warranties', false)`,
      [ibrahim.locationId],
    );
    const off = await runScan(deps());
    expect(off.closed.cancelled).toBe(1);
    expect(off.occurrences).toBe(0);
    expect(await occurrences(maker)).toEqual([expect.objectContaining({ state: 'cancelled' })]);
    await own(
      `UPDATE public.location_modules SET enabled = true WHERE location_id = $1 AND module = 'warranties'`,
      [ibrahim.locationId],
    );
    const on = await runScan(deps());
    expect(on).toMatchObject({ occurrences: 0, reopened: 1, notifications: 0, deliveries: 0 });
    expect(await occurrences(maker)).toEqual([expect.objectContaining({ state: 'open' })]);
  });

  it('trashing the thing cancels; restoring brings back the current period only (D162)', async () => {
    const milk = await thing('Fire extinguisher', { expiresOn: plus(10) });
    await runScan(deps());
    await own('UPDATE public.things SET deleted_at = now() WHERE id = $1', [milk]);
    expect((await runScan(deps())).closed.cancelled).toBe(1);
    await own('UPDATE public.things SET deleted_at = NULL WHERE id = $1', [milk]);
    await runScan(deps());
    expect(await occurrences(milk)).toEqual([
      expect.objectContaining({ kind: 'expiring', state: 'open' }),
    ]);
  });

  it('a returned loan is done, a renewed document done, a gone warranty cancelled', async () => {
    const lent = await loan(drill, ibrahim.userId, murdock, plus(-1));
    const lease = newId();
    await own(
      `INSERT INTO public.expiring_documents (id, location_id, kind, expires_on, created_by)
       VALUES ($1, $2, 'lease', $3, $4)`,
      [lease, ibrahim.locationId, plus(5), ibrahim.userId],
    );
    const maker = await warranty(drill, plus(8), 'Bosch');
    await runScan(deps());
    await own('UPDATE public.loans SET returned_at = now() WHERE id = $1', [lent]);
    const renewed = newId();
    await own(
      `INSERT INTO public.expiring_documents (id, location_id, kind, expires_on, created_by)
       VALUES ($1, $2, 'lease', $3, $4)`,
      [renewed, ibrahim.locationId, plus(370), ibrahim.userId],
    );
    await own('UPDATE public.expiring_documents SET superseded_by_id = $2 WHERE id = $1', [
      lease,
      renewed,
    ]);
    await own('DELETE FROM public.warranties WHERE id = $1', [maker]);
    const done = await runScan(deps());
    expect(done.closed).toEqual({ done: 2, superseded: 0, cancelled: 1 });
    expect((await occurrences(lent))[0]?.state).toBe('done');
    expect((await occurrences(lease))[0]?.state).toBe('done');
    expect((await occurrences(maker))[0]?.state).toBe('cancelled');
  });

  it('a completed schedule is done, and its next period waits until it is due', async () => {
    const filter = newId();
    await own(
      `INSERT INTO public.schedules (id, location_id, thing_id, name, every_months, anchor_on,
                                     created_by)
       VALUES ($1, $2, $3, 'Descale', 6, $4, $5)`,
      [filter, ibrahim.locationId, drill, plus(-190), ibrahim.userId],
    );
    await runScan(deps());
    expect((await occurrences(filter))[0]).toMatchObject({ kind: 'overdue', state: 'open' });
    const service = newId();
    await own(
      `INSERT INTO public.service_records (id, location_id, thing_id, serviced_on, logged_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [service, ibrahim.locationId, drill, today, ibrahim.userId],
    );
    await own(
      `INSERT INTO public.service_completions (location_id, service_record_id, schedule_id)
       VALUES ($1, $2, $3)`,
      [ibrahim.locationId, service, filter],
    );
    expect((await runScan(deps())).closed.done).toBe(1);
    expect(await occurrences(filter)).toEqual([expect.objectContaining({ state: 'done' })]);
  });

  it('a completion counts from when it was made, not when its record was logged or edited', async () => {
    const [early, late] = [newId(), newId()];
    for (const id of [early, late]) {
      await own(
        `INSERT INTO public.schedules (id, location_id, thing_id, name, every_months, anchor_on,
                                       created_by)
         VALUES ($1, $2, $3, 'Descale', 6, $4, $5)`,
        [id, ibrahim.locationId, drill, plus(-190), ibrahim.userId],
      );
    }
    // A service logged a week ago, before the reminders opened, and not touched since.
    const service = newId();
    await own(
      `INSERT INTO public.service_records (id, location_id, thing_id, serviced_on, logged_by,
                                           created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now() - interval '7 days', now() - interval '7 days')`,
      [service, ibrahim.locationId, drill, plus(-7), ibrahim.userId],
    );
    await runScan(deps());
    // It completes one schedule now, and was recorded as completing the other a week ago.
    await own(
      `INSERT INTO public.service_completions (location_id, service_record_id, schedule_id,
                                               created_at)
       VALUES ($1, $2, $3, now() - interval '7 days'), ($1, $2, $4, now())`,
      [ibrahim.locationId, service, early, late],
    );
    expect((await runScan(deps())).closed.done).toBe(1);
    expect((await occurrences(late))[0]?.state).toBe('done');
    expect((await occurrences(early))[0]?.state).not.toBe('done');
  });
});

describe('recipients (D29, D57; Q8, Q16)', () => {
  it('Bruce gets everything, Louis only his own loan, Talia nothing, Murdock never', async () => {
    const saw = await thing('Saw');
    const ladder = await thing('Ladder');
    const ibrahimsLoan = await loan(saw, ibrahim.userId, murdock, plus(-3));
    const louisLoan = await loan(ladder, louis, murdock, plus(-3));
    const lease = newId();
    await own(
      `INSERT INTO public.expiring_documents (id, location_id, kind, expires_on, created_by)
       VALUES ($1, $2, 'lease', $3, $4)`,
      [lease, ibrahim.locationId, plus(5), louis],
    );
    await runScan(deps());
    const sorted = (...ids: string[]) => ids.sort();
    expect(await notifiedUsers(ibrahimsLoan)).toEqual(sorted(ibrahim.userId, bruce));
    expect(await notifiedUsers(louisLoan)).toEqual(sorted(ibrahim.userId, bruce, louis));
    expect(await notifiedUsers(lease)).toEqual(sorted(ibrahim.userId, bruce));
    // Only Kept users are ever notified: every notification belongs to a member.
    const all = await own<{ user_id: string }>('SELECT DISTINCT user_id FROM public.notifications');
    expect(all.map((r) => r.user_id).sort()).toEqual(sorted(ibrahim.userId, bruce, louis));
  });

  it('a loan to a person linked to a member reaches that member too (their own household)', async () => {
    const louisAsPerson = await person('Louis', louis);
    const lent = await loan(drill, ibrahim.userId, louisAsPerson, plus(-2));
    await runScan(deps());
    expect(await notifiedUsers(lent)).toEqual([ibrahim.userId, bruce, louis].sort());
  });

  it('Peter, managed, is reminded in the app and never mailed: no email channel is made', async () => {
    const lent = await loan(drill, peter, murdock, plus(-2));
    await runScan(deps());
    expect(await notifiedUsers(lent)).toContain(peter);
    expect((await deliveries(lent)).map((d) => d.user_id)).not.toContain(peter);
    expect(
      await own('SELECT 1 FROM public.notification_channels WHERE user_id = $1', [peter]),
    ).toEqual([]);
  });

  it('a choice beats the default: Louis opting into leases, Bruce silencing loans in-app', async () => {
    await own(
      `INSERT INTO public.notification_preferences (user_id, location_id, kind, channel, enabled)
       VALUES ($1, $3, 'document', 'inapp', true), ($2, $3, 'loan', 'inapp', false)`,
      [louis, bruce, ibrahim.locationId],
    );
    const lent = await loan(drill, ibrahim.userId, murdock, plus(-2));
    const lease = newId();
    await own(
      `INSERT INTO public.expiring_documents (id, location_id, kind, expires_on, created_by)
       VALUES ($1, $2, 'lease', $3, $4)`,
      [lease, ibrahim.locationId, plus(5), ibrahim.userId],
    );
    await runScan(deps());
    expect(await notifiedUsers(lent)).toEqual([ibrahim.userId]);
    expect(await notifiedUsers(lease)).toEqual([ibrahim.userId, bruce, louis].sort());
    // Louis's email follows the kind's default (off for a member), unless he chose it too.
    expect((await deliveries(lease)).map((d) => d.user_id)).not.toContain(louis);
  });

  it('web push goes to a subscribed person; a webhook only when chosen; no sender, no delivery', async () => {
    await own(`INSERT INTO public.notification_channels (user_id, kind) VALUES ($1, 'webpush')`, [
      bruce,
    ]);
    await own(
      `INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth)
       VALUES ($1, 'https://push.example.test/bruce', 'k', 'a')`,
      [bruce],
    );
    for (const u of [ibrahim.userId, bruce]) {
      await own(
        `INSERT INTO public.notification_channels (user_id, kind, display_host, config_ciphertext,
                                                   key_version)
         VALUES ($1, 'webhook', 'hooks.example.test', '{"v": 1}', 1)`,
        [u],
      );
    }
    await own(
      `INSERT INTO public.notification_preferences (user_id, location_id, kind, channel, enabled)
       VALUES ($1, $2, 'loan', 'webhook', true)`,
      [ibrahim.userId, ibrahim.locationId],
    );
    const lent = await loan(drill, ibrahim.userId, murdock, plus(-2));
    await runScan({ ...deps(), channels: { webpush: recorder(), webhook: recorder() } });
    expect(await deliveries(lent)).toEqual([
      ...[
        { user_id: ibrahim.userId, kind: 'webhook' },
        { user_id: bruce, kind: 'webpush' },
      ]
        .sort((a, b) => a.user_id.localeCompare(b.user_id))
        .map((d) => ({ ...d, status: 'queued', not_before: null })),
    ]);
  });

  it('a user who hid Lending gets no loan reminder, and still gets the rest (§7.6; 0056)', async () => {
    await own(
      `INSERT INTO public.user_hidden_modules (user_id, location_id, module) VALUES ($1, $2, 'lending')`,
      [bruce, ibrahim.locationId],
    );
    const lent = await loan(drill, ibrahim.userId, murdock, plus(-2));
    const lease = newId();
    await own(
      `INSERT INTO public.expiring_documents (id, location_id, kind, expires_on, created_by)
       VALUES ($1, $2, 'lease', $3, $4)`,
      [lease, ibrahim.locationId, plus(5), ibrahim.userId],
    );
    await runScan(deps());
    expect(await notifiedUsers(lent)).toEqual([ibrahim.userId]);
    expect(await notifiedUsers(lease)).toEqual([ibrahim.userId, bruce].sort());
  });
});

describe('time (D122; V21)', () => {
  it('quiet hours 22:00–07:00 hold an overdue delivery until 07:00 on the person’s clock', async () => {
    await own(
      `UPDATE public.user_profiles SET timezone = 'Europe/Berlin', quiet_from = '22:00',
                                        quiet_to = '07:00' WHERE user_id = $1`,
      [bruce],
    );
    const lent = await loan(drill, ibrahim.userId, murdock, plus(-2));
    // 23:30 in Berlin in summer (CEST, UTC+2).
    await runScan({ ...deps() }, { now: new Date('2026-07-10T21:30:00Z') });
    const brucesDelivery = (await deliveries(lent)).find((d) => d.user_id === bruce);
    expect(brucesDelivery?.not_before?.toISOString()).toBe('2026-07-11T05:00:00.000Z');
    const job = jobs.find((j) => (j.data as { userId: string }).userId === bruce);
    expect(job?.startAfter?.toISOString()).toBe('2026-07-11T05:00:00.000Z');
    // Ibrahim has no quiet hours: his goes at once.
    expect((await deliveries(lent)).find((d) => d.user_id === ibrahim.userId)?.not_before).toBe(
      null,
    );
  });

  it("due and overdue are the location's date: the same loan reminds in Kiritimati and not in Pago Pago", async () => {
    const [{ kiri }] = (await own<{ kiri: string }>(
      `SELECT (now() AT TIME ZONE 'Pacific/Kiritimati')::date::text AS kiri`,
    )) as [{ kiri: string }];
    const due = new Date(`${kiri}T00:00:00Z`);
    due.setUTCDate(due.getUTCDate() - 1);
    const dueOn = due.toISOString().slice(0, 10);
    const east = await seedTenant(db, 'scan-kiritimati');
    const west = await seedTenant(db, 'scan-pagopago');
    await own(`UPDATE public.locations SET timezone = 'Pacific/Kiritimati' WHERE id = $1`, [
      east.locationId,
    ]);
    await own(`UPDATE public.locations SET timezone = 'Pacific/Pago_Pago' WHERE id = $1`, [
      west.locationId,
    ]);
    const lents: string[] = [];
    for (const t of [east, west]) {
      const item = newId();
      const who = newId();
      await own(
        `INSERT INTO public.things (id, location_id, place_id, name) VALUES ($1, $2, $3, 'Tent')`,
        [item, t.locationId, t.unplacedId],
      );
      await own(
        `INSERT INTO public.people (id, owner_account_id, display_name) VALUES ($1, $2, 'Murdock')`,
        [who, t.accountId],
      );
      const id = newId();
      await own(
        `INSERT INTO public.loans (id, location_id, thing_id, direction, person_id, started_at,
                                   due_on, created_by)
         VALUES ($1, $2, $3, 'out', $4, now() - interval '20 days', $5, $6)`,
        [id, t.locationId, item, who, dueOn, t.userId],
      );
      lents.push(id);
    }
    await runScan(deps());
    expect(await occurrences(lents[0] as string)).toHaveLength(1);
    expect(await occurrences(lents[1] as string)).toHaveLength(0);
  });
});

describe('the record and the admin alert (D166, §3.4)', () => {
  it('writes instance_settings.reminder_scan', async () => {
    await loan(drill, ibrahim.userId, murdock, plus(-2));
    await runScan(deps());
    const [row] = await own<{ value: Record<string, unknown> }>(
      `SELECT value FROM public.instance_settings WHERE key = 'reminder_scan'`,
    );
    expect(row?.value).toMatchObject({ occurrences: 1 });
    expect(typeof row?.value.lastOkAt).toBe('string');
    expect(typeof row?.value.durationMs).toBe('number');
  });
});
