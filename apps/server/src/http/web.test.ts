import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pools } from '../db/pools.js';
import { buildApp, type KeptApp } from './app.js';
import { inlineScriptHashes, loadWebBundle } from './web.js';

// Task 29: the API process serves the built web bundle, with an SPA fallback and a CSP that
// allows index.html's inline pre-paint script by hash only.

const PREPAINT = "\n      document.documentElement.setAttribute('data-theme', 'dark');\n    ";
const INDEX = `<!doctype html>
<html><head>
    <script>${PREPAINT}</script>
    <script type="module" crossorigin src="/assets/index-abc123.js"></script>
</head><body><div id="root"></div></body></html>
`;
const sha = (text: string) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;

// No route here touches the database.
const pools = {} as unknown as Pools;

let dir: string;
let app: KeptApp;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kept-web-'));
  await mkdir(path.join(dir, 'assets'));
  await writeFile(path.join(dir, 'index.html'), INDEX);
  await writeFile(path.join(dir, 'assets', 'index-abc123.js'), 'console.log(1);\n');
  await writeFile(path.join(dir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(path.join(dir, '.secret'), 'nope');
  await writeFile(path.join(dir, 'sw.js'), 'self.__SW_MANIFEST;\n');
  await writeFile(path.join(dir, 'manifest.webmanifest'), '{"name":"Kept"}\n');
  const web = await loadWebBundle(dir);
  app = await buildApp({ env: { KEPT_PUBLIC_URL: 'http://kept.test' }, pools, web });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await rm(dir, { recursive: true, force: true });
});

describe('inlineScriptHashes()', () => {
  it('hashes the exact text of inline scripts and skips scripts with src', () => {
    expect(inlineScriptHashes(INDEX)).toEqual([sha(PREPAINT)]);
    expect(inlineScriptHashes('<p>no scripts</p>')).toEqual([]);
  });
});

describe('loadWebBundle()', () => {
  it('returns null when there is no built index.html', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'kept-web-empty-'));
    try {
      expect(await loadWebBundle(empty)).toBeNull();
      expect(await loadWebBundle(path.join(empty, 'missing'))).toBeNull();
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

describe('serving the web bundle', () => {
  it('serves index.html at / with a CSP that allows its inline script by hash', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.body).toBe(INDEX);
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toBe(
      `default-src 'self';script-src 'self' 'wasm-unsafe-eval' ${sha(PREPAINT)};style-src 'self' 'sha256-38RhXrc7EdReTKsOm23ZPOCUgniTUUcjky8QOOrQx6o=' 'sha256-gYiS/BvZvRcK27JIXTuwhZ3hs2+VJ1X+2gUlE+farlg=';worker-src 'self';img-src 'self' blob:;media-src 'self' blob:;manifest-src 'self';frame-ancestors 'none'`,
    );
    expect(csp).not.toMatch(/unsafe-inline/);
  });

  it('answers client-side routes with index.html (GET and HEAD)', async () => {
    const res = await app.inject({ method: 'GET', url: '/locations/abc?tab=people' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(INDEX);
    const head = await app.inject({ method: 'HEAD', url: '/settings' });
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-type']).toMatch(/^text\/html/);
  });

  it('serves fingerprinted assets as immutable and other files as no-cache', async () => {
    const asset = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toBe('console.log(1);\n');
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const icon = await app.inject({ method: 'GET', url: '/favicon.svg' });
    expect(icon.statusCode).toBe(200);
    expect(icon.headers['cache-control']).toBe('no-cache');
  });

  // Step 3 (T2, T23): the service worker and the manifest are never cached as they are, so a new
  // release is noticed on the next check; the manifest is served as a manifest.
  it('serves sw.js and the manifest with no-cache, the manifest as application/manifest+json', async () => {
    const sw = await app.inject({ method: 'GET', url: '/sw.js' });
    expect(sw.statusCode).toBe(200);
    expect(sw.headers['cache-control']).toBe('no-cache');
    expect(sw.headers['content-type']).toMatch(/^(application|text)\/javascript/);
    const manifest = await app.inject({ method: 'GET', url: '/manifest.webmanifest' });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.headers['cache-control']).toBe('no-cache');
    expect(manifest.headers['content-type']).toMatch(/^application\/manifest\+json/);
  });

  // T23: the service worker precaches `index.html` (fetched at /index.html) and serves it for
  // navigations. That copy must be the same bytes as `/`, under a CSP that allows its pre-paint
  // script by hash, or the installed app would load with its theme script blocked.
  it('serves /index.html, the precached copy, as the same bytes under the same script hash', async () => {
    const root = await app.inject({ method: 'GET', url: '/' });
    const precached = await app.inject({ method: 'GET', url: '/index.html' });
    expect(precached.statusCode).toBe(200);
    expect(precached.body).toBe(root.body);
    expect(precached.headers['cache-control']).toBe('no-cache');
    const csp = precached.headers['content-security-policy'] as string;
    for (const hash of inlineScriptHashes(precached.body)) expect(csp).toContain(hash);
    expect(csp).toContain(sha(PREPAINT));
  });

  it('answers a missing sw.js or manifest with a 404, never the SPA', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'kept-web-nosw-'));
    try {
      await writeFile(path.join(empty, 'index.html'), INDEX);
      const bare = await buildApp({
        env: { KEPT_PUBLIC_URL: 'http://kept.test' },
        pools,
        web: await loadWebBundle(empty),
      });
      try {
        for (const url of ['/sw.js', '/manifest.webmanifest']) {
          const res = await bare.inject({ method: 'GET', url });
          expect(res.statusCode, url).toBe(404);
          expect(res.json()).toEqual({ error: 'Not found.', code: 'not_found' });
        }
      } finally {
        await bare.close();
      }
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('keeps JSON 404s for the API, missing assets, dotfiles and non-GET requests', async () => {
    for (const [method, url] of [
      ['GET', '/api/v1/nothing-here'],
      ['GET', '/api'],
      ['GET', '/assets/gone-123.js'],
      ['POST', '/locations'],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(res.json()).toEqual({ error: 'Not found.', code: 'not_found' });
    }
    const dot = await app.inject({ method: 'GET', url: '/.secret' });
    expect(dot.body).not.toContain('nope');
  });

  // Step 6 (T2): OAuth discovery and the MCP endpoint are machine paths. The four well-known
  // documents are reserved as public JSON 404s until T12 serves them; nothing under
  // `/.well-known/` or `/mcp` is ever answered with index.html.
  it('never answers /.well-known/ or /mcp with the SPA; the discovery paths are public JSON 404s', async () => {
    for (const url of [
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-authorization-server/api/v1/auth',
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.json(), url).toEqual({ error: 'Not found.', code: 'not_found' });
    }
    for (const url of ['/.well-known/openid-configuration', '/.well-known/', '/mcp', '/mcp/x']) {
      const res = await app.inject({ method: 'GET', url });
      // 404, the static plugin's 403 for a dot path (dotfiles: 'deny'), or `/mcp`'s own 405 for
      // a GET (T11: stateless, POST only); never a page.
      expect([403, 404, 405], url).toContain(res.statusCode);
      expect(res.body, url).not.toContain('<div id="root">');
    }
    // A client route that merely starts with the letters still gets the app.
    expect((await app.inject({ method: 'GET', url: '/mcpx' })).body).toContain('<div id="root">');
  });

  it('leaves the API routes alone', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
