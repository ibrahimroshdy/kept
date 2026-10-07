// SPIKE (step 3, L50): offline, no network. Prints the request body each provider package
// builds (reasoning, response_format, strict, the image part), with a stubbed fetch.
// Offline: capture the request body each provider package builds. No network.
import { createGroq } from '@ai-sdk/groq';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { generateText, Output } from 'ai';
import { z } from 'zod';
globalThis.AI_SDK_LOG_WARNINGS = false;
const canned = { id: 'x', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: '{"colour":"red"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
const grab = (label: string) => (async (_url: any, init: any) => {
  const b = JSON.parse(init.body);
  const img = b.messages?.flatMap((m: any) => Array.isArray(m.content) ? m.content : []).find((p: any) => p.type === 'image_url');
  console.log(label, JSON.stringify({ keys: Object.keys(b).filter((k) => b[k] !== undefined), reasoning: b.reasoning, reasoning_effort: b.reasoning_effort, max_tokens: b.max_tokens, response_format: b.response_format && { type: b.response_format.type, strict: b.response_format.json_schema?.strict }, usage: b.usage, image_part: img && { keys: Object.keys(img.image_url), prefix: img.image_url.url.slice(0, 23) } }));
  return new Response(JSON.stringify(canned), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;
const args = (model: any, extra: any = {}) => ({ model, output: Output.object({ schema: z.object({ colour: z.string() }) }), maxRetries: 0, maxOutputTokens: 300, reasoning: 'low' as const, messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'x' }, { type: 'file' as const, mediaType: 'image/jpeg', data: { type: 'data' as const, data: new Uint8Array([1, 2, 3]) } }] }], ...extra });
let r = await generateText(args(createOpenRouter({ apiKey: 'none', fetch: grab('openrouter default') })('m')));
console.log('  warnings', JSON.stringify(r.warnings));
r = await generateText(args(createOpenRouter({ apiKey: 'none', fetch: grab('openrouter settings') })('m', { reasoning: { effort: 'low' }, usage: { include: true }, structuredOutputs: { strict: false } })));
r = await generateText(args(createGroq({ apiKey: 'none', fetch: grab('groq default') })('m')));
console.log('  warnings', JSON.stringify(r.warnings));
r = await generateText(args(createGroq({ apiKey: 'none', fetch: grab('groq strict off') })('m'), { providerOptions: { groq: { strictJsonSchema: false } } }));
r = await generateText(args(createOpenAICompatible({ name: 'groq', baseURL: 'https://example.invalid/v1', apiKey: 'none', supportsStructuredOutputs: true, fetch: grab('compat so=true') })('m'), { providerOptions: { groq: { strictJsonSchema: false } } }));
r = await generateText(args(createOpenAICompatible({ name: 'groq', baseURL: 'https://example.invalid/v1', apiKey: 'none', fetch: grab('compat default') })('m')));
console.log('  warnings', JSON.stringify(r.warnings));
