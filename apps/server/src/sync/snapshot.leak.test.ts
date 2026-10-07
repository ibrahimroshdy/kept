import { newId, type SnapshotPage } from '@kept/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { testDb } from '../../test/db.js';
import { fillCapture } from '../../test/leak-capture.js';
import { fillInventory } from '../../test/leak-inventory.js';
import { addMember, ownerTx, seedTenant, seedUser, type Tenant } from '../../test/tenancy.js';
import { withScope } from '../db/scope.js';
import { type CursorState, FIRST_SYNC } from './cursor.js';
import { snapshotPage } from './snapshot.js';

// The snapshot's leak test (plan T12; engineering spec §7.2; D36, D159, D178). Two tenants,
// filled as the schema-wide leak test fills them (test/leak.test.ts fillTenant: step 2's and
// step 3's fixture rows), plus a tombstone of every kind the phone is sent. Tenant A's owner and
// a viewer of A pull A's snapshot on kept_app, in full and as a delta from the oldest watermark
// (which reads every tombstone), and nothing of B's may be in it: no id, no name, no code. And
// nothing of money, secrets, documents, notes or contact details for anyone (D36, D159, Q21).

const db = await testDb();

let a: Tenant;
let b: Tenant;
let viewer: string;
const ids: Record<'a' | 'b', string[]> = { a: [], b: [] };

async function fill(t: Tenant, label: string): Promise<void> {
  await ownerTx(db, async (c) => {
    const room = newId();
    await c.query('INSERT INTO public.places (id, location_id, name) VALUES ($1, $2, $3)', [
      room,
      t.locationId,
      `${label} room`,
    ]);
    await c.query(
      `INSERT INTO public.location_modules (location_id, module, enabled) VALUES ($1, 'money', true)`,
      [t.locationId],
    );
    await fillInventory(c, t, label, room);
    await fillCapture(c, t, label);
    // A tombstone of every kind the phone is sent, and one it never is. A code's and a legacy
    // code's carry their text key, and its hash as the id (0046).
    for (const kind of ['thing', 'place', 'thing_link']) {
      await c.query(
        'INSERT INTO public.sync_tombstones (location_id, entity_type, entity_id) VALUES ($1, $2, $3)',
        [t.locationId, kind, newId()],
      );
    }
    for (const [kind, key] of [
      ['code', `${label.toUpperCase().slice(-6)}`],
      ['legacy_code', `${t.locationId}:own::${label.toUpperCase()}-GONE`],
    ]) {
      await c.query(
        `INSERT INTO public.sync_tombstones (location_id, entity_type, entity_id, entity_key)
         VALUES ($1, $2, md5($3)::uuid, $3)`,
        [t.locationId, kind, key],
      );
    }
  });
}

/** Everything of a tenant a leak could carry: ids of its synced rows, codes, and its names. */
async function footprint(t: Tenant): Promise<string[]> {
  return ownerTx(db, async (c) => {
    const { rows } = await c.query<{ v: string }>(
      `SELECT id::text AS v FROM public.things WHERE location_id = $1
       UNION ALL SELECT id::text FROM public.places WHERE location_id = $1
       UNION ALL SELECT code::text FROM public.short_ids WHERE location_id = $1
       UNION ALL SELECT code FROM public.legacy_codes WHERE location_id = $1
       UNION ALL SELECT entity_id::text FROM public.sync_tombstones WHERE location_id = $1
       UNION ALL SELECT entity_key FROM public.sync_tombstones
                  WHERE location_id = $1 AND entity_key IS NOT NULL
       UNION ALL SELECT id::text FROM public.types WHERE owner_account_id = $2
       UNION ALL SELECT $1::text`,
      [t.locationId, t.accountId],
    );
    return rows.map((r) => r.v);
  });
}

async function pull(userId: string, from: CursorState): Promise<SnapshotPage[]> {
  const pages: SnapshotPage[] = [];
  let state = from;
  for (let i = 0; i < 100; i++) {
    const r = await withScope(db.pools.app, { userId, mfa: true }, (_tx, c) =>
      snapshotPage(c, state, { limit: 7 }),
    );
    pages.push({ ...r.page, nextCursor: '' });
    state = r.next;
    if (r.page.complete) return pages;
  }
  throw new Error('the snapshot never completed');
}

beforeAll(async () => {
  await db.reset();
  a = await seedTenant(db, 'tenantalpha');
  b = await seedTenant(db, 'tenantbeta');
  await fill(a, 'tenantalpha');
  await fill(b, 'tenantbeta');
  viewer = await seedUser(db, 'talia');
  await addMember(db, a.locationId, viewer, 'viewer');
  ids.a = await footprint(a);
  ids.b = await footprint(b);
});

/** A delta from the oldest possible watermark: every row and every tombstone of A's. */
const fromTheStart = (): CursorState => ({ v: 1, w: { [a.locationId]: '1' }, p: null });

describe.each([
  ['the owner', () => a.userId],
  ['a viewer', () => viewer],
])('the snapshot of A, as %s', (_who, userOf) => {
  it.each([
    ['in full', () => FIRST_SYNC],
    ['as a delta with every tombstone', fromTheStart],
  ])('%s, never holds anything of B', async (_how, stateOf) => {
    const pages = await pull(userOf(), stateOf());
    const json = JSON.stringify(pages);
    for (const v of ids.b) expect(json, v).not.toContain(v);
    expect(json).not.toMatch(/tenantbeta/i);
    // And it does hold A's: the check can see a leak.
    expect(json).toContain('tenantalpha thing');
    expect(json).toContain(a.locationId);
  });

  it('has no money, secret, document, note or contact field', async () => {
    const pages = await pull(userOf(), fromTheStart());
    const keys = new Set<string>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          keys.add(k);
          walk(x);
        }
      }
    };
    walk(pages);
    const forbidden = [...keys].filter((k) =>
      /price|amount|currency|cost|money|secret|custom|notes|serial|document|receipt|email|phone|address|contact|person/i.test(
        k,
      ),
    );
    expect(forbidden).toEqual([]);
    // The tombstones reach the phone, those of kinds it knows only.
    const removed = pages.flatMap((p) => p.removed);
    expect(new Set(removed.map((r) => r.entityType))).toEqual(
      new Set(['thing', 'place', 'code', 'legacy_code']),
    );
    expect(removed.every((r) => r.locationId === a.locationId)).toBe(true);
  });
});

it('shows B nothing of A either, and A and B only themselves', async () => {
  const pages = await pull(b.userId, FIRST_SYNC);
  const json = JSON.stringify(pages);
  for (const v of ids.a) expect(json, v).not.toContain(v);
  expect(pages[0]?.locations.map((l) => l.id)).toEqual([b.locationId]);
});

it('gives a person with no membership an empty snapshot', async () => {
  const stranger = await seedUser(db, 'stranger');
  const pages = await pull(stranger, fromTheStart());
  expect(pages).toHaveLength(1);
  expect(pages[0]).toMatchObject({
    locations: [],
    changes: { places: [], things: [], codes: [], legacyCodes: [] },
    removed: [],
    // A's watermark in the cursor is a location this person can't see: named as revoked.
    revokedLocationIds: [a.locationId],
    complete: true,
  });
  expect(ids.a.some((v) => JSON.stringify(pages[0]?.changes).includes(v))).toBe(false);
});
