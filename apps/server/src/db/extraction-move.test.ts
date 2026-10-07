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

// 0074 (step 5, T8 and T10): an extraction follows its photo onto a new attachment, so the old
// attachment's delete no longer cascades it away; only its requester or an admin moves it, and
// only onto an attachment of the same location.

const db = await testDb();
vi.setConfig({ testTimeout: 60_000 });

let ibrahim: Tenant; // owns Home and Garage
let garage: string;
let bruce: string; // admin of Home
let louis: string; // member of Home: asked for the reading
let alfred: string; // member of Home
let odometer: string; // Louis's photo of the Corolla's odometer
let onReading: string; // the same photo, now on the reading
let inGarage: string;
let extraction: string;

const own = <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(sql, values)).rows);
const move = (userId: string, attachmentId: string) =>
  withScope(
    db.pools.app,
    { userId, mfa: true },
    async (_tx, c) =>
      (
        await c.query('UPDATE public.extractions SET attachment_id = $2 WHERE id = $1', [
          extraction,
          attachmentId,
        ])
      ).rowCount,
  );
const attachment = async (locationId: string, thingId: string, name: string) =>
  (
    await own<{ id: string }>(
      `INSERT INTO public.attachments (location_id, url, thing_id, role, created_by)
       VALUES ($1, $2, $3, 'photo', $4) RETURNING id`,
      [locationId, `https://example.test/${name}.jpg`, thingId, ibrahim.userId],
    )
  )[0]?.id as string;

beforeEach(async () => {
  await db.reset();
  ibrahim = await seedTenant(db, 'mv-ibrahim', { name: 'Home' });
  const g = await ownerTx(db, (c) => insertLocation(c, ibrahim, { name: 'Garage' }));
  garage = g.locationId;
  bruce = await seedUser(db, 'mv-bruce');
  await addMember(db, ibrahim.locationId, bruce, 'admin');
  louis = await seedUser(db, 'mv-louis');
  await addMember(db, ibrahim.locationId, louis, 'member');
  alfred = await seedUser(db, 'mv-alfred');
  await addMember(db, ibrahim.locationId, alfred, 'member');
  const corolla = newId();
  const jack = newId();
  await own(
    `INSERT INTO public.things (id, location_id, place_id, name)
     VALUES ($1, $2, $3, 'Corolla'), ($4, $5, $6, 'Jack')`,
    [corolla, ibrahim.locationId, ibrahim.unplacedId, jack, garage, g.unplacedId],
  );
  odometer = await attachment(ibrahim.locationId, corolla, 'odometer');
  onReading = await attachment(ibrahim.locationId, corolla, 'odometer-reading');
  inGarage = await attachment(garage, jack, 'jack');
  extraction = (
    await own<{ id: string }>(
      `INSERT INTO public.extractions (location_id, attachment_id, mode, status, requested_by)
       VALUES ($1, $2, 'reading', 'succeeded', $3) RETURNING id`,
      [ibrahim.locationId, odometer, louis],
    )
  )[0]?.id as string;
});

describe('moving an extraction onto its photo’s new attachment (0074)', () => {
  it('lets its requester move it, and then the old attachment goes without it', async () => {
    expect(await move(louis, onReading)).toBe(1);
    await own('DELETE FROM public.attachments WHERE id = $1', [odometer]);
    expect(
      await own('SELECT attachment_id FROM public.extractions WHERE id = $1', [extraction]),
    ).toEqual([{ attachment_id: onReading }]);
  });

  it('lets an admin of the location move it, and no other member', async () => {
    expect(await pgError(move(alfred, onReading))).toMatchObject({
      code: '42501',
      constraint: 'extractions_attachment_move',
    });
    expect(await move(bruce, onReading)).toBe(1);
  });

  it('refuses an attachment of another location like one that does not exist', async () => {
    expect(await pgError(move(louis, inGarage))).toMatchObject({
      code: '42501',
      constraint: 'extractions_attachment_move',
    });
    expect((await pgError(move(louis, newId()))).code).toBe('42501');
  });
});

describe('the output cap a retry runs at (0095)', () => {
  it('its requester sets it, within bounds', async () => {
    const set = (cap: number) =>
      withScope(db.pools.app, { userId: louis, mfa: true }, (_tx, c) =>
        c.query('UPDATE public.extractions SET output_cap = $2 WHERE id = $1', [extraction, cap]),
      );
    expect((await set(4096)).rowCount).toBe(1);
    expect((await pgError(set(10))).constraint).toBe('extractions_output_cap_chk');
  });
});
