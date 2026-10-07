import { describe, expect, it } from 'vitest';
import { estimateCall } from './estimate.js';
import { loadMockAnswers, mockKey } from './mock.js';

describe('estimateCall (L43)', () => {
  it('Groq: 2,048 per image, and the pace estimate uses the expected output, not the cap', () => {
    const e = estimateCall({
      kind: 'groq',
      images: [{ width: 640, height: 900 }],
      promptText: 'x'.repeat(240),
      maxOutputTokens: 4548,
      expectedOutputTokens: 2500,
    });
    expect(e.imageTokensEach).toBe(2048);
    expect(e.inputTokens).toBe(100 + 32 + 2048);
    expect(e.reserveTokens).toBe(e.inputTokens + 4548);
    expect(e.paceTokens).toBe(e.inputTokens + 2500);
  });

  it('no images: no per-image figure; the expected output never exceeds the cap', () => {
    const e = estimateCall({
      kind: 'openai',
      images: [],
      promptText: 'hello',
      maxOutputTokens: 50,
      expectedOutputTokens: 500,
    });
    expect(e.imageTokensEach).toBeNull();
    expect(e.paceTokens).toBe(e.inputTokens + 50);
  });
});

describe('mock answers', () => {
  it('keys by the first 12 hex of SHA-256, and a missing file is an empty map', () => {
    expect(mockKey(new Uint8Array([1, 2, 3]))).toBe('039058c6f2c0');
    expect(loadMockAnswers('/nonexistent/mock-answers.json')).toEqual({});
  });
});
