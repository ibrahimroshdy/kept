import { newId } from '@kept/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../../test/db.js';
import {
  addMember,
  asOwner,
  pgError,
  seedTenant,
  seedUser,
  type Tenant,
} from '../../test/tenancy.js';
import type { auditEvents } from '../db/schema/index.js';
import { withScope } from '../db/scope.js';
import { type AuditEventInput, audited, auditedMany } from './audited.js';
import { classOf } from './classes.js';
import { renderAudit } from './render.js';

// Task 15: audited() and renderAudit() (engineering spec §7.5; D110).

const db = await testDb();

type EventRow = typeof auditEvents.$inferSelect;

let t: Tenant;

beforeEach(async () => {
  await db.reset();
  t = await seedTenant(db, 'audit-owner');
});

const asUser = <T>(userId: string, fn: Parameters<typeof withScope<T>>[2]) =>
  withScope(db.pools.app, { userId, mfa: true }, fn);

function locationUpdate(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    locationId: t.locationId,
    actor: { type: 'user', id: t.userId },
    action: 'location.update',
    entity: { type: 'location', id: t.locationId },
    before: { name: 'Home', timezone: 'Africa/Cairo', languages: ['en'] },
    after: { name: 'Flat', timezone: 'Africa/Cairo', languages: ['en'] },
    ...overrides,
  };
}

/** The stored event as kept_owner sees it, plus its row as JSON text. */
async function storedEvent(id: string): Promise<{ row: EventRow; text: string }> {
  return asOwner(db, async (c) => {
    const { rows } = await c.query(
      `SELECT id, at, location_id AS "locationId", owner_account_id AS "ownerAccountId",
              actor_type AS "actorType", actor_id AS "actorId", action,
              entity_type AS "entityType", entity_id AS "entityId", root_thing_id AS "rootThingId",
              diff, request_id AS "requestId", undo_of AS "undoOf",
              undoable_until AS "undoableUntil", to_jsonb(e)::text AS text
         FROM public.audit_events e WHERE id = $1`,
      [id],
    );
    expect(rows).toHaveLength(1);
    const { text, ...row } = rows[0];
    return { row: row as EventRow, text };
  });
}

describe('audited()', () => {
  it('writes one event whose diff holds only the changed fields, classed', async () => {
    const { id, diff } = await asUser(t.userId, (tx) =>
      audited(tx, locationUpdate({ requestId: 'req-1' })),
    );
    expect(diff).toEqual({ name: { before: 'Home', after: 'Flat', class: 'plain' } });

    const { row } = await storedEvent(id);
    expect(row).toMatchObject({
      locationId: t.locationId,
      // Filled from the location when the caller doesn't pass it (§7.13).
      ownerAccountId: t.accountId,
      actorType: 'user',
      actorId: t.userId,
      action: 'location.update',
      entityType: 'location',
      entityId: t.locationId,
      requestId: 'req-1',
      diff: { name: { before: 'Home', after: 'Flat', class: 'plain' } },
    });
    const count = await asOwner(db, (c) =>
      c.query('SELECT count(*)::int AS n FROM public.audit_events'),
    );
    expect(count.rows[0].n).toBe(1);
  });

  it('compares nested values deeply, per top-level field', async () => {
    const { diff } = await asUser(t.userId, (tx) =>
      audited(
        tx,
        locationUpdate({
          before: { address: { city: 'Cairo', lines: ['1'] }, languages: ['en', 'ar'] },
          after: { address: { city: 'Cairo', lines: ['1'] }, languages: ['ar', 'en'] },
        }),
      ),
    );
    expect(diff).toEqual({
      languages: { before: ['en', 'ar'], after: ['ar', 'en'], class: 'plain' },
    });
  });

  it('records a create as every field from null, and a delete as every field to null', async () => {
    const created = await asUser(t.userId, (tx) =>
      audited(
        tx,
        locationUpdate({ action: 'location.create', before: null, after: { name: 'A' } }),
      ),
    );
    expect(created.diff).toEqual({ name: { before: null, after: 'A', class: 'plain' } });
    const deleted = await asUser(t.userId, (tx) =>
      audited(
        tx,
        locationUpdate({ action: 'location.delete', before: { name: 'A' }, after: null }),
      ),
    );
    expect(deleted.diff).toEqual({ name: { before: 'A', after: null, class: 'plain' } });
  });

  it('leaves bookkeeping columns out of the diff, and stores dates as ISO strings', async () => {
    const at = new Date('2026-09-01T10:00:00.000Z');
    const { id, diff } = await asUser(t.userId, (tx) =>
      audited(
        tx,
        locationUpdate({
          before: {
            name: 'A',
            rowVersion: 1,
            updatedAt: new Date(0),
            changeSeq: 1n,
            purgeAfter: null,
          },
          after: { name: 'A', rowVersion: 2, updatedAt: at, changeSeq: 2n, purgeAfter: at },
        }),
      ),
    );
    // Keys are stored snake_case, the column and API name.
    expect(diff).toEqual({
      purge_after: { before: null, after: '2026-09-01T10:00:00.000Z', class: 'plain' },
    });
    expect((await storedEvent(id)).row.diff).toEqual(diff);
  });

  it('writes an event even when nothing changed (every write audits, D188)', async () => {
    const { id, diff } = await asUser(t.userId, (tx) =>
      audited(tx, locationUpdate({ before: { name: 'A' }, after: { name: 'A' } })),
    );
    expect(diff).toEqual({});
    expect((await storedEvent(id)).row.diff).toEqual({});
  });

  it('stores a secret change as {changed:true}, with neither value anywhere in the row', async () => {
    const oldHash = 'old-hash-6f1c2a9e';
    const newHash = 'new-hash-b73d08c4';
    const inviteId = newId();
    const { id, diff } = await asUser(t.userId, (tx) =>
      audited(tx, {
        locationId: t.locationId,
        actor: { type: 'user', id: t.userId },
        action: 'invite.update',
        entity: { type: 'invite', id: inviteId },
        before: { tokenHash: oldHash, role: 'member' },
        after: { tokenHash: newHash, role: 'viewer' },
      }),
    );
    expect(classOf('invite', 'token_hash')).toBe('secret');
    expect(diff).toEqual({
      token_hash: { changed: true, class: 'secret' },
      role: { before: 'member', after: 'viewer', class: 'plain' },
    });
    const { text } = await storedEvent(id);
    expect(text).not.toContain(oldHash);
    expect(text).not.toContain(newHash);
    expect(text).toContain('"changed": true');
  });

  it('never lets a per-call class lower a static one', async () => {
    const { diff } = await asUser(t.userId, (tx) =>
      audited(tx, {
        locationId: t.locationId,
        actor: { type: 'user', id: t.userId },
        action: 'invite.update',
        entity: { type: 'invite', id: newId() },
        before: { tokenHash: 'a' },
        after: { tokenHash: 'b' },
        fieldClasses: { token_hash: 'plain' },
      }),
    );
    expect(diff).toEqual({ token_hash: { changed: true, class: 'secret' } });
  });

  it('treats a field whose name says secret as secret, even when unmapped', async () => {
    const { diff } = await asUser(t.userId, (tx) =>
      audited(
        tx,
        locationUpdate({
          before: { smtpPassword: 'p1', apiToken: 't1', webhookSecret: 's1' },
          after: { smtpPassword: 'p2', apiToken: 't2', webhookSecret: 's2' },
        }),
      ),
    );
    expect(diff).toEqual({
      smtp_password: { changed: true, class: 'secret' },
      api_token: { changed: true, class: 'secret' },
      webhook_secret: { changed: true, class: 'secret' },
    });
  });

  it('stores a money field in full and tags it (type_fields.kind = money, §7.5)', async () => {
    const { id, diff } = await asUser(t.userId, (tx) =>
      audited(
        tx,
        locationUpdate({
          before: { price: '120.0000' },
          after: { price: '150.5000' },
          fieldClasses: { price: 'money' },
        }),
      ),
    );
    const expected = { price: { before: '120.0000', after: '150.5000', class: 'money' } };
    expect(diff).toEqual(expected);
    expect((await storedEvent(id)).row.diff).toEqual(expected);
  });

  it('writes audit_event_subjects rows for the subjects, sharing the event key', async () => {
    const things = [newId(), newId()];
    const { id } = await asUser(t.userId, (tx) =>
      audited(
        tx,
        locationUpdate({ subjects: [...things, things[0] as string], rootThingId: things[0] }),
      ),
    );
    const { row } = await storedEvent(id);
    expect(row.rootThingId).toBe(things[0]);
    const { rows } = await asOwner(db, (c) =>
      c.query(
        `SELECT s.thing_id, s.location_id, s.event_at = e.at AS same_at
           FROM public.audit_event_subjects s JOIN public.audit_events e ON e.id = s.event_id
          WHERE s.event_id = $1 ORDER BY s.thing_id`,
        [id],
      ),
    );
    expect(rows).toEqual(
      [...things]
        .sort()
        .map((thing) => ({ thing_id: thing, location_id: t.locationId, same_at: true })),
    );
  });

  it('writes two events in one transaction without colliding', async () => {
    const ids = await asUser(t.userId, async (tx) => [
      (await audited(tx, locationUpdate({ subjects: [newId()] }))).id,
      (await audited(tx, locationUpdate({ subjects: [newId()] }))).id,
    ]);
    expect(new Set(ids).size).toBe(2);
  });

  it('writes account-level events with no location', async () => {
    const { id } = await asUser(t.userId, (tx) =>
      audited(tx, {
        locationId: null,
        ownerAccountId: t.accountId,
        actor: { type: 'user', id: t.userId },
        action: 'account.update',
        entity: { type: 'account', id: t.accountId },
        before: { x: 1 },
        after: { x: 2 },
      }),
    );
    const { row } = await storedEvent(id);
    expect(row).toMatchObject({ locationId: null, ownerAccountId: t.accountId });
  });

  it('refuses subjects on an event with no location', async () => {
    await expect(
      asUser(t.userId, (tx) =>
        audited(tx, locationUpdate({ locationId: null, subjects: [newId()] })),
      ),
    ).rejects.toThrow(/subjects need a location/);
  });

  it("is refused by RLS in a location the user can't see", async () => {
    const other = await seedTenant(db, 'audit-other');
    const err = await pgError(
      asUser(t.userId, (tx) => audited(tx, locationUpdate({ locationId: other.locationId }))),
    );
    expect(err.code).toBe('42501');
  });

  it('a viewer member can write an audit row in their location (a reveal, say)', async () => {
    const viewer = await seedUser(db, 'audit-viewer');
    await addMember(db, t.locationId, viewer, 'viewer');
    const { id } = await asUser(viewer, (tx) =>
      audited(tx, locationUpdate({ actor: { type: 'user', id: viewer }, action: 'secret.reveal' })),
    );
    expect((await storedEvent(id)).row.actorId).toBe(viewer);
  });
});

describe('auditedMany()', () => {
  it('writes the same rows as audited(), one per event, in order, with their subjects', async () => {
    const things = [newId(), newId(), newId()];
    const results = await asUser(t.userId, (tx) =>
      auditedMany(tx, [
        locationUpdate({ requestId: 'req-many', subjects: [things[0] as string] }),
        locationUpdate({
          requestId: 'req-many',
          after: { name: 'Loft', timezone: 'Africa/Cairo', languages: ['en'] },
          subjects: [things[1] as string, things[2] as string, things[1] as string],
        }),
        {
          locationId: null,
          ownerAccountId: t.accountId,
          actor: { type: 'user', id: t.userId },
          action: 'tag.create',
          entity: { type: 'tag', id: newId() },
          after: { name: 'Travel' },
        },
      ]),
    );
    expect(results).toHaveLength(3);
    expect(results[1]?.diff).toEqual({ name: { before: 'Home', after: 'Loft', class: 'plain' } });
    const first = await storedEvent(results[0]?.id as string);
    expect(first.row).toMatchObject({ ownerAccountId: t.accountId, requestId: 'req-many' });
    const account = await storedEvent(results[2]?.id as string);
    expect(account.row).toMatchObject({ locationId: null, action: 'tag.create' });
    const { rows } = await asOwner(db, (c) =>
      c.query(
        `SELECT s.event_id, s.thing_id FROM public.audit_event_subjects s
          WHERE s.event_id = ANY ($1::uuid[]) ORDER BY s.thing_id`,
        [results.map((r) => r.id)],
      ),
    );
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.event_id === results[1]?.id)).toHaveLength(2);
  });

  it('refuses subjects on an event with no location, writing nothing', async () => {
    await expect(
      asUser(t.userId, (tx) =>
        auditedMany(tx, [locationUpdate({ locationId: null, subjects: [newId()] })]),
      ),
    ).rejects.toThrow(/subjects need a location/);
  });
});

describe('renderAudit()', () => {
  async function moneyEvent(): Promise<EventRow> {
    const { id } = await asUser(t.userId, (tx) =>
      audited(
        tx,
        locationUpdate({
          before: { name: 'A', price: '10.0000', pin: '1234' },
          after: { name: 'B', price: '20.0000', pin: '9876' },
          fieldClasses: { price: 'money', pin: 'secret' },
        }),
      ),
    );
    return (await storedEvent(id)).row;
  }

  it('hides money from a viewer unless the location allows it (D110, D13)', async () => {
    const event = await moneyEvent();
    const hidden = renderAudit(event, { role: 'viewer', moneyVisibleToViewers: false });
    expect(hidden.diff).toEqual({
      name: { before: 'A', after: 'B', class: 'plain' },
      price: { changed: true, class: 'money', hidden: true },
      pin: { changed: true, class: 'secret' },
    });
    expect(JSON.stringify(hidden)).not.toMatch(/10\.0000|20\.0000/);

    const allowed = renderAudit(event, { role: 'viewer', moneyVisibleToViewers: true });
    // Rendered in the one wire form (`"10"`), whatever the diff stored.
    expect(allowed.diff?.price).toEqual({ before: '10', after: '20', class: 'money' });
  });

  it('shows money to members and above', async () => {
    const event = await moneyEvent();
    for (const role of ['owner', 'admin', 'member'] as const) {
      const out = renderAudit(event, { role, moneyVisibleToViewers: false });
      expect(out.diff?.price, role).toEqual({ before: '10', after: '20', class: 'money' });
    }
  });

  it('never renders a secret value, even if one reached the stored diff', () => {
    const event = {
      id: newId(),
      at: new Date(),
      locationId: t.locationId,
      ownerAccountId: t.accountId,
      actorType: 'user',
      actorId: t.userId,
      action: 'x.update',
      entityType: 'x',
      entityId: null,
      rootThingId: null,
      diff: { pin: { before: '1234', after: '9876', class: 'secret' } },
      requestId: null,
      undoOf: null,
      undoableUntil: null,
    } satisfies EventRow;
    const out = renderAudit(event, { role: 'owner', moneyVisibleToViewers: true });
    expect(out.diff).toEqual({ pin: { changed: true, class: 'secret' } });
  });

  it('renders the event envelope for every view', async () => {
    const event = await moneyEvent();
    const out = renderAudit(event, { role: 'member', moneyVisibleToViewers: false });
    expect(out).toMatchObject({
      id: event.id,
      at: event.at.toISOString(),
      action: 'location.update',
      actor: { type: 'user', id: t.userId },
      entity: { type: 'location', id: t.locationId },
      location_id: t.locationId,
    });
  });
});
