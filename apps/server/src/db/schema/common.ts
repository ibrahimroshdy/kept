import { sql } from 'drizzle-orm';
import { bigint, check, customType, integer, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// Column helpers shared by Kept's own tables (engineering spec §1, §7.4, §7.13).

/** UUIDv7 primary key; Postgres 18 fills it when the client didn't (D17: offline rows bring
 * their own). */
export const id = () => uuid('id').primaryKey().default(sql`uuidv7()`);

export const tstz = (name: string) => timestamp(name, { withTimezone: true });

/** Every mutable table (§1, §7.4). `kept.touch_row()` (migration 0000) sets `change_seq` on
 * insert and update and bumps `row_version`/`updated_at` on update; the trigger is attached
 * per table in the tenancy triggers migration. Append-only tables (§7.13) don't use this. */
export const mutable = () => ({
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
  rowVersion: integer('row_version').notNull().default(1),
  changeSeq: bigint('change_seq', { mode: 'bigint' }),
});

/** A 64-bit transaction id. Drizzle has no `xid8`, so it is a custom type (as `tsvector` is in
 * things.ts); the value reads back as its decimal string. */
const xid8 = customType<{ data: string }>({ dataType: () => 'xid8' });

/**
 * The sync watermark's column (step-3 plan Q1, engineering spec §7.4) on the five synced tables:
 * places, things, short_ids, sync_tombstones and legacy_codes. `kept.stamp_change_xid()` (0036)
 * sets it to the writing transaction's id whenever `change_seq` changes, so the snapshot can ask
 * for rows at or above a `pg_snapshot_xmin` horizon and never skip a late commit. Written only by
 * the trigger: no role holds UPDATE on it.
 */
export const changeXid = () => xid8('change_xid');

const ENUM_VALUE = /^[a-z][a-z0-9_]*$/;

/** An enum as `text` + CHECK (D183): adding a value is a constraint change, never an
 * `ALTER TYPE`. `col()` is the column; `check(table)` is its constraint, named
 * `<table>_<column>_chk`. */
export function textEnum<const T extends readonly [string, ...string[]]>(name: string, values: T) {
  for (const value of values) {
    if (!ENUM_VALUE.test(value)) throw new Error(`textEnum ${name}: bad value ${value}`);
  }
  // Safe to inline: every value matched ENUM_VALUE above.
  const list = sql.raw(values.map((v) => `'${v}'`).join(', '));
  return {
    values,
    col: () => text(name, { enum: values as unknown as [T[number], ...T[number][]] }),
    check: (table: string) =>
      check(`${table}_${name}_chk`, sql`${sql.identifier(name)} IN (${list})`),
  };
}

/** Whether a captured row still needs a person's review (things, purchases; D76, §7.8). */
export const REVIEW_STATES = ['draft', 'confirmed'] as const;
/** Where a row came from (§1.3). */
export const CREATED_VIA = ['app', 'mcp', 'assistant', 'import', 'email'] as const;
