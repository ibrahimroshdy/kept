import { newId, warrantyEnds } from '@kept/shared';
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

// Step-4 T5 (0050, 0051): warranties, claims, loans and service records under row-level security,
// their guards, the thing's state bump, moves across locations and accounts, and a loan counting
// as a use of its person (engineering spec §1.6, §1.7, §7.13; D10, D53–D57, D172, D177; plan Q1,
// Q14–Q18, Q26).

const db = await testDb();
vi.setConfig({ testTimeout: 60_000 });

let ibrahim: Tenant; // owns Home
let garage: { locationId: string; unplacedId: string };
let bruce: string; // admin of Home
let louis: string; // member of Home
let talia: string; // viewer of Home
let alfred: Tenant; // owns بيت العائلة; Ibrahim is a member there
let drill: string;
let murdock: string; // a person of Ibrahim's account
let centre: string; // a vendor of Ibrahim's account

const as = <T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  withScope(db.pools.app, { userId, mfa: true }, (_tx, c) => fn(c));
const own = <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(sql, values)).rows);
const count = (userId: string, sql: string, values: unknown[] = []) =>
  as(userId, async (c) => (await c.query(sql, values)).rowCount ?? 0);
const versions = async (thingId: string) =>
  (
    await own<{ state_version: number; row_version: number }>(
      'SELECT state_version, row_version FROM public.things WHERE id = $1',
      [thingId],
    )
  )[0];

beforeEach(async () => {
  await db.reset();
  ibrahim = await seedTenant(db, 'rec-ibrahim');
  garage = await ownerTx(db, (c) =>
    insertLocation(c, { userId: ibrahim.userId, accountId: ibrahim.accountId }, { name: 'Garage' }),
  );
  bruce = await seedUser(db, 'rec-bruce');
  await addMember(db, ibrahim.locationId, bruce, 'admin');
  louis = await seedUser(db, 'rec-louis');
  await addMember(db, ibrahim.locationId, louis, 'member');
  talia = await seedUser(db, 'rec-talia');
  await addMember(db, ibrahim.locationId, talia, 'viewer');
  alfred = await seedTenant(db, 'rec-alfred', { name: 'بيت العائلة' });
  await addMember(db, alfred.locationId, ibrahim.userId, 'member');
  drill = newId();
  murdock = newId();
  centre = newId();
  await own(
    `INSERT INTO public.things (id, location_id, place_id, name) VALUES ($1, $2, $3, 'Drill')`,
    [drill, ibrahim.locationId, ibrahim.unplacedId],
  );
  await own(
    `INSERT INTO public.people (id, owner_account_id, display_name) VALUES ($1, $2, 'Murdock')`,
    [murdock, ibrahim.accountId],
  );
  await own(
    `INSERT INTO public.vendors (id, owner_account_id, name) VALUES ($1, $2, 'Service Centre')`,
    [centre, ibrahim.accountId],
  );
});

const addWarranty = (userId: string, over: Record<string, unknown> = {}) =>
  as(userId, async (c) => {
    const v = { thing: drill, startsOn: '2026-01-15', termMonths: 24, ...over };
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO public.warranties (location_id, thing_id, kind, starts_on, term_months,
                                      created_by)
       VALUES ($1, $2, 'manufacturer', $3, $4, $5) RETURNING id`,
      [ibrahim.locationId, v.thing, v.startsOn, v.termMonths, userId],
    );
    return rows[0]?.id as string;
  });
const addClaim = (userId: string, over: Record<string, unknown> = {}) =>
  as(userId, async (c) => {
    const v = { thing: drill, warranty: null, vendor: centre, status: 'open', ...over };
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO public.claims (location_id, thing_id, warranty_id, opened_on, vendor_id, status,
                                  created_by)
       VALUES ($1, $2, $3, '2026-09-20', $4, $5, $6) RETURNING id`,
      [ibrahim.locationId, v.thing, v.warranty, v.vendor, v.status, userId],
    );
    return rows[0]?.id as string;
  });
const lend = (userId: string, over: Record<string, unknown> = {}) =>
  as(userId, async (c) => {
    const v = { thing: drill, person: murdock, location: ibrahim.locationId, ...over };
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO public.loans (location_id, thing_id, direction, person_id, started_at, due_on,
                                 created_by)
       VALUES ($1, $2, 'out', $3, now(), current_date + 7, $4) RETURNING id`,
      [v.location, v.thing, v.person, userId],
    );
    return rows[0]?.id as string;
  });

describe('warranties (D53, D55)', () => {
  it('end where @kept/shared warrantyEnds() says, inclusive, clamping month ends (Q27)', async () => {
    const cases = [
      { startsOn: '2026-10-01', termMonths: 24 },
      { startsOn: '2026-01-31', termMonths: 1 },
      { startsOn: '2024-02-29', termMonths: 12 },
      { startsOn: '2023-03-31', termMonths: 11 },
      { startsOn: '2027-12-31', termMonths: 2 },
      { startsOn: '2026-05-10', endsOn: '2027-05-09' },
      { startsOn: '2026-05-10', lifetime: true },
    ];
    for (const w of cases) {
      const [row] = await own<{ e: string | null }>(
        `INSERT INTO public.warranties (location_id, thing_id, kind, starts_on, ends_on,
                                        term_months, lifetime, created_by)
         VALUES ($1, $2, 'extended', $3, $4, $5, $6, $7) RETURNING effective_ends_on::text AS e`,
        [
          ibrahim.locationId,
          drill,
          w.startsOn,
          w.endsOn ?? null,
          w.termMonths ?? null,
          w.lifetime ?? false,
          ibrahim.userId,
        ],
      );
      const expected = warrantyEnds(w);
      expect(row?.e ?? 'lifetime', JSON.stringify(w)).toBe(expected);
    }
  });

  it('take exactly one of an end date, a term or lifetime', async () => {
    const bad = await pgError(
      own(
        `INSERT INTO public.warranties (location_id, thing_id, kind, starts_on, ends_on, term_months,
                                        created_by)
         VALUES ($1, $2, 'store', '2026-01-01', '2027-01-01', 12, $3)`,
        [ibrahim.locationId, drill, ibrahim.userId],
      ),
    );
    expect(bad.constraint).toBe('warranties_term_chk');
  });

  it('are written by members, read by viewers, and invisible to another household', async () => {
    const id = await addWarranty(louis);
    expect((await pgError(addWarranty(talia))).code).toBe('42501');
    expect(await count(talia, 'SELECT 1 FROM public.warranties WHERE id = $1', [id])).toBe(1);
    expect(await count(alfred.userId, 'SELECT 1 FROM public.warranties WHERE id = $1', [id])).toBe(
      0,
    );
    expect(
      (
        await pgError(
          as(louis, (c) =>
            c.query('UPDATE public.warranties SET thing_id = thing_id WHERE id = $1', [id]),
          ),
        )
      ).code,
    ).toBe('42501');
  });

  it('D10: need a thing of quantity 1, and hold it there (Q26: "Split it first")', async () => {
    const cables = newId();
    await own(
      `INSERT INTO public.things (id, location_id, place_id, name, quantity)
       VALUES ($1, $2, $3, 'Cables', 5)`,
      [cables, ibrahim.locationId, ibrahim.unplacedId],
    );
    expect((await pgError(addWarranty(louis, { thing: cables }))).constraint).toBe(
      'warranties_quantity_one',
    );
    await addWarranty(louis);
    expect(
      (
        await pgError(
          as(louis, (c) => c.query('UPDATE public.things SET quantity = 2 WHERE id = $1', [drill])),
        )
      ).constraint,
    ).toBe('things_quantity_one');
  });
});

describe('claims (D54, D195; Q18)', () => {
  it('move through CLAIM_TRANSITIONS; a closed claim reopens only through undo', async () => {
    const id = await addClaim(louis);
    const setStatus = (status: string, closed: string | null, undo = false) =>
      as(louis, async (c) => {
        if (undo) await c.query(`SELECT set_config('app.undo', 'on', true)`);
        await c.query('UPDATE public.claims SET status = $2, closed_on = $3 WHERE id = $1', [
          id,
          status,
          closed,
        ]);
      });
    await setStatus('in_repair', null);
    await setStatus('resolved', '2026-09-25');
    expect((await pgError(setStatus('open', null))).constraint).toBe('claims_transition');
    await setStatus('open', null, true);
    expect(await own('SELECT status FROM public.claims WHERE id = $1', [id])).toEqual([
      { status: 'open' },
    ]);
    expect((await pgError(setStatus('resolved', null))).constraint).toBe('claims_closed_chk');
  });

  it('allow one repair at a time per thing, and only its own warranty', async () => {
    await addClaim(louis, { status: 'in_repair' });
    expect((await pgError(addClaim(louis, { status: 'in_repair' }))).constraint).toBe(
      'claims_one_repair_uq',
    );
    const other = newId();
    await own(
      `INSERT INTO public.things (id, location_id, place_id, name) VALUES ($1, $2, $3, 'TV')`,
      [other, ibrahim.locationId, ibrahim.unplacedId],
    );
    const tvWarranty = await addWarranty(louis, { thing: other });
    expect((await pgError(addClaim(louis, { warranty: tvWarranty }))).constraint).toBe(
      'claims_warranty_thing',
    );
  });

  it('refuse a vendor of another account like a missing one (§7.13)', async () => {
    const theirs = newId();
    await own(`INSERT INTO public.vendors (id, owner_account_id, name) VALUES ($1, $2, 'Shop')`, [
      theirs,
      alfred.accountId,
    ]);
    const refused = await pgError(addClaim(louis, { vendor: theirs }));
    expect(refused).toMatchObject({ code: '42501', constraint: 'claims_vendor_account' });
  });
});

describe('loans (D56, D57, D172)', () => {
  it('one open loan per thing; a person of the location account only', async () => {
    await lend(louis);
    expect((await pgError(lend(louis))).constraint).toBe('loans_one_open_uq');
    const theirs = newId();
    await own(
      `INSERT INTO public.people (id, owner_account_id, display_name) VALUES ($1, $2, 'Peter')`,
      [theirs, alfred.accountId],
    );
    const ladder = newId();
    await own(
      `INSERT INTO public.things (id, location_id, place_id, name) VALUES ($1, $2, $3, 'Ladder')`,
      [ladder, ibrahim.locationId, ibrahim.unplacedId],
    );
    expect(await pgError(lend(louis, { thing: ladder, person: theirs }))).toMatchObject({
      code: '42501',
      constraint: 'loans_person_account',
    });
    expect((await pgError(lend(talia, { thing: ladder }))).code).toBe('42501');
  });

  it("bump the thing's state_version, not its row_version, on a real change only", async () => {
    const before = await versions(drill);
    const loan = await lend(louis);
    const lent = await versions(drill);
    expect(lent?.state_version).toBe((before?.state_version ?? 0) + 1);
    expect(lent?.row_version).toBe(before?.row_version);
    await as(louis, (c) =>
      c.query(`UPDATE public.loans SET notes = 'charger too' WHERE id = $1`, [loan]),
    );
    expect((await versions(drill))?.state_version).toBe(lent?.state_version);
    await as(louis, (c) =>
      c.query('UPDATE public.loans SET returned_at = now() WHERE id = $1', [loan]),
    );
    expect((await versions(drill))?.state_version).toBe((lent?.state_version ?? 0) + 1);
    // A claim going in repair too.
    const claim = await addClaim(louis);
    await as(louis, (c) =>
      c.query(`UPDATE public.claims SET status = 'in_repair' WHERE id = $1`, [claim]),
    );
    expect((await versions(drill))?.state_version).toBe((lent?.state_version ?? 0) + 3);
    expect((await versions(drill))?.row_version).toBe(before?.row_version);
  });

  it("make the person's contact details an admin's of every location they are used in (D177)", async () => {
    const visible = (userId: string) =>
      as(userId, async (c) => {
        const { rows } = await c.query<{ v: boolean }>(
          'SELECT kept.person_contact_visible($1) AS v',
          [murdock],
        );
        return rows[0]?.v;
      });
    // Used nowhere: any admin of the account's locations sees them.
    expect(await visible(bruce)).toBe(true);
    // Lent something in the Garage, where Bruce isn't admin: no longer his to see.
    const saw = newId();
    await own(
      `INSERT INTO public.things (id, location_id, place_id, name) VALUES ($1, $2, $3, 'Saw')`,
      [saw, garage.locationId, garage.unplacedId],
    );
    await lend(ibrahim.userId, { thing: saw, location: garage.locationId });
    expect(await visible(bruce)).toBe(false);
    expect(await visible(ibrahim.userId)).toBe(true);
  });
});

describe('service records (§7.1; Q1)', () => {
  const log = (userId: string) =>
    as(userId, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO public.service_records (location_id, thing_id, serviced_on, vendor_id, total,
                                             currency, logged_by)
         VALUES ($1, $2, '2026-09-10', $3, 350, 'EGP', $4) RETURNING id`,
        [ibrahim.locationId, drill, centre, userId],
      );
      const id = rows[0]?.id as string;
      await c.query(
        `INSERT INTO public.service_lines (location_id, service_record_id, kind, description)
         VALUES ($1, $2, 'labour', 'Brushes replaced')`,
        [ibrahim.locationId, id],
      );
      return id;
    });

  it("are their logger's or an admin's to change, with their lines", async () => {
    const id = await log(louis);
    const other = await seedUser(db, 'rec-member');
    await addMember(db, ibrahim.locationId, other, 'member');
    const touch = (userId: string) =>
      count(userId, `UPDATE public.service_records SET notes = 'x' WHERE id = $1`, [id]);
    const touchLine = (userId: string) =>
      count(userId, `UPDATE public.service_lines SET sort = 1 WHERE service_record_id = $1`, [id]);
    expect(await touch(other)).toBe(0);
    expect(await touchLine(other)).toBe(0);
    expect(await touch(louis)).toBe(1);
    expect(await touchLine(bruce)).toBe(1);
    expect(
      await count(talia, 'SELECT 1 FROM public.service_lines WHERE service_record_id = $1', [id]),
    ).toBe(1);
    expect(await count(other, 'DELETE FROM public.service_records WHERE id = $1', [id])).toBe(0);
    expect(await count(bruce, 'DELETE FROM public.service_records WHERE id = $1', [id])).toBe(1);
  });

  it('take a thing or a place, never both, and money with its currency', async () => {
    expect(
      (
        await pgError(
          own(
            `INSERT INTO public.service_records (location_id, thing_id, place_id, serviced_on,
                                                 logged_by)
             VALUES ($1, $2, $3, current_date, $4)`,
            [ibrahim.locationId, drill, ibrahim.unplacedId, ibrahim.userId],
          ),
        )
      ).constraint,
    ).toBe('service_records_subject_chk');
    expect(
      (
        await pgError(
          own(
            `INSERT INTO public.service_records (location_id, place_id, serviced_on, total, logged_by)
             VALUES ($1, $2, current_date, 10, $3)`,
            [ibrahim.locationId, ibrahim.unplacedId, ibrahim.userId],
          ),
        )
      ).constraint,
    ).toBe('service_records_money_chk');
  });
});

describe('kept.move_things() with household records (Q17)', () => {
  const move = (userId: string, to: string, place: string) =>
    as(userId, async (c) => {
      const { rows } = await c.query<{
        thing_id: string;
        from_location: string;
        dropped_link_ids: string[];
        dropped_incident_ids: string[];
      }>('SELECT * FROM kept.move_things($1, $2, $3, NULL)', [[drill], to, place]);
      return rows;
    });

  it('refuses a thing on loan or in repair', async () => {
    const loan = await lend(louis);
    expect(
      (await pgError(move(ibrahim.userId, garage.locationId, garage.unplacedId))).constraint,
    ).toBe('things_move_open_loan');
    await own('UPDATE public.loans SET returned_at = now() WHERE id = $1', [loan]);
    await addClaim(louis, { status: 'in_repair' });
    expect(
      (await pgError(move(ibrahim.userId, garage.locationId, garage.unplacedId))).constraint,
    ).toBe('things_move_in_repair');
  });

  it('carries its history to another account, people and vendors copied; it leaves its incidents', async () => {
    const warranty = await addWarranty(louis);
    const claim = await addClaim(louis, { warranty });
    await as(louis, (c) =>
      c.query(
        `UPDATE public.claims SET status = 'resolved', closed_on = '2026-09-25' WHERE id = $1`,
        [claim],
      ),
    );
    const loan = await lend(louis);
    await own('UPDATE public.loans SET returned_at = now(), return_place_id = $2 WHERE id = $1', [
      loan,
      ibrahim.unplacedId,
    ]);
    const incident = newId();
    await own(
      `INSERT INTO public.incidents (id, location_id, kind, occurred_on, created_by)
       VALUES ($1, $2, 'flood', '2026-09-01', $3)`,
      [incident, ibrahim.locationId, ibrahim.userId],
    );
    await own(
      `INSERT INTO public.incident_things (location_id, incident_id, thing_id) VALUES ($1, $2, $3)`,
      [ibrahim.locationId, incident, drill],
    );
    await own('UPDATE public.claims SET incident_id = $2 WHERE id = $1', [claim, incident]);
    const service = newId();
    await own(
      `INSERT INTO public.service_records (id, location_id, thing_id, serviced_on, vendor_id,
                                           logged_by)
       VALUES ($1, $2, $3, '2026-09-10', $4, $5)`,
      [service, ibrahim.locationId, drill, centre, louis],
    );
    const file = newId();
    await own(
      `INSERT INTO public.files (id, location_id, storage_key, sha256, bytes, mime, class,
                                 derivative_state, created_by)
       VALUES ($1, $2, $3, $4, 10, 'application/pdf', 'document', 'ready', $5)`,
      [file, ibrahim.locationId, `f/${ibrahim.locationId}/${file}`, 'a'.repeat(64), louis],
    );
    await own(
      `INSERT INTO public.attachments (location_id, file_id, warranty_id, role, created_by)
       VALUES ($1, $2, $3, 'warranty_doc', $4)`,
      [ibrahim.locationId, file, warranty, louis],
    );

    const [moved] = await move(ibrahim.userId, alfred.locationId, alfred.unplacedId);
    expect(moved?.dropped_incident_ids).toEqual([incident]);
    const rows = await own<{ t: string; location_id: string; ref: string | null }>(
      `SELECT 'warranty' AS t, location_id, NULL::uuid::text AS ref FROM public.warranties WHERE id = $1
       UNION ALL
       SELECT 'claim', location_id, incident_id::text FROM public.claims WHERE id = $2
       UNION ALL
       SELECT 'loan', location_id, return_place_id::text FROM public.loans WHERE id = $3
       UNION ALL
       SELECT 'service', location_id, NULL FROM public.service_records WHERE id = $4
       ORDER BY 1`,
      [warranty, claim, loan, service],
    );
    expect(rows).toEqual([
      { t: 'claim', location_id: alfred.locationId, ref: null },
      { t: 'loan', location_id: alfred.locationId, ref: null },
      { t: 'service', location_id: alfred.locationId, ref: null },
      { t: 'warranty', location_id: alfred.locationId, ref: null },
    ]);
    // Murdock and the service centre, copied into Alfred's account.
    const names = await own<{ who: string; account: string }>(
      `SELECT p.display_name AS who, p.owner_account_id AS account
         FROM public.loans o JOIN public.people p ON p.id = o.person_id WHERE o.id = $1
       UNION ALL
       SELECT v.name, v.owner_account_id
         FROM public.claims k JOIN public.vendors v ON v.id = k.vendor_id WHERE k.id = $2
       UNION ALL
       SELECT v.name, v.owner_account_id
         FROM public.service_records s JOIN public.vendors v ON v.id = s.vendor_id WHERE s.id = $3`,
      [loan, claim, service],
    );
    expect(names).toEqual([
      { who: 'Murdock', account: alfred.accountId },
      { who: 'Service Centre', account: alfred.accountId },
      { who: 'Service Centre', account: alfred.accountId },
    ]);
    expect(await own('SELECT 1 FROM public.incident_things WHERE thing_id = $1', [drill])).toEqual(
      [],
    );
    // The warranty's document is re-homed as the thing's own files are (D161).
    expect(
      await own<{ location_id: string }>(
        `SELECT f.location_id FROM public.attachments a JOIN public.files f ON f.id = a.file_id
          WHERE a.warranty_id = $1`,
        [warranty],
      ),
    ).toEqual([{ location_id: alfred.locationId }]);
  });
});
