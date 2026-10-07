// Writes Kept's OpenAPI document for the API reference (D199), from the server's own buildApp()
// in-process: no database, no running server (spike D1, finding 1). Every pool points at a closed
// port, and the request's Host is the public URL's, so even the former-hostnames hook doesn't try
// a read. A connection attempt fails the script, so "no database" stays true.
//
//   pnpm --filter @kept/docs gen:openapi        (writes openapi/kept.json, git-ignored)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createPools } from '../../server/src/db/pools.js';
import { buildApp, OPENAPI_PATH } from '../../server/src/http/app.js';

const out = process.argv[2];
if (!out) throw new Error('usage: openapi.ts <out.json>');

const nowhere = 'postgres://nobody:nobody@127.0.0.1:1/nothing';
const pools = createPools({
  KEPT_DATABASE_URL: nowhere,
  KEPT_AUTH_DATABASE_URL: nowhere,
  KEPT_SYSTEM_DATABASE_URL: nowhere,
});
// Count every attempt, including ones that fail (a hook may catch the error and still answer).
let attempts = 0;
for (const pool of Object.values(pools)) {
  const connect = pool.connect.bind(pool) as (...a: unknown[]) => unknown;
  (pool as unknown as { connect: (...a: unknown[]) => unknown }).connect = (...a) => {
    attempts++;
    return connect(...a);
  };
}

const app = await buildApp({ env: { KEPT_PUBLIC_URL: 'http://kept.test' } as never, pools });
try {
  await app.ready();
  const res = await app.inject({
    method: 'GET',
    url: OPENAPI_PATH,
    headers: { host: 'kept.test' },
  });
  if (res.statusCode !== 200) throw new Error(`${OPENAPI_PATH} answered ${res.statusCode}`);
  const doc = res.json() as { openapi: string; paths: Record<string, object> };
  if (attempts > 0) throw new Error(`building the document touched the database (${attempts})`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(doc)}\n`);
  const operations = Object.values(doc.paths).reduce((n, p) => n + Object.keys(p).length, 0);
  console.log(
    `openapi: ${out}: OpenAPI ${doc.openapi}, ${Object.keys(doc.paths).length} paths, ${operations} operations`,
  );
} finally {
  await app.close();
  await Promise.all(Object.values(pools).map((p) => p.end()));
}
