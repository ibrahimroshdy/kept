// O1: @sentry/core alone (no @sentry/node) reporting one error to a local stub that speaks the
// envelope endpoint, with a fetch transport, no default integrations, and a beforeSend that keeps
// only what T14 allows (request id + route). Prints what the stub received.
//   export PATH=/opt/homebrew/opt/node@24/bin:$PATH; node report.mjs
import { createServer } from 'node:http';
import { createStackParser, createTransport } from '@sentry/core';
import { nodeStackLineParser, ServerRuntimeClient } from '@sentry/core/server';

const got = [];
const stub = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    got.push({ method: req.method, url: req.url, auth: req.headers['x-sentry-auth'], contentType: req.headers['content-type'], body });
    res.writeHead(200).end('{}');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => stub.once('listening', r));
const dsn = `http://publickey@127.0.0.1:${stub.address().port}/42`;

const client = new ServerRuntimeClient({
  dsn,
  integrations: [],
  stackParser: createStackParser(nodeStackLineParser()),
  sendDefaultPii: false,
  transport: (options) =>
    createTransport(options, async (request) => {
      const r = await fetch(options.url, { method: 'POST', body: request.body, signal: AbortSignal.timeout(2000) });
      return { statusCode: r.status, headers: { 'x-sentry-rate-limits': r.headers.get('x-sentry-rate-limits'), 'retry-after': r.headers.get('retry-after') } };
    }),
  beforeSend(event) {
    // Keep exception + stack; drop request/user/extra/breadcrumbs; add only the request id and route.
    return { ...event, request: undefined, user: undefined, extra: undefined, breadcrumbs: undefined, tags: { request_id: 'req-123', route: 'GET /api/v1/things/:id' } };
  },
});
client.init();
client.captureException(new Error('boom: synthetic'));
await client.flush(2000);
stub.close();
for (const g of got) {
  const [envHeader, itemHeader, item] = g.body.split('\n');
  const ev = JSON.parse(item);
  console.log(JSON.stringify({
    method: g.method, url: g.url, xSentryAuth: g.auth ?? null, contentType: g.contentType ?? null,
    envelopeHeader: JSON.parse(envHeader), itemHeader: JSON.parse(itemHeader),
    eventKeys: Object.keys(ev).sort(), exception: ev.exception?.values?.[0]?.value, frames: ev.exception?.values?.[0]?.stacktrace?.frames?.length, tags: ev.tags,
  }, null, 1));
}
