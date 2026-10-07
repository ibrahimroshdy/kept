// Step-4 spike T0: what web-push 3.6.7 sends, and how its errors read. A local HTTPS server
// stands in for a push service (web-push always speaks TLS); it answers 201, then 404, 410, 413,
// 429 and 500. Run: node recorder.mjs (from this directory; needs openssl for a throwaway cert).
import https from 'node:https';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.resolve(here, '../../../../../apps/server/package.json'));
const webpush = require('web-push');
const SP = mkdtempSync(path.join(tmpdir(), 'kept-push-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', `${SP}/push-key.pem`, '-out', `${SP}/push-cert.pem`, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
const seen = [];
let reply = 201;
const srv = https.createServer({ key: readFileSync(`${SP}/push-key.pem`), cert: readFileSync(`${SP}/push-cert.pem`) }, (req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    seen.push({ method: req.method, url: req.url, headers: req.headers, bodyLength: body.length, head: body.subarray(0, 21).toString('hex') });
    res.writeHead(reply, { 'content-type': 'text/plain' });
    res.end(reply === 201 ? '' : `status ${reply}`);
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const endpoint = `https://127.0.0.1:${srv.address().port}/push/abc`;
const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
const sub = { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
const vapid = webpush.generateVAPIDKeys();
console.log('vapid lengths', Buffer.from(vapid.publicKey, 'base64url').length, Buffer.from(vapid.privateKey, 'base64url').length, 'b64 chars', vapid.publicKey.length, vapid.privateKey.length);
const agent = new https.Agent({ ca: readFileSync(`${SP}/push-cert.pem`) });
const base = { vapidDetails: { subject: 'mailto:kept@example.org', publicKey: vapid.publicKey, privateKey: vapid.privateKey }, agent, timeout: 5000 };
const payload = JSON.stringify({ k: 'reminder', id: '0192f0c3-7c55-7000-8000-000000000000', url: '/things/abc' });

// 1. What the library would send, without sending.
for (const contentEncoding of ['aes128gcm', 'aesgcm']) {
  const d = webpush.generateRequestDetails(sub, payload, { ...base, contentEncoding, TTL: 3600, urgency: 'high', topic: 'reminder-abc' });
  const h = { ...d.headers }; if (h.Authorization) h.Authorization = h.Authorization.replace(/t=[^,]+/, 't=<jwt>').replace(/k=[^,]+/, 'k=<publicKey>'); if (h['Crypto-Key']) h['Crypto-Key'] = h['Crypto-Key'].replace(/dh=[^;]+/, 'dh=<server key>').replace(/p256ecdsa=[^;,]+/, 'p256ecdsa=<publicKey>');
  if (h.Authorization?.startsWith('WebPush ')) h.Authorization = 'WebPush <jwt>';
  if (h.Encryption) h.Encryption = h.Encryption.replace(/salt=.+/, 'salt=<16 bytes>');
  console.log(contentEncoding, d.method, JSON.stringify(h), 'body', d.body.length, 'B for a', payload.length, 'B payload');
}
// Default encoding:
console.log('default encoding header:', webpush.generateRequestDetails(sub, payload, base).headers['Content-Encoding']);
// A topic longer than 32 chars:
try { webpush.generateRequestDetails(sub, payload, { ...base, topic: 'x'.repeat(33) }); console.log('topic 33: accepted'); } catch (e) { console.log('topic 33:', e.message); }
try { webpush.generateRequestDetails(sub, payload, { ...base, topic: 'a.b' }); console.log('topic with a dot: accepted'); } catch (e) { console.log('topic with a dot:', e.message); }

// 2. Real sends to the recorder, and the errors for non-2xx.
for (const status of [201, 404, 410, 413, 429, 500]) {
  reply = status;
  try {
    const r = await webpush.sendNotification(sub, payload, { ...base, TTL: 3600 });
    console.log(status, '→ resolved', JSON.stringify({ statusCode: r.statusCode, body: r.body }));
  } catch (e) {
    console.log(status, '→ rejected', e.name, JSON.stringify({ statusCode: e.statusCode, body: e.body, message: e.message, endpoint: e.endpoint === endpoint }), 'instanceof WebPushError', e instanceof webpush.WebPushError);
  }
}
const last = seen[0];
console.log('recorded first request:', last.method, last.url, JSON.stringify(Object.fromEntries(Object.entries(last.headers).map(([k, v]) => [k, k === 'authorization' ? v.replace(/t=[^,]+/, 't=<jwt>').replace(/k=[^,]+/, 'k=<publicKey>') : v]))), 'body', last.bodyLength, 'B, first 21 bytes (salt 16 + rs 4 + idlen 1):', last.head);
// 3. A bad certificate is refused (no agent with the CA).
reply = 201;
try { await webpush.sendNotification(sub, payload, { vapidDetails: base.vapidDetails, timeout: 3000 }); console.log('no CA: resolved'); } catch (e) { console.log('no CA → rejected', e.name, e.code ?? '', String(e.message).slice(0, 80)); }
// 4. An http: endpoint.
try { await webpush.sendNotification({ ...sub, endpoint: endpoint.replace('https:', 'http:') }, payload, base); console.log('http endpoint: resolved'); } catch (e) { console.log('http endpoint → rejected', e.name, e.code ?? '', String(e.message).slice(0, 100)); }
srv.close();
rmSync(SP, { recursive: true, force: true });
