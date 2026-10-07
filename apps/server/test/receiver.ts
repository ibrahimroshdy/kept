import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

// A local stand-in for the outside world (step 4, T15): a push service or a webhook receiver on
// 127.0.0.1 that records what it gets and answers what the test says. Nothing a test sends ever
// leaves the machine. HTTPS uses a throwaway self-signed certificate made with openssl (as the
// push spike did, docs/spikes/2026-09-30-step4-push.md), trusted only by the agent a test builds.

export type Received = {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
};

export type Receiver = {
  url: string;
  /** Every request so far, in order. */
  received: Received[];
  /** The next answers: a status, and headers (a redirect's `location`). Repeats the last. */
  reply: (status: number, headers?: Record<string, string>) => void;
  /** The certificate a client must trust (HTTPS only). */
  ca: Buffer | null;
  close: () => Promise<void>;
};

function recorder(
  received: Received[],
  state: { status: number; headers: Record<string, string> },
) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      res.writeHead(state.status, { 'content-type': 'text/plain', ...state.headers });
      res.end(state.status < 300 ? '' : `status ${state.status}`);
    });
  };
}

export async function startReceiver(opts: { tls: boolean }): Promise<Receiver> {
  const received: Received[] = [];
  const state = { status: 201, headers: {} as Record<string, string> };
  let dir: string | null = null;
  let ca: Buffer | null = null;
  let server: http.Server | https.Server;
  if (opts.tls) {
    dir = mkdtempSync(path.join(tmpdir(), 'kept-receiver-'));
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        path.join(dir, 'key.pem'),
        '-out',
        path.join(dir, 'cert.pem'),
        '-days',
        '1',
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
      ],
      { stdio: 'ignore' },
    );
    ca = readFileSync(path.join(dir, 'cert.pem'));
    server = https.createServer(
      { key: readFileSync(path.join(dir, 'key.pem')), cert: ca },
      recorder(received, state),
    );
  } else {
    server = http.createServer(recorder(received, state));
  }
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `${opts.tls ? 'https' : 'http'}://127.0.0.1:${port}`,
    received,
    reply: (status, headers = {}) => {
      state.status = status;
      state.headers = headers;
    },
    ca,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (dir) rmSync(dir, { recursive: true, force: true });
    },
  };
}
