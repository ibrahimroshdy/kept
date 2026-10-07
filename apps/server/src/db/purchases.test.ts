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
import { diffRows } from '../audit/audited.js';
import { type Scope, withScope } from './scope.js';

// Task 7: purchases and lines (engineering spec §1.4, §7.2, §7.13; D13, D115; plan Q2).

const db = await testDb();
const app = db.pools.app;

beforeEach(async () => {
  await db.reset();
});

const as = (userId: string, mfa = false): Scope => ({ userId, mfa });

async function q<T extends pg.QueryResultRow = Record<string, unknown>>(
  scope: Scope,
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  return withScope(app, scope, async (_tx, client) => (await client.query<T>(text, values)).rows);
}

/** A purchase with one line in `locationId`, as kept_owner. Returns the line's id. */
async function purchaseLine(locationId: string, vendorId: string | null = null) {
  const purchase = newId();
  const line = newId();
  await ownerTx(db, async (c) => {
    await c.query(
      `INSERT INTO public.purchases (id, location_id, vendor_id, purchased_on, currency, total, tax)
       VALUES ($1, $2, $3, '2026-09-01', 'EGP', 1200.5, 14)`,
      [purchase, locationId, vendorId],
    );
    await c.query(
      `INSERT INTO public.purchase_lines (id, location_id, purchase_id, description, unit_price)
       VALUES ($1, $2, $3, 'Phone', 1200.5)`,
      [line, locationId, purchase],
    );
  });
  return { purchase, line };
}

async function thing(t: { locationId: string; unplacedId: string }, userId: string, line?: string) {
  const id = newId();
  await q(
    as(userId),
    `INSERT INTO public.things (id, location_id, place_id, name, purchase_line_id)
     VALUES ($1, $2, $3, 'Phone', $4)`,
    [id, t.locationId, t.unplacedId, line ?? null],
  );
  return id;
}

describe('purchase lines on things (D115)', () => {
  let a: Tenant;
  let b: Tenant;
  beforeEach(async () => {
    a = await seedTenant(db, 'a');
    b = await seedTenant(db, 'b');
  });

  it("refuses B's line, a line in another of A's locations, and a random id alike (42501)", async () => {
    const theirs = await purchaseLine(b.locationId);
    const second = await ownerTx(db, (c) => insertLocation(c, a, { name: 'Flat' }));
    const elsewhere = await purchaseLine(second.locationId);
    for (const line of [theirs.line, elsewhere.line, newId()]) {
      const err = await pgError(thing(a, a.userId, line));
      expect(err).toMatchObject({ code: '42501', constraint: 'things_purchase_line' });
    }
    const mine = await purchaseLine(a.locationId);
    await thing(a, a.userId, mine.line);
  });

  it('keeps the line across a move, readable through kept.thing_purchase() by the new location only', async () => {
    const flat = await ownerTx(db, (c) => insertLocation(c, a, { name: 'Flat' }));
    const { purchase, line } = await purchaseLine(a.locationId);
    const phone = await thing(a, a.userId, line);
    const flatMember = await seedUser(db, 'flat-member');
    await addMember(db, flat.locationId, flatMember, 'member');
    // Moved as kept_owner (the move definer is task 9's).
    await ownerTx(db, (c) =>
      c.query('UPDATE public.things SET location_id = $1, place_id = $2 WHERE id = $3', [
        flat.locationId,
        flat.unplacedId,
        phone,
      ]),
    );
    const read = (userId: string) =>
      q(
        as(userId),
        `SELECT purchase_id, line_id, total::text, currency, visible_purchase
           FROM kept.thing_purchase($1)`,
        [phone],
      );
    expect(await read(flatMember)).toEqual([
      {
        purchase_id: purchase,
        line_id: line,
        // Only the thing's own line: the purchase's total (and tax) are the purchase location's
        // (D115, security review I3).
        total: null,
        currency: 'EGP',
        visible_purchase: false,
      },
    ]);
    expect(await read(a.userId)).toMatchObject([{ visible_purchase: true, total: '1200.5000' }]);
    // Nothing for someone who can't see the thing.
    expect(await read(b.userId)).toEqual([]);
    // The member can't open the purchase itself.
    expect(
      await q(as(flatMember), 'SELECT id FROM public.purchases WHERE id = $1', [purchase]),
    ).toEqual([]);
  });

  it('clears the link when the line is deleted', async () => {
    const { purchase, line } = await purchaseLine(a.locationId);
    const phone = await thing(a, a.userId, line);
    await q(as(a.userId), 'DELETE FROM public.purchases WHERE id = $1', [purchase]);
    const { rows } = await asOwner(db, (c) =>
      c.query('SELECT purchase_line_id FROM public.things WHERE id = $1', [phone]),
    );
    expect(rows).toEqual([{ purchase_line_id: null }]);
  });
});

describe('purchases', () => {
  it('refuses a vendor of another account (42501), and money without a currency', async () => {
    const a = await seedTenant(db, 'a');
    const b = await seedTenant(db, 'b');
    const theirs = newId();
    await ownerTx(db, (c) =>
      c.query(`INSERT INTO public.vendors (id, owner_account_id, name) VALUES ($1, $2, 'Shop')`, [
        theirs,
        b.accountId,
      ]),
    );
    const insert = (vendor: string | null, currency: string | null) =>
      q(
        as(a.userId),
        `INSERT INTO public.purchases (location_id, vendor_id, purchased_on, currency, total)
         VALUES ($1, $2, '2026-09-01', $3, 10)`,
        [a.locationId, vendor, currency],
      );
    expect(await pgError(insert(theirs, 'EGP'))).toMatchObject({
      code: '42501',
      constraint: 'purchases_vendor_account',
    });
    expect(await pgError(insert(null, null))).toMatchObject({
      code: '23514',
      constraint: 'purchases_money_chk',
    });
    await insert(null, 'EGP');
  });

  it('classes the money columns as money in the audit diff (D13)', () => {
    const purchase = diffRows(
      'purchase',
      { total: '1', tax: '0', notes: 'a' },
      {
        total: '2',
        tax: '1',
        notes: 'b',
      },
    );
    expect(purchase.total?.class).toBe('money');
    expect(purchase.tax?.class).toBe('money');
    expect(purchase.notes?.class).toBe('plain');
    const line = diffRows('purchase_line', { unitPrice: '1' }, { unitPrice: '2' });
    expect(line.unit_price?.class).toBe('money');
  });
});
