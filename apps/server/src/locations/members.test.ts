import { beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { auditOf, call, join, type Person, peopleApp, person } from '../../test/people.js';
import { ownerTx } from '../../test/tenancy.js';

// Task 19: memberships (D46, D48, D180) through the front door.

const DAY = 86_400_000;

let db: TestDb;
let t: TestApp;
let owner: Person;
let admin: Person;
let member: Person;
let viewer: Person;
let homeId: string;
const ids: Record<string, string> = {};
const adminUntil = () => new Date(Date.now() + 10 * DAY);
const memberUntil = () => new Date(Date.now() + 5 * DAY);

beforeEach(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db);
  owner = await person(t, db, 'owner');
  admin = await person(t, db, 'admin');
  member = await person(t, db, 'member');
  viewer = await person(t, db, 'viewer');
  const res = await call(t, '/api/v1/locations', {
    as: owner,
    body: { name: 'Home', kind: 'home', timezone: 'UTC', currency: 'USD' },
  });
  homeId = res.json().id;
  ids.admin = await join(db, homeId, admin.userId, 'admin', adminUntil());
  // Within the admin's own end (D180): since 0010 an admin can't touch a membership that
  // outlasts theirs.
  ids.member = await join(db, homeId, member.userId, 'member', memberUntil());
  ids.viewer = await join(db, homeId, viewer.userId, 'viewer', memberUntil());
  const { rows } = await ownerTx(db, (c) =>
    c.query(`SELECT id FROM public.memberships WHERE location_id = $1 AND role = 'owner'`, [
      homeId,
    ]),
  );
  ids.owner = rows[0].id;
});

const url = (membershipId?: string) =>
  `/api/v1/locations/${homeId}/members${membershipId ? `/${membershipId}` : ''}`;

async function version(membershipId: string): Promise<number> {
  const { rows } = await ownerTx(db, (c) =>
    c.query('SELECT row_version FROM public.memberships WHERE id = $1', [membershipId]),
  );
  return rows[0].row_version;
}

async function patch(as: Person, membershipId: string, body: unknown) {
  return call(t, url(membershipId), {
    method: 'PATCH',
    as,
    body,
    headers: { 'if-match': String(await version(membershipId)) },
  });
}

describe('GET members', () => {
  it('lists members by role; addresses and invites only for those who manage members', async () => {
    const asOwner = (await call(t, url(), { as: owner })).json();
    expect(asOwner.members.map((m: { role: string }) => m.role)).toEqual([
      'owner',
      'admin',
      'member',
      'viewer',
    ]);
    expect(asOwner.members[2]).toMatchObject({ email: member.email, isYou: false });
    const asViewer = (await call(t, url(), { as: viewer })).json();
    expect(asViewer.members[2].email).toBeNull();
    expect(asViewer.members[3]).toMatchObject({ email: viewer.email, isYou: true });
    expect(asViewer.invites).toEqual([]);
    const outsider = await person(t, db, 'outsider');
    expect((await call(t, url(), { as: outsider })).statusCode).toBe(404);
  });
});

describe('PATCH a member', () => {
  // catalogue: PATCH /api/v1/locations/:id/members/:membershipId
  it('lets an admin change members and viewers, audited', async () => {
    const res = await patch(admin, ids.member as string, { role: 'viewer' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ role: 'viewer', rowVersion: 2 });
    expect((await auditOf(db, homeId)).at(-1)).toMatchObject({
      action: 'member.update',
      actor_id: admin.userId,
    });
  });

  it('keeps admins the owner’s to manage (D48)', async () => {
    expect((await patch(admin, ids.member as string, { role: 'admin' })).statusCode).toBe(403);
    const other = await person(t, db, 'admin2');
    const otherId = await join(db, homeId, other.userId, 'admin');
    expect((await patch(admin, otherId, { role: 'member' })).statusCode).toBe(403);
    expect((await patch(owner, ids.member as string, { role: 'admin' })).statusCode).toBe(200);
  });

  it('never touches the owner row or the caller’s own, and refuses members and viewers', async () => {
    expect((await patch(admin, ids.owner as string, { role: 'viewer' })).statusCode).toBe(403);
    expect((await patch(owner, ids.owner as string, { expiresAt: null })).statusCode).toBe(403);
    expect((await patch(admin, ids.admin as string, { expiresAt: null })).statusCode).toBe(403);
    expect((await patch(member, ids.viewer as string, { role: 'member' })).statusCode).toBe(403);
  });

  it("caps an admin's end dates at their own (D46, D180)", async () => {
    const later = new Date(Date.now() + 30 * DAY).toISOString();
    const sooner = new Date(Date.now() + 2 * DAY).toISOString();
    const tooLate = await patch(admin, ids.member as string, { expiresAt: later });
    expect(tooLate.statusCode).toBe(400);
    // No end date is later than any date.
    expect((await patch(admin, ids.member as string, { expiresAt: null })).statusCode).toBe(400);
    const ok = await patch(admin, ids.member as string, { expiresAt: sooner });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().expiresAt).toBe(sooner);
    // The owner has no end date, so no cap.
    expect((await patch(owner, ids.member as string, { expiresAt: later })).statusCode).toBe(200);
    const past = new Date(Date.now() - DAY).toISOString();
    expect((await patch(owner, ids.member as string, { expiresAt: past })).statusCode).toBe(400);
  });

  it('needs If-Match', async () => {
    const res = await call(t, url(ids.member), {
      method: 'PATCH',
      as: owner,
      body: { role: 'viewer' },
    });
    expect(res.statusCode).toBe(428);
  });
});

describe('DELETE a member, and leaving', () => {
  // catalogue: DELETE /api/v1/locations/:id/members/:membershipId
  it('lets an admin remove a member, only the owner remove an admin', async () => {
    expect((await call(t, url(ids.member), { method: 'DELETE', as: admin })).statusCode).toBe(204);
    const other = await person(t, db, 'admin2');
    const otherId = await join(db, homeId, other.userId, 'admin');
    expect((await call(t, url(otherId), { method: 'DELETE', as: admin })).statusCode).toBe(403);
    expect((await call(t, url(otherId), { method: 'DELETE', as: owner })).statusCode).toBe(204);
    expect((await call(t, url(ids.owner), { method: 'DELETE', as: admin })).statusCode).toBe(403);
    // A viewer (the member was removed above, so is no longer anyone here) removes nobody.
    expect((await call(t, url(ids.admin), { method: 'DELETE', as: viewer })).statusCode).toBe(403);
    expect((await call(t, url(ids.viewer), { method: 'DELETE', as: member })).statusCode).toBe(404);
    expect((await auditOf(db, homeId)).map((e) => e.action)).toEqual([
      'location.create',
      'member.remove',
      'member.remove',
    ]);
  });

  it('lets anyone but the owner leave (last_owner)', async () => {
    const leave = await call(t, url(ids.viewer), { method: 'DELETE', as: viewer });
    expect(leave.statusCode, leave.body).toBe(204);
    expect((await call(t, `/api/v1/locations/${homeId}`, { as: viewer })).statusCode).toBe(404);
    const events = await auditOf(db, homeId);
    expect(events.at(-1)).toMatchObject({ action: 'member.leave', actor_id: viewer.userId });

    const stay = await call(t, url(ids.owner), { method: 'DELETE', as: owner });
    expect(stay.statusCode).toBe(409);
    expect(stay.json().code).toBe('last_owner');
  });
});

describe('security review of tasks 19–21', () => {
  it('pages members (§7.7, M8)', async () => {
    const first = await call(t, `${url()}?limit=3`, { as: owner });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().members.map((m: { role: string }) => m.role)).toEqual([
      'owner',
      'admin',
      'member',
    ]);
    const next = await call(t, `${url()}?limit=3&cursor=${first.json().nextCursor}`, {
      as: owner,
    });
    expect(next.json().members.map((m: { role: string }) => m.role)).toEqual(['viewer']);
    expect(next.json().nextCursor).toBeNull();
  });

  it('lets one of two racing edits with the same If-Match through (M2)', async () => {
    const v = String(await version(ids.member as string));
    const edit = (role: string) =>
      call(t, url(ids.member), {
        method: 'PATCH',
        as: owner,
        body: { role },
        headers: { 'if-match': v },
      });
    const answers = await Promise.all([edit('viewer'), edit('admin'), edit('viewer')]);
    expect(answers.map((r) => r.statusCode).sort()).toEqual([200, 412, 412]);
  });

  it("leaves a membership that outlasts an admin's own to the owner (D180)", async () => {
    const longer = await person(t, db, 'longer');
    const id = await join(db, homeId, longer.userId, 'member');
    const res = await call(t, url(id), {
      method: 'PATCH',
      as: admin,
      body: { role: 'viewer' },
      headers: { 'if-match': String(await version(id)) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('caps the memberships an admin created when the admin is shortened or removed (D180, M6)', async () => {
    const invitee = await person(t, db, 'invitee');
    const inviteeId = await ownerTx(db, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO public.memberships (location_id, user_id, role, expires_at, invited_by)
         VALUES ($1, $2, 'member', $3, $4) RETURNING id`,
        [homeId, invitee.userId, adminUntil(), admin.userId],
      );
      return rows[0]?.id as string;
    });
    const until = new Date(Date.now() + 2 * DAY);
    const shorten = await patch(owner, ids.admin as string, { expiresAt: until.toISOString() });
    expect(shorten.statusCode, shorten.body).toBe(200);
    const expiry = async () =>
      (
        await ownerTx(db, (c) =>
          c.query('SELECT expires_at FROM public.memberships WHERE id = $1', [inviteeId]),
        )
      ).rows[0]?.expires_at as Date;
    expect((await expiry()).getTime()).toBe(until.getTime());
    expect((await auditOf(db, homeId)).map((e) => e.action)).toContain('member.recap');

    const removed = await call(t, url(ids.admin), { method: 'DELETE', as: owner });
    expect(removed.statusCode).toBe(204);
    expect((await expiry()).getTime()).toBeLessThanOrEqual(Date.now());
    expect((await call(t, `/api/v1/locations/${homeId}`, { as: invitee })).statusCode).toBe(404);
  });
});
