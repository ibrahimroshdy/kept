#!/usr/bin/env node
// One Kept instance for the e2e run (playwright.config.ts starts one per entry in
// e2e/instances.ts). Run with the compiled server, the way production runs it:
//
//   node --conditions=kept-dist e2e/serve.mjs <name> <port> [--seed] [--ai-mock] [--https] [--owner]
//
// 1. Creates a scratch database `kept_e2e_<name>_<pid>` on the dev Postgres (localhost:5452,
//    compose.dev.yaml), never the dev `kept` database, and migrates it as kept_owner.
// 2. With --seed, runs `kept admin seed --scenario households` against it (the seed refuses
//    NODE_ENV=production, so only that command runs in development mode).
// 3. Starts the built server in this process (apps/server/dist/main.js `startKept`, KEPT_ROLE=all,
//    NODE_ENV=production, serving apps/web/dist) on <port>. `node dist/main.js` always listens
//    on 8080; startKept's `port` option is what lets three instances run side by side.
//    The setup code line goes to <state>/server.log, where the tests read it.
//    With --ai-mock (step 3), KEPT_AI_MOCK=1 answers every AI call from the mock provider, and
//    the server runs with NODE_ENV=development, because a production boot refuses the mock.
//    The mock answers by the hash of the image it is sent, so e2e/fixtures/mock-answers.json
//    (keyed by fixture file) is re-keyed here to the hash of each fixture as the server sends it:
//    re-encoded as a receipt, label or reading is (extraction/image.ts `reencode`). The result,
//    <state>/mock-answers.json, is startKept's `aiMockAnswersFile`; any other image gets the
//    mock's per-mode default.
//    With --https (steps 6–8: token creation, an export with secrets and backup settings are
//    refused over plain http, D181), the public URL is https://localhost:<port>: a TLS proxy in
//    this process listens on <port> with a self-signed certificate made by `openssl` for the run
//    (the browser context takes ignoreHTTPSErrors) and forwards to the server on <port> + 1000.
//    With --owner (step 8: Admin → Backups' Run now), the server also gets the owner login
//    (KEPT_OWNER_DATABASE_URL), which a backup run needs; KEPT_RESTIC_BIN passes through when set.
// 4. On SIGTERM or SIGINT (Playwright's gracefulShutdown), stops the server and drops the
//    database. A database left behind by a run that was killed outright is dropped by the next
//    run of the same instance.
//
// Needs apps/server/dist and apps/web/dist: `pnpm --filter '@kept/server...' build` and
// `pnpm --filter @kept/web build` (scripts/ci-local.sh's e2e step does both).
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const [name, portArg, ...flags] = process.argv.slice(2);
const port = Number(portArg);
if (!name || !/^[a-z-]+$/.test(name) || !Number.isInteger(port)) {
  console.error(
    'usage: node --conditions=kept-dist e2e/serve.mjs <name> <port> [--seed] [--ai-mock] [--https] [--owner]',
  );
  process.exit(2);
}
const seed = flags.includes('--seed');
const aiMock = flags.includes('--ai-mock');
const tls = flags.includes('--https');
const owner = flags.includes('--owner');
// Behind the TLS proxy the server itself listens 1000 above the public port.
const serverPort = tls ? port + 1000 : port;

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const serverDist = new URL('../../server/dist/', import.meta.url);
const state = `${repo}.tmp/e2e/${name}/`;
const logFile = `${state}server.log`;

// pg is the server's dependency, not the web app's: resolve it from apps/server.
const pg = createRequire(new URL('../../server/package.json', import.meta.url))('pg');

const HOST = 'localhost:5452';
const SUPERUSER_URL = `postgres://postgres:postgres@${HOST}/postgres`;
const dbPrefix = `kept_e2e_${name.replaceAll('-', '_')}_`;
const db = `${dbPrefix}${process.pid}`;
const url = (role) => `postgres://${role}:${role}@${HOST}/${db}`;

const log = (line) => {
  appendFileSync(logFile, `${line}\n`);
  process.stdout.write(`[${name}] ${line}\n`);
};

async function superuser(fn) {
  const client = new pg.Client({ connectionString: SUPERUSER_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

async function dropLeftovers() {
  await superuser(async (c) => {
    const { rows } = await c.query('SELECT datname FROM pg_database WHERE datname LIKE $1', [
      `${dbPrefix}%`,
    ]);
    for (const { datname } of rows) {
      const pid = Number(datname.slice(dbPrefix.length));
      if (Number.isInteger(pid) && !alive(pid)) {
        await c.query(`DROP DATABASE IF EXISTS ${datname} WITH (FORCE)`);
      }
    }
  });
}

const dropDb = () => superuser((c) => c.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`));

function run(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      out += d;
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${args.join(' ')} exited ${code}\n${out}`)),
    );
  });
}

/** The e2e's mock answers, keyed as the mock looks them up (see the header). Answers the file. */
async function e2eMockAnswers() {
  const { reencode, EVIDENCE_MAX_PX } = await import(
    new URL('extraction/image.js', serverDist).href
  );
  const { mockKey } = await import(new URL('ai/mock.js', serverDist).href);
  const fixtures = new URL('./fixtures/', import.meta.url);
  const byFile = JSON.parse(readFileSync(new URL('mock-answers.json', fixtures), 'utf8'));
  const answers = {};
  for (const [file, answer] of Object.entries(byFile)) {
    const sent = await reencode(readFileSync(new URL(file, fixtures)), EVIDENCE_MAX_PX);
    if (!sent) throw new Error(`mock answers: the server can't decode ${file}`);
    answers[mockKey(sent.bytes)] = answer;
  }
  const out = `${state}mock-answers.json`;
  writeFileSync(out, JSON.stringify(answers, null, 2));
  log(`mock answers: ${Object.keys(answers).join(', ')} (${Object.keys(byFile).join(', ')})`);
  return out;
}

/**
 * The TLS proxy (--https): a self-signed certificate for localhost, made for this run, and an
 * https server on the public port that forwards every request to the server, streaming both ways
 * (the assistant's and MCP's event streams included).
 */
async function tlsProxy() {
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '2',
      '-keyout',
      `${state}tls-key.pem`,
      '-out',
      `${state}tls-cert.pem`,
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1',
    ],
    { stdio: 'ignore' },
  );
  const server = https.createServer(
    { key: readFileSync(`${state}tls-key.pem`), cert: readFileSync(`${state}tls-cert.pem`) },
    (req, res) => {
      const upstream = http.request(
        {
          host: 'localhost',
          port: serverPort,
          method: req.method,
          path: req.url,
          headers: req.headers,
        },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    },
  );
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, 'localhost', resolve);
  });
  return server;
}

rmSync(state, { recursive: true, force: true });
mkdirSync(`${state}config`, { recursive: true });
mkdirSync(`${state}data`, { recursive: true });
writeFileSync(logFile, '');

// The runtime environment, the same for the seed command and the server.
const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TZ: 'UTC',
  KEPT_DATABASE_URL: url('kept_app'),
  KEPT_AUTH_DATABASE_URL: url('kept_auth'),
  KEPT_SYSTEM_DATABASE_URL: url('kept_system'),
  KEPT_PUBLIC_URL: `${tls ? 'https' : 'http'}://localhost:${port}`,
  KEPT_SOURCE_URL: 'https://github.com/ibrahimroshdy/kept',
  KEPT_CONFIG_DIR: `${state}config`,
  KEPT_DATA_DIR: `${state}data`,
  KEPT_ROLE: 'all',
  KEPT_LOG_LEVEL: 'warn',
  ...(aiMock ? { KEPT_AI_MOCK: '1' } : {}),
  ...(owner ? { KEPT_OWNER_DATABASE_URL: url('kept_owner') } : {}),
  ...(process.env.KEPT_RESTIC_BIN ? { KEPT_RESTIC_BIN: process.env.KEPT_RESTIC_BIN } : {}),
};

let running = null;
let proxy = null;
let stopping = false;
async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  proxy?.closeAllConnections();
  proxy?.close();
  try {
    await running?.stop();
  } catch (err) {
    console.error(`[${name}] stop failed`, err);
  }
  try {
    await dropDb();
  } catch (err) {
    console.error(`[${name}] could not drop ${db}`, err);
  }
  process.exit(code);
}
process.on('SIGTERM', () => void shutdown(0));
process.on('SIGINT', () => void shutdown(0));

try {
  await dropLeftovers();
  await superuser((c) => c.query(`CREATE DATABASE ${db} OWNER kept_owner`));
  const { runMigrations } = await import(new URL('db/migrate.js', serverDist).href);
  await runMigrations(url('kept_owner'));
  log(`database ${db} migrated`);

  if (seed) {
    const out = await run(
      process.execPath,
      [
        '--conditions=kept-dist',
        fileURLToPath(new URL('cli/index.js', serverDist)),
        'admin',
        'seed',
        '--scenario',
        'households',
      ],
      { ...env, NODE_ENV: 'development' },
    );
    appendFileSync(logFile, out);
    log('seeded: households');
  }

  // This process's own environment becomes the server's before its modules load, so any
  // library that reads NODE_ENV itself sees what `node dist/main.js` in the image would.
  const serverEnv = { ...env, NODE_ENV: aiMock ? 'development' : 'production' };
  Object.assign(process.env, serverEnv);
  const aiMockAnswersFile = aiMock ? await e2eMockAnswers() : undefined;
  const { loadEnv } = await import(new URL('config/env.js', serverDist).href);
  const { startKept } = await import(new URL('main.js', serverDist).href);
  const loaded = await loadEnv(serverEnv, { logger: (line) => log(line) });
  // `localhost`: the address the public URL names, on both 127.0.0.1 and ::1, never the LAN.
  running = await startKept(loaded, {
    port: serverPort,
    host: 'localhost',
    print: (line) => log(line),
    // Nine servers share the dev Postgres (max_connections 100): 3 connections a pool, and 3
    // for pg-boss, keep them all inside it (main.ts `poolMax`).
    poolMax: 3,
    ...(aiMockAnswersFile ? { aiMockAnswersFile } : {}),
  });
  log(`listening on ${running.address}`);
  if (tls) {
    proxy = await tlsProxy();
    log(`https://localhost:${port} → ${serverPort}`);
  }
} catch (err) {
  console.error(`[${name}] failed to start`, err);
  await shutdown(1);
}
