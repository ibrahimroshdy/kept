import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type PgTools, pgTools } from '../src/backup/pg-tools.js';

// pg_dump and pg_restore for the backup tests (T31c). They must be the database server's major
// version (18). A developer's machine often has another one on the PATH (Homebrew's default is
// older), so when the local tools don't match, the tests run the ones inside the dev database's
// own container (compose.dev.yaml's `db`, pgvector/pgvector:*-pg18), which match it by
// construction: the same `docker compose exec` ci-local.sh already uses for psql. The URL is
// rewritten to the container's own port, and the password goes in through PGPASSWORD (-e).

const COMPOSE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'compose.dev.yaml',
);

/** Which tools the tests use, and why, for the test's own output. */
export type TestPgTools = { tools: PgTools; how: string };

export async function testPgTools(serverMajor: number): Promise<TestPgTools> {
  const local = pgTools();
  try {
    const v = await local.versions();
    if (v.dump === serverMajor && v.restore === serverMajor) {
      return { tools: local, how: `local pg_dump ${v.dump}` };
    }
  } catch {
    // Not installed: use the container's.
  }
  // The Docker Desktop credential helper can hang without a desktop session (ci-local.sh).
  process.env.DOCKER_CONFIG ??= '/tmp/kept-docker-config';
  const inContainer = pgTools({
    prefix: ['docker', 'compose', '-f', COMPOSE, 'exec', '-T', '-e', 'PGPASSWORD', 'db'],
    mapUrl: (url) => {
      const u = new URL(url);
      u.hostname = 'localhost';
      u.port = '5432';
      return u.toString();
    },
  });
  const v = await inContainer.versions();
  if (v.dump !== serverMajor || v.restore !== serverMajor) {
    throw new Error(`the dev database container's pg_dump is ${v.dump}, the server ${serverMajor}`);
  }
  return { tools: inContainer, how: `pg_dump ${v.dump} in the dev database container` };
}
