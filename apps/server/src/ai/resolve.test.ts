import { describe, expect, it } from 'vitest';
import { cascade, type LocationFacts, type ProviderRow } from './resolve.js';

const p = (over: Partial<ProviderRow> & Pick<ProviderRow, 'id' | 'scope'>): ProviderRow => ({
  ownerAccountId: null,
  userId: null,
  kind: 'groq',
  baseUrl: null,
  models: { vision: 'qwen/qwen3.8-27b', chat: 'openai/gpt-oss-120b', embeddings: null },
  reasoning: 'low',
  disabled: false,
  apiKey: 'k',
  ...over,
});

const instance = p({
  id: 'inst',
  scope: 'instance',
  kind: 'openai',
  models: { vision: 'v', chat: 'c', embeddings: 'e' },
});
const alfredAccount = p({ id: 'alfred-acct', scope: 'account', ownerAccountId: 'acct-alfred' });
const alfredUser = p({ id: 'alfred-user', scope: 'user', userId: 'alfred' });
const bruceUser = p({ id: 'bruce-user', scope: 'user', userId: 'bruce' });
const providers = [instance, alfredAccount, alfredUser, bruceUser];

const shared: LocationFacts = {
  id: 'home',
  ownerAccountId: 'acct-alfred',
  ownerUserId: 'alfred',
  personal: false,
};
const alfredPersonal: LocationFacts = {
  id: 'alfred-p',
  ownerAccountId: 'acct-alfred',
  ownerUserId: 'alfred',
  personal: true,
};

describe('cascade (Q5, D121, D206)', () => {
  it('a shared location is paid by its owner account, never a member’s personal key', () => {
    const r = cascade({
      providers,
      location: shared,
      userId: 'bruce',
      userAccountId: 'acct-bruce',
      task: 'extraction',
    });
    expect(r?.provider.id).toBe('alfred-acct');
    expect(r?.payer).toEqual({
      scope: 'account',
      accountId: 'acct-alfred',
      userId: null,
      fellBack: false,
    });
    expect(r?.ownerAccountId).toBe('acct-alfred');
  });

  it('nor its owner’s personal key: a personal key never pays for a shared home', () => {
    const r = cascade({
      providers: [instance, alfredUser],
      location: shared,
      userId: 'alfred',
      userAccountId: 'acct-alfred',
      task: 'extraction',
    });
    expect(r?.provider.id).toBe('inst');
    expect(r?.payer).toEqual({ scope: 'instance', accountId: null, userId: null, fellBack: true });
  });

  it('a Personal location: the owner’s key, then their account, then the instance', () => {
    expect(
      cascade({
        providers,
        location: alfredPersonal,
        userId: 'alfred',
        userAccountId: 'acct-alfred',
        task: 'extraction',
      })?.provider.id,
    ).toBe('alfred-user');
    expect(
      cascade({
        providers: [instance, alfredAccount],
        location: alfredPersonal,
        userId: 'alfred',
        userAccountId: 'acct-alfred',
        task: 'extraction',
      })?.payer,
    ).toMatchObject({ scope: 'account', fellBack: true });
  });

  it('per task: the first scope with a model for it (Groq has no embeddings)', () => {
    const r = cascade({
      providers,
      location: shared,
      userId: 'bruce',
      userAccountId: 'acct-bruce',
      task: 'embeddings',
    });
    expect(r?.provider).toMatchObject({ id: 'inst', model: 'e' });
    expect(r?.payer.fellBack).toBe(true);
  });

  it('no location: the asker’s key, then their account, then the instance', () => {
    expect(
      cascade({
        providers,
        location: null,
        userId: 'bruce',
        userAccountId: 'acct-bruce',
        task: 'assistant',
      })?.provider.id,
    ).toBe('bruce-user');
    expect(
      cascade({
        providers: [instance, alfredAccount],
        location: null,
        userId: 'alfred',
        userAccountId: 'acct-alfred',
        task: 'assistant',
      })?.provider.id,
    ).toBe('alfred-acct');
  });

  it('skips disabled, keyless and auth-tripped providers; null when nothing is usable (D19)', () => {
    const list = [
      p({ ...alfredAccount, disabled: true }),
      p({ id: 'x', scope: 'instance', apiKey: null }),
    ];
    expect(
      cascade({
        providers: list,
        location: shared,
        userId: null,
        userAccountId: null,
        task: 'extraction',
      }),
    ).toBeNull();
    const tripped = [p({ ...alfredAccount, authTripped: true }), instance];
    expect(
      cascade({
        providers: tripped,
        location: shared,
        userId: null,
        userAccountId: null,
        task: 'extraction',
      })?.provider.id,
    ).toBe('inst');
    const compat = [
      p({
        id: 'c',
        scope: 'instance',
        kind: 'openai_compatible',
        baseUrl: 'http://ollama.lan:11434/v1',
        apiKey: null,
      }),
    ];
    expect(
      cascade({
        providers: compat,
        location: shared,
        userId: null,
        userAccountId: null,
        task: 'extraction',
      })?.provider.id,
    ).toBe('c');
  });
});
