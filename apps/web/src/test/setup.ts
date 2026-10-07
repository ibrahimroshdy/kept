import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// findBy* and waitFor wait 1 s by default. A screen that answers in 100 ms alone can take longer
// when the full suite shares the CPU with other runs; 5 s still fails a screen that never answers
// well inside the 20 s test timeout (vitest.config.ts).
configure({ asyncUtilTimeout: 5_000 });

afterEach(() => {
  cleanup();
});
