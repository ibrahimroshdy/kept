import { createHash } from 'node:crypto';
import { newId } from '@kept/shared';
import type pg from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../../test/db.js';
import {
  addMember,
  asOwner,
  insertLocation,
  ownerTx,
  pgError,
  seedTenant,
  seedUser,
  type Tenant,
} from '../../test/tenancy.js';
import { type Scope, withScope } from './scope.js';

// Task 8: files, derivatives and attachments (engineering spec §1.5, §7.2, §7.13; D115, D117,
// D155, D177), plus saved views and hints (D42, D138). As kept_app unless noted.

const db = await testDb();
const app = db.pools.app;

beforeEach(async () => {
  await db.reset();
});

const as = (userId: string): Scope => ({ userId, mfa: false });

async function q<T extends pg.QueryResultRow = Record<string, unknown>>(
  scope: Scope,
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  return withScope(app, scope, async (_tx, client) => (await client.query<T>(text, values)).rows);
}

/** Uploads a file into `locationId` as `userId`, with a thumbnail; returns its id. */
async function upload(userId: string, locationId: string, label = newId()) {
  const id = newId();
  await withScope(app, as(userId), async (_tx, c) => {
    await c.query(
      `INSERT INTO public.files (id, location_id, storage_key, sha256, bytes, mime, class,
                                 derivative_state, created_by)
       VALUES ($1, $2, $3, $4, 10, 'image/jpeg', 'photo', 'ready', $5)`,
      [
        id,
        locationId,
        `f/${locationId}/${id}`,
        createHash('sha256').update(label).digest('hex'),
        userId,
      ],
    );
    await c.query(
      `INSERT INTO public.file_derivatives (file_id, variant, location_id, storage_key, width, height, bytes)
       VALUES ($1, 'thumb', $2, $3, 10, 10, 5)`,
      [id, locationId, `d/${id}/thumb.jpg`],
    );
  });
  return id;
}

async function thing(t: Tenant, userId = t.userId) {
  const id = newId();
  await q(
    as(userId),
    `INSERT INTO public.things (id, location_id, place_id, name) VALUES ($1, $2, $3, 'Thing')`,
    [id, t.locationId, t.unplacedId],
  );
  return id;
}

const attach = (userId: string, t: Tenant, fileId: string, thingId: string, role = 'photo') =>
  withScope(app, as(userId), async (_tx, c) =>
    c.query(
      `INSERT INTO public.attachments (location_id, file_id, thing_id, role, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [t.locationId, fileId, thingId, role, userId],
    ),
  );

describe('files (§7.2, D177)', () => {
  let a: Tenant;
  let member: string;
  let viewer: string;
  beforeEach(async () => {
    a = await seedTenant(db, 'a');
    member = await seedUser(db, 'member');
    viewer = await seedUser(db, 'viewer');
    await addMember(db, a.locationId, member, 'member');
    await addMember(db, a.locationId, viewer, 'viewer');
  });

  const seen = (userId: string, fileId: string) =>
    q(as(userId), 'SELECT id FROM public.files WHERE id = $1', [fileId]).then((r) => r.length);

  it('is invisible without an attachment, except to its uploader', async () => {
    const file = await upload(member, a.locationId);
    expect(await seen(member, file)).toBe(1);
    expect(await seen(a.userId, file)).toBe(0);
    expect(await seen(viewer, file)).toBe(0);
    await attach(member, a, file, await thing(a, member));
    expect(await seen(a.userId, file)).toBe(1);
    expect(await seen(viewer, file)).toBe(1);
  });

  it("refuses attaching a file the caller can't see, like one that doesn't exist (42501)", async () => {
    const theirs = await upload(member, a.locationId);
    const mine = await thing(a);
    for (const fileId of [theirs, newId()]) {
      expect(await pgError(attach(a.userId, a, fileId, mine))).toMatchObject({
        code: '42501',
        constraint: 'attachments_file',
      });
    }
  });

  it("shows a viewer a photo's derivatives once the photo is attached", async () => {
    const file = await upload(a.userId, a.locationId);
    const derivatives = () =>
      q(as(viewer), 'SELECT variant FROM public.file_derivatives WHERE file_id = $1', [file]);
    expect(await derivatives()).toEqual([]);
    await attach(a.userId, a, file, await thing(a));
    expect(await derivatives()).toEqual([{ variant: 'thumb' }]);
  });

  it('dedupes by content per location (D177), and is never updated', async () => {
    await upload(a.userId, a.locationId, 'same bytes');
    expect(await pgError(upload(member, a.locationId, 'same bytes'))).toMatchObject({
      code: '23505',
      constraint: 'files_location_sha_uq',
    });
    const file = await upload(a.userId, a.locationId);
    expect(
      (
        await pgError(
          q(as(a.userId), `UPDATE public.files SET mime = 'text/html' WHERE id = $1`, [file]),
        )
      ).code,
    ).toBe('42501');
  });

  it("refuses a file in another location's attachment (the composite key)", async () => {
    const b = await seedTenant(db, 'b');
    const theirs = await upload(b.userId, b.locationId);
    await attach(b.userId, b, theirs, await thing(b));
    const err = await pgError(attach(a.userId, a, theirs, await thing(a)));
    expect(err.code).toBe('42501');
  });
});

describe('storage keys and deletes (security review I6, minor)', () => {
  let a: Tenant;
  let member: string;
  let admin: string;
  beforeEach(async () => {
    a = await seedTenant(db, 'a');
    member = await seedUser(db, 'member');
    admin = await seedUser(db, 'admin');
    await addMember(db, a.locationId, member, 'member');
    await addMember(db, a.locationId, admin, 'admin');
  });

  const keysOf = (fileId: string) =>
    asOwner(db, async (c) => {
      const f = await c.query('SELECT storage_key FROM public.files WHERE id = $1', [fileId]);
      const d = await c.query(
        'SELECT variant, storage_key FROM public.file_derivatives WHERE file_id = $1',
        [fileId],
      );
      return { file: f.rows[0]?.storage_key as string, derivatives: d.rows };
    });

  it('builds the storage keys itself, whatever the client sends', async () => {
    const b = await seedTenant(db, 'b');
    const id = newId();
    await withScope(app, as(member), async (_tx, c) => {
      await c.query(
        `INSERT INTO public.files (id, location_id, storage_key, sha256, bytes, mime, class,
                                   derivative_state, created_by)
         VALUES ($1, $2, $3, $4, 10, 'image/jpeg', 'photo', 'ready', $5)`,
        [
          id,
          a.locationId,
          `f/${b.locationId}/${newId()}`,
          createHash('sha256').update(id).digest('hex'),
          member,
        ],
      );
      await c.query(
        `INSERT INTO public.file_derivatives (file_id, variant, location_id, storage_key, width, height, bytes)
         VALUES ($1, 'thumb', $2, 'f/someone-elses/blob', 10, 10, 5)`,
        [id, a.locationId],
      );
    });
    expect(await keysOf(id)).toEqual({
      file: `f/${a.locationId}/${id}`,
      derivatives: [{ variant: 'thumb', storage_key: `d/${id}/thumb.jpg` }],
    });
  });

  it("refuses a derivative of someone else's file (42501)", async () => {
    const file = await upload(member, a.locationId);
    await attach(member, a, file, await thing(a, member));
    const derivative = withScope(app, as(a.userId), (_tx, c) =>
      c.query(
        `INSERT INTO public.file_derivatives (file_id, variant, location_id, storage_key, width, height, bytes)
         VALUES ($1, 'display', $2, 'x', 10, 10, 5)`,
        [file, a.locationId],
      ),
    );
    expect((await pgError(derivative)).code).toBe('42501');
  });

  it('lets the uploader delete an unattached upload, and only an admin an attached file (D162)', async () => {
    const del = (userId: string, fileId: string) =>
      withScope(
        app,
        as(userId),
        async (_tx, c) =>
          (await c.query('DELETE FROM public.files WHERE id = $1', [fileId])).rowCount,
      );
    const loose = await upload(member, a.locationId);
    expect(await del(a.userId, loose)).toBe(0);
    expect(await del(member, loose)).toBe(1);
    const attached = await upload(member, a.locationId);
    await attach(member, a, attached, await thing(a, member));
    const other = await seedUser(db, 'other-member');
    await addMember(db, a.locationId, other, 'member');
    expect(await del(other, attached)).toBe(0);
    expect(await del(member, attached)).toBe(0);
    expect(await del(admin, attached)).toBe(1);
  });
});

describe('receipts after a move (D115)', () => {
  it("serves a thing's receipt to a member of its new location, and nothing else", async () => {
    const a = await seedTenant(db, 'a');
    const flat = await ownerTx(db, (c) => insertLocation(c, a, { name: 'Flat' }));
    const flatMember = await seedUser(db, 'flat-member');
    await addMember(db, flat.locationId, flatMember, 'member');
    const purchase = newId();
    const line = newId();
    await ownerTx(db, async (c) => {
      await c.query(
        `INSERT INTO public.purchases (id, location_id, purchased_on) VALUES ($1, $2, '2026-09-01')`,
        [purchase, a.locationId],
      );
      await c.query(
        `INSERT INTO public.purchase_lines (id, location_id, purchase_id, description)
         VALUES ($1, $2, $3, 'Phone')`,
        [line, a.locationId, purchase],
      );
    });
    const receipt = await upload(a.userId, a.locationId);
    const photo = await upload(a.userId, a.locationId);
    await q(
      as(a.userId),
      `INSERT INTO public.attachments (location_id, file_id, purchase_id, role, created_by)
       VALUES ($1, $2, $3, 'receipt', $4), ($1, $5, $3, 'photo', $4)`,
      [a.locationId, receipt, purchase, a.userId, photo],
    );
    const phone = newId();
    // Bought for A's home, then moved to the flat (as kept_owner; task 9's definer is the path).
    await ownerTx(db, async (c) => {
      await c.query(
        `INSERT INTO public.things (id, location_id, place_id, name, purchase_line_id)
         VALUES ($1, $2, $3, 'Phone', $4)`,
        [phone, a.locationId, a.unplacedId, line],
      );
      await c.query('UPDATE public.things SET location_id = $2, place_id = $3 WHERE id = $1', [
        phone,
        flat.locationId,
        flat.unplacedId,
      ]);
    });
    expect(
      await q(as(flatMember), 'SELECT file_id, role FROM kept.thing_receipts($1)', [phone]),
    ).toEqual([{ file_id: receipt, role: 'receipt' }]);
    const serve = (userId: string, fileId: string) =>
      q(as(userId), 'SELECT mime, bytes FROM kept.thing_receipt_file($1, $2)', [phone, fileId]);
    expect(await serve(flatMember, receipt)).toEqual([{ mime: 'image/jpeg', bytes: '10' }]);
    expect(await serve(flatMember, photo)).toEqual([]);
    // Originals are for members and above (D117): a viewer lists the receipt, never gets the file.
    const flatViewer = await seedUser(db, 'flat-viewer');
    await addMember(db, flat.locationId, flatViewer, 'viewer');
    expect(await q(as(flatViewer), 'SELECT file_id FROM kept.thing_receipts($1)', [phone])).toEqual(
      [{ file_id: receipt }],
    );
    expect(await serve(flatViewer, receipt)).toEqual([]);
    // Directly, the file stays invisible to them.
    expect(await q(as(flatMember), 'SELECT id FROM public.files WHERE id = $1', [receipt])).toEqual(
      [],
    );
    const b = await seedTenant(db, 'b');
    expect(await serve(b.userId, receipt)).toEqual([]);
  });
});

describe('saved views and hints (D42, D138)', () => {
  let a: Tenant;
  let viewer: string;
  beforeEach(async () => {
    a = await seedTenant(db, 'a');
    viewer = await seedUser(db, 'viewer');
    await addMember(db, a.locationId, viewer, 'viewer');
  });

  const view = (userId: string, locationId: string | null, shared: boolean) =>
    q(
      as(userId),
      `INSERT INTO public.saved_views (user_id, location_id, name, shared) VALUES ($1, $2, 'V', $3)`,
      [userId, locationId, shared],
    );

  it('shows a shared view to the location, and a personal one to its owner only', async () => {
    await view(a.userId, a.locationId, true);
    await view(a.userId, null, false);
    expect(await q(as(viewer), 'SELECT shared FROM public.saved_views')).toEqual([
      { shared: true },
    ]);
    expect(await q(as(a.userId), 'SELECT count(*)::int AS n FROM public.saved_views')).toEqual([
      { n: 2 },
    ]);
    // The viewer may keep a personal view of the location, but not share one.
    await view(viewer, a.locationId, false);
    expect((await pgError(view(viewer, a.locationId, true))).code).toBe('42501');
    // Nobody edits someone else's shared view.
    expect(
      await q(as(viewer), `UPDATE public.saved_views SET name = 'X' WHERE shared RETURNING id`),
    ).toEqual([]);
  });

  it("lets an admin of the location delete another user's shared view, never edit it", async () => {
    const admin = await seedUser(db, 'admin');
    const member = await seedUser(db, 'member');
    await addMember(db, a.locationId, admin, 'admin');
    await addMember(db, a.locationId, member, 'member');
    await view(member, a.locationId, true);
    await view(member, a.locationId, false);
    const del = (userId: string) =>
      withScope(
        app,
        as(userId),
        async (_tx, c) => (await c.query('DELETE FROM public.saved_views')).rowCount,
      );
    expect(
      await q(as(admin), `UPDATE public.saved_views SET name = 'X' WHERE shared RETURNING id`),
    ).toEqual([]);
    // A viewer can't; an admin deletes the shared one only, not the member's personal view.
    expect(await del(viewer)).toBe(0);
    expect(await del(admin)).toBe(1);
    expect(await q(as(member), 'SELECT shared FROM public.saved_views')).toEqual([
      { shared: false },
    ]);
  });

  it('keeps hints to their user', async () => {
    await q(
      as(a.userId),
      `INSERT INTO public.user_hints (user_id, hint_key) VALUES ($1, 'home.intro')`,
      [a.userId],
    );
    expect(await q(as(viewer), 'SELECT hint_key FROM public.user_hints')).toEqual([]);
    expect(
      (
        await pgError(
          q(as(viewer), `INSERT INTO public.user_hints (user_id, hint_key) VALUES ($1, 'x')`, [
            a.userId,
          ]),
        )
      ).code,
    ).toBe('42501');
  });
});
