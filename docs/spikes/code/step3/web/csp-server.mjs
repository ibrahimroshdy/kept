#!/usr/bin/env node
// SPIKE (step 3, T0). A static server for apps/web/dist with the same CSP directives the real
// server sends (apps/server/src/http/app.ts: default-src 'self'; script-src 'self' + index.html's
// inline-script hashes; frame-ancestors 'none'), optionally plus 'wasm-unsafe-eval'.
//
//   node csp-server.mjs <port> [--wasm]
//
// GET /api/ping answers JSON (to prove the service worker never caches /api). GET /__bump makes
// every later /sw.js carry a new trailing comment, so the browser sees a new worker version (the
// D148 update flow). Extensionless GETs fall back to index.html, like the server's SPA fallback.
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('./dist/', import.meta.url));
const port = Number(process.argv[2] ?? 4199);
const wasm = process.argv.includes('--wasm');

const indexHtml = readFileSync(join(dist, 'index.html'), 'utf8');
const hashes = [...indexHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
  (m) =>
    `'sha256-${createHash('sha256')
      .update(m[1] ?? '')
      .digest('base64')}'`,
);
const scriptSrc = ["'self'", ...(wasm ? ["'wasm-unsafe-eval'"] : []), ...hashes].join(' ');
const CSP = `default-src 'self'; script-src ${scriptSrc}; frame-ancestors 'none'`;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

let bump = 0;

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  res.setHeader('Content-Security-Policy', CSP);
  if (url.pathname === '/__bump') {
    bump += 1;
    res.end(String(bump));
    return;
  }
  if (url.pathname === '/api/ping') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ t: Date.now() }));
    return;
  }
  let file = normalize(join(dist, decodeURIComponent(url.pathname)));
  if (!file.startsWith(dist)) {
    res.statusCode = 400;
    res.end();
    return;
  }
  try {
    if (statSync(file).isDirectory()) file = join(file, 'index.html');
  } catch {
    if (!extname(url.pathname)) file = join(dist, 'index.html');
  }
  try {
    let body = readFileSync(file);
    if (url.pathname === '/sw.js' && bump > 0)
      body = Buffer.concat([body, Buffer.from(`\n// bump ${bump}\n`)]);
    res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', url.pathname === '/sw.js' ? 'no-cache' : 'public, max-age=0');
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`csp-server ${port} ${CSP}`));
