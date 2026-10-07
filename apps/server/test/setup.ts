import { afterAll } from 'vitest';
import { closeTestDbs } from './db.js';

// Runs in every test file of this project (setupFiles): close the file's pools when it ends.
afterAll(async () => {
  await closeTestDbs();
});
