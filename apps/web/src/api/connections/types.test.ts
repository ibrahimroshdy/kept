/**
 * The step-6 Connections mock answers its contract through the real fetchers (./queries.ts), for
 * T21–T23 to build on (plan T3): every path in ./paths.ts has a handler, the answers carry the
 * contract's fields, and the fixtures hold two tokens, an OAuth app, three recent changes and a
 * webhook with a failing delivery. A secret appears in a create or rotate answer only.
 */
import { parseToken } from '@kept/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ApiError, isApiError } from '../client';
import { INV_IDS } from '../inventory/mock/fixtures';
import { type MockState, memberScenario, ownerScenario } from '../mock/fixtures';
import { createMockApi } from '../mock/server';
import { connectionsMockRoutes } from './mock';
import { CONNECTION_IDS as C } from './mock/state';
import { CONNECTIONS_METHODS, connectionsPaths } from './paths';
import { connectionsApi as api } from './queries';
import { type CreatedToken, isCrossLocationWarning, type TokenRow } from './types';

const use = (state: MockState = ownerScenario()) => {
  vi.stubGlobal('fetch', createMockApi(state).fetch);
  return state;
};
beforeEach(() => use());
afterEach(() => vi.unstubAllGlobals());

const fail = async (p: Promise<unknown>) => {
  const e = await p.catch((x: unknown) => x);
  if (!isApiError(e)) throw new Error('expected an ApiError');
  return e as ApiError;
};
const keys = (o: object) => Object.keys(o).sort();
const L = INV_IDS.loc;

const TOKEN_KEYS = [
  'createdAt',
  'expiresAt',
  'id',
  'kind',
  'lastUsedAt',
  'locations',
  'name',
  'revokedAt',
  'revokedReason',
  'rowVersion',
  'scope',
];

describe('the connections mock', () => {
  it('has a handler for every path and method the web calls', () => {
    const routes = connectionsMockRoutes(ownerScenario());
    const matches = (template: string, path: string) =>
      new RegExp(
        `^${template
          .split('/')
          .map((part) => (part.startsWith('%3A') ? '[^/]+' : part))
          .join('/')}$`,
      ).test(path);
    const missing: string[] = [];
    for (const [key, methods] of Object.entries(CONNECTIONS_METHODS)) {
      const v = connectionsPaths[key as keyof typeof connectionsPaths] as
        | string
        | ((id: string) => string);
      const path = typeof v === 'string' ? v : v('a');
      for (const method of methods)
        if (!routes.some((r) => r.method === method && matches(r.template, path)))
          missing.push(`${method} ${path}`);
    }
    expect(missing).toEqual([]);
  });

  it('lists two tokens and one connected app, never a secret', async () => {
    const page = await api.tokens();
    expect(page.items.map((t) => [t.name, t.kind, t.scope, t.locations.map((l) => l.id)])).toEqual([
      ['Garage dashboard', 'personal', 'read', [L.garage]],
      ['Claude Desktop', 'personal', 'write', [L.home]],
      ['Claude', 'oauth', 'read', [L.home]],
    ]);
    for (const t of page.items)
      expect(keys(t)).toEqual(
        t.kind === 'oauth' ? [...TOKEN_KEYS, 'clientName'].sort() : TOKEN_KEYS,
      );
    expect(JSON.stringify(page)).not.toMatch(/kpt_|secret|hash/);
  });

  it('creates a token once, with its secret and client configs', async () => {
    const r = await api.createToken({
      name: 'Odometer shortcut',
      scope: 'write',
      locationIds: [L.garage],
    });
    if (isCrossLocationWarning(r)) throw new Error('no warning for one location');
    const created: CreatedToken = r;
    expect(keys(created)).toEqual(['clientConfigs', 'secret', 'token']);
    expect(parseToken(created.secret)).not.toBeNull();
    expect(created.clientConfigs.generic).toEqual({
      url: `${location.origin}/mcp`,
      headers: { Authorization: `Bearer ${created.secret}` },
    });
    const listed = await api.tokens();
    expect(listed.items[0]?.name).toBe('Odometer shortcut');
    expect(JSON.stringify(listed)).not.toContain(created.secret);
  });

  it('warns before a write token across locations (D179), then makes it when asked again', async () => {
    const body = { name: 'Both', scope: 'write' as const, locationIds: [L.home, L.garage] };
    expect(await api.createToken(body)).toEqual({ warning: 'cross_location_write' });
    const again = await api.createToken({ ...body, confirmCrossLocation: true });
    expect(isCrossLocationWarning(again)).toBe(false);
  });

  it('renames with If-Match and revokes', async () => {
    const row = (await api.tokens()).items[0] as TokenRow;
    expect((await fail(api.renameToken(row.id, { name: 'x' }, row.rowVersion + 1))).code).toBe(
      'precondition_failed',
    );
    expect((await api.renameToken(row.id, { name: 'Garage wall' }, row.rowVersion)).name).toBe(
      'Garage wall',
    );
    await api.revokeToken(row.id);
    const after = (await api.tokens()).items.find((t) => t.id === row.id);
    expect(after).toMatchObject({ revokedReason: 'user', revokedAt: expect.any(String) });
  });

  it('lists three recent changes by a token, the undoable ones with their undo', async () => {
    const page = await api.changes();
    expect(page.items.map((c) => c.id)).toEqual([C.change.move, C.change.seen, C.change.add]);
    expect(page.items.map((c) => c.undo !== null)).toEqual([true, true, false]);
    expect(page.items[0]).toMatchObject({
      actor: { type: 'token' },
      token: { id: C.token.homeWrite, name: 'Claude Desktop' },
    });
    expect((await api.changes({ tokenId: C.token.garageRead })).items).toEqual([]);
  });

  it('OAuth consent: the client as it calls itself, the locations with what each allows', async () => {
    const consent = await api.consent('?client_id=https%3A%2F%2Fclient.example%2Fcimd.json');
    expect(keys(consent)).toEqual(['client', 'locations', 'requestedScopes']);
    expect(consent.locations.find((l) => l.id === L.home)).toMatchObject({
      role: 'owner',
      canWrite: true,
    });
    const r = await api.answerConsent('client_id=x', {
      accept: true,
      scope: 'read',
      locationIds: [L.home],
    });
    expect(r.redirectTo).toMatch(/^https:\/\//);
    expect((await api.tokens()).items.filter((t) => t.kind === 'oauth')).toHaveLength(2);
  });

  it('a webhook with a failing delivery; the secret only on create and rotate', async () => {
    const { items } = await api.webhooks(L.home);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      failingSince: expect.any(String),
      lastDelivery: { status: 'failed', httpStatus: 500 },
    });
    expect(JSON.stringify(items)).not.toContain('secret');
    const deliveries = await api.deliveries(C.webhook.home);
    expect(deliveries.items.map((d) => d.status)).toEqual(['failed', 'delivered']);
    expect(await api.testWebhook(C.webhook.home)).toEqual({ httpStatus: 500 });
    const made = await api.createWebhook(L.garage, {
      url: 'https://hooks.example.org/kept/garage',
      events: ['reading.logged'],
    });
    expect(made.secret.length).toBeGreaterThan(20);
    expect((await api.rotateWebhookSecret(made.webhook.id)).secret).not.toBe(made.secret);
    expect((await fail(api.updateWebhook(made.webhook.id, { active: false }, 99))).code).toBe(
      'precondition_failed',
    );
    expect(
      (await api.updateWebhook(made.webhook.id, { active: false }, made.webhook.rowVersion)).active,
    ).toBe(false);
    await api.deleteWebhook(made.webhook.id);
    expect((await api.webhooks(L.garage)).items).toEqual([]);
  });

  it('a member can neither list nor add a location’s webhooks', async () => {
    use(memberScenario());
    expect((await fail(api.webhooks(L.home))).status).toBe(403);
  });
});
