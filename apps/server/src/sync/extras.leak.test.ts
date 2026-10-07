import { beforeAll, describe, expect, it } from 'vitest';
import { testDb } from '../../test/db.js';
import { fillInventory } from '../../test/leak-inventory.js';
import { addMember, ownerTx, seedTenant, seedUser, type Tenant } from '../../test/tenancy.js';
import { type Scope, withScope } from '../db/scope.js';
import { extrasEstimate, extrasPage } from './extras.js';

// The keep-offline extras' leak test (step-8 plan T12; engineering spec §7.2; D36, D159). Two
// tenants filled as the schema-wide leak test fills them (test/leak-inventory.ts: a purchase with
// a receipt, a person with contact details, a secret value), with money on. Tenant A's owner and
// a viewer of A read A's extras on kept_app, every page and the estimate, and nothing of B's may
// be in them; for anyone, no secret value, no contact detail, no vendor. B's location is a 404.

const db = await testDb();

let a: Tenant;
let b: Tenant;
let viewer: string;

/** Everything of B's a leak could carry, and what must never leave for anyone. */
let footprintB: string[] = [];
let never: string[] = [];

async function fill(t: Tenant, label: string): Promise<void> {
  await ownerTx(db, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO public.places (location_id, name) VALUES ($1, $2) RETURNING id`,
      [t.locationId, `${label} room`],
    );
    await c.query(
      `INSERT INTO public.location_modules (location_id, module, enabled)
       VALUES ($1, 'money', true)
       ON CONFLICT (location_id, module) DO UPDATE SET enabled = true`,
      [t.locationId],
    );
    await fillInventory(c, t, label, rows[0]?.id as string);
  });
}

async function footprint(t: Tenant): Promise<string[]> {
  return ownerTx(db, async (c) => {
    const { rows } = await c.query<{ v: string }>(
      `SELECT id::text AS v FROM public.things WHERE location_id = $1
       UNION ALL SELECT id::text FROM public.files WHERE location_id = $1
       UNION ALL SELECT id::text FROM public.attachments WHERE location_id = $1
       UNION ALL SELECT sha256::text FROM public.files WHERE location_id = $1
       UNION ALL SELECT $1::text`,
      [t.locationId],
    );
    return rows.map((r) => r.v);
  });
}

/** Secret ciphertext, contact details and vendor names: never in an extras answer. */
async function forbidden(): Promise<string[]> {
  return ownerTx(db, async (c) => {
    const { rows } = await c.query<{ v: string }>(
      `SELECT ciphertext::text AS v FROM public.secret_values
       UNION ALL SELECT name FROM public.vendors WHERE owner_account_id IS NOT NULL
       UNION ALL SELECT display_name FROM public.people
       UNION ALL SELECT phone FROM public.person_contacts WHERE phone IS NOT NULL
                   AND char_length(phone) > 3`,
    );
    return rows.map((r) => r.v);
  });
}

const as = (userId: string): Scope => ({ userId, mfa: true });

async function everything(userId: string, locationId: string): Promise<string> {
  const scope = as(userId);
  return withScope(db.pools.app, scope, async (tx, c) => {
    const pages: unknown[] = [];
    let after: string | null = null;
    for (let i = 0; i < 100; i++) {
      const r = await extrasPage(tx, c, scope, locationId, after, 1);
      pages.push(r);
      if (r.next === null) break;
      after = r.next;
    }
    pages.push(await extrasEstimate(tx, c, scope, locationId));
    return JSON.stringify(pages);
  });
}

beforeAll(async () => {
  await db.reset();
  a = await seedTenant(db, 'tenantalpha');
  b = await seedTenant(db, 'tenantbeta');
  await fill(a, 'tenantalpha');
  await fill(b, 'tenantbeta');
  viewer = await seedUser(db, 'talia');
  await addMember(db, a.locationId, viewer, 'viewer');
  footprintB = await footprint(b);
  never = await forbidden();
}, 120_000);

describe.each([
  ['the owner', () => a.userId],
  ['a viewer', () => viewer],
])('the extras of A, as %s', (_who, userOf) => {
  it('never hold anything of B, nor a secret, a contact or a vendor', async () => {
    const json = await everything(userOf(), a.locationId);
    for (const v of footprintB) expect(json, v).not.toContain(v);
    expect(json).not.toMatch(/tenantbeta/i);
    for (const v of never) expect(json, v).not.toContain(v);
    // And they do hold A's: the check can see a leak.
    expect(json).toContain('2026-09-01');
  });

  it("are a 404 for B's location", async () => {
    const scope = as(userOf());
    await expect(
      withScope(db.pools.app, scope, (tx, c) => extrasPage(tx, c, scope, b.locationId, null)),
    ).rejects.toMatchObject({ status: 404 });
  });
});

it("gives A's owner the receipt with its money, and the viewer neither", async () => {
  const owner = JSON.parse(await everything(a.userId, a.locationId)) as {
    items?: { purchase: { price: string | null } | null; documents: { kind: string }[] }[];
  }[];
  const items = owner.flatMap((p) => p.items ?? []);
  expect(items.some((x) => x.purchase?.price === '100')).toBe(true);
  expect(items.flatMap((x) => x.documents).some((d) => d.kind === 'receipt')).toBe(true);
  const seen = JSON.parse(await everything(viewer, a.locationId)) as typeof owner;
  const theirs = seen.flatMap((p) => p.items ?? []);
  expect(theirs.length).toBeGreaterThan(0);
  expect(theirs.every((x) => x.purchase?.price == null && x.documents.length === 0)).toBe(true);
});
