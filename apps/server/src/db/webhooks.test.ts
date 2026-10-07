import { newId } from '@kept/shared';
import type pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testDb } from '../../test/db.js';
import {
  addMember,
  ownerTx,
  pgError,
  seedTenant,
  seedUser,
  type Tenant,
} from '../../test/tenancy.js';
import { type Scope, withScope, withSystem } from './scope.js';

// Step-6 T7 (0077, 0078): location webhooks with write-only secrets, their deliveries, D180's
// switch-off, Better Auth's OAuth tables, and the step-6 instance settings (engineering spec
// §1.10, §2.6, §3.1b; D63, D110, D180; plan Q16, Q18).

const db = await testDb();
vi.setConfig({ testTimeout: 60_000 });

let ibrahim: Tenant; // owns Home
let bruce: string; // admin of Home
let louis: string; // member of Home
let alfred: Tenant; // owns بيت العائلة, shares nothing

const own = <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(sql, values)).rows);
const as = <T>(scope: Scope, fn: (c: pg.PoolClient) => Promise<T>) =>
  withScope(db.pools.app, scope, (_tx, c) => fn(c));
const user = (userId: string): Scope => ({ userId, mfa: true });
const system = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  withSystem(db.pools.system, (_tx, c) => fn(c));

const hook = (userId: string, events = ['thing.created']) =>
  as(user(userId), async (c) => {
    const id = newId();
    await c.query(
      `INSERT INTO public.webhooks (id, location_id, url, secret_ciphertext, key_version, events,
                                    created_by)
       VALUES ($1, $2, 'https://hooks.example.test/kept', '{"v": 1, "c": "sealed"}', 1, $3, $4)`,
      [id, ibrahim.locationId, events, userId],
    );
    return id;
  });
const state = async (id: string) =>
  (
    await own<{ active: boolean; disabled_reason: string | null }>(
      'SELECT active, disabled_reason FROM public.webhooks WHERE id = $1',
      [id],
    )
  )[0];

beforeEach(async () => {
  await db.reset();
  ibrahim = await seedTenant(db, 'wh-ibrahim', { name: 'Home' });
  bruce = await seedUser(db, 'wh-bruce');
  await addMember(db, ibrahim.locationId, bruce, 'admin');
  louis = await seedUser(db, 'wh-louis');
  await addMember(db, ibrahim.locationId, louis, 'member');
  alfred = await seedTenant(db, 'wh-alfred', { name: 'بيت العائلة' });
});

describe('webhooks (D63, D180)', () => {
  it("are their location's admins' to add and read; a member neither sees nor adds one", async () => {
    const id = await hook(bruce);
    const seen = (userId: string) =>
      as(user(userId), async (c) => (await c.query('SELECT id FROM public.webhooks')).rowCount);
    expect([await seen(bruce), await seen(ibrahim.userId), await seen(louis)]).toEqual([1, 1, 0]);
    expect((await pgError(hook(louis))).code).toBe('42501');
    expect(
      (
        await pgError(
          as(user(bruce), (c) =>
            c.query(
              `INSERT INTO public.webhooks (location_id, url, secret_ciphertext, key_version,
                                            events, created_by)
               VALUES ($1, 'https://x.example.test', '{}', 1, ARRAY['thing.moved'], $2)`,
              [ibrahim.locationId, ibrahim.userId],
            ),
          ),
        )
      ).code,
    ).toBe('42501');
    expect(id).toBeTruthy();
  });

  it('keeps the secret write-only: kept_app writes it and never reads it; the job opens it', async () => {
    const id = await hook(bruce);
    expect(
      (
        await pgError(
          as(user(bruce), (c) => c.query('SELECT secret_ciphertext FROM public.webhooks')),
        )
      ).code,
    ).toBe('42501');
    await as(user(bruce), (c) =>
      c.query(
        `UPDATE public.webhooks SET secret_ciphertext = '{"v": 2, "c": "new"}', key_version = 2
          WHERE id = $1`,
        [id],
      ),
    );
    const opened = await system(
      async (c) => (await c.query('SELECT * FROM kept.webhook_secret($1)', [id])).rows,
    );
    expect(opened).toEqual([
      {
        location_id: ibrahim.locationId,
        url: 'https://hooks.example.test/kept',
        secret_ciphertext: { v: 2, c: 'new' },
        key_version: 2,
        active: true,
      },
    ]);
    expect(
      (
        await pgError(
          as(user(bruce), (c) => c.query('SELECT * FROM kept.webhook_secret($1)', [id])),
        )
      ).code,
    ).toBe('42501');
  });

  it('refuses an event it does not know, and no event at all', async () => {
    expect((await pgError(hook(bruce, ['thing.exploded']))).constraint).toBe('webhooks_events_chk');
    expect((await pgError(hook(bruce, []))).constraint).toBe('webhooks_events_chk');
  });

  it("stops Bruce's hooks when he stops administering Home, and leaves Ibrahim's (D180)", async () => {
    const his = await hook(bruce);
    const ibrahims = await hook(ibrahim.userId);
    await as(user(ibrahim.userId), (c) =>
      c.query(`UPDATE public.memberships SET role = 'member' WHERE user_id = $1`, [bruce]),
    );
    expect(await state(his)).toEqual({ active: false, disabled_reason: 'creator_lost_role' });
    expect(await state(ibrahims)).toEqual({ active: true, disabled_reason: null });
    await as(user(ibrahim.userId), (c) =>
      c.query(`UPDATE public.memberships SET role = 'admin' WHERE user_id = $1`, [bruce]),
    );
    const again = await hook(bruce);
    await as(user(ibrahim.userId), (c) =>
      c.query('DELETE FROM public.memberships WHERE user_id = $1', [bruce]),
    );
    expect(await state(again)).toEqual({ active: false, disabled_reason: 'creator_lost_role' });
  });

  it('kept.disable_webhooks_for(): the user, an admin of the location, or the system', async () => {
    await hook(bruce);
    const call = (scope: Scope) =>
      as(
        scope,
        async (c) =>
          (
            await c.query('SELECT kept.disable_webhooks_for($1, $2) AS n', [
              bruce,
              ibrahim.locationId,
            ])
          ).rows[0]?.n,
      );
    expect((await pgError(call(user(louis)))).code).toBe('42501');
    expect(await call(user(ibrahim.userId))).toBe(1);
  });

  it('kept.webhooks_listening(): yes for a subscribed event where the caller sees the location', async () => {
    await hook(bruce, ['thing.created', 'thing.moved']);
    const listening = (userId: string, event: string) =>
      as(
        user(userId),
        async (c) =>
          (
            await c.query('SELECT kept.webhooks_listening($1, $2) AS v', [
              ibrahim.locationId,
              event,
            ])
          ).rows[0]?.v,
      );
    expect(await listening(louis, 'thing.moved')).toBe(true);
    expect(await listening(louis, 'reading.logged')).toBe(false);
    expect(await listening(alfred.userId, 'thing.moved')).toBe(false);
  });
});

describe('webhook deliveries (§3.1b)', () => {
  const deliver = (webhookId: string, eventId: string) =>
    system((c) =>
      c.query(
        `INSERT INTO public.webhook_deliveries (location_id, webhook_id, event_id, event)
         VALUES ($1, $2, $3, 'thing.created')`,
        [ibrahim.locationId, webhookId, eventId],
      ),
    );

  it('are written by the jobs only, once per hook and event, and read by admins', async () => {
    const id = await hook(bruce);
    await deliver(id, 'evt_0123456789ab');
    expect(await pgError(deliver(id, 'evt_0123456789ab'))).toMatchObject({
      code: '23505',
      constraint: 'webhook_deliveries_event_uq',
    });
    await system((c) =>
      c.query(
        `UPDATE public.webhook_deliveries SET status = 'failed', attempts = 1, http_status = 500,
                next_attempt_at = now() + interval '1 minute'`,
      ),
    );
    expect(
      (
        await pgError(
          as(user(bruce), (c) =>
            c.query(
              `INSERT INTO public.webhook_deliveries (location_id, webhook_id, event_id, event)
               VALUES ($1, $2, 'evt_abcdefghijkl', 'thing.created')`,
              [ibrahim.locationId, id],
            ),
          ),
        )
      ).code,
    ).toBe('42501');
    const seen = (userId: string) =>
      as(
        user(userId),
        async (c) => (await c.query('SELECT status FROM public.webhook_deliveries')).rows,
      );
    expect(await seen(bruce)).toEqual([{ status: 'failed' }]);
    expect(await seen(louis)).toEqual([]);
  });

  it('are pruned after 30 days', async () => {
    const id = await hook(bruce);
    await deliver(id, 'evt_0123456789ab');
    await own(`UPDATE public.webhook_deliveries SET created_at = now() - interval '31 days'`);
    const pruned = await system(
      async (c) =>
        (
          await c.query(
            `SELECT removed::int AS n FROM kept.prune_stale_rows() WHERE what = 'webhook_deliveries'`,
          )
        ).rows[0]?.n,
    );
    expect(pruned).toBe(1);
  });
});

describe("Better Auth's OAuth tables (S6.2)", () => {
  it("are kept_auth's alone", async () => {
    const tables = [
      'jwks',
      'oauth_client',
      'oauth_resource',
      'oauth_client_resource',
      'oauth_access_token',
      'oauth_refresh_token',
      'oauth_consent',
      'oauth_client_assertion',
    ];
    const grants = await own<{ t: string; auth: boolean; app: boolean; sys: boolean }>(
      `SELECT t,
              has_table_privilege('kept_auth', format('auth.%I', t), 'SELECT,INSERT,UPDATE,DELETE') AS auth,
              has_table_privilege('kept_app', format('auth.%I', t), 'SELECT') AS app,
              has_table_privilege('kept_system', format('auth.%I', t), 'SELECT') AS sys
         FROM unnest($1::text[]) AS t`,
      [tables],
    );
    expect(grants).toEqual(tables.map((t) => ({ t, auth: true, app: false, sys: false })));
    await db.pools.auth.query(
      `INSERT INTO auth.oauth_client (client_id, name, redirect_uris, scopes, client_discovery_id,
                                      token_endpoint_auth_method, created_at, updated_at)
       VALUES ('https://claude.example.test/client.json', 'Claude',
               ARRAY['https://claude.example.test/cb'], ARRAY['kept:read'], 'cimd', 'none', now(),
               now())`,
    );
    await db.pools.auth.query(
      `INSERT INTO auth.oauth_client_assertion (id, expires_at) VALUES ('jti-digest-AbC_-', now())`,
    );
  });
});

describe('instance settings (T7 step 3)', () => {
  const set = (key: string, value: string) =>
    own('INSERT INTO public.instance_settings (key, value) VALUES ($1, $2::jsonb)', [key, value]);

  it('holds the step-6 keys to their shapes, and leaves every other key alone', async () => {
    await set('embeddings_source', '"local"');
    await set('assistant_thread_days', '30');
    await set('oidc_config_hash', `"${'a'.repeat(64)}"`);
    await set('smtp_config_hash', `"${'b'.repeat(64)}"`);
    await set('some_other_key', '"anything"');
    for (const [key, value] of [
      ['embeddings_source', '"cloud"'],
      ['assistant_thread_days', '3'],
      ['assistant_thread_days', '"90"'],
      ['oidc_config_hash', '"not a hash"'],
    ] as const) {
      await own('DELETE FROM public.instance_settings WHERE key = $1', [key]);
      expect((await pgError(set(key, value))).constraint, `${key} ${value}`).toBe(
        'instance_settings_values_chk',
      );
    }
  });
});
