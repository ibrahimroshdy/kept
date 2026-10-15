#!/usr/bin/env node
// Every e2e instance at once (playwright.config.ts's one webServer entry). Playwright starts its
// webServer entries one after another, and each instance migrates, seeds and boots a database of
// its own (e2e/serve.mjs): fifteen in a row took about four minutes of every CI shard before a
// single test ran. This starts the same serve.mjs processes, several at a time, and answers
// 200 on /readyz only once every one of them answers 200 on its own /readyz.
//
//   node --conditions=kept-dist e2e/serve-all.mjs <status-port>
//
// The instances come from KEPT_E2E_SERVE: a JSON array of { name, port, seed, aiMock, https,
// owner } (playwright.config.ts writes it). KEPT_E2E_START_CONCURRENCY caps how many start at
// once (default 4: each seed opens its own pools on the dev Postgres, max_connections 100).
//
// One instance that exits before it is ready fails the whole start, with its output above. On
// SIGTERM or SIGINT (Playwright's gracefulShutdown) every serve.mjs gets SIGTERM, so each stops
// its server and drops its database, and this process exits once they all have.
import { spawn } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';

const statusPort = Number(process.argv[2]);
if (!Number.isInteger(statusPort)) {
  console.error('usage: node --conditions=kept-dist e2e/serve-all.mjs <status-port>');
  process.exit(2);
}
const instances = JSON.parse(process.env.KEPT_E2E_SERVE ?? '[]');
if (!Array.isArray(instances) || instances.length === 0) {
  console.error('serve-all: KEPT_E2E_SERVE names no instance');
  process.exit(2);
}
const limit = Math.max(
  1,
  Number(process.env.KEPT_E2E_START_CONCURRENCY) || Math.min(4, availableParallelism()),
);

const serve = fileURLToPath(new URL('./serve.mjs', import.meta.url));
const children = new Map();
let ready = false;
let stopping = false;

const urlOf = (i) => `${i.https ? 'https' : 'http'}://localhost:${i.port}/readyz`;

/** 200 from the instance's /readyz (its certificate is self-signed for the run). */
function answers(i) {
  return new Promise((resolve) => {
    const get = i.https ? https.get : http.get;
    const req = get(urlOf(i), { rejectUnauthorized: false, timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function stopAll(code) {
  if (stopping) return;
  stopping = true;
  const exits = [...children.values()].map(
    (child) =>
      new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once('exit', resolve);
        child.kill('SIGTERM');
      }),
  );
  await Promise.all(exits);
  process.exit(code);
}
process.on('SIGTERM', () => void stopAll(0));
process.on('SIGINT', () => void stopAll(0));

/** Starts one serve.mjs and resolves once its /readyz answers 200. */
function start(i) {
  const flags = [
    i.seed && '--seed',
    i.aiMock && '--ai-mock',
    i.https && '--https',
    i.owner && '--owner',
  ].filter(Boolean);
  const child = spawn(
    process.execPath,
    ['--conditions=kept-dist', serve, i.name, String(i.port), ...flags],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  children.set(i.name, child);
  const began = Date.now();
  return new Promise((resolve, reject) => {
    child.once('exit', (code, signal) => {
      if (!stopping) reject(new Error(`${i.name} exited (${signal ?? code}) before it was ready`));
    });
    const poll = async () => {
      if (stopping) return;
      if (await answers(i)) {
        console.log(`[serve-all] ${i.name} ready in ${((Date.now() - began) / 1000).toFixed(1)}s`);
        return resolve();
      }
      setTimeout(poll, 250);
    };
    void poll();
  });
}

// The status server first, so Playwright's poll gets an answer (503) while the instances start.
const status = http.createServer((_req, res) => {
  res.writeHead(ready ? 200 : 503).end(ready ? 'ready' : 'starting');
});
await new Promise((resolve) => status.listen(statusPort, 'localhost', resolve));

const began = Date.now();
const queue = [...instances];
try {
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let i = queue.shift(); i; i = queue.shift()) await start(i);
    }),
  );
  ready = true;
  console.log(
    `[serve-all] ${instances.length} instances ready in ${((Date.now() - began) / 1000).toFixed(1)}s (${limit} at a time)`,
  );
} catch (err) {
  console.error(`[serve-all] ${err.message}`);
  await stopAll(1);
}
