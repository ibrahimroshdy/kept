import { newId } from '@kept/shared';
import type pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

// Step-7 T6 (0085): converting a field to secret, back, or to another kind, through the account
// owner's three doors (D172, D177, plan Q20).

const db = await testDb();
vi.setConfig({ testTimeout: 60_000 });

let alfred: Tenant; // owns بيت العائلة, and a second location
let garage: string;
let bruce: string; // admin of بيت العائلة, not the account owner
let doorType: string;
let doorCode: string; // a text field, made secret below
let size: string; // a text field of sizes, made a number below
const things: Record<string, string> = {};

const SEALED = { v: 1, kv: 1, dek: 'ZGVr', iv: 'aXY=', ct: 'Y3Q=', tag: 'dGFn' };

const as = <T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  withScope(db.pools.app, { userId, mfa: true }, (_tx, c) => fn(c));
const own = <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(sql, values)).rows);

const preview = (userId: string, field: string, to: object) =>
  as(
    userId,
    async (c) =>
      (
        await c.query<{
          location_id: string;
          values: number;
          convertible: number;
          to_notes: number;
        }>('SELECT * FROM kept.field_conversion_preview($1, $2)', [field, JSON.stringify(to)])
      ).rows,
  );
const rows = (userId: string, field: string) =>
  as(
    userId,
    async (c) =>
      (
        await c.query<{ subject_kind: string; subject_id: string; value: unknown }>(
          'SELECT * FROM kept.field_conversion_rows($1, NULL, 100)',
          [field],
        )
      ).rows,
  );
const apply = (userId: string, field: string, to: object, batch: object[], finish = true) =>
  as(
    userId,
    async (c) =>
      (
        await c.query<{ n: number }>('SELECT kept.apply_field_conversion($1, $2, $3, $4) AS n', [
          field,
          JSON.stringify(to),
          JSON.stringify(batch),
          finish,
        ])
      ).rows[0]?.n,
  );

beforeEach(async () => {
  await db.reset();
  alfred = await seedTenant(db, 'conv-alfred', { name: 'بيت العائلة' });
  garage = await ownerTx(
    db,
    async (c) =>
      (
        await insertLocation(
          c,
          { userId: alfred.userId, accountId: alfred.accountId },
          { name: 'Garage' },
        )
      ).locationId,
  );
  bruce = await seedUser(db, 'conv-bruce');
  await addMember(db, alfred.locationId, bruce, 'admin');
  doorType = newId();
  doorCode = newId();
  size = newId();
  await own(
    `INSERT INTO public.types (id, owner_account_id, name, icon) VALUES ($1, $2, 'Door', 'lucide:door-open')`,
    [doorType, alfred.accountId],
  );
  await own(
    `INSERT INTO public.type_fields (id, owner_account_id, type_id, key, label, kind)
     VALUES ($1, $3, $4, 'door_code', 'Door code', 'text'), ($2, $3, $4, 'size', 'Size', 'text')`,
    [doorCode, size, alfred.accountId, doorType],
  );
  const garageUnplaced = (
    await own<{ id: string }>(
      'SELECT id FROM public.places WHERE location_id = $1 AND is_unplaced',
      [garage],
    )
  )[0]?.id;
  for (const [name, loc, place, custom] of [
    ['front', alfred.locationId, alfred.unplacedId, { door_code: '1234', size: '12' }],
    ['back', alfred.locationId, alfred.unplacedId, { door_code: '5678', size: 'about 12' }],
    ['shed', garage, garageUnplaced, { door_code: '9999' }],
  ] as const) {
    things[name] = newId();
    await own(
      `INSERT INTO public.things (id, location_id, place_id, name, type_id, custom)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [things[name], loc, place, name, doorType, JSON.stringify(custom)],
    );
  }
  await own(
    `INSERT INTO public.audit_events (location_id, owner_account_id, actor_type, actor_id, action,
                                      entity_type, entity_id, diff)
     VALUES ($1, $2, 'user', $3, 'update', 'thing', $4,
             '{"custom.door_code": {"before": "1111", "after": "1234", "class": "plain"},
               "name": {"before": "a", "after": "front", "class": "plain"}}')`,
    [alfred.locationId, alfred.accountId, alfred.userId, things.front],
  );
});

describe('field conversion (D172, D177, plan Q20)', () => {
  it('previews per location, counts only', async () => {
    const p = await preview(alfred.userId, doorCode, { toSecret: true });
    expect(p.map((r) => [r.location_id, r.values, r.convertible, r.to_notes]).sort()).toEqual(
      [
        [alfred.locationId, 2, 2, 0],
        [garage, 1, 1, 0],
      ].sort(),
    );
  });

  it("is the account owner's alone: an admin is refused at every door", async () => {
    expect((await pgError(preview(bruce, doorCode, { toSecret: true }))).code).toBe('42501');
    expect((await pgError(rows(bruce, doorCode))).code).toBe('42501');
    expect((await pgError(apply(bruce, doorCode, { toSecret: true }, []))).code).toBe('42501');
  });

  it('to secret: values move to the secret store, custom and past diffs lose them, and back', async () => {
    const values = await rows(alfred.userId, doorCode);
    expect(values.map((v) => v.value).sort()).toEqual(['1234', '5678', '9999']);
    const sealed = values.map((v) => ({
      subjectKind: v.subject_kind,
      subjectId: v.subject_id,
      id: newId(),
      ciphertext: SEALED,
      keyVersion: 1,
    }));
    expect(await apply(alfred.userId, doorCode, { toSecret: true }, sealed)).toBe(3);

    const [field] = await own<{ secret: boolean }>(
      'SELECT secret FROM public.type_fields WHERE id = $1',
      [doorCode],
    );
    expect(field?.secret).toBe(true);
    const left = await own<{ n: string }>(
      `SELECT count(*) AS n FROM public.things WHERE custom ? 'door_code'`,
    );
    expect(Number(left[0]?.n)).toBe(0);
    const stored = await own<{ n: string }>(
      `SELECT count(*) AS n FROM public.secret_values
        WHERE type_field_id = $1 AND superseded_at IS NULL AND ciphertext IS NOT NULL`,
      [doorCode],
    );
    expect(Number(stored[0]?.n)).toBe(3);
    const [event] = await own<{ diff: Record<string, unknown> }>(
      `SELECT diff FROM public.audit_events WHERE entity_id = $1 AND actor_type = 'user'`,
      [things.front],
    );
    expect(event?.diff['custom.door_code']).toEqual({ changed: true, class: 'secret' });
    expect(event?.diff.name).toEqual({ before: 'a', after: 'front', class: 'plain' });
    const [doc] = await own<{ tsv: string | null }>(
      'SELECT search_tsv::text AS tsv FROM public.things WHERE id = $1',
      [things.front],
    );
    expect(doc?.tsv ?? '').not.toContain('1234');

    // And back to plain text, with the opened values.
    const back = (await rows(alfred.userId, doorCode)).map((v, i) => ({
      subjectKind: v.subject_kind,
      subjectId: v.subject_id,
      value: `code-${i}`,
    }));
    expect(back).toHaveLength(3);
    expect(await apply(alfred.userId, doorCode, { toSecret: false }, back)).toBe(3);
    const plain = await own<{ n: string }>(
      `SELECT count(*) AS n FROM public.things WHERE custom ? 'door_code'`,
    );
    expect(Number(plain[0]?.n)).toBe(3);
    const erased = await own<{ n: string }>(
      `SELECT count(*) AS n FROM public.secret_values
        WHERE type_field_id = $1 AND ciphertext IS NOT NULL`,
      [doorCode],
    );
    expect(Number(erased[0]?.n)).toBe(0);
  });

  it('keeps the guard outside the door', async () => {
    const app = as(alfred.userId, (c) =>
      c.query('UPDATE public.type_fields SET secret = true WHERE id = $1', [doorCode]),
    );
    expect((await pgError(app)).code).toBe('42501');
    const owner = own('UPDATE public.type_fields SET secret = true WHERE id = $1', [doorCode]);
    expect(await pgError(owner)).toMatchObject({
      code: '23514',
      constraint: 'type_fields_secret_fixed',
    });
  });

  it('to a number: "12" converts, "about 12" goes to the notes', async () => {
    const p = await preview(alfred.userId, size, { kind: 'number' });
    expect(p).toMatchObject([
      { location_id: alfred.locationId, values: 2, convertible: 1, to_notes: 1 },
    ]);
    expect(
      await apply(alfred.userId, size, { kind: 'number', unit: 'cm' }, [
        { subjectKind: 'thing', subjectId: things.front, value: 12 },
        { subjectKind: 'thing', subjectId: things.back, toNotes: true },
      ]),
    ).toBe(2);
    const [field] = await own<{ kind: string; unit: string }>(
      'SELECT kind, unit FROM public.type_fields WHERE id = $1',
      [size],
    );
    expect(field).toEqual({ kind: 'number', unit: 'cm' });
    const got = await own<{ id: string; size: unknown; notes: string | null }>(
      `SELECT id, custom -> 'size' AS size, notes FROM public.things WHERE id = ANY ($1)`,
      [[things.front, things.back]],
    );
    const byId = Object.fromEntries(got.map((g) => [g.id, g]));
    expect(byId[things.front as string]?.size).toBe(12);
    expect(byId[things.back as string]).toMatchObject({ size: null, notes: 'Size: about 12' });
    // A number becomes nothing but text.
    expect((await pgError(preview(alfred.userId, size, { kind: 'date' }))).code).toBe('22023');
  });
});
