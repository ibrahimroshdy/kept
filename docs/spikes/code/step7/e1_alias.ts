/**
 * E1: alias batches on Groq (plan T15, D41, D69). One call per run, so the maintainer's tier
 * (1,000 output tokens a minute, V36) is respected by spacing the runs by hand.
 *
 *   KEPT_DEV_GROQ_API_KEY=… apps/server/node_modules/.bin/tsx docs/spikes/code/step7/e1_alias.ts <en|ar> <from> <count> [perLang]
 *
 * Uses the server's own provider wiring (providers.ts: modelFor, callSettingsFor) and the same
 * generateText + Output.object shape as ai/call.ts, so token counts are what T15 will see.
 */
import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { callSettingsFor, modelFor } from '../../../../apps/server/src/ai/providers.ts';

const serverRequire = createRequire(new URL('../../../../apps/server/package.json', import.meta.url));
const ai = await import(pathToFileURL(serverRequire.resolve('ai')).href);

export const NAMES = {
  en: [
    'Samsung QA55Q60 TV', 'Makita DHP485 cordless drill', 'Rocket R58 espresso machine',
    'Dyson V15 Detect', 'IKEA KALLAX shelf', 'Philips Hue Bridge', 'Brother HL-L2350DW',
    'Raspberry Pi 4 Model B', 'Bosch SMS4 dishwasher', 'Garden hose reel', 'Allen key set',
    'Ubiquiti U6 Lite', 'Canon EOS R6', 'Kindle Paperwhite', 'Weber kettle grill',
    'Stanley vacuum flask', 'Sony WH-1000XM5', 'Anker PowerCore 20000', 'Le Creuset cast iron pot',
    'First aid kit',
  ],
  ar: [
    'غسالة سامسونج', 'مكيف شارب', 'ثلاجة توشيبا', 'خلاط مولينكس', 'مكواة بخار فيليبس', 'سجادة صلاة',
    'دلة قهوة', 'طقم فناجين', 'شاحن آيفون', 'راوتر وي', 'مروحة سقف', 'سخان مياه أريستون',
    'بوتاجاز يونيفرسال', 'مكنسة كهربائية', 'ريموت التلفزيون', 'شنطة عدة', 'كشاف طوارئ',
    'ميزان حرارة', 'طاولة كي', 'صندوق إسعافات أولية',
  ],
};

const [lang, fromS, countS, perLangS] = process.argv.slice(2);
const from = Number(fromS);
const count = Number(countS);
const perLang = Number(perLangS || 3);
const names = NAMES[lang as 'en' | 'ar'].slice(from, from + count);
const languages = ['en', 'ar'];

// The prompt T15's prompt.ts starts from. Answers are by index; the model never sees or returns ids.
const instructions = [
  'You add search aliases to things in a household inventory.',
  `For each numbered thing, give at most ${perLang} aliases in each of these languages: ${languages.join(', ')}.`,
  'An alias is a word or short phrase a person would type to find the thing: its common name, a',
  'generic name, a nickname or another spelling. Do not repeat the name itself, do not give only the',
  'brand, no model numbers alone, no URLs or ids. Keep each alias under 4 words.',
  'Answer with every index exactly once.',
].join('\n');

const schema = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          i: { type: 'integer' },
          aliases: {
            type: 'object',
            properties: Object.fromEntries(languages.map((l) => [l, { type: 'array', items: { type: 'string' } }])),
            required: languages,
            additionalProperties: false,
          },
        },
        required: ['i', 'aliases'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
} as const;

const target = { kind: 'groq' as const, baseUrl: null, model: 'qwen/qwen3.8-27b', reasoning: (process.env.E1_REASONING || 'low') as 'low' };
const key = process.env.KEPT_DEV_GROQ_API_KEY;
if (!key) throw new Error('KEPT_DEV_GROQ_API_KEY is not set');
const settings = callSettingsFor(target);
const content = names.map((n, i) => `${i + 1}. ${n}`).join('\n');

if (process.env.E1_DRY) {
  console.log(instructions, '\n---\n', content);
  process.exit(0);
}
const t0 = performance.now();
let result;
try {
  result = await ai.generateText({
  model: modelFor(target, key, fetch),
  instructions,
  messages: [{ role: 'user', content }],
  output: ai.Output.object({ schema: ai.jsonSchema(schema), name: 'aliases' }),
  maxRetries: 0,
  maxOutputTokens: Number(process.env.E1_MAX_OUT || 900),
  ...(settings.reasoning ? { reasoning: settings.reasoning } : {}),
  ...(settings.providerOptions ? { providerOptions: settings.providerOptions } : {}),
  });
} catch (e) {
  const err = e as { name?: string; message?: string; statusCode?: number; usage?: unknown; text?: string; finishReason?: string };
  const rec = { at: new Date().toISOString(), lang, from, count, perLang, error: { name: err.name, message: err.message?.slice(0, 300), statusCode: err.statusCode, finishReason: err.finishReason, usage: err.usage, text: err.text?.slice(0, 2000) } };
  appendFileSync(new URL('./out/e1-results.jsonl', import.meta.url), `${JSON.stringify(rec)}\n`);
  console.log(JSON.stringify(rec, null, 1));
  process.exit(1);
}
const ms = Math.round(performance.now() - t0);
const h = result.response?.headers ?? {};
const record = {
  at: new Date().toISOString(),
  lang,
  from,
  count,
  perLang,
  reasoningLevel: target.reasoning,
  finishReason: result.finishReason,
  ms,
  usage: {
    input: result.usage.inputTokens,
    output: result.usage.outputTokens,
    reasoning: result.usage.outputTokenDetails?.reasoningTokens,
  },
  rate: Object.fromEntries(Object.entries(h).filter(([k]) => /^x-ratelimit/i.test(k))),
  names,
  answer: result.output,
};
appendFileSync(new URL('./out/e1-results.jsonl', import.meta.url), `${JSON.stringify(record)}\n`);
console.log(JSON.stringify(record, null, 1));
