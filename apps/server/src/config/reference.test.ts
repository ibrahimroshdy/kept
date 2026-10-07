import { describe, expect, it } from 'vitest';
import { envSchema } from './env.js';
import { renderEnvReference } from './reference.js';

describe('renderEnvReference', () => {
  it('contains every variable name from the env schema', () => {
    const text = renderEnvReference();
    for (const name of Object.keys(envSchema.shape)) {
      expect(text).toContain(name);
    }
  });

  it('has a Default column: the default where there is one, blank where there is not', () => {
    const lines = renderEnvReference().split('\n');
    expect(lines[0]).toBe('| Variable | Default | Notes |');
    expect(lines).toContainEqual(expect.stringMatching(/^\| `KEPT_ROLE` \| `all` \| /));
    expect(lines).toContainEqual(expect.stringMatching(/^\| `KEPT_LOG_LEVEL` \| `info` \| /));
    expect(lines).toContainEqual(expect.stringMatching(/^\| `KEPT_CONFIG_DIR` \| `\/config` \| /));
    expect(lines).toContainEqual(expect.stringMatching(/^\| `KEPT_DATABASE_URL` \| {2}\| /));
  });
});
