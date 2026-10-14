/**
 * Step 6's instance-wide mock answers (for T22 and T24): the sign-in page's "Sign in with <name>"
 * (`GET /setup`'s `oidc`, T16), Better Auth's start of an OIDC sign-in, and Admin → Status's
 * OIDC, connectors and embeddings rows with the embeddings switch (T12, T14, T16). Kept beside
 * the scenario in a WeakMap, like the rest of Connections' mock state; these routes are composed
 * after the base server's, so they answer first.
 */
import { EMBEDDINGS_SOURCES, type EmbeddingsSource } from '@kept/shared';
import type { MockState } from '../../mock/fixtures';
import { err, type MockRoute, reply, route, sessionGate } from '../../mock/kit';
import { paths } from '../../paths';
import type { AdminStatus, EmbeddingsStatus, PutEmbeddingsBody, SignInMethod } from '../../types';

export type InstanceMock = {
  oidc: NonNullable<AdminStatus['oidc']>;
  /** 1.2 (D226): Google sign-in, off by default. */
  google: NonNullable<AdminStatus['google']>;
  /** The signed-in account's sign-in methods (Better Auth's list-accounts). */
  methods: SignInMethod[];
  /** The session is older than ten minutes: link and unlink answer SESSION_NOT_FRESH. */
  staleSession: boolean;
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
    google: { configured: false, callbackUrl: null },
    methods: [
      {
        id: 'acc-password',
        providerId: 'credential',
        accountId: 'u-ibrahim',
        createdAt: '2026-09-01T09:00:00.000Z',
      },
    ],
    staleSession: false,
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
      ...(s().google.configured ? { google: true } : {}),
    })),
    // Better Auth's generic-OAuth start (spike S6.7): `{provider, callbackURL, errorCallbackURL}`
    // → `{url}` at the IdP. The mock's IdP is a placeholder; tests stub the navigation.
    route('POST', paths.auth.signInSocial, ({ body }) => {
      const b = body as { provider?: string };
      if (b?.provider === 'google' && s().google.configured)
        return {
          url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=kept',
          redirect: true,
        };
      if (b?.provider !== 'oidc' || !s().oidc.configured)
        return err(404, 'not_found', 'Not found.');
      return {
        url: 'https://sso.example.net/application/o/authorize/?client_id=kept',
        redirect: true,
      };
    }),
    // Linking and unlinking (D176, D226): Better Auth's shapes, its fresh-session refusal included.
    route('GET', paths.auth.listAccounts, () => sessionGate(state) ?? s().methods),
    route('POST', paths.auth.linkSocial, ({ body }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      if (s().staleSession)
        return reply(403, {
          code: 'SESSION_NOT_FRESH',
          message: 'Sign in again, then link or unlink the account.',
        });
      const provider = (body as { provider?: string })?.provider;
      if (provider === 'google' && s().google.configured)
        return {
          url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=kept',
          redirect: false,
        };
      if (provider === 'oidc' && s().oidc.configured)
        return {
          url: 'https://sso.example.net/application/o/authorize/?client_id=kept',
          redirect: false,
        };
      return reply(404, { code: 'PROVIDER_NOT_FOUND', message: 'Provider not found' });
    }),
    route('POST', paths.auth.unlinkAccount, ({ body }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      if (s().staleSession)
        return reply(403, {
          code: 'SESSION_NOT_FRESH',
          message: 'Sign in again, then link or unlink the account.',
        });
      const id = (body as { accountId?: string })?.accountId;
      if (s().methods.length === 1)
        return reply(400, {
          code: 'FAILED_TO_UNLINK_LAST_ACCOUNT',
          message: "You can't unlink your last account",
        });
      if (!s().methods.some((m) => m.id === id))
        return reply(400, { code: 'ACCOUNT_NOT_FOUND', message: 'Account not found' });
      s().methods = s().methods.filter((m) => m.id !== id);
      return { status: true };
    }),
    route('GET', paths.admin.status, () => {
      const gate = requireAdmin();
      if (gate) return gate;
      const out: AdminStatus = {
        ...state.admin.status,
        oidc: s().oidc,
        google: s().google,
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
