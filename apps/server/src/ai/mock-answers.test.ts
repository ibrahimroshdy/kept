/**
 * The mock's answers file (KEPT_AI_MOCK=1): a running server answers from a file keyed by the
 * sent image's hash, so the e2e run can give its receipt a `$` (StartOptions.aiMockAnswersFile,
 * apps/web/e2e/serve.mjs). Without the mock there are no answers at all.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import { createMockModel, mockKey } from './mock.js';
import { MOCK_ANSWERS_PATH, mockAnswersFor } from './runtime.js';

const receiptCall = (bytes: Uint8Array) =>
  ({
    prompt: [{ role: 'user', content: [{ type: 'file', data: bytes, mediaType: 'image/jpeg' }] }],
    responseFormat: { type: 'json', name: 'kept_receipt' },
  }) as unknown as LanguageModelV4CallOptions;

const textOf = (r: Awaited<ReturnType<ReturnType<typeof createMockModel>['doGenerate']>>) =>
  r.content.map((c) => (c.type === 'text' ? c.text : '')).join('');

describe('the mock answers file', () => {
  it('answers an image from the file named, by its hash; others get the mode default', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kept-mock-'));
    const file = path.join(dir, 'answers.json');
    const receipt = new Uint8Array([0xff, 0xd8, 1, 2, 3]);
    const other = new Uint8Array([0xff, 0xd8, 9]);
    writeFileSync(
      file,
      JSON.stringify({
        [mockKey(receipt)]: {
          output: { currency: { value: '$', confidence: 0.9 }, lines: [] },
        },
      }),
    );
    const answers = mockAnswersFor(true, file);
    expect(Object.keys(answers ?? {})).toEqual([mockKey(receipt)]);
    const model = createMockModel(answers ?? {});
    expect(JSON.parse(textOf(await model.doGenerate(receiptCall(receipt)))).currency.value).toBe(
      '$',
    );
    expect(JSON.parse(textOf(await model.doGenerate(receiptCall(other)))).currency.value).toBe(
      'EGP',
    );
  });

  it('is T11’s fixtures by default, and nothing without the mock', () => {
    expect(
      MOCK_ANSWERS_PATH.endsWith(path.join('test', 'fixtures', 'eval', 'mock-answers.json')),
    ).toBe(true);
    expect(mockAnswersFor(false, '/nonexistent.json')).toBeNull();
  });
});
