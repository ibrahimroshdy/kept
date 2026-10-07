import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

// The built web bundle (apps/web/dist), served by the API process (task 29).
//
// One process, one origin: the SPA and /api share `self`, so the CSP stays `default-src 'self'`.
// The only exception is index.html's inline pre-paint script (theme, language, direction before
// first paint, apps/web/index.html), which is allowed by its sha256 hash rather than by
// 'unsafe-inline'. The hashes are computed from the file actually served, so a rebuilt bundle
// can never drift from its CSP.

export type WebBundle = {
  /** Absolute path of the built bundle (the directory holding index.html). */
  root: string;
  /** index.html as read at boot; sent for every SPA route. */
  indexHtml: string;
  /** CSP source expressions ('sha256-…') for index.html's inline scripts. */
  scriptHashes: string[];
};

const INLINE_SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

/** CSP hashes for every inline (no `src`) script in an HTML document. The hash covers the exact
 * text between the tags, which is what browsers hash. */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  for (const match of html.matchAll(INLINE_SCRIPT)) {
    const attrs = match[1] ?? '';
    const body = match[2] ?? '';
    if (/\bsrc\s*=/i.test(attrs)) continue;
    hashes.push(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
  }
  return hashes;
}

/** Reads the bundle at `root`, or null when it has no index.html (dev: Vite serves the web). */
export async function loadWebBundle(root: string): Promise<WebBundle | null> {
  const abs = path.resolve(root);
  let indexHtml: string;
  try {
    indexHtml = await readFile(path.join(abs, 'index.html'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return { root: abs, indexHtml, scriptHashes: inlineScriptHashes(indexHtml) };
}

// Vite fingerprints everything under /assets/, so those files never change under a name.
const IMMUTABLE = 'public, max-age=31536000, immutable';

// Step 3 (T2, T23): the service worker and the web app manifest keep their names across
// releases, so they get `no-cache` like every other unfingerprinted file: the browser checks
// for a new worker on each visit and the update prompt can appear (D148). The manifest's type is
// set here rather than left to the MIME table.
const MANIFEST = 'manifest.webmanifest';

/** Serves the bundle's files. Unknown paths fall through to the app's not-found handler, which
 * calls `spaFallback()`. */
export async function webRoutes(app: FastifyInstance, bundle: WebBundle): Promise<void> {
  // An encapsulated scope, so the onRoute hook below marks only the bundle's own routes public
  // (auth/http.ts: routes require a session unless they say otherwise).
  await app.register(async (scope) => {
    scope.addHook('onRoute', (route) => {
      route.config = { ...route.config, auth: 'none' };
    });
    await scope.register(fastifyStatic, {
      root: bundle.root,
      // `/` and client routes are answered by spaFallback() from the in-memory index.html.
      index: false,
      redirect: false,
      dotfiles: 'deny',
      cacheControl: false,
      setHeaders: (reply, filePath) => {
        const rel = path.relative(bundle.root, filePath).split(path.sep);
        reply.header('cache-control', rel[0] === 'assets' ? IMMUTABLE : 'no-cache');
        if (rel.length === 1 && rel[0] === MANIFEST) {
          reply.header('content-type', 'application/manifest+json; charset=utf-8');
        }
      },
    });
    // The static route answers a directory (with `index: false`) with 403, so `/` is explicit.
    scope.get('/', { schema: { hide: true } }, async (req, reply) => {
      spaFallback(bundle, req, reply);
      return reply;
    });
  });
}

/** Paths that never get the SPA: the API (JSON 404s), fingerprinted assets (a missing asset
 * is a real 404, not a page), the service worker and manifest (a build without them must
 * not register index.html as a worker or read it as a manifest), and step 6's machine paths:
 * `/.well-known/…` (OAuth discovery, T12) and `/mcp` (T11), which a client must never read as
 * a page. */
const NOT_SPA =
  /^\/(?:(?:api|assets|\.well-known)(?:\/|$)|mcp(?:\/|$)|(?:sw\.js|manifest\.webmanifest)$)/;

/** Sends index.html for a client-side route, or returns false when the request isn't one. */
export function spaFallback(bundle: WebBundle, req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const pathname = req.url.split('?')[0] ?? '/';
  if (NOT_SPA.test(pathname)) return false;
  reply.code(200).type('text/html; charset=utf-8').header('cache-control', 'no-cache');
  reply.send(bundle.indexHtml);
  return true;
}
