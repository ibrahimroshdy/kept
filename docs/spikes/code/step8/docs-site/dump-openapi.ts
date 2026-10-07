// Spike D1: dump Kept's OpenAPI JSON from buildApp() in-process, with NO database.
// The pools point at 127.0.0.1:1 (nothing listens there); pg.Pool connects lazily, and the
// script counts connection attempts to prove none happen.
// Run from the repo root:
//   pnpm --filter @kept/server exec tsx ../../docs/spikes/code/step8/docs-site/dump-openapi.ts \
//     ../../docs/spikes/code/step8/docs-site/site/openapi/kept.json
import { writeFileSync } from 'node:fs';
import { buildApp, OPENAPI_PATH } from '../../../../../apps/server/src/http/app.js';
import { createPools, type Pools } from '../../../../../apps/server/src/db/pools.js';

const out = process.argv[2];
if (!out) throw new Error('usage: dump-openapi.ts <out.json>');

let attempts = 0;
const callers: string[] = [];
const nowhere = 'postgres://nobody:nobody@127.0.0.1:1/nothing';
// Kept's own createPools (the server's pg), every URL pointing nowhere.
const pools: Pools = createPools({
  KEPT_DATABASE_URL: nowhere,
  KEPT_AUTH_DATABASE_URL: nowhere,
  KEPT_SYSTEM_DATABASE_URL: nowhere,
});
const watch = (p: Pools['app']) => {
  p.on('connect', () => attempts++);
  p.on('error', () => attempts++);
  const orig = p.connect.bind(p);
  // biome-ignore lint/suspicious/noExplicitAny: spike instrumentation
  (p as any).connect = (...a: any[]) => {
    attempts++;
    callers.push(
      (new Error().stack ?? '')
        .split('\n')
        .filter((l) => l.includes('apps/server/src') || l.includes('better-auth') || l.includes('pg-boss'))
        .slice(0, 4)
        .map((l) => l.trim().replace(/\(.*\/(apps\/server\/src\/|node_modules\/)/, '('))
        .join(' <- '),
    );
    // biome-ignore lint/suspicious/noExplicitAny: spike instrumentation
    return (orig as any)(...a);
  };
};
for (const p of Object.values(pools)) watch(p);

const t0 = performance.now();
const app = await buildApp({ env: { KEPT_PUBLIC_URL: 'http://kept.test' } as never, pools });
await app.ready();
// Host = KEPT_PUBLIC_URL's host, so the former-hostnames hook (labels/former-hosts.ts) doesn't
// read instance_settings; inject's default Host (localhost:80) makes it try the database once.
const res = await app.inject({ method: 'GET', url: OPENAPI_PATH, headers: { host: 'kept.test' } });
const ms = Math.round(performance.now() - t0);
const doc = res.json() as { openapi: string; info: { version: string }; paths: Record<string, unknown> };
writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
const ops = Object.values(doc.paths).reduce<number>((n, p) => n + Object.keys(p as object).length, 0);
console.log(
  JSON.stringify({
    status: res.statusCode,
    openapi: doc.openapi,
    version: doc.info.version,
    paths: Object.keys(doc.paths).length,
    operations: ops,
    bytes: res.body.length,
    dbConnectionAttempts: attempts,
    callers,
    ms,
  }),
);
await app.close();
await Promise.all(Object.values(pools).map((p) => p.end()));
