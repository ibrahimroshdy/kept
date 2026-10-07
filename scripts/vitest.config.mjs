import { defineConfig } from 'vitest/config';

// Tests for the repo's own CI scripts (check-licences, ...). No database.
export default defineConfig({
  test: {
    name: 'scripts',
    environment: 'node',
    include: ['*.test.mjs'],
  },
});
