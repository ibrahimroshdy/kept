// SPIKE (step 3, L50): offline, no network. Output.object with the zod schema throws away the
// whole answer when one optional field is bad; Output.object with jsonSchema(wire) returns it
// as-is, and parseLenient then drops only the bad field (L52). Run like real-providers.spike.ts.
import { generateText, Output, jsonSchema, NoObjectGeneratedError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
const { EXTRACTION_SCHEMAS, parseLenient } = await import(`${process.env.KEPT_SPIKE_REPO}/packages/shared/src/extraction.ts`);
globalThis.AI_SDK_LOG_WARNINGS = false;
// A reading with a valid value but a bad optional field (unit 'kms').
const answer = { value: { value: 52340, confidence: 0.9 }, unit: { value: 'kms', confidence: 0.4 } };
const model = () => new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: 'text', text: JSON.stringify(answer) }], finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] }) });
const msg = [{ role: 'user' as const, content: 'x' }];
try { await generateText({ model: model(), output: Output.object({ schema: EXTRACTION_SCHEMAS.reading }), messages: msg }); console.log('zod: resolved'); }
catch (e) { console.log('zod schema:', NoObjectGeneratedError.isInstance(e) ? 'NoObjectGeneratedError (whole answer lost)' : String(e)); }
const wire = z.toJSONSchema(EXTRACTION_SCHEMAS.reading);
const r = await generateText({ model: model(), output: Output.object({ schema: jsonSchema(wire as any) }), messages: msg });
console.log('jsonSchema(): resolved, output =', JSON.stringify(r.output), '→ parseLenient =', JSON.stringify(parseLenient(EXTRACTION_SCHEMAS.reading, r.output)));
