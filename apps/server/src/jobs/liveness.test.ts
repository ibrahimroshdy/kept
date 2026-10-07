import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { beat, lastPoll } from './liveness.js';

// The worker's liveness signal (step-1 carry-over; plan T13) and the image's healthcheck script
// that reads it (docker/healthcheck.mjs), run as the HEALTHCHECK runs it.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const script = path.join(repoRoot, 'docker', 'healthcheck.mjs');
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kept-liveness-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

type Wip = { lastFetchedOn: number | null };
const boss = (wips: Wip[]) => ({ getWipData: () => wips }) as never;

function healthcheck(args: string[], env: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [script, ...args],
      { env: { PATH: process.env.PATH ?? '', ...env } },
      (err) => resolve(err ? ((err as { code?: number }).code ?? 1) : 0),
    );
  });
}

describe('the worker heartbeat', () => {
  it('reads the newest successful fetch across the workers', () => {
    expect(lastPoll(boss([]))).toBeNull();
    expect(
      lastPoll(boss([{ lastFetchedOn: null }, { lastFetchedOn: 5 }, { lastFetchedOn: 9 }])),
    ).toBe(9);
  });

  it('touches the file only while pg-boss is polling', async () => {
    const file = path.join(dir, 'alive-a');
    const now = Date.now();
    expect(await beat(boss([{ lastFetchedOn: null }]), file, now)).toBe(false);
    await expect(stat(file)).rejects.toThrow();
    expect(await beat(boss([{ lastFetchedOn: now - 2_000 }]), file, now)).toBe(true);
    expect(Math.abs((await stat(file)).mtimeMs - now)).toBeLessThan(1_000);
    // Polling stopped a while ago: no touch, so the file goes stale.
    expect(await beat(boss([{ lastFetchedOn: now - 90_000 }]), file, now + 60_000)).toBe(false);
  });
});

describe('docker/healthcheck.mjs', () => {
  it('as a worker: healthy with a fresh heartbeat, unhealthy when it is stale or missing', async () => {
    const file = path.join(dir, 'alive-b');
    await writeFile(file, '');
    expect(await healthcheck(['--worker', `--file=${file}`])).toBe(0);
    // KEPT_ROLE=worker picks the mode without the flag, as the image's HEALTHCHECK runs it.
    expect(await healthcheck([`--file=${file}`], { KEPT_ROLE: 'worker' })).toBe(0);
    const old = new Date(Date.now() - 180_000);
    await utimes(file, old, old);
    expect(await healthcheck(['--worker', `--file=${file}`])).toBe(1);
    expect(await healthcheck(['--worker', `--file=${path.join(dir, 'none')}`])).toBe(1);
  });

  describe('as the web', () => {
    let server: Server;
    let status = 200;
    let port = 0;
    beforeAll(async () => {
      server = createServer((req, res) => {
        res.writeHead(req.url === '/readyz' ? status : 404).end();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as AddressInfo).port;
    });
    afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

    it('asks /readyz on KEPT_PORT', async () => {
      status = 200;
      expect(await healthcheck([], { KEPT_PORT: String(port) })).toBe(0);
      status = 503;
      expect(await healthcheck([], { KEPT_PORT: String(port) })).toBe(1);
    });
  });
});
