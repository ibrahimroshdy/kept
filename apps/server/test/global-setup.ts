import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '../src/db/migrate.js';
import { newRunId, runDbPattern, templateDbName } from './names.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /** This run's id; worker databases and the template are named after it (test/names.ts). */
    keptRunId: string;
  }
}

const SUPERUSER_URL = 'postgres://postgres:postgres@localhost:5452/postgres';

async function withSuperuser<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: SUPERUSER_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// Runs once, in the main process, before any worker is spawned (§7.12). TZ is set per project
// with `test.env`, not here.
export async function setup(project: TestProject): Promise<() => Promise<void>> {
  const runId = newRunId();
  const template = templateDbName(runId);
  project.provide('keptRunId', runId);

  await withSuperuser((client) => client.query(`CREATE DATABASE ${template} OWNER kept_owner`));
  await runMigrations(`postgres://kept_owner:kept_owner@localhost:5452/${template}`);
  // Marking it a template also stops ordinary roles from connecting to or dropping it.
  await withSuperuser((client) => client.query(`ALTER DATABASE ${template} IS_TEMPLATE true`));

  return async function teardown() {
    await withSuperuser(async (client) => {
      const { rows } = await client.query<{ datname: string }>(
        `SELECT datname FROM pg_database WHERE datname LIKE $1`,
        [runDbPattern(runId)],
      );
      for (const { datname } of rows) {
        await client.query(`ALTER DATABASE ${datname} IS_TEMPLATE false`);
        await client.query(`DROP DATABASE ${datname} WITH (FORCE)`);
      }
    });
  };
}
