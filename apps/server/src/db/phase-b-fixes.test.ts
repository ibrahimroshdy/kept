import { createHash } from 'node:crypto';
import { newId } from '@kept/shared';
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

// Phase B's schema gaps (0056): admins' exchange-rate history; undo keeping who made a row and
// re-linking the files its event held; the orphan-file purge waiting out the undo window; the
// reminder jobs' reads and lazy email channel; merged parts.

const db = await testDb();
vi.setConfig({ testTimeout: 60_000 });

let ibrahim: Tenant; // owns Home
let bruce: string; // admin
let louis: string; // member
let talia: Tenant; // another household
let drill: string;

const as = <T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  withScope(db.pools.app, { userId, mfa: true }, (_tx, c) => fn(c));
const asSystem = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  withSystem(db.pools.system, (_tx, c) => fn(c));
const own = <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(sql, values)).rows);

beforeEach(async () => {
  await db.reset();
  ibrahim = await seedTenant(db, 'pb-ibrahim');
  bruce = await seedUser(db, 'pb-bruce');
  await addMember(db, ibrahim.locationId, bruce, 'admin');
  louis = await seedUser(db, 'pb-louis');
  await addMember(db, ibrahim.locationId, louis, 'member');
  talia = await seedTenant(db, 'pb-talia');
  drill = newId();
  await own(
    `INSERT INTO public.things (id, location_id, place_id, name) VALUES ($1, $2, $3, 'Drill')`,
    [drill, ibrahim.locationId, ibrahim.unplacedId],
  );
});

/** A file Louis uploaded to Home, attached to nothing. */
async function louisFile(age = "interval '2 days'"): Promise<string> {
  const id = newId();
  await own(
    `INSERT INTO public.files (id, location_id, storage_key, sha256, bytes, mime, class,
                               derivative_state, created_by, created_at)
     VALUES ($1, $2, $3, $4, 10, 'application/pdf', 'document', 'ready', $5, now() - ${age})`,
    [
      id,
      ibrahim.locationId,
      `f/${ibrahim.locationId}/${id}`,
      createHash('sha256').update(id).digest('hex'),
      louis,
    ],
  );
  return id;
}

/** Bruce deleting Louis's lease with its attachment: the event documents.ts writes. */
async function deletedLease(file: string) {
  const doc = newId();
  const attachment = newId();
  await own(
    `INSERT INTO public.audit_events (location_id, owner_account_id, actor_type, actor_id, action,
                                      entity_type, entity_id, diff)
     VALUES ($1, $2, 'user', $3, 'document.create', 'expiring_document', $4, '{}')`,
    [ibrahim.locationId, ibrahim.accountId, louis, doc],
  );
  const [event] = await own<{ id: string }>(
    `INSERT INTO public.audit_events (location_id, owner_account_id, actor_type, actor_id, action,
                                      entity_type, entity_id, diff, undoable_until)
     VALUES ($1, $2, 'user', $3, 'document.delete', 'expiring_document', $4,
             jsonb_build_object(
               'kind', jsonb_build_object('before', 'lease', 'after', NULL),
               'attachments', jsonb_build_object('before', jsonb_build_array(jsonb_build_object(
                 'id', $5::text, 'file_id', $6::text, 'url', NULL, 'role', 'document', 'sort', 0)),
                 'after', NULL)),
             now() + interval '7 days')
     RETURNING id`,
    [ibrahim.locationId, ibrahim.accountId, bruce, doc, attachment, file],
  );
  return { doc, attachment, event: event?.id as string };
}

/** The undo's re-inserts, as paperwork/undo.ts makes them, with or without `app.undo`. */
const reinsert = (
  userId: string,
  d: { doc: string; attachment: string; event: string },
  file: string,
  undo: boolean,
) =>
  as(userId, async (c) => {
    if (undo) await c.query(`SELECT set_config('app.undo', $1, true)`, [d.event]);
    await c.query(
      `INSERT INTO public.expiring_documents (id, location_id, kind, expires_on, created_by)
       VALUES ($1, $2, 'lease', '2027-01-01', kept.current_user_id())`,
      [d.doc, ibrahim.locationId],
    );
    await c.query(
      `INSERT INTO public.attachments (id, location_id, file_id, expiring_document_id, role,
                                       created_by)
       VALUES ($1, $2, $3, $4, 'document', kept.current_user_id())`,
      [d.attachment, ibrahim.locationId, file, d.doc],
    );
  });

describe("an admin's exchange-rate history (T8)", () => {
  const event = (userId: string) =>
    as(userId, (c) =>
      c.query(
        `INSERT INTO public.audit_events (owner_account_id, actor_type, actor_id, action,
                                          entity_type, diff)
         VALUES ($1, 'user', $2, 'fx_rate.set', 'fx_rate', '{}')`,
        [ibrahim.accountId, userId],
      ),
    );

  it('is written and read by the account admins, never its members', async () => {
    await event(bruce);
    expect((await pgError(event(louis))).code).toBe('42501');
    const seen = (userId: string) =>
      as(
        userId,
        async (c) =>
          (await c.query(`SELECT 1 FROM public.audit_events WHERE entity_type = 'fx_rate'`))
            .rowCount,
      );
    expect(await seen(bruce)).toBe(1);
    expect(await seen(louis)).toBe(0);
  });
});

describe('undo keeps who made a row, and its files (D150; 0056)', () => {
  it("brings Louis's document back as his, with his file, when Bruce undoes the delete", async () => {
    const file = await louisFile();
    const d = await deletedLease(file);
    await reinsert(bruce, d, file, true);
    expect(
      await own('SELECT created_by FROM public.expiring_documents WHERE id = $1', [d.doc]),
    ).toEqual([{ created_by: louis }]);
    expect(
      await own('SELECT created_by, file_id FROM public.attachments WHERE id = $1', [d.attachment]),
    ).toEqual([{ created_by: louis, file_id: file }]);
  });

  it("without the undo's event, Bruce can't link Louis's file nor claim Louis made the row", async () => {
    const file = await louisFile();
    const d = await deletedLease(file);
    expect((await pgError(reinsert(bruce, d, file, false))).code).toBe('42501');
    const forged = await pgError(
      as(bruce, (c) =>
        c.query(
          `INSERT INTO public.expiring_documents (id, location_id, kind, expires_on, created_by)
           VALUES ($1, $2, 'lease', '2027-01-01', $3)`,
          [newId(), ibrahim.locationId, louis],
        ),
      ),
    );
    expect(forged.code).toBe('42501');
  });

  it('ignores an event that is expired, already undone, or not the row', async () => {
    const file = await louisFile();
    const expired = await deletedLease(file);
    await own(
      `UPDATE public.audit_events SET undoable_until = now() - interval '1 minute' WHERE id = $1`,
      [expired.event],
    );
    expect((await pgError(reinsert(bruce, expired, file, true))).code).toBe('42501');
    const d = await deletedLease(file);
    await own(
      `INSERT INTO public.audit_events (location_id, owner_account_id, actor_type, actor_id,
                                        action, entity_type, entity_id, undo_of)
       VALUES ($1, $2, 'user', $3, 'document.delete', 'expiring_document', $4, $5)`,
      [ibrahim.locationId, ibrahim.accountId, bruce, d.doc, d.event],
    );
    expect((await pgError(reinsert(bruce, d, file, true))).code).toBe('42501');
    // Another tenant can't use the event at all.
    const creator = await as(talia.userId, async (c) => {
      await c.query(`SELECT set_config('app.undo', $1, true)`, [d.event]);
      return (
        await c.query<{ u: string | null }>('SELECT kept.undo_creator($1, $2) AS u', [
          ibrahim.locationId,
          d.doc,
        ])
      ).rows[0]?.u;
    });
    expect(creator).toBeNull();
  });
});

describe('the orphan-file purge and the undo window (T10–T12)', () => {
  const purge = () =>
    asSystem(async (c) =>
      (
        await c.query<{ storage_key: string }>(
          `SELECT storage_key FROM kept.purge_orphan_files(now() - interval '1 day', 100)`,
        )
      ).rows.map((r) => r.storage_key),
    );

  it('keeps a file an undoable event holds, and purges it once the window closes', async () => {
    const held = await louisFile();
    const loose = await louisFile();
    const d = await deletedLease(held);
    expect(await purge()).toEqual([`f/${ibrahim.locationId}/${loose}`]);
    await own(
      `UPDATE public.audit_events SET undoable_until = now() - interval '1 second' WHERE id = $1`,
      [d.event],
    );
    expect(await purge()).toEqual([`f/${ibrahim.locationId}/${held}`]);
  });
});

describe('the reminder jobs (T14, T16)', () => {
  it('read who hid a module and which services completed a schedule', async () => {
    await own(
      `INSERT INTO public.user_hidden_modules (user_id, location_id, module) VALUES ($1, $2, 'lending')`,
      [bruce, ibrahim.locationId],
    );
    const service = newId();
    const schedule = newId();
    await own(
      `INSERT INTO public.schedules (id, location_id, thing_id, name, every_months, anchor_on, created_by)
       VALUES ($1, $2, $3, 'Oil', 6, '2026-01-01', $4)`,
      [schedule, ibrahim.locationId, drill, ibrahim.userId],
    );
    await own(
      `INSERT INTO public.service_records (id, location_id, thing_id, serviced_on, logged_by)
       VALUES ($1, $2, $3, '2026-09-01', $4)`,
      [service, ibrahim.locationId, drill, ibrahim.userId],
    );
    await own(
      `INSERT INTO public.service_completions (location_id, service_record_id, schedule_id)
       VALUES ($1, $2, $3)`,
      [ibrahim.locationId, service, schedule],
    );
    const counts = await asSystem(async (c) => ({
      hidden: (await c.query('SELECT 1 FROM public.user_hidden_modules')).rowCount,
      services: (await c.query('SELECT 1 FROM public.service_records')).rowCount,
      completions: (await c.query('SELECT 1 FROM public.service_completions')).rowCount,
    }));
    expect(counts).toEqual({ hidden: 1, services: 1, completions: 1 });
  });

  it("make a user's email channel, and nothing else", async () => {
    await asSystem((c) =>
      c.query(`INSERT INTO public.notification_channels (user_id, kind) VALUES ($1, 'email')`, [
        bruce,
      ]),
    );
    expect(
      (
        await pgError(
          asSystem((c) =>
            c.query(
              `INSERT INTO public.notification_channels (user_id, kind, config_ciphertext, key_version)
               VALUES ($1, 'webhook', '{"v": 1}', 1)`,
              [bruce],
            ),
          ),
        )
      ).code,
    ).toBe('42501');
  });
});

describe('merged parts (T10; D172, Q14)', () => {
  it('stay in the trash but for an un-merge, and their loans move to the row they joined', async () => {
    const part = newId();
    await own(
      `INSERT INTO public.things (id, location_id, place_id, name) VALUES ($1, $2, $3, 'Drill')`,
      [part, ibrahim.locationId, ibrahim.unplacedId],
    );
    const person = newId();
    await own(
      `INSERT INTO public.people (id, owner_account_id, display_name) VALUES ($1, $2, 'Murdock')`,
      [person, ibrahim.accountId],
    );
    const loan = newId();
    await own(
      `INSERT INTO public.loans (id, location_id, thing_id, direction, person_id, started_at,
                                 returned_at, split_from_thing_id, created_by)
       VALUES ($1, $2, $3, 'out', $4, now() - interval '3 days', now(), $5, $6)`,
      [loan, ibrahim.locationId, part, person, drill, louis],
    );
    const merge = (into: string) =>
      as(louis, (c) =>
        c.query(
          `UPDATE public.things SET deleted_at = now(), trash_batch_id = $2, merged_into_id = $3
            WHERE id = $1`,
          [part, newId(), into],
        ),
      );
    // Not into itself, nor into another location's thing.
    expect((await pgError(merge(part))).constraint).toBe('things_merged_into');
    const theirs = newId();
    await own(
      `INSERT INTO public.things (id, location_id, place_id, name) VALUES ($1, $2, $3, 'Saw')`,
      [theirs, talia.locationId, talia.unplacedId],
    );
    expect((await pgError(merge(theirs))).constraint).toBe('things_merged_into');
    await merge(drill);
    // The trash can't bring it back on its own; un-merging does.
    expect(
      (
        await pgError(
          as(louis, (c) =>
            c.query(
              'UPDATE public.things SET deleted_at = NULL, trash_batch_id = NULL WHERE id = $1',
              [part],
            ),
          ),
        )
      ).constraint,
    ).toBe('things_merged_restore');
    await as(louis, (c) =>
      c.query(
        `UPDATE public.things SET deleted_at = NULL, trash_batch_id = NULL, merged_into_id = NULL
          WHERE id = $1`,
        [part],
      ),
    );
    await merge(drill);
    // The trash purge: the part goes, its loan stays, on the drill.
    await asSystem((c) => c.query(`SELECT kept.purge_trash(now() + interval '1 day', 100)`));
    expect(await own('SELECT id FROM public.things WHERE id = $1', [part])).toEqual([]);
    expect(
      await own('SELECT thing_id, split_from_thing_id FROM public.loans WHERE id = $1', [loan]),
    ).toEqual([{ thing_id: drill, split_from_thing_id: null }]);
  });
});
