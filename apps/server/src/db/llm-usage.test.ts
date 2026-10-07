import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testDb } from '../../test/db.js';
import { ownerTx } from '../../test/tenancy.js';

// Step 6 (0092, 0093; spike S6.4 finding 5): a ledger row whose provider reported no tokens
// carries Kept's estimate, flagged usage_estimated.

const db = await testDb();
vi.setConfig({ testTimeout: 60_000 });

const ctx = {
  request_id: 'r-embed',
  task: 'embed_thing',
  paying_scope: 'instance',
  provider_kind: 'google',
  model: 'gemini-embedding-001',
  estimate_tokens: 120,
};
const insert = (usage: object) =>
  ownerTx(db, async (c) => {
    const { rows: made } = await c.query<{ id: string }>(
      `SELECT kept.ai_insert_call($1, $2, 'ok', '{}') AS id`,
      [JSON.stringify(ctx), JSON.stringify(usage)],
    );
    const { rows } = await c.query<{ input_tokens: number | null; usage_estimated: boolean }>(
      'SELECT input_tokens, usage_estimated FROM public.llm_calls WHERE id = $1',
      [made[0]?.id],
    );
    return rows;
  });

beforeEach(async () => {
  await db.reset();
});

describe('llm_calls.usage_estimated', () => {
  it('is set from the usage of a sent call, and false otherwise', async () => {
    expect(await insert({ sent: true, input_tokens: 120, usage_estimated: true })).toEqual([
      { input_tokens: 120, usage_estimated: true },
    ]);
    expect(await insert({ sent: true, input_tokens: 98 })).toEqual([
      { input_tokens: 98, usage_estimated: false },
    ]);
    expect(await insert({ sent: false, usage_estimated: true })).toEqual([
      { input_tokens: null, usage_estimated: false },
    ]);
  });
});
