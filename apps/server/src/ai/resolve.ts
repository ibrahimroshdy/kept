/**
 * Who pays, and with which key (D121, D167, D206; step-3 plan Q5; product design §8a "Resolution
 * order"). With T6 the cascade runs inside `kept.ai_provider_for`, the only way application
 * code reaches a key; this is the same order in TypeScript, for the in-memory KeyStore and as
 * the executable statement of the rule the door's tests check.
 *
 * - A **Personal** location: its owner's user key → their account key → the instance key.
 * - Any **other** location: its owner account's key → the instance key. A member's personal
 *   key never pays for someone else's home, nor for a shared home they belong to.
 * - No location (a private thread, a turn spanning owners, D167): the asker's own key → their
 *   account's key → the instance key.
 * - Per task, the first scope with a model **for that task** wins (Groq has no embeddings model,
 *   so embeddings fall through).
 * "Usable" is: not disabled; a key, or `openai_compatible` with a base URL; not tripped `auth`.
 */
import type { AiTask, ProviderKind } from '@kept/shared';
import type { Payer, PayerScope, Resolved } from './ports.js';
import type { Reasoning } from './providers.js';

export type ProviderRow = {
  id: string;
  scope: PayerScope;
  ownerAccountId: string | null;
  userId: string | null;
  kind: ProviderKind;
  baseUrl: string | null;
  models: { vision?: string | null; chat?: string | null; embeddings?: string | null };
  reasoning: Reasoning;
  structured?: boolean;
  disabled: boolean;
  /** Only the in-memory store holds a key in the clear; the DB never returns one here. */
  apiKey: string | null;
  authTripped?: boolean;
};

export type LocationFacts = {
  id: string;
  ownerAccountId: string;
  ownerUserId: string;
  personal: boolean;
};

const MODEL_FOR_TASK = {
  extraction: 'vision',
  assistant: 'chat',
  embeddings: 'embeddings',
} as const;

export function modelForTask(p: ProviderRow, task: AiTask): string | null {
  return p.models[MODEL_FOR_TASK[task]] ?? null;
}

function usable(p: ProviderRow): boolean {
  if (p.disabled || p.authTripped) return false;
  return p.apiKey !== null || (p.kind === 'openai_compatible' && p.baseUrl !== null);
}

export function payerOf(p: ProviderRow, fellBack: boolean): Payer {
  switch (p.scope) {
    case 'instance':
      return { scope: 'instance', accountId: null, userId: null, fellBack };
    case 'account':
      return { scope: 'account', accountId: p.ownerAccountId, userId: null, fellBack };
    case 'user':
      return { scope: 'user', accountId: null, userId: p.userId, fellBack };
  }
}

/**
 * The provider that pays for `task`, or null. `userAccountId` is the asker's own account
 * (personal work with no location).
 */
export function cascade(input: {
  providers: readonly ProviderRow[];
  location: LocationFacts | null;
  userId: string | null;
  userAccountId: string | null;
  task: AiTask;
}): Resolved | null {
  const { providers, location, userId, userAccountId, task } = input;
  const find = (scope: PayerScope, id: string | null) =>
    id === null
      ? undefined
      : providers.find(
          (p) =>
            p.scope === scope &&
            !p.disabled &&
            (scope === 'instance' ||
              (scope === 'account' ? p.ownerAccountId === id : p.userId === id)),
        );
  const instance = providers.find((p) => p.scope === 'instance' && !p.disabled);

  let order: (ProviderRow | undefined)[];
  let ownerAccountId: string | null;
  if (location) {
    ownerAccountId = location.ownerAccountId;
    order = location.personal
      ? [find('user', location.ownerUserId), find('account', location.ownerAccountId), instance]
      : [find('account', location.ownerAccountId), instance];
  } else {
    ownerAccountId = userAccountId;
    order = [find('user', userId), find('account', userAccountId), instance];
  }

  for (let i = 0; i < order.length; i++) {
    const p = order[i];
    if (!p || !usable(p)) continue;
    const model = modelForTask(p, task);
    if (!model) continue;
    return {
      provider: {
        id: p.id,
        scope: p.scope,
        kind: p.kind,
        baseUrl: p.baseUrl,
        model,
        reasoning: p.reasoning,
        ...(p.structured === undefined ? {} : { structured: p.structured }),
      },
      apiKey: p.apiKey,
      payer: payerOf(p, i > 0),
      ownerAccountId,
    };
  }
  return null;
}
