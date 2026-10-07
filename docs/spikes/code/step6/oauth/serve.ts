/**
 * Spike S6.2 (V15), the real-client half: the same stand-in server as run.ts, on a public HTTPS
 * URL the maintainer provides, with a minimal sign-in and consent page, recording what each real
 * client does. Steps: docs/spikes/2026-09-30-step6-oauth-cimd.md, "Maintainer check".
 *
 *   SPIKE_PG=<dev superuser URL, no database> \
 *   SPIKE_PUBLIC_URL=https://<the tunnel's host> \
 *   SPIKE_PORT=<the local port the tunnel forwards to> \
 *   npx tsx serve.ts
 *
 * Optional: SPIKE_ALLOW_DCR=1 turns on open Dynamic Client Registration, only to observe a client
 * that refuses to connect without it (Q8 stays the maintainer's decision).
 *
 * Records to ./serve-log.jsonl (git-ignored): per request the path, status and user agent, and
 * for the OAuth and MCP requests what V15 asks (CIMD or DCR, `resource` sent or not, the MCP
 * protocol version). Never a token, code, verifier or password: only whether one was present.
 * Ctrl+C stops the server and drops the scratch database.
 */
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { createSpikeAuth, type SpikeAuth } from './auth.js';
import { createGuardedCimdFetch, type FetchLogEntry } from './cimd-fetch.js';
import { createDatabase, dropDatabase, here, roleUrl, type ServerState, startKept } from './lib.js';

const publicUrl = (process.env.SPIKE_PUBLIC_URL ?? '').replace(/\/$/, '');
const port = Number(process.env.SPIKE_PORT);
if (!publicUrl.startsWith('https://')) throw new Error('set SPIKE_PUBLIC_URL to the https URL');
if (!Number.isInteger(port) || port <= 0) throw new Error('set SPIKE_PORT');
const email = process.env.SPIKE_EMAIL ?? 'louis@kept.test';
const allowDcr = process.env.SPIKE_ALLOW_DCR === '1';
const logFile = path.join(here, 'serve-log.jsonl');
const record = (entry: Record<string, unknown>) =>
  appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (title: string, body: string) =>
  new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title></head><body style="font-family:system-ui;max-width:32rem;margin:2rem auto;padding:0 1rem">${body}</body></html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  );

// The sign-in page posts the signed query back as `oauth_query` (run.ts check L1: the answer is
// {redirect: true, url: '/oauth/consent?…'}).
const SIGNIN = `<h1>Kept spike: sign in</h1>
<form id="f"><p><input name="email" type="email" value="${esc(email)}" style="width:100%"></p>
<p><input name="password" type="password" placeholder="password" style="width:100%"></p>
<p><button>Sign in</button></p></form><pre id="o"></pre>
<script>
const f = document.getElementById('f');
f.onsubmit = async (e) => {
  e.preventDefault();
  const r = await fetch('/api/v1/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: f.email.value, password: f.password.value, oauth_query: location.search.slice(1) }) });
  const j = await r.json().catch(() => ({}));
  if (j.url) location.href = j.url; else document.getElementById('o').textContent = r.status + ' ' + JSON.stringify(j);
};
</script>`;

// The consent page: the client's name from /oauth2/public-client, shown as text only.
const CONSENT = `<h1>Kept spike: allow access?</h1>
<p>Client: <strong id="n">…</strong></p><p id="c"></p><p>Scopes: <span id="s"></span></p>
<p><button id="yes">Allow</button> <button id="no">Deny</button></p><pre id="o"></pre>
<script>
const q = new URLSearchParams(location.search);
document.getElementById('s').textContent = q.get('scope') || '';
fetch('/api/v1/auth/oauth2/public-client?client_id=' + encodeURIComponent(q.get('client_id') || ''))
  .then((r) => r.json()).then((j) => {
    document.getElementById('n').textContent = j.client_name || '(no name)';
    document.getElementById('c').textContent = q.get('client_id') || '';
  });
const answer = async (accept) => {
  const r = await fetch('/api/v1/auth/oauth2/consent', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accept, oauth_query: location.search.slice(1) }) });
  const j = await r.json().catch(() => ({}));
  const next = j.url || j.redirect_uri;
  if (next) location.href = next; else document.getElementById('o').textContent = r.status + ' ' + JSON.stringify(j);
};
document.getElementById('yes').onclick = () => answer(true);
document.getElementById('no').onclick = () => answer(false);
</script>`;

function parseBody(headers: Headers, body: Buffer): Record<string, unknown> {
  const type = headers.get('content-type') ?? '';
  const text = body.toString('utf8');
  try {
    if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
    if (type.includes('json') && text) return JSON.parse(text) as Record<string, unknown>;
  } catch {}
  return {};
}

const clientKind = (id: unknown) =>
  typeof id !== 'string' || !id ? 'none' : id.startsWith('https://') ? 'cimd-url' : 'registered-id (DCR or pre-registered)';

async function main(): Promise<void> {
  await createDatabase((k, v) => console.log(`## ${k}\n${JSON.stringify(v)}`));
  const authPool = new pg.Pool({ connectionString: roleUrl('auth'), max: 5 });
  const fetchLog: FetchLogEntry[] = [];
  const state = {
    auth: undefined as unknown as SpikeAuth,
    wellKnown: 'mounted' as ServerState['wellKnown'],
    // In-process JWKS: requireMcpAuth would fetch <public URL>/api/v1/auth/jwks through the tunnel.
    mcpGuard: 'verifyBearerToken' as ServerState['mcpGuard'],
    requests: [] as string[],
    toolCalls: [] as unknown[],
    jwtClaims: [] as unknown[],
  };
  const guarded = createGuardedCimdFetch({ allowPrivate: false, label: 'guardedFetch{allowPrivate:false}', log: fetchLog });
  state.auth = createSpikeAuth({
    pool: authPool,
    publicUrl,
    secret: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'),
    allowDynamicClientRegistration: allowDcr,
    allowUnauthenticatedClientRegistration: allowDcr,
    fetchClientMetadataResource: async (input, init) => {
      const before = fetchLog.length;
      try {
        return await guarded(input, init);
      } finally {
        for (const e of fetchLog.slice(before)) record({ kind: 'cimd-fetch', ...e, ms: Math.round(e.ms) });
      }
    },
  });
  const password = Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString('base64url');
  await state.auth.api.signUpEmail({ body: { email, password, name: 'Louis' } });

  const server = await startKept(state, {
    port,
    publicUrl,
    pages: (url) => (url.pathname === '/signin' ? page('Sign in', SIGNIN) : page('Allow access', CONSENT)),
    observe: ({ method, url, headers, body }, status) => {
      const base = { method, path: url.pathname, status, ua: headers.get('user-agent') };
      const p = url.pathname;
      if (p.endsWith('/oauth2/authorize')) {
        const q = url.searchParams;
        record({ ...base, kind: 'authorize', clientId: q.get('client_id'), clientKind: clientKind(q.get('client_id')), sendsResource: q.has('resource'), resource: q.get('resource'), scope: q.get('scope'), pkce: q.get('code_challenge_method'), prompt: q.get('prompt') });
      } else if (p.endsWith('/oauth2/register')) {
        const b = parseBody(headers, body);
        record({ ...base, kind: 'DCR register', clientName: b.client_name, redirectUris: b.redirect_uris, authMethod: b.token_endpoint_auth_method });
      } else if (p.endsWith('/oauth2/token')) {
        const b = parseBody(headers, body);
        record({ ...base, kind: 'token', contentType: headers.get('content-type'), grantType: b.grant_type, clientKind: clientKind(b.client_id), clientId: b.client_id, sendsResource: 'resource' in b, resource: b.resource, hasCodeVerifier: 'code_verifier' in b, dpop: headers.has('dpop'), basicAuth: (headers.get('authorization') ?? '').startsWith('Basic ') });
      } else if (p === '/mcp') {
        const b = parseBody(headers, body) as { method?: string; params?: { protocolVersion?: string } } | Record<string, unknown>[];
        const msgs = Array.isArray(b) ? b : [b];
        record({ ...base, kind: 'mcp', protocolVersionHeader: headers.get('mcp-protocol-version'), methods: msgs.map((m) => (m as { method?: string }).method), initializeVersion: msgs.map((m) => (m as { params?: { protocolVersion?: string } }).params?.protocolVersion).filter(Boolean), authorization: (headers.get('authorization') ?? '').split(' ')[0] || 'none' });
      } else if (p.startsWith('/.well-known/') || p.includes('/.well-known/') || p.endsWith('/jwks')) {
        record({ ...base, kind: 'discovery' });
      } else if (p === '/signin' || p === '/oauth/consent' || p.endsWith('/oauth2/consent') || p.endsWith('/sign-in/email')) {
        record({ ...base, kind: 'browser' });
      } else record({ ...base, kind: 'other' });
    },
  });

  console.log(`
Kept spike OAuth server
  public URL:   ${publicUrl}   (forwarded to 127.0.0.1:${port})
  MCP server:   ${publicUrl}/mcp
  sign in as:   ${email}
  password:     ${password}      (printed once, never written)
  DCR:          ${allowDcr ? 'ON (observation only)' : 'off'}
  log:          ${logFile}
Ctrl+C stops it and drops the scratch database.`);

  const stop = async () => {
    server.close();
    await authPool.end();
    await dropDatabase();
    console.log('stopped; database dropped');
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
