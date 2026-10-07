import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { isV7 } from '@kept/shared';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { testDb } from '../../test/db.js';
import type { Pools } from '../db/pools.js';
import type { BlobStore, FileStorage } from '../storage/blob-store.js';
import { S3BlobStore } from '../storage/s3.js';
import type { UrlSigner } from '../storage/signed-url.js';
import { buildApp, type KeptApp, OPENAPI_PATH } from './app.js';
import { AppError } from './errors.js';
import { createLogger, redactUrl } from './logger.js';

// Task 16: the HTTP skeleton, exercised through app.inject().

const db = await testDb();
const pools = db.pools as Pools;

function memoryLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const logger = createLogger({ KEPT_LOG_LEVEL: 'info', KEPT_LOG_FORMAT: 'json' }, stream);
  return { logger, text: () => lines.join('') };
}

let app: KeptApp;
const log = memoryLogger();

/** The CSP header as directive → sources. */
function cspOf(header: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of String(header ?? '').split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out.set(name, sources);
  }
  return out;
}

/** File storage whose blob store signs URLs like `blobs` does; nothing else is used. */
function storageWith(blobs: Pick<BlobStore, 'signedUrl'>): FileStorage {
  return {
    blobs: blobs as BlobStore,
    signer: {} as UrlSigner,
    maxFileBytes: 1,
    imageConcurrency: 1,
    tmpDir: '/nowhere',
  };
}

beforeAll(async () => {
  app = await buildApp({
    env: { KEPT_PUBLIC_URL: 'http://kept.test' },
    pools,
    logger: log.logger,
    build: { version: '1.2.3', revision: 'abc123' },
  });
  app.post(
    '/test/echo',
    {
      config: { auth: 'none' },
      schema: { body: z.object({ name: z.string().min(2), n: z.number().int() }) },
    },
    async (req) => ({ name: req.body.name }),
  );
  app.get('/test/boom', { config: { auth: 'none' } }, async () => {
    throw Object.assign(new Error('Failed query: select $1 params: hunter2'), {
      name: 'DrizzleQueryError',
    });
  });
  app.get('/test/pg', { config: { auth: 'none' } }, async () => {
    throw Object.assign(new Error('duplicate key'), {
      code: '23505',
      severity: 'ERROR',
      constraint: 'places_pkey',
    });
  });
  app.get('/test/app-error', { config: { auth: 'none' } }, async () => {
    throw new AppError('forbidden', 403, 'Ask an admin.');
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('buildApp()', () => {
  it('gives every response a uuidv7 x-request-id, never the client one', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-request-id': 'forged' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const id = res.headers['x-request-id'] as string;
    expect(isV7(id)).toBe(true);
  });

  it('sends the CSP and no HSTS over plain http', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'self';script-src 'self' 'wasm-unsafe-eval';style-src 'self' 'sha256-38RhXrc7EdReTKsOm23ZPOCUgniTUUcjky8QOOrQx6o=' 'sha256-gYiS/BvZvRcK27JIXTuwhZ3hs2+VJ1X+2gUlE+farlg=';worker-src 'self';img-src 'self' blob:;media-src 'self' blob:;manifest-src 'self';frame-ancestors 'none'",
    );
    expect(res.headers['content-security-policy']).not.toMatch(/'unsafe-inline'|'unsafe-eval'/);
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  // Step 3 (T2; T0's scanner spike): the zxing wasm needs 'wasm-unsafe-eval' in script-src, the
  // service worker needs worker-src, camera frames and phone-made labels are blob: images, and
  // the manifest is our own.
  it('lets the service worker, the scanner and camera blobs run, and nothing more', async () => {
    const csp = cspOf(
      (await app.inject({ method: 'GET', url: '/healthz' })).headers['content-security-policy'],
    );
    expect(csp.get('script-src')).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(csp.get('worker-src')).toEqual(["'self'"]);
    expect(csp.get('img-src')).toEqual(["'self'", 'blob:']);
    expect(csp.get('media-src')).toEqual(["'self'", 'blob:']);
    expect(csp.get('manifest-src')).toEqual(["'self'"]);
    expect(csp.get('default-src')).toEqual(["'self'"]);
  });

  // Step 6 (T2): the assistant needs no fetch beyond Kept's own API, and dictation is the
  // browser's own recogniser, not a page fetch. connect-src stays default-src's 'self'; nobody
  // widens it for the assistant (no remote images, no model endpoints from the page, D179).
  it("keeps fetches to Kept's own origin: connect-src falls back to default-src 'self'", async () => {
    const csp = cspOf(
      (await app.inject({ method: 'GET', url: '/healthz' })).headers['content-security-policy'],
    );
    expect(csp.has('connect-src')).toBe(false);
    expect(csp.get('default-src')).toEqual(["'self'"]);
  });

  it('adds the origin presigned file URLs come from, and only that, to img-src and media-src', async () => {
    const s3 = new S3BlobStore({
      bucket: 'kept',
      region: 'us-east-1',
      endpoint: 'http://rustfs:9000',
      publicEndpoint: 'https://files.example.test',
      forcePathStyle: true,
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'not-a-real-secret' },
    });
    const local = storageWith({ signedUrl: async () => '/f/token' });
    const onS3 = await buildApp({
      env: { KEPT_PUBLIC_URL: 'http://kept.test' },
      pools,
      files: storageWith(s3),
    });
    const onDisk = await buildApp({
      env: { KEPT_PUBLIC_URL: 'http://kept.test' },
      pools,
      files: local,
    });
    try {
      const s3Csp = cspOf(
        (await onS3.inject({ method: 'GET', url: '/healthz' })).headers['content-security-policy'],
      );
      expect(s3Csp.get('img-src')).toEqual(["'self'", 'blob:', 'https://files.example.test']);
      expect(s3Csp.get('media-src')).toEqual(["'self'", 'blob:', 'https://files.example.test']);
      expect(s3Csp.get('default-src')).toEqual(["'self'"]);
      // Local storage serves /f/<token> from this origin: nothing to add.
      const diskCsp = cspOf(
        (await onDisk.inject({ method: 'GET', url: '/healthz' })).headers[
          'content-security-policy'
        ],
      );
      expect(diskCsp.get('img-src')).toEqual(["'self'", 'blob:']);
    } finally {
      await onS3.close();
      await onDisk.close();
      s3.destroy();
    }
  });

  it('sends HSTS when the public URL is https', async () => {
    const httpsApp = await buildApp({ env: { KEPT_PUBLIC_URL: 'https://kept.test' }, pools });
    try {
      const res = await httpsApp.inject({ method: 'GET', url: '/healthz' });
      expect(res.headers['strict-transport-security']).toMatch(/max-age=31536000/);
    } finally {
      await httpsApp.close();
    }
  });

  it('validates with zod: 400 validation, paths but no values', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/test/echo',
      payload: { name: 'x', n: 'hunter2' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body).toMatchObject({ code: 'validation', error: 'The request is not valid.' });
    expect(body.hint).toContain('body.name');
    expect(JSON.stringify(body)).not.toContain('hunter2');
    const ok = await app.inject({
      method: 'POST',
      url: '/test/echo',
      payload: { name: 'ok', n: 1 },
    });
    expect(ok.json()).toEqual({ name: 'ok' });
  });

  it('answers malformed JSON with the error shape', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/test/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{nope',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'The request is not valid.', code: 'validation' });
  });

  it('answers an unknown route with 404 not_found', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/nothing-here' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Not found.', code: 'not_found' });
  });

  it('maps an AppError and a pg error through the one handler', async () => {
    const forbidden = await app.inject({ method: 'GET', url: '/test/app-error' });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toEqual({
      error: "You don't have permission to do that.",
      hint: 'Ask an admin.',
      code: 'forbidden',
    });
    const collision = await app.inject({ method: 'GET', url: '/test/pg' });
    expect(collision.statusCode).toBe(404);
    expect(collision.json()).toEqual({ error: 'Not found.', code: 'not_found' });
  });

  it('returns a bare 500 and logs no query parameters', async () => {
    const res = await app.inject({ method: 'GET', url: '/test/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Something went wrong.', code: 'internal' });
    expect(res.body).not.toMatch(/hunter2|stack|at /);
    expect(log.text()).toContain('request failed');
    expect(log.text()).not.toContain('hunter2');
  });

  it('redacts tokens in logged URLs, and logs no headers', async () => {
    await app.inject({
      method: 'GET',
      url: '/healthz?token=abc123secret&x=1',
      headers: { authorization: 'Bearer very-secret', cookie: 'kept=session-secret' },
    });
    const text = log.text();
    expect(text).toContain('/healthz?token=[redacted]&x=1');
    expect(text).not.toMatch(/abc123secret|very-secret|session-secret/);
  });

  it('serves the OpenAPI document with the app routes and without the hidden ones', async () => {
    const res = await app.inject({ method: 'GET', url: OPENAPI_PATH });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.openapi).toMatch(/^3\./);
    expect(doc.info).toEqual({ title: 'Kept API', version: '1.2.3' });
    expect(Object.keys(doc.paths)).toContain('/test/echo');
    expect(Object.keys(doc.paths)).not.toContain('/healthz');
    expect(Object.keys(doc.paths)).not.toContain(OPENAPI_PATH);
  });
});

// Step 3 (T2, Q26): the web app's share target is handled by the service worker. A share that
// reaches the server (the worker isn't active yet) is sent back to the capture screen with an
// explanation, before its body is read, and nothing of it is kept.
describe('POST /share', () => {
  const multipart = (size: number) => {
    const boundary = 'kept-share-boundary';
    return {
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: [
        `--${boundary}`,
        'Content-Disposition: form-data; name="photos"; filename="a.jpg"',
        'Content-Type: image/jpeg',
        '',
        'x'.repeat(size),
        `--${boundary}--`,
        '',
      ].join('\r\n'),
    };
  };

  it('answers 303 to the capture screen, without a session', async () => {
    const res = await app.inject({ method: 'POST', url: '/share', ...multipart(10) });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/capture?share=unavailable');
    expect(res.body).toBe('');
  });

  it('answers before reading the body: one over the body limit is still a 303, not a 413', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/share?x=1',
      ...multipart(2 * 1024 * 1024),
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/capture?share=unavailable');
  });

  it('redirects a cookie-bearing share from the OS share sheet too (no Origin to check)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/share',
      ...multipart(10),
      headers: { ...multipart(10).headers, cookie: 'kept=anything', 'sec-fetch-site': 'none' },
    });
    expect(res.statusCode).toBe(303);
  });

  it('leaves other methods and paths alone', async () => {
    expect((await app.inject({ method: 'GET', url: '/share' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/share/more' })).statusCode).toBe(404);
  });
});

describe('redactUrl()', () => {
  it.each([
    ['/a?token=x', '/a?token=[redacted]'],
    ['/a?invite_token=x&b=2', '/a?invite_token=[redacted]&b=2'],
    ['/a?code=123456', '/a?code=[redacted]'],
    ['/a?page=2', '/a?page=2'],
    // Invite tokens in the path (task 20): the preview and accept routes.
    ['/api/v1/invites/abcDEF_-123', '/api/v1/invites/[redacted]'],
    ['/api/v1/invites/abc/accept?x=1', '/api/v1/invites/[redacted]/accept?x=1'],
    ['/api/v1/locations/1/invites/2', '/api/v1/locations/1/invites/2'],
    // Signed file URLs (security review #11): the whole token is the path.
    ['/f/abc.DEF_-1', '/f/[redacted]'],
    ['/f/abc.def?x=1', '/f/[redacted]?x=1'],
    ['/fa/b', '/fa/b'],
    // A claim pack's download link (step 4, T18).
    ['/x/Zm9vYmFyYmF6cXV4MTIzNDU2', '/x/[redacted]'],
    ['/cal/Zm9vYmFyYmF6cXV4MTIzNDU2.ics', '/cal/[redacted]'],
    ['/xa/b', '/xa/b'],
    ['/a', '/a'],
  ])('%s → %s', (input, output) => {
    expect(redactUrl(input)).toBe(output);
  });
});

describe('health', () => {
  it('/version reports version, revision and source (D147)', async () => {
    const withSource = await buildApp({
      env: { KEPT_PUBLIC_URL: 'http://kept.test', KEPT_SOURCE_URL: 'https://example.test/src' },
      pools,
      build: { version: '1.2.3', revision: 'abc123' },
      noticesPath: null,
    });
    try {
      const res = await withSource.inject({ method: 'GET', url: '/version' });
      expect(res.json()).toEqual({
        version: '1.2.3',
        revision: 'abc123',
        source: 'https://example.test/src',
        notices: null,
      });
      // No notices file, no route.
      expect((await withSource.inject({ method: 'GET', url: '/notices.txt' })).statusCode).toBe(
        404,
      );
    } finally {
      await withSource.close();
    }
  });

  it('serves the image’s third-party notices and names them in /version (D151)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kept-notices-'));
    const file = join(dir, 'THIRD-PARTY-NOTICES.txt');
    writeFileSync(file, 'Kept third-party notices\n\nweb-push (MPL-2.0)\n');
    const withNotices = await buildApp({
      env: { KEPT_PUBLIC_URL: 'http://kept.test' },
      pools,
      noticesPath: file,
    });
    try {
      expect((await withNotices.inject({ method: 'GET', url: '/version' })).json()).toMatchObject({
        notices: '/notices.txt',
      });
      const res = await withNotices.inject({ method: 'GET', url: '/notices.txt' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(res.body).toContain('web-push (MPL-2.0)');
    } finally {
      await withNotices.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('/readyz is 200 when both pools answer, 503 when one does not', async () => {
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
    const dead = new pg.Pool({ connectionString: 'postgres://nobody:x@127.0.0.1:1/none' });
    dead.on('error', () => {});
    const broken = await buildApp({
      env: { KEPT_PUBLIC_URL: 'http://kept.test' },
      pools: { ...pools, system: dead },
    });
    try {
      const res = await broken.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ ok: false, app: true, system: false });
    } finally {
      await broken.close();
      await dead.end();
    }
  });

  it('/metrics does not exist without KEPT_METRICS_TOKEN', async () => {
    expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(404);
  });

  it('/metrics requires the bearer token when set', async () => {
    const metrics = await buildApp({
      env: { KEPT_PUBLIC_URL: 'http://kept.test', KEPT_METRICS_TOKEN: 'metrics-token' },
      pools,
    });
    try {
      const none = await metrics.inject({ method: 'GET', url: '/metrics' });
      expect(none.statusCode).toBe(401);
      expect(none.json().code).toBe('unauthenticated');
      const wrong = await metrics.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: 'Bearer nope' },
      });
      expect(wrong.statusCode).toBe(401);
      const ok = await metrics.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: 'Bearer metrics-token' },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.headers['content-type']).toMatch(/^text\/plain/);
      expect(ok.body).toContain('kept_db_pool_connections{pool="app",state="total"}');
    } finally {
      await metrics.close();
    }
  });
});
