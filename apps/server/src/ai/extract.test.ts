import { CAPTURE_MODES, EXTRACTION_SCHEMAS } from '@kept/shared';
import { describe, expect, it } from 'vitest';
import { jpeg, kit } from '../../test/ai-kit.js';
import { PROMPT_VERSIONS } from '../extraction/prompts/index.js';
import { extract } from './extract.js';
import { mockKey } from './mock.js';
import type { ProviderRow } from './resolve.js';
import { ledgerPromptVersion, WIRE_VARIANTS } from './wire.js';

const groq: ProviderRow = {
  id: 'p-groq',
  scope: 'account',
  ownerAccountId: 'acct-1',
  userId: null,
  kind: 'groq',
  baseUrl: null,
  models: { vision: 'qwen/qwen3.8-27b', chat: 'openai/gpt-oss-120b' },
  reasoning: 'low',
  disabled: false,
  apiKey: 'test-key-groq',
};
const home = { id: 'loc-1', ownerAccountId: 'acct-1', ownerUserId: 'owner', personal: false };
const prompt = { system: 'Read it.', text: 'Read this.', version: 'v1' };
const base = {
  locationId: 'loc-1',
  userId: 'member-1',
  links: {},
  requestId: 'r',
  attempt: 1,
  jobId: 'j',
};

describe('extract (mock provider)', () => {
  it.each(CAPTURE_MODES)(
    '%s: a schema-valid answer, the ledger task and the output cap',
    async (mode) => {
      const { rt, ledger } = kit({ providers: [groq], locations: [home] });
      const img = await jpeg('#abcdef');
      const r = await extract(rt, { ...base, mode, images: [img], prompt });
      expect(r.status).toBe('ok');
      if (r.status !== 'ok') return;
      expect(EXTRACTION_SCHEMAS[mode].safeParse(r.value.value).success).toBe(true);
      expect(ledger.rows[0]).toMatchObject({
        task: `extract_${mode}`,
        payingAccountId: 'acct-1',
        userId: 'member-1',
        promptVersion: mode === 'receipt' ? 'v1+req' : 'v1',
      });
    },
  );

  it('names the wire variant sent in prompt_version: +req for receipt-required, nothing for simple', async () => {
    const { rt, ledger } = kit({ providers: [groq], locations: [home] });
    const img = await jpeg('#123456');
    const receipt = { ...prompt, version: 'receipt-v1' };
    await extract(rt, { ...base, mode: 'receipt', images: [img], prompt: receipt });
    await extract(rt, {
      ...base,
      mode: 'receipt',
      images: [img],
      prompt: receipt,
      wire: 'simple',
    });
    expect(ledger.rows.map((r) => r.promptVersion)).toEqual(['receipt-v1+req', 'receipt-v1']);
  });

  it('keeps every prompt_version within the ledger’s 20 characters', () => {
    for (const mode of CAPTURE_MODES) {
      for (const v of WIRE_VARIANTS) {
        expect(ledgerPromptVersion(PROMPT_VERSIONS[mode], mode, v).length).toBeLessThanOrEqual(20);
      }
    }
    expect(ledgerPromptVersion('receipt-v2', 'receipt', 'receipt-required')).toBe('receipt-v2+req');
  });

  it('sends the mode’s JSON allowance plus the reasoning allowance as maxOutputTokens', async () => {
    const { rt, ledger } = kit({ providers: [groq], locations: [home] });
    await extract(rt, { ...base, mode: 'receipt', images: [await jpeg('#010203')], prompt });
    // outputTokenCap('receipt', 'low') = 2500 + 2048; the estimate reserves input + that.
    expect(ledger.rows[0]?.estimateTokens).toBeGreaterThan(4548);
  });

  it('drops a failing optional field and reports it (L52)', async () => {
    const img = await jpeg('#0a0b0c');
    const { rt } = kit({
      providers: [groq],
      locations: [home],
      runtime: {
        mock: {
          [mockKey(img.bytes)]: {
            output: {
              value: { value: 52340, confidence: 0.98 },
              unit: { value: 'kms', confidence: 0.4 },
            },
          },
        },
      },
    });
    const r = await extract(rt, { ...base, mode: 'reading', images: [img], prompt });
    expect(r).toMatchObject({
      status: 'ok',
      value: { value: { value: { value: 52340, confidence: 0.98 } }, dropped: ['unit'] },
    });
  });

  it('no provider → no_provider, and no ledger row (D19: everything still works)', async () => {
    const { rt, ledger } = kit({ providers: [], locations: [home] });
    expect(
      await extract(rt, { ...base, mode: 'thing', images: [await jpeg('#fff000')], prompt }),
    ).toEqual({ status: 'no_provider' });
    expect(ledger.rows).toHaveLength(0);
  });
});
