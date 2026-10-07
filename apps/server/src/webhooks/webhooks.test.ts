import { randomBytes } from 'node:crypto';
import type { WebhookPayload } from '@kept/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import { type Receiver, startReceiver } from '../../test/receiver.js';
import {
  createLocation,
  createThing,
  type Loc,
  ok,
  own,
  place,
  setDisplayName,
} from '../../test/things.js';
import type { Keyring, MasterKey } from '../crypto/envelope.js';
import { fixedSecretKeys } from '../crypto/keyring.js';
import { PrivateAddressError } from '../net/ssrf.js';
import { verifyWebhook } from '../notify/webhook.js';
import { runScan } from '../reminders/scan.js';
import { runWebhookDelivery } from './deliver.js';
import {
  auditEventIdOf,
  eventIdOf,
  type FanoutSend,
  occurrenceIdOf,
  reminderEventIdOf,
  runWebhookFanout,
  setWebhookFanout,
} from './fanout.js';
import { checkWebhookUrl } from './service.js';

// Location webhooks through the front door (step-6 plan T15; §2.6; D63, D110, D180): the secret
// shown once and never stored in the clear or audited, owners and admins only, URLs checked for
// private addresses when saved, and the whole path from a thing's move to a signed, value-free
// POST: audited() → `webhook-fanout` → a delivery row → `webhook-deliver`. Every request goes
// to a local receiver on 127.0.0.1; nothing leaves the machine.

let db: TestDb;
let t: TestApp;
let receiver: Receiver;
const master: MasterKey = { key: randomBytes(32), keyVersion: 1 };
const keyring = new Map([[1, master.key]]) as Keyring;
const deliverDeps = () => ({ pools: db.pools, keyring: () => keyring });

let ibrahim: Person; // owns Home
let bruce: Person; // admin of Home
let talia: Person; // viewer of Home
let alfred: Person; // a stranger to Home
let home: Loc;

/** The fan-out jobs audited() sent, recorded instead of queued. */
const fanouts: string[] = [];
const recordFanout: FanoutSend = async (_client, _name, data) => {
  fanouts.push(data.auditEventId);
};

type Row = {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  disabledReason: string | null;
  failingSince: string | null;
  createdBy: { id: string; displayName: string };
  rowVersion: number;
};

const hooks = (as: Person, locationId = home.id) =>
  call(t, `/api/v1/locations/${locationId}/webhooks`, { as });

async function addHook(
  as: Person,
  events: string[] = ['thing.moved'],
): Promise<{ webhook: Row; secret: string }> {
  const res = await call(t, `/api/v1/locations/${home.id}/webhooks`, {
    as,
    body: { url: `${receiver.url}/kept`, events },
  });
  return ok(res, 201) as unknown as { webhook: Row; secret: string };
}

const webhookAudit = (entityId: string) =>
  own<{ action: string; diff: Record<string, unknown>; undoable_until: Date | null }>(
    db,
    `SELECT action, diff, undoable_until FROM public.audit_events
      WHERE entity_type = 'webhook' AND entity_id = $1 ORDER BY at, id`,
    [entityId],
  );

const deliveriesOf = (webhookId: string) =>
  own<{ id: string; status: string; attempts: number; event: string; event_id: string }>(
    db,
    `SELECT id, status, attempts, event, event_id FROM public.webhook_deliveries
      WHERE webhook_id = $1 ORDER BY id`,
    [webhookId],
  );

beforeAll(async () => {
  db = await testDb();
  receiver = await startReceiver({ tls: false });
  t = await peopleApp(db, { secretKeys: fixedSecretKeys({ current: master, keyring }) });
});

afterAll(async () => {
  setWebhookFanout(null);
  await t.app.close();
  await receiver.close();
});

beforeEach(async () => {
  await db.reset();
  fanouts.length = 0;
  receiver.received.length = 0;
  receiver.reply(200);
  // The receiver is on 127.0.0.1: the instance allows private addresses, as a LAN self-host would.
  await own(
    db,
    `INSERT INTO public.instance_settings (key, value) VALUES ('ssrf_allow_private', 'true')
     ON CONFLICT (key) DO UPDATE SET value = 'true'`,
  );
  ibrahim = await person(t, db, 'ibrahim');
  bruce = await person(t, db, 'bruce');
  talia = await person(t, db, 'talia');
  alfred = await person(t, db, 'alfred');
  await setDisplayName(db, bruce, 'Bruce');
  home = await createLocation(t, db, ibrahim, 'essentials', 'Home');
  await join(db, home.id, bruce.userId, 'admin');
  await join(db, home.id, talia.userId, 'viewer');
});

afterEach(() => {
  setWebhookFanout(null);
});

describe('managing webhooks (webhooks.manage)', () => {
  // catalogue: POST /api/v1/locations/:id/webhooks
  it('adds a hook for an admin and shows its secret once; the audit holds no secret', async () => {
    const { webhook, secret } = await addHook(bruce, ['thing.moved', 'thing.created']);
    expect(secret).toMatch(/^whsec_/);
    expect(webhook).toMatchObject({
      url: `${receiver.url}/kept`,
      events: ['thing.created', 'thing.moved'],
      active: true,
      createdBy: { id: bruce.userId, displayName: 'Bruce' },
      rowVersion: 1,
    });
    const listed = ok(await hooks(ibrahim)) as unknown as { items: Row[] };
    expect(listed.items.map((w) => w.id)).toEqual([webhook.id]);
    expect(JSON.stringify(listed)).not.toContain(secret);
    const [event] = await webhookAudit(webhook.id);
    expect(event?.action).toBe('webhook.create');
    expect(JSON.stringify(event?.diff)).not.toMatch(/whsec_/);
    expect(event?.diff).not.toHaveProperty('secret');
    // Security review T25 (M2): the URL is often the receiver's credential, and the activity feed
    // shows Home's events to every member, a viewer included: the log says only "changed".
    expect(event?.diff.url).toEqual({ changed: true, class: 'secret' });
    const feed = await call(t, `/api/v1/activity?locationId=${home.id}&entityType=webhook`, {
      as: talia,
    });
    expect(feed.statusCode).toBe(200);
    expect(feed.body).not.toContain(receiver.url);
    // Stored sealed: the plaintext is nowhere in the row.
    const [stored] = await own<{ c: unknown }>(
      db,
      'SELECT secret_ciphertext AS c FROM public.webhooks WHERE id = $1',
      [webhook.id],
    );
    expect(JSON.stringify(stored?.c)).not.toContain(secret);
  });

  it('is 403 for a viewer and 404 for a stranger; a hook is invisible to both', async () => {
    expect((await hooks(talia)).statusCode).toBe(403);
    expect((await hooks(alfred)).statusCode).toBe(404);
    const viewerAdd = await call(t, `/api/v1/locations/${home.id}/webhooks`, {
      as: talia,
      body: { url: 'https://hooks.example.org/kept', events: ['thing.moved'] },
    });
    expect(viewerAdd.statusCode).toBe(403);
    const { webhook } = await addHook(bruce);
    expect(
      (await call(t, `/api/v1/webhooks/${webhook.id}/deliveries`, { as: talia })).statusCode,
    ).toBe(404);
    expect(
      (await call(t, `/api/v1/webhooks/${webhook.id}/deliveries`, { as: alfred })).statusCode,
    ).toBe(404);
  });

  it('refuses a private address unless the instance allows them', async () => {
    await own(
      db,
      `UPDATE public.instance_settings SET value = 'false' WHERE key = 'ssrf_allow_private'`,
    );
    const res = await call(t, `/api/v1/locations/${home.id}/webhooks`, {
      as: bruce,
      body: { url: 'http://10.0.0.5/hook', events: ['thing.moved'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'private_address' });
    // A name that resolves to one is refused the same way (DNS stubbed).
    const resolve = (
      _h: string,
      cb: (e: Error | null, a: { address: string; family: number }[]) => void,
    ) => cb(null, [{ address: '10.0.0.5', family: 4 }]);
    await expect(
      checkWebhookUrl('https://hooks.example.org/x', false, resolve),
    ).rejects.toBeInstanceOf(PrivateAddressError);
    await expect(checkWebhookUrl('https://hooks.example.org/x', true, resolve)).resolves.toBe(
      'https://hooks.example.org/x',
    );
    await expect(checkWebhookUrl('ftp://hooks.example.org/x', true)).rejects.toMatchObject({
      status: 400,
    });
  });

  // catalogue: PATCH /api/v1/webhooks/:id
  it('changes a hook with If-Match, and turns it off as the admin', async () => {
    const { webhook } = await addHook(bruce);
    const stale = await call(t, `/api/v1/webhooks/${webhook.id}`, {
      method: 'PATCH',
      as: bruce,
      body: { events: ['thing.trashed'] },
      headers: { 'if-match': '7' },
    });
    expect(stale.statusCode).toBe(412);
    const res = await call(t, `/api/v1/webhooks/${webhook.id}`, {
      method: 'PATCH',
      as: ibrahim,
      body: { events: ['thing.trashed'], active: false },
      headers: { 'if-match': String(webhook.rowVersion) },
    });
    expect(ok(res)).toMatchObject({
      events: ['thing.trashed'],
      active: false,
      disabledReason: 'admin',
    });
    const events = await webhookAudit(webhook.id);
    expect(events.at(-1)?.action).toBe('webhook.update');
    expect(events.at(-1)?.diff).toMatchObject({ active: { before: true, after: false } });
  });

  // catalogue: POST /api/v1/webhooks/:id/rotate-secret
  it('rotates the secret: shown once, audited as changed without either value', async () => {
    const { webhook, secret } = await addHook(bruce);
    const res = ok(
      await call(t, `/api/v1/webhooks/${webhook.id}/rotate-secret`, { as: bruce, body: {} }),
    ) as unknown as { secret: string };
    expect(res.secret).toMatch(/^whsec_/);
    expect(res.secret).not.toBe(secret);
    const events = await webhookAudit(webhook.id);
    expect(events.at(-1)?.action).toBe('webhook.rotate_secret');
    expect(events.at(-1)?.diff).toEqual({ secret: { changed: true, class: 'secret' } });
    expect(events.at(-1)?.undoable_until).toBeNull();
  });

  // catalogue: DELETE /api/v1/webhooks/:id
  it('removes a hook, audited', async () => {
    const { webhook } = await addHook(bruce);
    const res = await call(t, `/api/v1/webhooks/${webhook.id}`, { method: 'DELETE', as: ibrahim });
    expect(res.statusCode).toBe(204);
    expect((ok(await hooks(bruce)) as unknown as { items: Row[] }).items).toEqual([]);
    expect((await webhookAudit(webhook.id)).at(-1)?.action).toBe('webhook.delete');
  });

  it('sends a signed ping on test, and lists it in the deliveries', async () => {
    const { webhook, secret } = await addHook(bruce);
    receiver.reply(204);
    const res = ok(await call(t, `/api/v1/webhooks/${webhook.id}/test`, { as: bruce, body: {} }));
    expect(res).toEqual({ httpStatus: 204 });
    const [got] = receiver.received;
    const raw = got?.body.toString() ?? '';
    expect(verifyWebhook(secret, String(got?.headers['kept-signature']), raw)).toBe(true);
    const body = JSON.parse(raw) as WebhookPayload;
    expect(body).toMatchObject({ event: 'ping', entity: { type: 'webhook', id: webhook.id } });
    const page = ok(await call(t, `/api/v1/webhooks/${webhook.id}/deliveries`, { as: bruce }));
    expect(page).toMatchObject({
      items: [{ event: 'ping', status: 'delivered', attempts: 1, httpStatus: 204 }],
      next_cursor: null,
    });
    // A ping that fails is a failed delivery, and the hook isn't marked failing for it.
    receiver.reply(500);
    expect(
      ok(await call(t, `/api/v1/webhooks/${webhook.id}/test`, { as: bruce, body: {} })),
    ).toEqual({
      httpStatus: 500,
    });
    const listed = ok(await hooks(bruce)) as unknown as { items: Row[] };
    expect(listed.items[0]?.failingSince).toBeNull();
  });
});

describe('events, from a write to a signed POST (Q18, D110)', () => {
  it('a move sends one delivery: ids and changed field names, no name, place or value', async () => {
    setWebhookFanout(recordFanout);
    const { secret } = await addHook(bruce, ['thing.moved']);
    const shelf = await place(db, home, 'Office shelf');
    const cable = await createThing(t, bruce, home, { name: 'HDMI cable', notes: 'the long one' });
    // The create is no event this hook takes: nothing was sent for it.
    expect(fanouts).toEqual([]);
    ok(
      await call(t, '/api/v1/things/move', {
        as: bruce,
        body: { thingIds: [cable.id], to: { placeId: shelf } },
      }),
    );
    expect(fanouts).toHaveLength(1);

    const sent: string[] = [];
    const deliveries = await runWebhookFanout(
      {
        pools: db.pools,
        send: async (_c, _n, data) => void sent.push((data as { deliveryId: string }).deliveryId),
      },
      { auditEventId: fanouts[0] },
    );
    expect(deliveries).toHaveLength(1);
    expect(sent).toEqual(deliveries);
    // A retried fan-out adds nothing.
    expect(await runWebhookFanout({ pools: db.pools }, { auditEventId: fanouts[0] })).toEqual([]);

    expect(await runWebhookDelivery(deliverDeps(), { deliveryId: deliveries[0] })).toEqual({
      outcome: 'delivered',
      httpStatus: 200,
    });
    const [got] = receiver.received;
    const raw = got?.body.toString() ?? '';
    expect(verifyWebhook(secret, String(got?.headers['kept-signature']), raw)).toBe(true);
    const body = JSON.parse(raw) as WebhookPayload;
    expect(body).toMatchObject({
      id: eventIdOf(fanouts[0] as string),
      event: 'thing.moved',
      location_id: home.id,
      entity: { type: 'thing', id: cable.id },
      actor: { type: 'user', id: bruce.userId },
    });
    expect(body.changed_fields).toContain('place_id');
    expect(raw).not.toMatch(/HDMI|long one|Office shelf/);
    expect(raw).not.toContain(shelf);
    expect(auditEventIdOf(body.id)).toBe(fanouts[0]);
    // Delivered once: running the job again sends nothing.
    expect((await runWebhookDelivery(deliverDeps(), { deliveryId: deliveries[0] })).outcome).toBe(
      'nothing',
    );
    expect(receiver.received).toHaveLength(1);
  });

  it('a location with no hook listening fans out nothing', async () => {
    setWebhookFanout(recordFanout);
    const shelf = await place(db, home, 'Shelf');
    const cable = await createThing(t, bruce, home, { name: 'Cable' });
    ok(
      await call(t, '/api/v1/things/move', {
        as: bruce,
        body: { thingIds: [cable.id], to: { placeId: shelf } },
      }),
    );
    expect(fanouts).toEqual([]);
  });

  it('retries a 500 with backoff, then gives up and marks the hook failing', async () => {
    setWebhookFanout(recordFanout);
    const { webhook } = await addHook(bruce, ['thing.created']);
    await createThing(t, bruce, home, { name: 'Drill' });
    const [deliveryId] = await runWebhookFanout({ pools: db.pools }, { auditEventId: fanouts[0] });
    receiver.reply(500);
    for (let retryCount = 0; retryCount < 9; retryCount++) {
      await expect(
        runWebhookDelivery(deliverDeps(), { deliveryId }, { id: 'j', retryCount, retryLimit: 9 }),
      ).rejects.toThrow(/http_500/);
    }
    let [d] = await deliveriesOf(webhook.id);
    expect(d).toMatchObject({ status: 'failed', attempts: 9 });
    const mailed: unknown[] = [];
    const alerts = { pools: db.pools, mailer: { send: async (m: unknown) => void mailed.push(m) } };
    expect(
      await runWebhookDelivery(
        { ...deliverDeps(), alerts },
        { deliveryId },
        { id: 'j', retryCount: 9, retryLimit: 9 },
      ),
    ).toEqual({ outcome: 'gave_up', httpStatus: 500 });
    // The instance admins hear of it once, by an alert naming the hook and when, nothing else.
    const alertOf = () =>
      own<{ kind: string; payload: Record<string, unknown>; resolved_at: Date | null }>(
        db,
        'SELECT kind, payload, resolved_at FROM public.admin_alerts WHERE dedupe_key = $1',
        [`webhook_failing:${webhook.id}`],
      );
    expect(await alertOf()).toEqual([
      {
        kind: 'webhook_failing',
        payload: { webhookId: webhook.id, locationId: home.id, since: expect.any(String) },
        resolved_at: null,
      },
    ]);
    [d] = await deliveriesOf(webhook.id);
    expect(d).toMatchObject({ status: 'gave_up', attempts: 10 });
    const listed = ok(await hooks(bruce)) as unknown as {
      items: (Row & { lastDelivery: unknown })[];
    };
    expect(listed.items[0]?.failingSince).not.toBeNull();
    expect(listed.items[0]?.lastDelivery).toMatchObject({ status: 'gave_up', httpStatus: 500 });

    // Its next delivery succeeds: the mark and the alert go.
    await createThing(t, bruce, home, { name: 'Saw' });
    const [next] = await runWebhookFanout({ pools: db.pools }, { auditEventId: fanouts[1] });
    receiver.reply(200);
    expect(
      await runWebhookDelivery({ ...deliverDeps(), alerts }, { deliveryId: next }, undefined),
    ).toMatchObject({ outcome: 'delivered' });
    expect((await alertOf())[0]?.resolved_at).not.toBeNull();
  });

  it("D180: a hook whose creator's membership has expired sends nothing, before the expiry job runs", async () => {
    setWebhookFanout(recordFanout);
    await addHook(bruce, ['thing.created']);
    await own(
      db,
      `UPDATE public.memberships SET expires_at = now() - interval '1 minute'
        WHERE location_id = $1 AND user_id = $2`,
      [home.id, bruce.userId],
    );
    await createThing(t, ibrahim, home, { name: 'Ladder' });
    expect(fanouts).toHaveLength(1);
    expect(await runWebhookFanout({ pools: db.pools }, { auditEventId: fanouts[0] })).toEqual([]);
  });

  it('D180: a hook stops when its creator stops administering the location', async () => {
    setWebhookFanout(recordFanout);
    const { webhook } = await addHook(bruce, ['thing.created']);
    await createThing(t, ibrahim, home, { name: 'Ladder' });
    const [deliveryId] = await runWebhookFanout({ pools: db.pools }, { auditEventId: fanouts[0] });
    await own(
      db,
      `UPDATE public.memberships SET role = 'member' WHERE location_id = $1 AND user_id = $2`,
      [home.id, bruce.userId],
    );
    const listed = ok(await hooks(ibrahim)) as unknown as { items: Row[] };
    expect(listed.items[0]).toMatchObject({ active: false, disabledReason: 'creator_lost_role' });
    // Its pending delivery is never sent, and new writes fan out nothing.
    expect((await runWebhookDelivery(deliverDeps(), { deliveryId })).outcome).toBe('nothing');
    expect(receiver.received).toEqual([]);
    expect((await deliveriesOf(webhook.id))[0]?.status).toBe('gave_up');
    fanouts.length = 0;
    await createThing(t, ibrahim, home, { name: 'Saw' });
    expect(fanouts).toEqual([]);
    // Security review T25 (M3): another admin can't switch it back on for the departed creator.
    const reopen = await call(t, `/api/v1/webhooks/${webhook.id}`, {
      method: 'PATCH',
      as: ibrahim,
      body: { active: true },
      headers: { 'if-match': String((listed.items[0] as Row).rowVersion) },
    });
    expect(reopen.statusCode).toBe(400);
    const still = ok(await hooks(ibrahim)) as unknown as { items: Row[] };
    expect(still.items[0]).toMatchObject({ active: false, disabledReason: 'creator_lost_role' });
  });
});

describe('reminder.due, from the reminder scan (§2.6, D172)', () => {
  // A thing's expiry reminds when Schedules is on (D141); Home was made with the essentials.
  beforeEach(async () => {
    await own(
      db,
      `INSERT INTO public.location_modules (location_id, module, enabled) VALUES ($1, 'schedules', true)
       ON CONFLICT (location_id, module) DO UPDATE SET enabled = true`,
      [home.id],
    );
  });

  it('a new occurrence sends one signed, value-free delivery to a hook taking it; a rescan sends nothing', async () => {
    const { webhook, secret } = await addHook(bruce, ['reminder.due']);
    const { webhook: moves } = await addHook(bruce, ['thing.moved']);
    const extinguisher = await createThing(t, bruce, home, {
      name: 'Fire extinguisher',
      notes: 'under the sink',
    });
    await own(
      db,
      `UPDATE public.things t SET expires_on = (now() AT TIME ZONE l.timezone)::date + 10
         FROM public.locations l WHERE t.id = $1 AND l.id = t.location_id`,
      [extinguisher.id],
    );
    const jobs: { name: string; data: { occurrenceId?: string } }[] = [];
    const scanDeps = {
      pools: db.pools,
      channels: null,
      send: async (_c: unknown, name: string, data: object) =>
        void jobs.push({ name, data: data as { occurrenceId?: string } }),
    };
    expect((await runScan(scanDeps)).occurrences).toBe(1);
    const [occurrence] = await own<{ id: string }>(
      db,
      'SELECT id FROM public.reminder_occurrences WHERE thing_id = $1',
      [extinguisher.id],
    );
    expect(jobs).toEqual([{ name: 'webhook-fanout', data: { occurrenceId: occurrence?.id } }]);

    const deliveries = await runWebhookFanout({ pools: db.pools }, jobs[0]?.data);
    expect(deliveries).toHaveLength(1);
    // Only the hook taking reminder.due; a retried fan-out adds nothing.
    expect(await deliveriesOf(moves.id)).toEqual([]);
    expect(await runWebhookFanout({ pools: db.pools }, jobs[0]?.data)).toEqual([]);
    expect(await deliveriesOf(webhook.id)).toEqual([
      expect.objectContaining({ event: 'reminder.due', status: 'pending' }),
    ]);

    expect(await runWebhookDelivery(deliverDeps(), { deliveryId: deliveries[0] })).toEqual({
      outcome: 'delivered',
      httpStatus: 200,
    });
    const [got] = receiver.received;
    const raw = got?.body.toString() ?? '';
    expect(verifyWebhook(secret, String(got?.headers['kept-signature']), raw)).toBe(true);
    const body = JSON.parse(raw) as WebhookPayload;
    expect(body).toEqual({
      id: reminderEventIdOf(occurrence?.id as string),
      event: 'reminder.due',
      occurred_at: expect.any(String),
      location_id: home.id,
      entity: { type: 'reminder', id: occurrence?.id },
      changed_fields: [],
      actor: { type: 'system', id: null },
    });
    expect(occurrenceIdOf(body.id)).toBe(occurrence?.id);
    // Never an audit event's id, and nothing of the thing in it.
    expect(auditEventIdOf(body.id)).toBeNull();
    expect(raw).not.toMatch(/extinguisher|sink|expir/i);
    expect(raw).not.toContain(extinguisher.id as string);

    // The next pass writes nothing new, so it fans out nothing.
    jobs.length = 0;
    expect((await runScan(scanDeps)).occurrences).toBe(0);
    expect(jobs).toEqual([]);
  });

  it('a location with no hook taking reminder.due fans out nothing from the scan', async () => {
    await addHook(bruce, ['thing.created']);
    const milk = await createThing(t, bruce, home, { name: 'Milk' });
    await own(
      db,
      `UPDATE public.things t SET expires_on = (now() AT TIME ZONE l.timezone)::date + 3
         FROM public.locations l WHERE t.id = $1 AND l.id = t.location_id`,
      [milk.id],
    );
    const jobs: string[] = [];
    const done = await runScan({
      pools: db.pools,
      channels: null,
      send: async (_c, name) => void jobs.push(name),
    });
    expect(done.occurrences).toBe(1);
    expect(jobs).not.toContain('webhook-fanout');
  });
});
