/**
 * Mock handlers for Settings → Connections (step-6 plan T10, T12, T15; for T21–T23 to build on).
 * Tokens and grants are the caller's own; a viewer's token is read only, and a write token across
 * more than one location first answers D179's warning. A secret is in the create or rotate answer
 * only. Webhooks are for the location's owner and admins (`webhooks.manage`); their PATCH takes
 * If-Match. OAuth consent lists the caller's locations, one pre-selected by the page.
 */
import { formatToken, newTokenParts, TOKEN_SCOPES, WEBHOOK_EVENTS } from '@kept/shared';
import { now } from '../../inventory/mock/db';
import { inventoryPaths } from '../../inventory/paths';
import type { MockState } from '../../mock/fixtures';
import { err, forbidden, type MockRoute, notFound, PASS, reply, route } from '../../mock/kit';
import { connectionsPaths as p } from '../paths';
import type {
  ClientConfig,
  CreateTokenBody,
  CreateWebhookBody,
  OAuthConsent,
  OAuthConsentBody,
  TokenRow,
  UpdateTokenBody,
  UpdateWebhookBody,
  WebhookRow,
} from '../types';
import { instanceMockRoutes } from './instance';
import { connectionsMock, type StoredToken, type StoredWebhook } from './state';

const PAGE = 20;
let next = 0;
const newId = () => `01926f00-0000-7000-8000-0000000a${String(++next).padStart(4, '0')}`;
const origin = () => (typeof location === 'undefined' ? 'http://kept.test' : location.origin);
const randomSecret = () => newTokenParts().secret;

const tokenRow = ({ userId: _u, ...t }: StoredToken): TokenRow => t;
const webhookRow = ({ locationId: _l, ...w }: StoredWebhook): WebhookRow => w;

/** A page of `items` from an offset cursor. */
function page<T>(items: T[], cursor: string | null) {
  const from = Number(cursor ?? 0) || 0;
  return {
    items: items.slice(from, from + PAGE),
    next_cursor: from + PAGE < items.length ? String(from + PAGE) : null,
  };
}

const preconditionFailed = () =>
  err(412, 'precondition_failed', 'This changed since you opened it.');

export function connectionsMockRoutes(state: MockState): MockRoute[] {
  const s = () => connectionsMock(state);
  const me = () => state.me.user.id;
  const roleIn = (locationId: string) => state.locations.find((l) => l.id === locationId)?.role;
  const nameOf = (locationId: string) =>
    state.locations.find((l) => l.id === locationId)?.name ?? '';
  const kindOf = (locationId: string) => state.locations.find((l) => l.id === locationId)?.kind;
  const manages = (locationId: string) => {
    const role = roleIn(locationId);
    return role === 'owner' || role === 'admin';
  };
  const ownToken = (id: string) => s().tokens.find((t) => t.id === id && t.userId === me());
  const hook = (id: string) => {
    const w = s().webhooks.find((x) => x.id === id);
    return w && manages(w.locationId) ? w : undefined;
  };
  const clientConfig = (secret: string): ClientConfig => ({
    url: `${origin()}/mcp`,
    headers: { Authorization: `Bearer ${secret}` },
  });

  return [
    // ----- tokens and connected apps -----
    route('GET', p.tokens, ({ query }) =>
      page(
        s()
          .tokens.filter((t) => t.userId === me())
          .map(tokenRow),
        query.get('cursor'),
      ),
    ),
    route('POST', p.tokens, ({ body }) => {
      const b = body as CreateTokenBody;
      const name = (b?.name ?? '').trim();
      if (
        !name ||
        name.length > 80 ||
        !TOKEN_SCOPES.includes(b.scope) ||
        !Array.isArray(b.locationIds) ||
        b.locationIds.length < 1
      )
        return err(400, 'validation', 'The request is not valid.');
      const roles = b.locationIds.map(roleIn);
      if (roles.some((r) => !r)) return notFound();
      // A viewer's token is read only; a member's is up to their own role (roles.ts).
      if (b.scope === 'write' && roles.includes('viewer')) return forbidden();
      if (b.scope === 'write' && b.locationIds.length > 1 && !b.confirmCrossLocation)
        return { warning: 'cross_location_write' };
      const parts = newTokenParts();
      const secret = formatToken(parts);
      const row: StoredToken = {
        id: newId(),
        userId: me(),
        kind: 'personal',
        name,
        scope: b.scope,
        locations: b.locationIds.map((id) => ({ id, name: nameOf(id), kind: kindOf(id) })),
        createdAt: now(),
        expiresAt: b.expiresAt ?? null,
        lastUsedAt: null,
        revokedAt: null,
        revokedReason: null,
        rowVersion: 1,
      };
      s().tokens.unshift(row);
      return reply(201, {
        token: tokenRow(row),
        secret,
        clientConfigs: { claudeDesktop: clientConfig(secret), generic: clientConfig(secret) },
      });
    }),
    route('PATCH', p.token(':id'), ({ params, body, headers }) => {
      const t = ownToken(params.id as string);
      if (!t) return notFound();
      if (headers['if-match'] !== String(t.rowVersion)) return preconditionFailed();
      const name = ((body as UpdateTokenBody)?.name ?? '').trim();
      if (!name || name.length > 80) return err(400, 'validation', 'The request is not valid.');
      t.name = name;
      t.rowVersion += 1;
      return tokenRow(t);
    }),
    route('DELETE', p.token(':id'), ({ params }) => {
      const t = ownToken(params.id as string);
      if (!t) return notFound();
      t.revokedAt ??= now();
      t.revokedReason ??= 'user';
      return reply(204);
    }),
    route('GET', p.changes, ({ query }) => {
      const mine = new Set(
        s()
          .tokens.filter((t) => t.userId === me())
          .map((t) => t.id),
      );
      const tokenId = query.get('tokenId');
      return page(
        s().changes.filter((c) => mine.has(c.token.id) && (!tokenId || c.token.id === tokenId)),
        query.get('cursor'),
      );
    }),

    // ----- OAuth consent -----
    route('GET', p.oauthConsent, () => {
      const consent: OAuthConsent = {
        client: { name: 'Claude', uri: 'https://claude.ai' },
        requestedScopes: ['kept:read', 'kept:write'],
        locations: state.locations.map((l) => ({
          id: l.id,
          name: l.name,
          kind: l.kind,
          role: l.role,
          canWrite: l.role !== 'viewer',
        })),
      };
      return consent;
    }),
    route('POST', p.oauthConsent, ({ body }) => {
      const b = body as OAuthConsentBody;
      if (!b?.accept) return { redirectTo: 'https://client.example/callback?error=access_denied' };
      if (!TOKEN_SCOPES.includes(b.scope) || !b.locationIds?.length)
        return err(400, 'validation', 'The request is not valid.');
      if (b.locationIds.some((id) => !roleIn(id))) return notFound();
      if (b.scope === 'write' && b.locationIds.some((id) => roleIn(id) === 'viewer'))
        return forbidden();
      s().tokens.unshift({
        id: newId(),
        userId: me(),
        kind: 'oauth',
        name: 'Claude',
        clientName: 'Claude',
        scope: b.scope,
        locations: b.locationIds.map((id) => ({ id, name: nameOf(id), kind: kindOf(id) })),
        createdAt: now(),
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
        revokedReason: null,
        rowVersion: 1,
      });
      return { redirectTo: 'https://client.example/callback?code=mock-code' };
    }),

    // ----- location webhooks -----
    route('GET', p.locationWebhooks(':id'), ({ params }) => {
      const id = params.id as string;
      if (!roleIn(id)) return notFound();
      if (!manages(id)) return forbidden();
      return {
        items: s()
          .webhooks.filter((w) => w.locationId === id)
          .map(webhookRow),
      };
    }),
    route('POST', p.locationWebhooks(':id'), ({ params, body }) => {
      const id = params.id as string;
      if (!roleIn(id)) return notFound();
      if (!manages(id)) return forbidden();
      const b = body as CreateWebhookBody;
      const events = b?.events ?? [];
      if (
        !/^https?:\/\//.test(b?.url ?? '') ||
        (b?.url ?? '').length > 500 ||
        events.length < 1 ||
        events.some((e) => !WEBHOOK_EVENTS.includes(e))
      )
        return err(400, 'validation', 'The request is not valid.');
      const w: StoredWebhook = {
        id: newId(),
        locationId: id,
        url: b.url,
        events,
        active: true,
        failingSince: null,
        disabledReason: null,
        createdBy: { id: me(), displayName: state.me.user.displayName },
        rowVersion: 1,
      };
      s().webhooks.push(w);
      return reply(201, { webhook: webhookRow(w), secret: randomSecret() });
    }),
    route('PATCH', p.webhook(':id'), ({ params, body, headers }) => {
      const w = hook(params.id as string);
      if (!w) return notFound();
      if (headers['if-match'] !== String(w.rowVersion)) return preconditionFailed();
      const b = (body ?? {}) as UpdateWebhookBody;
      if (b.url !== undefined) w.url = b.url;
      if (b.events !== undefined) w.events = b.events;
      if (b.active !== undefined) w.active = b.active;
      w.rowVersion += 1;
      return webhookRow(w);
    }),
    route('POST', p.webhookRotateSecret(':id'), ({ params }) =>
      hook(params.id as string) ? { secret: randomSecret() } : notFound(),
    ),
    route('POST', p.webhookTest(':id'), ({ params }) => {
      const w = hook(params.id as string);
      if (!w) return notFound();
      return { httpStatus: w.failingSince ? 500 : 204 };
    }),
    route('DELETE', p.webhook(':id'), ({ params }) => {
      const w = hook(params.id as string);
      if (!w) return notFound();
      s().webhooks = s().webhooks.filter((x) => x.id !== w.id);
      return reply(204);
    }),
    route('GET', p.webhookDeliveries(':id'), ({ params, query }) => {
      const w = hook(params.id as string);
      if (!w) return notFound();
      return page(
        s()
          .deliveries.filter((d) => d.webhookId === w.id)
          .map(({ webhookId: _w, ...d }) => d),
        query.get('cursor'),
      );
    }),

    // Undo of a change a token made (D58, D124): the change's event is the connections mock's
    // own, so it answers here; any other event goes on to the inventory mock's undo.
    route('POST', inventoryPaths.undo(':id'), ({ params }) => {
      const c = s().changes.find((x) => x.undo?.eventId === params.id);
      if (!c) return PASS;
      c.undo = null;
      c.undoable_until = null;
      return { undoOf: c.id, eventId: newId() };
    }),

    // ----- the instance's sign-in, connectors and embeddings (T22, T24) -----
    ...instanceMockRoutes(state),
  ];
}
