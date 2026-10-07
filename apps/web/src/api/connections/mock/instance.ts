/**
 * Step 6's instance-wide mock answers (for T22 and T24): the sign-in page's "Sign in with <name>"
 * (`GET /setup`'s `oidc`, T16), Better Auth's start of an OIDC sign-in, and Admin → Status's
 * OIDC, connectors and embeddings rows with the embeddings switch (T12, T14, T16). Kept beside
 * the scenario in a WeakMap, like the rest of Connections' mock state; these routes are composed
 * after the base server's, so they answer first.
 */
import { EMBEDDINGS_SOURCES, type EmbeddingsSource } from '@kept/shared';
import type { MockState } from '../../mock/fixtures';
import { err, type MockRoute, route, sessionGate } from '../../mock/kit';
import { paths } from '../../paths';
import type { AdminStatus, EmbeddingsStatus, PutEmbeddingsBody } from '../../types';

export type InstanceMock = {
  oidc: NonNullable<AdminStatus['oidc']>;
  connectors: NonNullable<AdminStatus['connectors']>;
  embeddings: EmbeddingsStatus;
};

const origin = () => (typeof location === 'undefined' ? 'http://kept.test' : location.origin);

/** OIDC is configured as "Home SSO"; connectors need https, which a dev server hasn't got. */
function fixtures(): InstanceMock {
  return {
    oidc: {
      configured: true,
      name: 'Home SSO',
      issuer: 'https://sso.example.net/application/o/kept/',
      callbackUrl: `${origin()}/api/v1/auth/callback/oidc`,
      error: null,
    },
    connectors: { mcpUrl: `${origin()}/mcp`, oauth: 'needs_https' },
    embeddings: {
      source: 'provider',
      indexed: 8412,
      total: 10000,
      paused: null,
      local: { available: true, downloadBytes: 137_000_000, downloadedBytes: null },
    },
  };
}

const states = new WeakMap<MockState, InstanceMock>();

export function instanceMock(state: MockState): InstanceMock {
  let s = states.get(state);
  if (!s) {
    s = fixtures();
    states.set(state, s);
  }
  return s;
}

export function instanceMockRoutes(state: MockState): MockRoute[] {
  const s = () => instanceMock(state);
  const requireAdmin = () =>
    sessionGate(state) ??
    (state.me.user.instanceAdmin ? null : err(403, 'forbidden', "You don't have permission."));
  return [
    route('GET', paths.setup, () => ({
      needed: state.setupNeeded,
      oidc: s().oidc.configured && s().oidc.name ? { name: s().oidc.name } : null,
    })),
    // Better Auth's generic-OAuth start (spike S6.7): `{provider, callbackURL, errorCallbackURL}`
    // → `{url}` at the IdP. The mock's IdP is a placeholder; tests stub the navigation.
    route('POST', paths.auth.signInSocial, ({ body }) => {
      const b = body as { provider?: string };
      if (b?.provider !== 'oidc' || !s().oidc.configured)
        return err(404, 'not_found', 'Not found.');
      return {
        url: 'https://sso.example.net/application/o/authorize/?client_id=kept',
        redirect: true,
      };
    }),
    route('GET', paths.admin.status, () => {
      const gate = requireAdmin();
      if (gate) return gate;
      const out: AdminStatus = {
        ...state.admin.status,
        oidc: s().oidc,
        connectors: s().connectors,
        embeddings: s().embeddings,
      };
      return out;
    }),
    route('PUT', paths.admin.embeddings, ({ body }) => {
      const gate = requireAdmin();
      if (gate) return gate;
      const source = (body as PutEmbeddingsBody)?.source as EmbeddingsSource;
      if (!EMBEDDINGS_SOURCES.includes(source))
        return err(400, 'validation', 'The request is not valid.');
      const e = s().embeddings;
      if (source === 'local' && !e.local.available)
        return err(409, 'local_unavailable', 'The local model is not installed on this server.');
      e.source = source;
      if (source === 'local' && e.local.downloadBytes !== null) e.local.downloadedBytes = 0;
      return e;
    }),
  ];
}
