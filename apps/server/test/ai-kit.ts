// Test helpers for the AI provider layer (src/ai): an in-memory runtime with a controllable
// clock, and small images. Test-only; never imported by src.
import type { ProviderKind } from '@kept/shared';
import sharp from 'sharp';
import type { AiRuntime, ImageInput } from '../src/ai/call.js';
import {
  type CapRow,
  InMemoryBudgetGate,
  InMemoryKeyStore,
  InMemoryLedger,
  InMemoryPacer,
} from '../src/ai/memory.js';
import type { Resolved } from '../src/ai/ports.js';
import type { LocationFacts, ProviderRow } from '../src/ai/resolve.js';

export const T0 = new Date('2026-09-26T12:00:00.000Z');

export function kit(
  opts: {
    providers?: ProviderRow[];
    locations?: LocationFacts[];
    userAccounts?: Record<string, string>;
    caps?: CapRow[];
    runtime?: Partial<AiRuntime>;
  } = {},
) {
  const ledger = new InMemoryLedger();
  const gate = new InMemoryBudgetGate(opts.caps ?? []);
  const pacer = new InMemoryPacer();
  let now = T0.getTime();
  const clock = {
    now: () => new Date(now),
    advance: (ms: number) => {
      now += ms;
    },
  };
  const sleeps: number[] = [];
  const logs: { obj: Record<string, unknown>; msg: string }[] = [];
  const rt: AiRuntime = {
    keys: new InMemoryKeyStore(opts.providers ?? [], opts.locations ?? [], opts.userAccounts ?? {}),
    ledger,
    gate,
    pacer,
    prices: async () => null,
    fetch: (() => {
      throw new Error('no network in unit tests');
    }) as unknown as typeof fetch,
    now: clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.advance(ms);
    },
    log: {
      warn: (obj, msg) => logs.push({ obj, msg }),
      info: (obj, msg) => logs.push({ obj, msg }),
    },
    mock: {},
    ...opts.runtime,
  };
  return { rt, ledger, gate, pacer, clock, sleeps, logs };
}

export function resolved(
  kind: ProviderKind = 'groq',
  over: Partial<Resolved['provider']> = {},
  payer: Partial<Resolved['payer']> = {},
): Resolved {
  return {
    provider: {
      id: `prov-${kind}`,
      scope: 'account',
      kind,
      baseUrl: kind === 'openai_compatible' ? 'https://llm.example.test/v1' : null,
      model: kind === 'groq' ? 'qwen/qwen3.8-27b' : 'some-model',
      reasoning: 'low',
      ...over,
    },
    apiKey: 'test-key-TESTKEYMARKER0123456789',
    payer: { scope: 'account', accountId: 'acct-1', userId: null, fellBack: false, ...payer },
    ownerAccountId: 'acct-1',
  };
}

/** A small EXIF-free JPEG; the colour makes its hash (and so its mock answer) distinct. */
export async function jpeg(colour: string, width = 64, height = 64): Promise<ImageInput> {
  const bytes = await sharp({ create: { width, height, channels: 3, background: colour } })
    .jpeg()
    .toBuffer();
  return { bytes, mediaType: 'image/jpeg', width, height };
}
