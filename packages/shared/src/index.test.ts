import { describe, expect, it } from 'vitest';
import { KEPT_VERSION } from './index.js';

describe('KEPT_VERSION', () => {
  it('is a string', () => {
    expect(typeof KEPT_VERSION).toBe('string');
  });
});
