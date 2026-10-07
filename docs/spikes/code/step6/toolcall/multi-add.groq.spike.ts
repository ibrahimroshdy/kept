/**
 * Spike S6.3 addendum for D213 (speak a list, add it all at once): does Groq `openai/gpt-oss-120b`
 * emit several `add_thing` calls in ONE step for a spoken list? One call per language (2 in all;
 * with tool-calling.groq.spike.ts's 6, the spike's 8-call budget). Same loop rules: no `execute`,
 * `stopWhen: isStepCount(1)`, retries off, `reasoning: 'low'`, 900 output tokens, 61 s apart.
 *
 * Run (from this folder):  KEPT_SPIKE_ENV=<repo>/.env node --import tsx multi-add.groq.spike.ts
 * Appends to groq-results.jsonl. The key is read from the env file and never printed.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { createGroq } from '@ai-sdk/groq';
import { generateText, isStepCount, jsonSchema, tool } from 'ai';

globalThis.AI_SDK_LOG_WARNINGS = false;
const file = process.env.KEPT_SPIKE_ENV;
if (!file) throw new Error('set KEPT_SPIKE_ENV');
const apiKey = readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('KEPT_DEV_GROQ_API_KEY='))?.slice(22).trim().replace(/^["']|["']$/g, '');
if (!apiKey) throw new Error('no key');

const obj = (properties: Record<string, unknown>, required: string[] = []) => jsonSchema({ type: 'object', properties, required, additionalProperties: false });
const tools = {
  where_is: tool({ description: 'Where is a thing? Give a name or words from it.', inputSchema: obj({ query: { type: 'string' } }, ['query']) }),
  search_things: tool({ description: 'Find things by words in their name, aliases, brand, model or notes.', inputSchema: obj({ query: { type: 'string' } }, ['query']) }),
  list_contents: tool({ description: 'What is inside a place or container?', inputSchema: obj({ id: { type: 'string' } }, ['id']) }),
  add_thing: tool({
    description: 'Propose adding ONE thing. Call it once per thing; the person confirms all proposals together.',
    inputSchema: obj({ name: { type: 'string' }, quantity: { type: 'integer', minimum: 1 }, place: { type: 'string', description: 'Place name or path, e.g. "Garage"' } }, ['name']),
  }),
  create_place: tool({ description: 'Propose a new place. The person confirms it.', inputSchema: obj({ name: { type: 'string' }, parent: { type: 'string' } }, ['name']) }),
  move_thing: tool({ description: 'Propose moving a thing. The person confirms it.', inputSchema: obj({ id: { type: 'string' }, to_place_id: { type: 'string' } }, ['id', 'to_place_id']) }),
};
const INSTRUCTIONS = 'You are Kept, a home inventory assistant. Write tools only propose changes; the person confirms them. Places in this location: Garage, Kitchen, Office. Answer in the language of the question.';
const QUESTIONS = { en: 'In the garage I have a drill, a ladder and two paint cans.', ar: 'في المخزن عندي شنيور وسلم وعلبتين دهان.' };

const groq = createGroq({ apiKey });
for (const [i, lang] of (['en', 'ar'] as const).entries()) {
  if (i > 0) await new Promise((r) => setTimeout(r, 61_000));
  const t0 = performance.now();
  const r = await generateText({
    model: groq('openai/gpt-oss-120b'), instructions: INSTRUCTIONS, prompt: QUESTIONS[lang], tools, toolChoice: 'auto',
    stopWhen: isStepCount(1), maxRetries: 0, maxOutputTokens: 900, reasoning: 'low', abortSignal: AbortSignal.timeout(80_000),
  });
  const row = {
    at: new Date().toISOString(), case: 'd213-multi-add', lang, ms: Math.round(performance.now() - t0), finishReason: r.finishReason,
    toolCalls: r.toolCalls.map((c) => ({ tool: c.toolName, input: c.input })), inputTokens: r.usage.inputTokens,
    outputTokens: r.usage.outputTokens, reasoningTokens: r.usage.outputTokenDetails.reasoningTokens, text: r.text || null,
  };
  appendFileSync(new URL('./groq-results.jsonl', import.meta.url), `${JSON.stringify(row)}\n`);
  console.log(JSON.stringify(row));
}
