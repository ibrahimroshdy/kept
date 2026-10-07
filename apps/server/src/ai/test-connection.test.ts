import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { kit, resolved } from '../../test/ai-kit.js';
import type { Price } from './cost.js';
import { createMockModel, mockKey } from './mock.js';
import { testConnection, testSquare } from './test-connection.js';

const req = { resolved: resolved('groq'), userId: 'owner', requestId: 'req-1', jobId: 'req-1' };

describe('testConnection (D202, L50)', () => {
  it('the square is 64×64 and carries no metadata', async () => {
    const meta = await sharp(await testSquare()).metadata();
    expect([meta.width, meta.height, meta.format, meta.exif]).toEqual([64, 64, 'jpeg', undefined]);
  });

  it('two connection_test rows; vision and structured both ok; tokens and cost summed', async () => {
    const price: Price = {
      id: 'p',
      inputPerMtok: '0.8',
      outputPerMtok: '4',
      reasoningPerMtok: null,
      cachedInputPerMtok: null,
      perImage: null,
      currency: 'USD',
    };
    const { rt, ledger } = kit({ runtime: { prices: async () => price } });
    const r = await testConnection(rt, req);
    expect(r.vision.ok).toBe(true);
    expect(r.structured.ok).toBe(true);
    expect(r.model).toBe('qwen/qwen3.8-27b');
    expect(ledger.rows.map((x) => [x.task, x.imageCount, x.attempt])).toEqual([
      ['connection_test', 1, 1],
      ['connection_test', 0, 2],
    ]);
    expect(r.tokens).toBe(
      ledger.rows.reduce((n, x) => n + (x.inputTokens ?? 0) + (x.outputTokens ?? 0), 0),
    );
    expect(r.cost).toMatchObject({ currency: 'USD', source: 'price_table' });
    expect(r.callIds).toHaveLength(2);
  });

  it('a model that cannot see the square fails vision and still tries structured output', async () => {
    const square = await testSquare();
    const { rt } = kit({
      runtime: { mock: { [mockKey(square)]: { text: 'I cannot see images' } } },
    });
    const r = await testConnection(rt, req);
    expect(r.vision).toMatchObject({ ok: false, error: 'wrong_answer' });
    expect(r.structured.ok).toBe(true);
    expect(r.cost).toBeNull();
  });

  it('a rejected key: vision paused (auth), structured not run', async () => {
    const square = await testSquare();
    const answers = { [mockKey(square)]: { error: { status: 401 } } };
    const { rt, ledger } = kit({ runtime: { modelFactory: () => createMockModel(answers) } });
    const r = await testConnection(rt, req);
    expect(r.vision).toEqual({ ok: false, latencyMs: null, error: 'paused_auth' });
    expect(r.structured.error).toBe('not_run');
    expect(ledger.rows).toHaveLength(1);
  });
});
