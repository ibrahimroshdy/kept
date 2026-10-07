import http from 'node:http';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import { createLocation, type Loc, own as ownOf } from '../../test/things.js';

// Brand logos (step-4 T9; D157, D172; Q33; 0057, 0058): an account's admins set one from a PNG,
// JPEG, WebP or SVG, and Kept keeps only the PNG it renders; whoever sees the brand reads it.
// The SVG cases follow the step-4 T0 spike: nothing referenced outside the upload is fetched.

let db: TestDb;
let t: TestApp;
let ibrahim: Person;
let bruce: Person;
let louis: Person;
let alfred: Person;
let home: Loc;
let brand: string;
let hits = 0;
let server: http.Server;
let origin = '';

const own = <T extends import('pg').QueryResultRow>(text: string, values: unknown[] = []) =>
  ownOf<T>(db, text, values);
const putLogo = (as: Person, body: Buffer, type = 'image/png', id = brand) =>
  call(t, `/api/v1/brands/${id}/logo`, {
    as,
    method: 'PUT',
    body,
    headers: { 'content-type': type },
  });
const getLogo = (as: Person) => call(t, `/api/v1/brands/${brand}/logo`, { as });

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db);
  ibrahim = await person(t, db, 'ibrahim');
  bruce = await person(t, db, 'bruce');
  louis = await person(t, db, 'louis');
  alfred = await person(t, db, 'alfred');
  home = await createLocation(t, db, ibrahim, 'household', 'Home');
  await join(db, home.id, bruce.userId, 'admin');
  await join(db, home.id, louis.userId, 'member');
  const [row] = await own<{ id: string }>(
    `INSERT INTO public.brands (owner_account_id, name) VALUES ($1, 'Toshiba') RETURNING id`,
    [home.accountId],
  );
  brand = row?.id as string;
  // A recorder standing in for anywhere an SVG might point.
  server = http.createServer((_req, res) => {
    hits += 1;
    res.end('x');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const red = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 3, background: '#c00' } })
    .jpeg()
    .toBuffer();

describe('brand logos', () => {
  // catalogue: PUT /api/v1/brands/:id/logo
  it('an admin sets one from a JPEG; it is kept as a PNG of at most 256 px, audited', async () => {
    // The brand says whether it has one, so its page asks for no logo it would get a 404 for.
    const brandOf = async () => (await call(t, `/api/v1/brands/${brand}`, { as: louis })).json();
    expect(await brandOf()).toMatchObject({ hasLogo: false });
    const res = await putLogo(bruce, await red(800, 400), 'image/jpeg');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ brandId: brand, width: 256, height: 128 });
    const got = await getLogo(louis);
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect((await sharp(got.rawPayload).metadata()).format).toBe('png');
    expect(await brandOf()).toMatchObject({ hasLogo: true });
    const again = await call(t, `/api/v1/brands/${brand}/logo`, {
      as: louis,
      headers: { 'if-none-match': got.headers.etag as string },
    });
    expect(again.statusCode).toBe(304);
    const events = await own<{ action: string; location_id: string | null; actor_id: string }>(
      `SELECT action, location_id, actor_id FROM public.audit_events WHERE entity_id = $1`,
      [brand],
    );
    expect(events).toEqual([
      { action: 'brand.logo_set', location_id: null, actor_id: bruce.userId },
    ]);
  });

  it("refuses a member (403), someone who can't see the brand (404), and what isn't an image (415)", async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#000' } })
      .png()
      .toBuffer();
    expect((await putLogo(louis, png)).statusCode).toBe(403);
    expect((await putLogo(alfred, png)).statusCode).toBe(404);
    expect((await getLogo(alfred)).statusCode).toBe(404);
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
    expect((await putLogo(bruce, pdf, 'image/png')).statusCode).toBe(415);
  });

  it('renders an SVG to a PNG without fetching anything it points at, and keeps no SVG', async () => {
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
            width="512" height="512">
         <style>@import url("${origin}/x.css");</style>
         <circle cx="256" cy="256" r="200" fill="#0a6"/>
         <image href="${origin}/img.png" width="100" height="100"/>
         <use xlink:href="${origin}/sprite.svg#a"/>
       </svg>`,
    );
    const res = await putLogo(ibrahim, svg, 'image/svg+xml');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ width: 256, height: 256 });
    expect(hits).toBe(0);
    const [row] = await own<{ head: string }>(
      `SELECT encode(substr(png, 1, 8), 'hex') AS head FROM public.brand_logos WHERE brand_id = $1`,
      [brand],
    );
    expect(row?.head).toBe('89504e470d0a1a0a');
    // An external entity is refused, as is a canvas past the pixel limit.
    const entity = Buffer.from(
      `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY ext SYSTEM "${origin}/e">]>
       <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text>&ext;</text></svg>`,
    );
    expect((await putLogo(ibrahim, entity, 'image/svg+xml')).statusCode).toBe(415);
    const huge = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100000" height="100000"></svg>',
    );
    expect((await putLogo(ibrahim, huge, 'image/svg+xml')).statusCode).toBe(415);
    expect(hits).toBe(0);
  });

  // catalogue: DELETE /api/v1/brands/:id/logo
  it('an admin removes it; then there is none', async () => {
    expect(
      (await call(t, `/api/v1/brands/${brand}/logo`, { as: louis, method: 'DELETE' })).statusCode,
    ).toBe(403);
    const res = await call(t, `/api/v1/brands/${brand}/logo`, { as: bruce, method: 'DELETE' });
    expect(res.statusCode, res.body).toBe(204);
    expect((await getLogo(louis)).statusCode).toBe(404);
    expect((await call(t, `/api/v1/brands/${brand}`, { as: louis })).json()).toMatchObject({
      hasLogo: false,
    });
    const [removed] = await own<{ actor_id: string }>(
      `SELECT actor_id FROM public.audit_events
        WHERE entity_id = $1 AND action = 'brand.logo_remove'`,
      [brand],
    );
    expect(removed?.actor_id).toBe(bruce.userId);
  });
});
