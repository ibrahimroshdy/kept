/**
 * The DB-backed KeyStore (ports.ts; step-3 T6). Keys come only from `kept.ai_provider_for` (a
 * call's cascade, plan Q5) and `kept.ai_provider_secret` (one provider its manager tests, T9):
 * kept_app holds no SELECT on `ai_providers.key_ciphertext`. The key is opened with the keyring
 * here and lives only in the returned `Resolved`, in the caller's frame; it is never logged.
 */
import type { AiTask, ProviderKind } from '@kept/shared';
import type pg from 'pg';
import { type Aad, type Keyring, open, type Sealed } from '../crypto/envelope.js';
import type { DoorRunner } from './db-run.js';
import type { KeyStore, PayerScope, Resolved, ResolveRequest } from './ports.js';
import type { Reasoning } from './providers.js';

/** The AAD a provider's key is sealed under (T9 seals with the same). */
export const providerKeyAad = (providerId: string): Aad => ({
  table: 'ai_providers',
  rowId: providerId,
  fieldKey: 'api_key',
});

type ProviderForRow = {
  provider_id: string;
  scope: PayerScope;
  kind: ProviderKind;
  base_url: string | null;
  model: string;
  reasoning: Reasoning;
  structured: boolean;
  key_ciphertext: Sealed | null;
  paying_scope: PayerScope;
  paying_account_id: string | null;
  paying_user_id: string | null;
  fell_back: boolean;
  owner_account_id: string | null;
};

function openKey(keyring: Keyring, providerId: string, sealed: Sealed | null): string | null {
  return sealed ? open(keyring, sealed, providerKeyAad(providerId)).toString('utf8') : null;
}

/**
 * The provider that pays for `task` in `locationId` (null: the caller's own work), inside the
 * caller's scoped transaction, with its key opened; null when AI is off there (no usable
 * provider with a model for the task). 42501 for a location the caller can't use.
 */
export async function resolveFor(
  client: pg.ClientBase,
  keyring: Keyring,
  locationId: string | null,
  task: AiTask,
): Promise<Resolved | null> {
  const { rows } = await client.query<ProviderForRow>(
    'SELECT * FROM kept.ai_provider_for($1, $2)',
    [locationId, task],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    provider: {
      id: r.provider_id,
      scope: r.scope,
      kind: r.kind,
      baseUrl: r.base_url,
      model: r.model,
      reasoning: r.reasoning,
      structured: r.structured,
    },
    apiKey: openKey(keyring, r.provider_id, r.key_ciphertext),
    payer: {
      scope: r.paying_scope,
      accountId: r.paying_account_id,
      userId: r.paying_user_id,
      fellBack: r.fell_back,
    },
    ownerAccountId: r.owner_account_id,
  };
}

type SecretRow = {
  kind: ProviderKind;
  base_url: string | null;
  key_ciphertext: Sealed | null;
  model: string | null;
  scope: PayerScope;
  owner_account_id: string | null;
  user_id: string | null;
  reasoning: Reasoning;
  structured: boolean;
};

export class DbKeyStore implements KeyStore {
  constructor(
    private readonly run: DoorRunner,
    private readonly keyring: Keyring,
  ) {}

  resolve(req: ResolveRequest): Promise<Resolved | null> {
    return this.run((client) => resolveFor(client, this.keyring, req.locationId, req.task));
  }

  async forProvider(providerId: string, task: AiTask): Promise<Resolved | null> {
    const r = await this.run(async (client) => {
      const { rows } = await client.query<SecretRow>(
        'SELECT * FROM kept.ai_provider_secret($1, $2)',
        [providerId, task],
      );
      return rows[0];
    });
    if (!r?.model) return null;
    return {
      provider: {
        id: providerId,
        scope: r.scope,
        kind: r.kind,
        baseUrl: r.base_url,
        model: r.model,
        reasoning: r.reasoning,
        structured: r.structured,
      },
      apiKey: openKey(this.keyring, providerId, r.key_ciphertext),
      payer: {
        scope: r.scope,
        accountId: r.scope === 'account' ? r.owner_account_id : null,
        userId: r.scope === 'user' ? r.user_id : null,
        fellBack: false,
      },
      ownerAccountId: r.owner_account_id,
    };
  }
}

type SystemProviderRow = ProviderForRow & { tripped_until: Date | null };

/**
 * The provider that pays for a location's background embeddings (step-6 T14, D206: "Kept
 * (background)"), through `kept.ai_provider_for_system` on a kept_system transaction: the same
 * cascade as `resolveFor`, for `embeddings` only, with no caller. Null when the location has no
 * embeddings model anywhere in its cascade (it stays keyword-only), or while the provider's
 * breaker holds it (`tripped_until` in the future).
 */
export async function resolveForSystem(
  client: pg.ClientBase,
  keyring: Keyring,
  locationId: string,
  now: Date = new Date(),
): Promise<Resolved | null> {
  const { rows } = await client.query<SystemProviderRow>(
    `SELECT * FROM kept.ai_provider_for_system($1, 'embeddings')`,
    [locationId],
  );
  const r = rows[0];
  if (!r?.model) return null;
  if (r.tripped_until && r.tripped_until.getTime() > now.getTime()) return null;
  return {
    provider: {
      id: r.provider_id,
      scope: r.scope,
      kind: r.kind,
      baseUrl: r.base_url,
      model: r.model,
      reasoning: r.reasoning,
      structured: r.structured,
    },
    apiKey: openKey(keyring, r.provider_id, r.key_ciphertext),
    payer: {
      scope: r.paying_scope,
      accountId: r.paying_account_id,
      userId: r.paying_user_id,
      fellBack: r.fell_back,
    },
    ownerAccountId: r.owner_account_id,
  };
}
