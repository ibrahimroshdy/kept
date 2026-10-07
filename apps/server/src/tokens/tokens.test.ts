import { parseToken } from '@kept/shared';
import type { LightMyRequestResponse } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import {
  createLocation,
  createThing,
  type Json,
  type Loc,
  ok,
  own,
  setDisplayName,
} from '../../test/things.js';

// T10: personal tokens through the front door. Ibrahim owns Home and Garage; Bruce is an admin of
// Home and a member of Garage; Louis a member of both; Talia a viewer of Home.

const db: TestDb = await testDb();
let t: TestApp;
let ibrahim: Person;
let bruce: Person;
let louis: Person;
let talia: Person;
let home: Loc;
let garage: Loc;

beforeAll(async () => {
  await db.reset();
  // Token creation is https only (D181); the refusal over http is tested below.
  t = await peopleApp(db, { publicUrl: 'https://kept.example' });
  ibrahim = await person(t, db, 'ibrahim');
  bruce = await person(t, db, 'bruce');
  louis = await person(t, db, 'louis');
  talia = await person(t, db, 'talia');
  await setDisplayName(db, bruce, 'Bruce');
  home = await createLocation(t, db, ibrahim, 'complete');
  garage = await createLocation(t, db, ibrahim, 'essentials', 'Garage');
  await join(db, home.id, bruce.userId, 'admin');
  await join(db, garage.id, bruce.userId, 'member');
  await join(db, home.id, louis.userId, 'member');
  await join(db, garage.id, louis.userId, 'member');
  await join(db, home.id, talia.userId, 'viewer');
});

type Created = { token: Json & { rowVersion: number }; secret: string; clientConfigs: Json };

async function makeToken(
  who: Person,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Created> {
  const res = await call(t, '/api/v1/tokens', { as: who, body, headers });
  return ok(res, 201) as unknown as Created;
}

/** A request with the token only (no cookie). */
function bearer(
  secret: string,
  url: string,
  opts: {
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<LightMyRequestResponse> {
  return call(t, url, {
    ...opts,
    headers: { authorization: `Bearer ${secret}`, ...opts.headers },
  });
}

/** The person's own account-level token events (as kept_owner). */
function tokenAudit(who: Person) {
  return own<{ action: string; actor_type: string; entity_id: string; diff: unknown }>(
    db,
    `SELECT e.action, e.actor_type, e.entity_id, e.diff FROM public.audit_events e
      WHERE e.entity_type = 'api_token' AND e.actor_id = $1 ORDER BY e.at, e.id`,
    [who.userId],
  );
}

describe('tokens', () => {
  // catalogue: POST /api/v1/tokens
  it('makes a read token for one location: the secret once, client configs, audited without it', async () => {
    const made = await makeToken(
      bruce,
      { name: 'Home reader', scope: 'read', locationIds: [home.id] },
      { 'idempotency-key': 'token-create-1' },
    );
    expect(parseToken(made.secret)).not.toBeNull();
    expect(made.token).toMatchObject({
      kind: 'personal',
      name: 'Home reader',
      scope: 'read',
      locations: [{ id: home.id, name: 'Home' }],
      revokedAt: null,
    });
    expect(made.clientConfigs).toMatchObject({
      generic: { url: `${t.publicUrl}/mcp`, headers: { Authorization: `Bearer ${made.secret}` } },
    });
    const events = await tokenAudit(bruce);
    expect(events.at(-1)).toMatchObject({ action: 'token.create', entity_id: made.token.id });
    expect(JSON.stringify(events)).not.toContain(made.secret.slice(4));
    // Not in the idempotency row, a replay or a later list.
    const stored = await own<{ response: unknown }>(
      db,
      `SELECT response FROM public.idempotency_keys WHERE key = 'token-create-1'`,
    );
    expect(JSON.stringify(stored)).not.toContain(made.secret.slice(4));
    const replay = await call(t, '/api/v1/tokens', {
      as: bruce,
      body: { name: 'Home reader', scope: 'read', locationIds: [home.id] },
      headers: { 'idempotency-key': 'token-create-1' },
    });
    expect(replay.body).not.toContain(made.secret.slice(4));
    const list = ok(await call(t, '/api/v1/tokens', { as: bruce }));
    expect(JSON.stringify(list)).not.toContain(made.secret.slice(4));
    expect(JSON.stringify(list)).not.toMatch(/"hash"/);
  });

  it('reads with a read token, is refused writes and routes it is not open to, and sees only its locations', async () => {
    const thing = await createThing(t, ibrahim, home, { name: 'HDMI cable' });
    const elsewhere = await createThing(t, ibrahim, garage, { name: 'Drill' });
    const { secret } = await makeToken(bruce, {
      name: 'Reader',
      scope: 'read',
      locationIds: [home.id],
    });
    const list = ok(await bearer(secret, `/api/v1/things?locationId=${home.id}`));
    expect((list.items as Json[]).map((i) => i.name)).toContain('HDMI cable');
    expect((await bearer(secret, `/api/v1/things/${thing.id}`)).statusCode).toBe(200);
    // Bruce sees Garage himself; his Home token doesn't.
    expect((await call(t, `/api/v1/things/${elsewhere.id}`, { as: bruce })).statusCode).toBe(200);
    expect((await bearer(secret, `/api/v1/things/${elsewhere.id}`)).statusCode).toBe(404);
    const locs = ok(await bearer(secret, '/api/v1/locations')) as unknown as Json[] | Json;
    expect(JSON.stringify(locs)).not.toContain(garage.id);

    const write = await bearer(secret, '/api/v1/things', {
      body: { locationId: home.id, placeId: home.unplacedId, name: 'Kettle' },
    });
    expect(write.statusCode).toBe(403);
    expect(write.json()).toMatchObject({ code: 'token_scope' });
    // Never a token's: its person's settings, AI providers, tokens.
    for (const url of ['/api/v1/me', '/api/v1/ai/providers', '/api/v1/tokens']) {
      const res = await bearer(secret, url);
      expect(res.statusCode, url).toBe(403);
      expect(res.json()).toMatchObject({ code: 'token_scope' });
    }
    const mint = await bearer(secret, '/api/v1/tokens', {
      body: { name: 'Child', scope: 'read', locationIds: [home.id] },
    });
    expect(mint.statusCode).toBe(403);
  });

  it('refuses a token it does not know, and any other bearer value', async () => {
    const res = await bearer(`kpt_AAAAAAAA_${'A'.repeat(43)}`, '/api/v1/locations');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({
      code: 'token_revoked',
      hint: 'create a new token in Settings → Connections',
    });
    expect((await bearer('not-a-token', '/api/v1/locations')).statusCode).toBe(401);
  });

  // catalogue: DELETE /api/v1/tokens/:id
  it('revokes: the next call is 401 with the hint, and it is audited', async () => {
    const { token, secret } = await makeToken(louis, {
      name: 'Shortcut',
      scope: 'read',
      locationIds: [home.id],
    });
    expect((await bearer(secret, '/api/v1/locations')).statusCode).toBe(200);
    const del = await call(t, `/api/v1/tokens/${token.id}`, { as: louis, method: 'DELETE' });
    expect(del.statusCode).toBe(204);
    const events = await tokenAudit(louis);
    expect(events.at(-1)).toMatchObject({ action: 'token.revoke', entity_id: token.id });
    const after = await bearer(secret, '/api/v1/locations');
    expect(after.statusCode).toBe(401);
    expect(after.json()).toMatchObject({ code: 'token_revoked' });
    const row = ok(await call(t, '/api/v1/tokens', { as: louis }));
    expect((row.items as Json[]).find((r) => r.id === token.id)).toMatchObject({
      revokedReason: 'user',
    });
    // Someone else's token is a 404.
    const other = await makeToken(bruce, { name: 'Mine', scope: 'read', locationIds: [home.id] });
    expect(
      (await call(t, `/api/v1/tokens/${other.token.id}`, { as: louis, method: 'DELETE' }))
        .statusCode,
    ).toBe(404);
  });

  // catalogue: PATCH /api/v1/tokens/:id
  it('renames with If-Match, audited', async () => {
    const { token } = await makeToken(louis, {
      name: 'Old name',
      scope: 'read',
      locationIds: [home.id],
    });
    const stale = await call(t, `/api/v1/tokens/${token.id}`, {
      as: louis,
      method: 'PATCH',
      body: { name: 'New name' },
      headers: { 'if-match': String(token.rowVersion + 5) },
    });
    expect(stale.statusCode).toBe(412);
    const res = ok(
      await call(t, `/api/v1/tokens/${token.id}`, {
        as: louis,
        method: 'PATCH',
        body: { name: 'New name' },
        headers: { 'if-match': String(token.rowVersion) },
      }),
    );
    expect(res.name).toBe('New name');
    const events = await tokenAudit(louis);
    expect(events.at(-1)).toMatchObject({ action: 'token.update', entity_id: token.id });
  });

  it('keeps a token at or under its creator’s role, and warns before writing across differing member lists (D179)', async () => {
    const viewer = await call(t, '/api/v1/tokens', {
      as: talia,
      body: { name: 'Mine', scope: 'write', locationIds: [home.id] },
    });
    expect(viewer.statusCode).toBe(403);
    await makeToken(talia, { name: 'Mine', scope: 'read', locationIds: [home.id] });

    // Home has Talia, Garage doesn't: their member lists differ.
    const warned = ok(
      await call(t, '/api/v1/tokens', {
        as: louis,
        body: { name: 'Both', scope: 'write', locationIds: [home.id, garage.id] },
      }),
    );
    expect(warned).toEqual({ warning: 'cross_location_write' });
    const made = await makeToken(louis, {
      name: 'Both',
      scope: 'write',
      locationIds: [home.id, garage.id],
      confirmCrossLocation: true,
    });
    expect((made.token.locations as Json[]).map((l) => l.id).sort()).toEqual(
      [home.id, garage.id].sort(),
    );
    // A read token across them needs no warning.
    await makeToken(louis, {
      name: 'Both, read',
      scope: 'read',
      locationIds: [home.id, garage.id],
    });
    // A location the person isn't in is a 404.
    const outsider = await call(t, '/api/v1/tokens', {
      as: talia,
      body: { name: 'Garage', scope: 'read', locationIds: [garage.id] },
    });
    expect(outsider.statusCode).toBe(404);
  });

  it('writes as the token: audited as it, listed in recent changes, undone by its creator', async () => {
    const { token, secret } = await makeToken(louis, {
      name: 'Script',
      scope: 'write',
      locationIds: [home.id],
    });
    // A bearer request ignores the cookie it carries, and the CSRF check with it.
    const created = ok(
      await bearer(secret, `/api/v1/locations/${home.id}/places`, {
        body: { name: 'Shed', kindKey: 'room' },
        headers: { cookie: talia.cookie, origin: 'https://elsewhere.example' },
      }),
      201,
    ) as Json & { rowVersion: number };
    const renamed = ok(
      await bearer(secret, `/api/v1/places/${created.id}`, {
        method: 'PATCH',
        body: { name: 'Garden shed' },
        headers: { 'if-match': String(created.rowVersion) },
      }),
    );
    expect(renamed.name).toBe('Garden shed');
    const events = await own<{ actor_type: string; actor_id: string; action: string }>(
      db,
      'SELECT actor_type, actor_id, action FROM public.audit_events WHERE entity_id = $1 ORDER BY at',
      [created.id],
    );
    expect(events).toEqual([
      { actor_type: 'token', actor_id: token.id, action: 'place.create' },
      { actor_type: 'token', actor_id: token.id, action: 'place.update' },
    ]);

    const changes = ok(await call(t, '/api/v1/connections/changes', { as: louis }));
    const row = (changes.items as Json[]).find((c) => c.action === 'place.update');
    expect(row).toMatchObject({
      token: { id: token.id, name: 'Script', kind: 'personal' },
      actor: { type: 'token', id: token.id },
    });
    const undo = row?.undo as { eventId: string } | null;
    expect(undo?.eventId).toBeTruthy();
    // History and Activity name the token, never "Kept" (UI review steps 6–8, L3, 0105): its
    // creator reads its name, another member of the location "Louis (Script)".
    await setDisplayName(db, louis, 'Louis');
    const actorsOf = (page: Json) =>
      (page.items as Json[])
        .filter((e) => e.entity && (e.entity as Json).id === created.id)
        .map((e) => (e.actor as Json).displayName);
    expect(
      actorsOf(ok(await call(t, `/api/v1/places/${created.id}/history`, { as: louis }))),
    ).toEqual(['Script', 'Script']);
    expect(
      actorsOf(ok(await call(t, `/api/v1/places/${created.id}/history`, { as: talia }))),
    ).toEqual(['Louis (Script)', 'Louis (Script)']);
    expect(
      actorsOf(ok(await call(t, `/api/v1/activity?locationId=${home.id}`, { as: bruce }))),
    ).toEqual(['Louis (Script)', 'Louis (Script)']);
    // Only the creator's own tokens: Bruce sees none of Louis's.
    const theirs = ok(await call(t, '/api/v1/connections/changes', { as: bruce }));
    expect(JSON.stringify(theirs)).not.toContain(token.id);
    // Another token can't undo it; its creator can.
    const other = await makeToken(louis, {
      name: 'Other',
      scope: 'write',
      locationIds: [home.id],
    });
    const refused = await bearer(other.secret, `/api/v1/audit/${undo?.eventId}/undo`, {
      body: {},
    });
    expect(refused.statusCode).toBe(403);
    ok(await call(t, `/api/v1/audit/${undo?.eventId}/undo`, { as: louis, body: {} }));
    const again = ok(
      await call(t, `/api/v1/connections/changes?tokenId=${token.id}`, { as: louis }),
    );
    expect((again.items as Json[]).find((c) => c.action === 'place.update')?.undo).toBeNull();
  });

  // A thing's events fan out to audit_event_subjects, whose insert policy takes the token actor
  // since 0094.
  it('writes a thing as the token, its subjects included', async () => {
    const { token, secret } = await makeToken(louis, {
      name: 'Things',
      scope: 'write',
      locationIds: [home.id],
    });
    const thing = ok(
      await bearer(secret, '/api/v1/things', {
        body: { locationId: home.id, placeId: home.unplacedId, name: 'Torch' },
      }),
      201,
    );
    const events = await own<{ actor_type: string; actor_id: string }>(
      db,
      'SELECT actor_type, actor_id FROM public.audit_events WHERE entity_id = $1',
      [thing.id],
    );
    expect(events).toEqual([{ actor_type: 'token', actor_id: token.id }]);
  });

  it('names a thing’s brand: lists and creates brands, never edits or deletes them', async () => {
    // Creating a brand is an owner's or admin's (registries), so an admin's token can (Bruce
    // admins Home); a member's write token is refused, as its creator would be.
    const write = await makeToken(bruce, {
      name: 'Brands',
      scope: 'write',
      locationIds: [home.id],
    });
    const brands = `/api/v1/accounts/${home.accountId}/brands`;
    const made = ok(
      await bearer(write.secret, brands, { body: { name: 'Anker' } }),
      201,
    ) as unknown as {
      item: { id: string; name: string };
    };
    expect(made.item.name).toBe('Anker');
    const page = ok(await bearer(write.secret, `${brands}?q=Ank`)) as unknown as {
      items: { id: string }[];
    };
    expect(page.items.map((b) => b.id)).toContain(made.item.id);
    expect(ok(await bearer(write.secret, `/api/v1/brands/${made.item.id}`))).toMatchObject({
      name: 'Anker',
    });
    ok(
      await bearer(write.secret, '/api/v1/things', {
        body: {
          locationId: home.id,
          placeId: home.unplacedId,
          name: 'Power bank',
          brandId: made.item.id,
        },
      }),
      201,
    );
    const del = await bearer(write.secret, `/api/v1/brands/${made.item.id}`, { method: 'DELETE' });
    expect(del.statusCode).toBe(403);
    const read = await makeToken(louis, { name: 'Read', scope: 'read', locationIds: [home.id] });
    expect((await bearer(read.secret, brands)).statusCode).toBe(200);
    expect((await bearer(read.secret, brands, { body: { name: 'Sony' } })).statusCode).toBe(403);
    const member = await makeToken(louis, {
      name: 'Member',
      scope: 'write',
      locationIds: [home.id],
    });
    expect((await bearer(member.secret, brands, { body: { name: 'Sony' } })).statusCode).toBe(403);
  });

  it('dies with the creator’s role or membership, at the next call (D180)', async () => {
    const peter = await person(t, db, 'bruce-two');
    const membership = await join(db, home.id, peter.userId, 'member');
    const { secret: write } = await makeToken(peter, {
      name: 'Writer',
      scope: 'write',
      locationIds: [home.id],
    });
    const { token: readToken, secret: read } = await makeToken(peter, {
      name: 'Reader',
      scope: 'read',
      locationIds: [home.id],
    });
    expect((await bearer(write, '/api/v1/locations')).statusCode).toBe(200);
    // Dropping to viewer: the write token loses Home (its only location: revoked), no job.
    await own(db, `UPDATE public.memberships SET role = 'viewer' WHERE id = $1`, [membership]);
    expect((await bearer(write, '/api/v1/locations')).statusCode).toBe(401);
    expect((await bearer(read, '/api/v1/locations')).statusCode).toBe(200);
    // Leaving: the read token goes too.
    await own(db, 'DELETE FROM public.memberships WHERE id = $1', [membership]);
    expect((await bearer(read, '/api/v1/locations')).statusCode).toBe(401);
    const rows = await own<{ revoked_reason: string }>(
      db,
      'SELECT revoked_reason FROM public.api_tokens WHERE id = $1',
      [readToken.id],
    );
    expect(rows).toEqual([{ revoked_reason: 'membership_ended' }]);
  });

  it('limits a token to 120 reads a minute, with Retry-After', async () => {
    const { token, secret } = await makeToken(louis, {
      name: 'Busy',
      scope: 'read',
      locationIds: [home.id],
    });
    // This minute and the next are full, whichever the request lands in.
    await own(
      db,
      `INSERT INTO public.token_rate_windows (token_id, minute, kind, count)
       SELECT $1, date_trunc('minute', now()) + make_interval(mins => m), 'read', 120
         FROM generate_series(0, 1) AS m`,
      [token.id],
    );
    const res = await bearer(secret, '/api/v1/locations');
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });

  it('documents token access in the OpenAPI document', async () => {
    const doc = ok(await call(t, '/api/v1/openapi.json')) as unknown as {
      components: { securitySchemes: Record<string, unknown> };
      paths: Record<string, Record<string, { security?: unknown }>>;
    };
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({ scheme: 'bearer' });
    expect(doc.paths['/api/v1/things']?.get?.security).toEqual([{ bearerAuth: [] }]);
    expect(doc.paths['/api/v1/tokens']?.get?.security).toBeUndefined();
  });
});

describe('over plain http (D181, step-8 T24)', () => {
  it('refuses to make a token: 403 https_required, and none is made', async () => {
    const plain = await peopleApp(db);
    try {
      const who = await person(plain, db, 'plain');
      const res = await call(plain, '/api/v1/tokens', {
        as: who,
        body: { name: 'Script', scope: 'read', locationIds: [who.personalLocationId] },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'https_required' });
      expect(ok(await call(plain, '/api/v1/tokens', { as: who, method: 'GET' })).items).toEqual([]);
    } finally {
      await plain.app.close();
    }
  });
});
