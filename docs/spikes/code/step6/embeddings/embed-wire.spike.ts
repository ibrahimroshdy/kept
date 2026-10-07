/**
 * Spike S6.4, wire half without keys (step-6 plan, T0): what `embed`/`embedMany` (ai 7.0.116) send
 * to OpenAI (`@ai-sdk/openai` 4.0.78, `text-embedding-3-small`) and Google (`@ai-sdk/google` 4.0.82,
 * `gemini-embedding-001`): how many HTTP requests a batch makes, to which path, whether
 * `usage.tokens` is reported, and whether response headers (for the pacer) reach the result.
 * The fetch is stubbed: nothing leaves the laptop, no key is used. Response bodies follow the
 * providers' own response schemas as declared in the installed packages (dist/index.js).
 *
 * Run (from this folder, after `npm ci`):  node --import tsx embed-wire.spike.ts
 */
import { writeFileSync } from 'node:fs';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { embed, embedMany } from 'ai';

globalThis.AI_SDK_LOG_WARNINGS = false;

type Seen = { path: string; inputs: number; bodyBytes: number; startedAt: number; endedAt: number };

function stub(kind: 'openai' | 'google', seen: Seen[], dims = 8, delayMs = 20): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const body = JSON.parse(String(init?.body ?? '{}'));
    const startedAt = performance.now();
    await new Promise((r) => setTimeout(r, delayMs));
    const vec = () => Array.from({ length: dims }, () => Math.random());
    let n = 0;
    let json: unknown;
    if (kind === 'openai') {
      n = (body.input as string[]).length;
      json = { object: 'list', data: Array.from({ length: n }, (_, index) => ({ object: 'embedding', index, embedding: vec() })), model: body.model, usage: { prompt_tokens: 7 * n, total_tokens: 7 * n } };
    } else if (url.pathname.endsWith(':batchEmbedContents')) {
      n = (body.requests as unknown[]).length;
      json = { embeddings: Array.from({ length: n }, () => ({ values: vec() })) };
    } else {
      n = 1;
      json = { embedding: { values: vec() } };
    }
    seen.push({ path: url.pathname, inputs: n, bodyBytes: Buffer.byteLength(String(init?.body ?? '')), startedAt, endedAt: performance.now() });
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-ratelimit-remaining-tokens': '999000', 'x-ratelimit-remaining-requests': '2999' },
    });
  };
}

function model(kind: 'openai' | 'google', seen: Seen[]) {
  if (kind === 'openai') return createOpenAI({ apiKey: 'sk-stub', fetch: stub('openai', seen) }).embeddingModel('text-embedding-3-small');
  return createGoogleGenerativeAI({ apiKey: 'stub', fetch: stub('google', seen) }).embeddingModel('gemini-embedding-001');
}

const texts = (n: number) => Array.from({ length: n }, (_, i) => `HDMI cable ${i} · Garage › Box 3`);
const out: Record<string, unknown>[] = [];

for (const kind of ['openai', 'google'] as const) {
  {
    const seen: Seen[] = [];
    const r = await embed({ model: model(kind, seen), value: 'the thing for the TV', maxRetries: 0 });
    out.push({ kind, call: 'embed(1)', requests: seen.length, paths: [...new Set(seen.map((s) => s.path))], usageTokens: r.usage.tokens, dims: r.embedding.length, headersReachResult: Boolean(r.response?.headers?.['x-ratelimit-remaining-tokens']) });
  }
  for (const n of [3, 64, 150, 2100]) {
    for (const maxParallelCalls of [undefined, 1]) {
      const seen: Seen[] = [];
      const r = await embedMany({ model: model(kind, seen), values: texts(n), maxRetries: 0, ...(maxParallelCalls ? { maxParallelCalls } : {}) });
      // Concurrency actually observed: the most requests in flight at once.
      let peak = 0;
      for (const s of seen) peak = Math.max(peak, seen.filter((o) => o.startedAt < s.endedAt && o.endedAt > s.startedAt).length);
      out.push({
        kind,
        call: `embedMany(${n})`,
        maxParallelCalls: maxParallelCalls ?? 'default',
        requests: seen.length,
        inputsPerRequest: seen.map((s) => s.inputs),
        peakInFlight: peak,
        paths: [...new Set(seen.map((s) => s.path))],
        usageTokens: r.usage.tokens,
        responses: r.responses?.length,
        headersReachResult: Boolean(r.responses?.[0]?.headers?.['x-ratelimit-remaining-tokens']),
        embeddings: r.embeddings.length,
      });
    }
  }
}

writeFileSync(new URL('./embed-wire-results.json', import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
console.table(out.map((o) => ({ kind: o.kind, call: o.call, par: o.maxParallelCalls ?? '', requests: o.requests, peak: o.peakInFlight ?? '', usage: o.usageTokens, headers: o.headersReachResult, path: (o.paths as string[]).join(' ') })));
