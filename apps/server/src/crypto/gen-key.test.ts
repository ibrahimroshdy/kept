import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCli } from '../cli/index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('kept admin gen-key', () => {
  it('prints one 32-byte key as base64url and nothing else', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await buildCli().parseAsync(['admin', 'gen-key'], { from: 'user' });
    expect(log).toHaveBeenCalledTimes(1);
    const key = String(log.mock.calls[0]?.[0]);
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(key, 'base64url').length).toBe(32);
  });
});
