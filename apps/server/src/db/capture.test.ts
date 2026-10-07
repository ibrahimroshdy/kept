import { createHash } from 'node:crypto';
import { newId } from '@kept/shared';
import type pg from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../../test/db.js';
import {
  addMember,
  insertLocation,
  ownerTx,
  pgError,
  seedTenant,
  seedUser,
  type Tenant,
} from '../../test/tenancy.js';
import { withScope } from './scope.js';

// Step-3 T5: extractions, the inbox, templates, imports and file text (engineering spec §1.5,
// §1.8, §7.2, §7.8; D18, D36, D77, D177; plan Q10, Q15, Q17).

const db = await testDb();

let t: Tenant;
let member: string;
let viewer: string;
let thing: string;
let photo: string;

const as = <T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  withScope(db.pools.app, { userId, mfa: true }, (_tx, c) => fn(c));
const own = <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(sql, values)).rows);

async function insertFile(
  c: pg.ClientBase,
  locationId: string,
  createdBy: string,
  mime = 'image/jpeg',
): Promise<string> {
  const file = newId();
  await c.query(
    `INSERT INTO public.files (id, location_id, storage_key, sha256, bytes, mime, class,
                               derivative_state, created_by)
     VALUES ($1, $2, $3, $4, 10, $5, $6, 'ready', $7)`,
    [
      file,
      locationId,
      `f/${locationId}/${file}`,
      createHash('sha256').update(file).digest('hex'),
      mime,
      mime === 'application/pdf' ? 'document' : 'photo',
      createdBy,
    ],
  );
  return file;
}

beforeEach(async () => {
  await db.reset();
  t = await seedTenant(db, 'capture-ibrahim');
  member = await seedUser(db, 'capture-alfred');
  await addMember(db, t.locationId, member, 'member');
  viewer = await seedUser(db, 'capture-bruce');
  await addMember(db, t.locationId, viewer, 'viewer');
  thing = newId();
  photo = newId();
  await ownerTx(db, async (c) => {
    await c.query(
      `INSERT INTO public.things (id, location_id, place_id, review_state)
       VALUES ($1, $2, $3, 'draft')`,
      [thing, t.locationId, t.unplacedId],
    );
    const file = await insertFile(c, t.locationId, member);
    await c.query(
      `INSERT INTO public.attachments (id, location_id, file_id, thing_id, role, created_by)
       VALUES ($1, $2, $3, $4, 'photo', $5)`,
      [photo, t.locationId, file, thing, member],
    );
  });
});

const queue = (userId: string, attempt: number) =>
  as(userId, (c) =>
    c.query(
      `INSERT INTO public.extractions (location_id, attachment_id, thing_id, mode, attempt,
                                       requested_by)
       VALUES ($1, $2, $3, 'thing', $4, $5)`,
      [t.locationId, photo, thing, attempt, userId],
    ),
  );

describe('extractions', () => {
  it('allow one live attempt per attachment', async () => {
    await queue(member, 1);
    expect((await pgError(queue(member, 2))).code).toBe('23505');
    await as(member, (c) => c.query(`UPDATE public.extractions SET status = 'succeeded'`));
    await queue(member, 2);
  });

  it('are queued by writers as themselves, never by a viewer', async () => {
    expect((await pgError(queue(viewer, 1))).code).toBe('42501');
    expect(
      (
        await pgError(
          as(member, (c) =>
            c.query(
              `INSERT INTO public.extractions (location_id, attachment_id, mode, requested_by)
               VALUES ($1, $2, 'thing', $3)`,
              [t.locationId, photo, t.userId],
            ),
          ),
        )
      ).code,
    ).toBe('42501');
  });
});

describe('inbox_items', () => {
  it('are for members and above: a viewer sees none', async () => {
    await as(member, (c) =>
      c.query(
        `INSERT INTO public.inbox_items (location_id, kind, thing_id, created_by)
         VALUES ($1, 'draft', $2, $3)`,
        [t.locationId, thing, member],
      ),
    );
    expect((await as(t.userId, (c) => c.query('SELECT 1 FROM public.inbox_items'))).rowCount).toBe(
      1,
    );
    expect((await as(viewer, (c) => c.query('SELECT 1 FROM public.inbox_items'))).rowCount).toBe(0);
  });

  it('hold one open item per kind and subject', async () => {
    const add = () =>
      as(member, (c) =>
        c.query(
          `INSERT INTO public.inbox_items (location_id, kind, thing_id, created_by)
           VALUES ($1, 'draft', $2, $3)`,
          [t.locationId, thing, member],
        ),
      );
    await add();
    expect((await pgError(add())).code).toBe('23505');
    await as(member, (c) =>
      c.query(`UPDATE public.inbox_items SET resolved_at = now(), resolution = 'accepted'`),
    );
    await add();
  });
});

describe('templates (D177, Q17)', () => {
  let second: { locationId: string };
  let template: string;
  let admin: string;

  beforeEach(async () => {
    second = await ownerTx(db, (c) =>
      insertLocation(c, { userId: t.userId, accountId: t.accountId }, { name: 'Cottage' }),
    );
    admin = await seedUser(db, 'capture-louis');
    await addMember(db, t.locationId, admin, 'admin');
    template = newId();
    await as(t.userId, async (c) => {
      await c.query(
        `INSERT INTO public.templates (id, owner_account_id, name, created_by)
         VALUES ($1, $2, 'Power tool', $3)`,
        [template, t.accountId, t.userId],
      );
      await c.query(
        `INSERT INTO public.template_locations (template_id, owner_account_id, location_id)
         VALUES ($1, $2, $3)`,
        [template, t.accountId, t.locationId],
      );
    });
  });

  const rename = (userId: string) =>
    as(
      userId,
      async (c) =>
        (await c.query(`UPDATE public.templates SET name = 'Tool' WHERE id = $1`, [template]))
          .rowCount,
    );

  it('a member uses one shared with their location, but can’t edit it', async () => {
    expect((await as(member, (c) => c.query('SELECT name FROM public.templates'))).rows).toEqual([
      { name: 'Power tool' },
    ]);
    expect(await rename(member)).toBe(0);
    expect((await as(viewer, (c) => c.query('SELECT 1 FROM public.templates'))).rowCount).toBe(0);
  });

  it('an admin of only one of its two locations can’t edit it', async () => {
    expect(await rename(admin)).toBe(1);
    await as(t.userId, (c) =>
      c.query(
        `INSERT INTO public.template_locations (template_id, owner_account_id, location_id)
         VALUES ($1, $2, $3)`,
        [template, t.accountId, second.locationId],
      ),
    );
    expect(await rename(admin)).toBe(0);
    expect(await rename(t.userId)).toBe(1);
  });

  it("refuses another account's type, and a location of another account", async () => {
    const other = await seedTenant(db, 'capture-talia');
    const otherType = newId();
    await own(
      `INSERT INTO public.types (id, owner_account_id, name, icon) VALUES ($1, $2, 'Talia gadget',
         'lucide:box')`,
      [otherType, other.accountId],
    );
    expect(
      (
        await pgError(
          as(t.userId, (c) =>
            c.query(`UPDATE public.templates SET type_id = $1 WHERE id = $2`, [
              otherType,
              template,
            ]),
          ),
        )
      ).code,
    ).toBe('42501');
    expect(
      (
        await pgError(
          as(t.userId, (c) =>
            c.query(
              `INSERT INTO public.template_locations (template_id, owner_account_id, location_id)
               VALUES ($1, $2, $3)`,
              [template, t.accountId, other.locationId],
            ),
          ),
        )
      ).code,
    ).toBe('42501');
  });
});

describe('file_text (§7.2)', () => {
  it('follows its file: invisible to others until an attachment makes the file visible', async () => {
    const pdf = await ownerTx(db, (c) => insertFile(c, t.locationId, member, 'application/pdf'));
    await as(member, (c) =>
      c.query(
        `INSERT INTO public.file_text (file_id, location_id, source, text)
         VALUES ($1, $2, 'pdf', 'Warranty card for the drill')`,
        [pdf, t.locationId],
      ),
    );
    const read = (userId: string) =>
      as(userId, async (c) => ({
        rows: (await c.query('SELECT file_id FROM public.file_text')).rowCount,
        search: (
          await c.query(
            `SELECT * FROM kept.search_file_ids(to_tsquery('simple', 'warranty'), NULL)`,
          )
        ).rowCount,
      }));
    expect(await read(member)).toEqual({ rows: 1, search: 1 });
    expect(await read(viewer)).toEqual({ rows: 0, search: 0 });
    await own(
      `INSERT INTO public.attachments (location_id, file_id, thing_id, role, created_by)
       VALUES ($1, $2, $3, 'warranty_doc', $4)`,
      [t.locationId, pdf, thing, member],
    );
    expect(await read(viewer)).toEqual({ rows: 1, search: 1 });
    const other = await seedTenant(db, 'capture-peter');
    expect(await read(other.userId)).toEqual({ rows: 0, search: 0 });
  });
});

describe('draft purchases (Q10)', () => {
  it('may lack a date only while a draft', async () => {
    const insert = (state: string) =>
      as(member, (c) =>
        c.query(
          `INSERT INTO public.purchases (location_id, review_state, created_by)
           VALUES ($1, $2, $3)`,
          [t.locationId, state, member],
        ),
      );
    await insert('draft');
    expect((await pgError(insert('confirmed'))).constraint).toBe('purchases_dated_chk');
  });
});

describe('imports (§7.1)', () => {
  it('are for owners and admins only', async () => {
    const start = (userId: string) =>
      as(userId, (c) =>
        c.query(
          `INSERT INTO public.import_runs (location_id, source, created_by) VALUES ($1, 'csv', $2)`,
          [t.locationId, userId],
        ),
      );
    await start(t.userId);
    expect((await pgError(start(member))).code).toBe('42501');
    expect((await as(member, (c) => c.query('SELECT 1 FROM public.import_runs'))).rowCount).toBe(0);
  });
});
