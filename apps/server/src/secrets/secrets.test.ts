import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { newId } from '@kept/shared';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import {
  builtinType,
  createLocation,
  createThing,
  type Json,
  type Loc,
  ok,
  own,
} from '../../test/things.js';
import { open, type Sealed } from '../crypto/envelope.js';
import { fixedSecretKeys, keyringOf } from '../crypto/keyring.js';
import { withScope } from '../db/scope.js';
import { createLogger } from '../http/logger.js';
import { aadOf } from './service.js';

// Task 19 through the front door, as the web calls it (apps/web/src/api/inventory/{types,
// paths}.ts; mock/things.ts, mock/registries.ts): secret values sealed in their own store,
// revealed per the field's policy (D13, D116, D177) for 30 s (D175) and audited, never in the
// audit's values (D110), a row, the search index or a log line; the recovery-kit gate (D193).

let db: TestDb;
let t: TestApp;
const logLines: string[] = [];

let ann: Person; // owner of `home`
let ada: Person; // admin of `home`
let mo: Person; // member of `home`
let vic: Person; // viewer of `home`
let bob: Person; // owner of his own home, nothing of Ann's
let home: Loc; // complete: the secrets module is on
let plain: Loc; // household: no secrets module
let safeType: string;
let comboField: string;

const master = { key: randomBytes(32), keyVersion: 1 };
const keys = fixedSecretKeys(keyringOf({ version: 1, key: master.key, retired: new Map() }));

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  const sink = new Writable({
    write(chunk, _enc, done) {
      logLines.push(String(chunk));
      done();
    },
  });
  t = await peopleApp(db, {
    // Reveal is https only (D181); the refusal over http is tested below.
    publicUrl: 'https://kept.example',
    secretKeys: keys,
    logger: createLogger({ KEPT_LOG_LEVEL: 'trace', KEPT_LOG_FORMAT: 'json' }, sink),
  });
  ann = await person(t, db, 'ann');
  ada = await person(t, db, 'ada');
  mo = await person(t, db, 'mo');
  vic = await person(t, db, 'vic');
  bob = await person(t, db, 'bob');
  home = await createLocation(t, db, ann, 'complete');
  plain = await createLocation(t, db, ann, 'household', 'Cabin');
  await join(db, home.id, ada.userId, 'admin');
  await join(db, home.id, mo.userId, 'member');
  await join(db, home.id, vic.userId, 'viewer');
  await join(db, plain.id, mo.userId, 'member');
  safeType = await builtinType(db, 'safe');
  const [field] = await own<{ id: string }>(
    db,
    `SELECT id FROM public.type_fields WHERE type_id = $1 AND key = 'combination'`,
    [safeType],
  );
  comboField = field?.id as string;
});

beforeEach(async () => {
  await acknowledgeKit();
});

const acknowledgeKit = () =>
  own(
    db,
    `INSERT INTO public.instance_settings (key, value)
     VALUES ('recovery_kit_acknowledged_at', to_jsonb(now())) ON CONFLICT (key) DO NOTHING`,
  );

const newSafe = (name = 'Safe', loc: Loc = home) =>
  createThing(t, ann, loc, { name, typeId: safeType });

const secretUrl = (thingId: string, key = 'combination') =>
  `/api/v1/things/${thingId}/secrets/${key}`;

const put = (as: Person, url: string, value: string, headers: Record<string, string> = {}) =>
  call(t, url, { as, method: 'PUT', body: { value }, headers });

const reveal = (as: Person, url: string) => call(t, `${url}/reveal`, { as, method: 'POST' });

type ValueRow = {
  id: string;
  ciphertext: Sealed;
  key_version: number;
  superseded_at: Date | null;
  updated_by: string;
};
const valueRows = (subjectId: string) =>
  own<ValueRow>(
    db,
    `SELECT id, ciphertext, key_version, superseded_at, updated_by FROM public.secret_values
      WHERE thing_id = $1 OR place_id = $1 ORDER BY created_at, id`,
    [subjectId],
  );

type Event = {
  action: string;
  actor_id: string | null;
  entity_type: string;
  entity_id: string | null;
  diff: Record<string, unknown>;
  root_thing_id: string | null;
};
const eventsFor = (ids: string[], action?: string) =>
  own<Event>(
    db,
    `SELECT action, actor_id, entity_type, entity_id, diff, root_thing_id FROM public.audit_events
      WHERE entity_id = ANY ($1::uuid[]) ${action ? 'AND action = $2' : ''} ORDER BY at, id`,
    action ? [ids, action] : [ids],
  );

const secretsOfView = async (as: Person, thingId: string) =>
  ok(await call(t, `/api/v1/things/${thingId}`, { as })).secrets as Json[];

describe('PUT /api/v1/things/:id/secrets/:fieldKey', () => {
  // catalogue: PUT /api/v1/things/:id/secrets/:fieldKey
  it('seals the value into its own row, bound to it, and audits only that it changed', async () => {
    const safe = await newSafe();
    const res = await put(ann, secretUrl(safe.id), '12-34-56');
    expect(res.statusCode, res.body).toBe(204);
    expect(res.headers['cache-control']).toBe('no-store');

    const [row] = await valueRows(safe.id);
    expect(row).toMatchObject({ key_version: 1, superseded_at: null, updated_by: ann.userId });
    expect(JSON.stringify(row?.ciphertext)).not.toContain('12-34-56');
    const value = open(
      keys.get().keyring,
      row?.ciphertext as Sealed,
      aadOf(row?.id as string, 'combination'),
    );
    expect(value.toString()).toBe('12-34-56');
    // Bound to its row: the same ciphertext names nothing else.
    expect(() =>
      open(keys.get().keyring, row?.ciphertext as Sealed, aadOf(newId(), 'combination')),
    ).toThrow(/authentication/);

    const [event] = await eventsFor([safe.id], 'secret.set');
    expect(event).toMatchObject({
      actor_id: ann.userId,
      entity_type: 'thing',
      entity_id: safe.id,
      root_thing_id: safe.id,
      diff: { combination: { changed: true, class: 'secret' } },
    });

    expect(await secretsOfView(ann, safe.id)).toEqual([
      { fieldKey: 'combination', label: null, set: true, canReveal: true },
    ]);
    expect(await secretsOfView(mo, safe.id)).toEqual([
      { fieldKey: 'combination', label: null, set: true, canReveal: false },
    ]);
  });

  it('lets a member write a value they cannot read back, superseding the old one', async () => {
    const safe = await newSafe('Gun safe');
    expect((await put(ann, secretUrl(safe.id), 'first')).statusCode).toBe(204);
    const res = await put(mo, secretUrl(safe.id), 'second');
    expect(res.statusCode, res.body).toBe(204);
    expect((await reveal(mo, secretUrl(safe.id))).statusCode).toBe(404);
    const shown = ok(await reveal(ann, secretUrl(safe.id)));
    expect(shown.value).toBe('second');
    const rows = await valueRows(safe.id);
    expect(rows.map((r) => [r.updated_by, r.superseded_at === null])).toEqual([
      [ann.userId, false],
      [mo.userId, true],
    ]);
    // Under RLS the member sees no row at all; the owner sees the current and the old one.
    const visible = (p: Person) =>
      withScope(db.pools.app, { userId: p.userId, mfa: true }, async (_tx, c) => {
        const { rows: r } = await c.query(
          'SELECT id FROM public.secret_values WHERE thing_id = $1',
          [safe.id],
        );
        return r.length;
      });
    expect(await visible(mo)).toBe(0);
    expect(await visible(ann)).toBe(2);
  });

  it('is 403 for a viewer, 404 for an outsider, a trashed thing or a field that is not secret', async () => {
    const safe = await newSafe('Wall safe');
    expect((await put(vic, secretUrl(safe.id), 'x')).statusCode).toBe(403);
    expect((await put(bob, secretUrl(safe.id), 'x')).statusCode).toBe(404);
    expect((await put(ann, secretUrl(safe.id, 'serial_number'), 'x')).statusCode).toBe(404);
    expect((await put(ann, secretUrl(safe.id, 'nope'), 'x')).statusCode).toBe(404);
    const drill = await createThing(t, ann, home, { name: 'Drill' });
    expect((await put(ann, secretUrl(drill.id), 'x')).statusCode).toBe(404);
    await own(db, 'UPDATE public.things SET deleted_at = now() WHERE id = $1', [safe.id]);
    expect((await put(ann, secretUrl(safe.id), 'x')).statusCode).toBe(404);
    expect(await valueRows(safe.id)).toEqual([]);
  });

  it('takes 1 to 4096 characters, as given (no trimming)', async () => {
    const safe = await newSafe('Deposit box');
    expect((await put(ann, secretUrl(safe.id), '')).statusCode).toBe(400);
    expect((await put(ann, secretUrl(safe.id), 'x'.repeat(4097))).statusCode).toBe(400);
    expect((await put(ann, secretUrl(safe.id), '  spaced  ')).statusCode).toBe(204);
    expect(ok(await reveal(ann, secretUrl(safe.id))).value).toBe('  spaced  ');
  });

  it('is gated on the recovery kit (D193): 409 recovery_kit_required, "ask your instance admin"', async () => {
    const safe = await newSafe('Kit safe');
    await own(
      db,
      `DELETE FROM public.instance_settings WHERE key = 'recovery_kit_acknowledged_at'`,
    );
    const res = await put(mo, secretUrl(safe.id), '9999');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'recovery_kit_required',
      hint: expect.stringContaining('Ask your instance admin'),
    });
    // An instance admin is told what to do instead.
    await own(db, 'INSERT INTO public.instance_admins (user_id) VALUES ($1)', [ann.userId]);
    const admin = await put(ann, secretUrl(safe.id), '9999');
    expect(admin.statusCode).toBe(409);
    expect(admin.json().hint).toContain('kept admin recovery-kit');
    await own(db, 'DELETE FROM public.instance_admins WHERE user_id = $1', [ann.userId]);
    expect(await valueRows(safe.id)).toEqual([]);
    await acknowledgeKit();
    expect((await put(mo, secretUrl(safe.id), '9999')).statusCode).toBe(204);
  });

  it('answers 409 module_off where the secrets module is off, and 404 for its reads', async () => {
    const safe = await newSafe('Cabin safe', plain);
    const res = await put(mo, secretUrl(safe.id), '1');
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('module_off');
    expect((await reveal(ann, secretUrl(safe.id))).statusCode).toBe(409);
    const policy = await call(t, `/api/v1/locations/${plain.id}/secret-policies/${comboField}`, {
      as: ann,
    });
    expect(policy.statusCode).toBe(404);
    expect(policy.json().code).toBe('module_off');
  });

  it('stores nothing of an Idempotency-Key request (no body, no hash of a short PIN)', async () => {
    const safe = await newSafe('Idem safe');
    const key = newId();
    const res = await put(ann, secretUrl(safe.id), '4711', { 'idempotency-key': key });
    expect(res.statusCode).toBe(204);
    const rows = await own(db, 'SELECT 1 FROM public.idempotency_keys WHERE key = $1', [key]);
    expect(rows).toEqual([]);
  });
});

describe('POST /api/v1/things/:id/secrets/:fieldKey/reveal', () => {
  // catalogue: POST /api/v1/things/:id/secrets/:fieldKey/reveal
  it('shows the value for 30 s, uncached, audited as a reveal of that row', async () => {
    const safe = await newSafe('Office safe');
    await put(ann, secretUrl(safe.id), '31-41-59');
    const before = Date.now();
    const res = await reveal(ada, secretUrl(safe.id));
    const body = ok(res);
    expect(Object.keys(body).sort()).toEqual(['revealedUntil', 'value']);
    expect(body.value).toBe('31-41-59');
    const until = Date.parse(body.revealedUntil as string);
    expect(until - before).toBeGreaterThanOrEqual(29_000);
    expect(until - before).toBeLessThanOrEqual(31_000);
    expect(res.headers['cache-control']).toBe('no-store');

    const [row] = await valueRows(safe.id);
    const [event] = await eventsFor([row?.id as string], 'secret.reveal');
    expect(event).toMatchObject({
      actor_id: ada.userId,
      entity_type: 'secret_value',
      root_thing_id: safe.id,
      diff: {},
    });
    const [subject] = await own<{ thing_id: string }>(
      db,
      `SELECT s.thing_id FROM public.audit_event_subjects s
         JOIN public.audit_events e ON e.id = s.event_id
        WHERE e.action = 'secret.reveal' AND e.entity_id = $1`,
      [row?.id],
    );
    expect(subject?.thing_id).toBe(safe.id);
  });

  it('allows a person 30 reveals an hour, then 429 with Retry-After (review #17)', async () => {
    const rex = await person(t, db, 'rex');
    await join(db, home.id, rex.userId, 'admin');
    const safe = await newSafe('Busy safe');
    await put(ann, secretUrl(safe.id), '27-18-28');
    for (let i = 0; i < 30; i++) {
      expect((await reveal(rex, secretUrl(safe.id))).statusCode, `reveal ${i + 1}`).toBe(200);
    }
    const refused = await reveal(rex, secretUrl(safe.id));
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ code: 'rate_limited' });
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    // Refused, so not revealed and not audited: 30 reveal rows, not 31.
    const [row] = await valueRows(safe.id);
    expect(await eventsFor([row?.id as string], 'secret.reveal')).toHaveLength(30);
    // Someone else's allowance is their own.
    expect((await reveal(ada, secretUrl(safe.id))).statusCode).toBe(200);
  });

  it('is 404 when nothing is set, for a member and a viewer, and for an outsider', async () => {
    const safe = await newSafe('Empty safe');
    expect((await reveal(ann, secretUrl(safe.id))).statusCode).toBe(404);
    await put(ann, secretUrl(safe.id), 'hidden');
    for (const as of [mo, vic, bob]) {
      expect((await reveal(as, secretUrl(safe.id))).statusCode).toBe(404);
    }
    const [row] = await valueRows(safe.id);
    expect(await eventsFor([row?.id as string], 'secret.reveal')).toEqual([]);
  });

  it('refuses a ciphertext moved onto another row (the AAD binds it to its own)', async () => {
    const a = await newSafe('Safe A');
    const b = await newSafe('Safe B');
    await put(ann, secretUrl(a.id), 'value-of-a');
    await put(ann, secretUrl(b.id), 'value-of-b');
    await own(
      db,
      `UPDATE public.secret_values SET ciphertext = (SELECT ciphertext FROM public.secret_values
                                                      WHERE thing_id = $1)
        WHERE thing_id = $2`,
      [a.id, b.id],
    );
    const res = await reveal(ann, secretUrl(b.id));
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('value-of-a');
    expect(ok(await reveal(ann, secretUrl(a.id))).value).toBe('value-of-a');
  });
});

describe('POST /api/v1/things/:id/secrets/:fieldKey/copied', () => {
  // catalogue: POST /api/v1/things/:id/secrets/:fieldKey/copied
  it('audits a copy for who may reveal it, and is 404 for anyone else', async () => {
    const safe = await newSafe('Copy safe');
    await put(ann, secretUrl(safe.id), 'copy-me');
    const res = await call(t, `${secretUrl(safe.id)}/copied`, { as: ada, method: 'POST' });
    expect(res.statusCode, res.body).toBe(204);
    const [row] = await valueRows(safe.id);
    const [event] = await eventsFor([row?.id as string], 'secret.copied');
    expect(event).toMatchObject({ actor_id: ada.userId, entity_type: 'secret_value', diff: {} });
    const refused = await call(t, `${secretUrl(safe.id)}/copied`, { as: mo, method: 'POST' });
    expect(refused.statusCode).toBe(404);
  });
});

describe('DELETE /api/v1/things/:id/secrets/:fieldKey', () => {
  // catalogue: DELETE /api/v1/things/:id/secrets/:fieldKey
  it('ends the current value (history stays), audited; clearing nothing changes nothing', async () => {
    const safe = await newSafe('Clear safe');
    await put(ann, secretUrl(safe.id), 'gone-soon');
    const res = await call(t, secretUrl(safe.id), { as: mo, method: 'DELETE' });
    expect(res.statusCode, res.body).toBe(204);
    expect((await valueRows(safe.id)).map((r) => r.superseded_at !== null)).toEqual([true]);
    expect(await secretsOfView(ann, safe.id)).toEqual([
      { fieldKey: 'combination', label: null, set: false, canReveal: true },
    ]);
    expect((await reveal(ann, secretUrl(safe.id))).statusCode).toBe(404);
    const [event] = await eventsFor([safe.id], 'secret.clear');
    expect(event).toMatchObject({
      actor_id: mo.userId,
      diff: { combination: { changed: true, class: 'secret' } },
    });
    expect((await call(t, secretUrl(safe.id), { as: mo, method: 'DELETE' })).statusCode).toBe(204);
    expect(await eventsFor([safe.id], 'secret.clear')).toHaveLength(1);
    expect((await call(t, secretUrl(safe.id), { as: vic, method: 'DELETE' })).statusCode).toBe(403);
    expect((await call(t, secretUrl(safe.id), { as: bob, method: 'DELETE' })).statusCode).toBe(404);
  });
});

describe('secret-field policies (owner only, D177)', () => {
  const policyUrl = (loc: Loc = home, field = comboField) =>
    `/api/v1/locations/${loc.id}/secret-policies/${field}`;

  it('answers the default (owners and admins, no AI) to the owner, and 404 to anyone else', async () => {
    expect(ok(await call(t, policyUrl(), { as: ann }))).toEqual({
      revealRoles: ['owner', 'admin'],
      revealUserIds: [],
      aiAllowed: false,
    });
    for (const as of [ada, mo, vic, bob]) {
      expect((await call(t, policyUrl(), { as })).statusCode).toBe(404);
    }
    const [plainField] = await own<{ id: string }>(
      db,
      `SELECT id FROM public.type_fields WHERE owner_account_id IS NULL AND NOT secret LIMIT 1`,
    );
    expect((await call(t, policyUrl(home, plainField?.id), { as: ann })).statusCode).toBe(404);
  });

  // catalogue: PUT /api/v1/locations/:locationId/secret-policies/:typeFieldId
  it('widens who may reveal: members by role, a viewer by name; audited', async () => {
    const safe = await newSafe('Shared safe');
    await put(ann, secretUrl(safe.id), 'open-sesame');
    expect((await reveal(mo, secretUrl(safe.id))).statusCode).toBe(404);

    const res = await call(t, policyUrl(), {
      as: ann,
      method: 'PUT',
      body: { revealRoles: ['member'], revealUserIds: [vic.userId], aiAllowed: false },
    });
    // Owners and admins always stay on it (D13: a policy only widens the default).
    expect(ok(res)).toEqual({
      revealRoles: ['owner', 'admin', 'member'],
      revealUserIds: [vic.userId],
      aiAllowed: false,
    });
    expect(ok(await reveal(mo, secretUrl(safe.id))).value).toBe('open-sesame');
    expect(ok(await reveal(vic, secretUrl(safe.id))).value).toBe('open-sesame');
    expect((await secretsOfView(mo, safe.id))[0]).toMatchObject({ canReveal: true });

    const [event] = await eventsFor([comboField], 'secret_policy.update');
    expect(event).toMatchObject({
      actor_id: ann.userId,
      entity_type: 'secret_field_policy',
      diff: {
        reveal_roles: { before: ['owner', 'admin'], after: ['owner', 'admin', 'member'] },
        reveal_user_ids: { before: [], after: [vic.userId] },
      },
    });

    // Back to the default: the member and the viewer lose it again.
    ok(
      await call(t, policyUrl(), {
        as: ann,
        method: 'PUT',
        body: { revealRoles: [], revealUserIds: [], aiAllowed: false },
      }),
    );
    expect((await reveal(mo, secretUrl(safe.id))).statusCode).toBe(404);
    expect((await reveal(vic, secretUrl(safe.id))).statusCode).toBe(404);
  });

  it('is 403 for an admin, 404 for an outsider, 400 for someone who is not a member', async () => {
    const body = { revealRoles: ['member'], revealUserIds: [], aiAllowed: true };
    expect((await call(t, policyUrl(), { as: ada, method: 'PUT', body })).statusCode).toBe(403);
    expect((await call(t, policyUrl(), { as: bob, method: 'PUT', body })).statusCode).toBe(404);
    const stranger = await call(t, policyUrl(), {
      as: ann,
      method: 'PUT',
      body: { ...body, revealUserIds: [bob.userId] },
    });
    expect(stranger.statusCode).toBe(400);
    const bad = await call(t, policyUrl(), {
      as: ann,
      method: 'PUT',
      body: { ...body, revealRoles: ['everyone'] },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('secret values on a place (a place kind with a secret field)', () => {
  let serverRoom: string;

  beforeAll(async () => {
    const [kind] = await own<{ id: string }>(
      db,
      `INSERT INTO public.place_kinds (owner_account_id, key, name, icon)
       VALUES ($1, 'server_room', 'Server room', 'lucide:box') RETURNING id`,
      [home.accountId],
    );
    await own(
      db,
      `INSERT INTO public.type_fields (owner_account_id, place_kind_id, key, label, kind, secret)
       VALUES ($1, $2, 'door_code', 'Door code', 'text', true)`,
      [home.accountId, kind?.id],
    );
    const [p] = await own<{ id: string }>(
      db,
      `INSERT INTO public.places (location_id, name, kind_key) VALUES ($1, 'Rack room', 'server_room')
       RETURNING id`,
      [home.id],
    );
    serverRoom = p?.id as string;
  });

  const placeUrl = () => `/api/v1/places/${serverRoom}/secrets/door_code`;

  // catalogue: PUT /api/v1/places/:id/secrets/:fieldKey
  // catalogue: POST /api/v1/places/:id/secrets/:fieldKey/reveal
  // catalogue: POST /api/v1/places/:id/secrets/:fieldKey/copied
  // catalogue: DELETE /api/v1/places/:id/secrets/:fieldKey
  it('sets, reveals, copies and clears it, each audited on the place or its value row', async () => {
    expect((await put(mo, placeUrl(), '2468#')).statusCode).toBe(204);
    const view = ok(await call(t, `/api/v1/places/${serverRoom}`, { as: ann }));
    expect(view.secrets).toEqual([
      { fieldKey: 'door_code', label: 'Door code', set: true, canReveal: true },
    ]);
    expect((await reveal(mo, placeUrl())).statusCode).toBe(404);
    expect(ok(await reveal(ann, placeUrl())).value).toBe('2468#');
    const copied = await call(t, `${placeUrl()}/copied`, { as: ann, method: 'POST' });
    expect(copied.statusCode).toBe(204);
    expect((await call(t, placeUrl(), { as: ann, method: 'DELETE' })).statusCode).toBe(204);
    expect((await reveal(ann, placeUrl())).statusCode).toBe(404);

    const [row] = await valueRows(serverRoom);
    const events = await eventsFor([serverRoom, row?.id as string]);
    expect(events.map((e) => [e.action, e.entity_type, e.root_thing_id])).toEqual([
      ['secret.set', 'place', null],
      ['secret.reveal', 'secret_value', null],
      ['secret.copied', 'secret_value', null],
      ['secret.clear', 'place', null],
    ]);
    expect(events[0]?.diff).toEqual({ door_code: { changed: true, class: 'secret' } });
    expect((await put(ann, `/api/v1/places/${serverRoom}/secrets/nope`, 'x')).statusCode).toBe(404);
  });
});

describe('where a value never goes (D110, D116)', () => {
  it('is in no audit row, thing row, search index, idempotency row or log line', async () => {
    const value = `leak-canary-${randomBytes(6).toString('hex')}`;
    const safe = await newSafe('Hall safe');
    expect((await put(ann, secretUrl(safe.id), value)).statusCode).toBe(204);
    expect(ok(await reveal(ann, secretUrl(safe.id))).value).toBe(value);
    await call(t, `${secretUrl(safe.id)}/copied`, { as: ann, method: 'POST' });
    await call(t, secretUrl(safe.id), { as: ann, method: 'DELETE' });
    // A refused write logs its error too.
    await put(vic, secretUrl(safe.id), value);

    const dumps = await own<{ n: number }>(
      db,
      `SELECT count(*)::int AS n FROM (
         SELECT row_to_json(e)::text AS j FROM public.audit_events e
         UNION ALL SELECT row_to_json(x)::text FROM public.things x
         UNION ALL SELECT row_to_json(p)::text FROM public.places p
         UNION ALL SELECT row_to_json(i)::text FROM public.idempotency_keys i
         UNION ALL SELECT row_to_json(s)::text FROM public.secret_values s
       ) d WHERE d.j LIKE '%' || $1 || '%'`,
      [value],
    );
    expect(dumps[0]?.n).toBe(0);
    const [tsv] = await own<{ tsv: string }>(
      db,
      'SELECT search_tsv::text AS tsv FROM public.things WHERE id = $1',
      [safe.id],
    );
    expect(tsv?.tsv).not.toContain('canary');
    expect(logLines.length).toBeGreaterThan(0);
    expect(logLines.join('\n')).toContain(safe.id);
    expect(logLines.join('\n')).not.toContain(value);
  });
});

describe('over plain http (D181, step-8 T24)', () => {
  it('refuses a reveal: 403 https_required, the value not in the answer', async () => {
    const overHttp = await peopleApp(db, { secretKeys: keys });
    try {
      const who = await person(overHttp, db, 'plain');
      const loc = await createLocation(overHttp, db, who, 'complete');
      const safe = await createThing(overHttp, who, loc, { name: 'Safe', typeId: safeType });
      const url = secretUrl(safe.id);
      const set = await call(overHttp, url, {
        as: who,
        method: 'PUT',
        body: { value: '73-19-42' },
      });
      expect(set.statusCode).toBe(204);
      const res = await call(overHttp, `${url}/reveal`, { as: who, method: 'POST' });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'https_required' });
      expect(res.body).not.toContain('73-19-42');
    } finally {
      await overHttp.app.close();
    }
  });
});
