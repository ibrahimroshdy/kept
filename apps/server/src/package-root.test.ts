import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { migrationsFolder } from './db/migrate.js';
import { packageRoot } from './package-root.js';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('packageRoot', () => {
  it('finds apps/server from a source file', () => {
    expect(packageRoot(import.meta.url)).toBe(serverRoot);
  });

  it('finds the same root from where the built file lives', () => {
    const built = pathToFileURL(path.join(serverRoot, 'dist', 'db', 'migrate.js')).href;
    expect(packageRoot(built)).toBe(serverRoot);
  });

  it('puts the migrations folder at the package root, where the journal is', () => {
    expect(migrationsFolder).toBe(path.join(serverRoot, 'migrations'));
    expect(existsSync(path.join(migrationsFolder, 'meta', '_journal.json'))).toBe(true);
  });
});
