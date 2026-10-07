// SPIKE (step 3, T0), PENDING the maintainer's keys: one structured-output request with an image
// to each provider (L50). Not run in T0: no keys were available. Keys come from the environment
// only; never write them into a file.
//
//   pnpm -C apps/server add -E ai@7.0.116 @ai-sdk/openai@4.0.78 @ai-sdk/anthropic@4.0.65 \
//     @ai-sdk/google@4.0.82 @ai-sdk/openai-compatible@3.0.57
//   cp docs/spikes/code/step3/server/ai-providers.spike.ts apps/server/
//   cd apps/server
//   KEPT_SPIKE_IMAGE=/path/to/photo.jpg \
//   OPENAI_API_KEY=… KEPT_SPIKE_OPENAI_MODEL=<model id> \
//   ANTHROPIC_API_KEY=… KEPT_SPIKE_ANTHROPIC_MODEL=<model id> \
//   GOOGLE_GENERATIVE_AI_API_KEY=… KEPT_SPIKE_GOOGLE_MODEL=<model id> \
//   KEPT_SPIKE_COMPAT_BASE_URL=http://<ollama-host>:11434/v1 KEPT_SPIKE_COMPAT_MODEL=<model id> \
//   node ai-providers.spike.ts
//
// Model ids are deliberately not written here: pick current vision models from each provider's
// model list. A provider whose variables are missing is skipped. The image must already be free
// of GPS metadata (the rule in the plan's "AI rules").
//
// Factory names from each package's dist/index.d.ts: createOpenAI, createAnthropic, createGoogle
// (createGoogleGenerativeAI is an alias of it), createOpenAICompatible({name, baseURL, apiKey?,
// fetch?, supportsStructuredOutputs?}).
import { readFileSync } from 'node:fs';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogle } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { APICallError, generateText, type LanguageModel, NoObjectGeneratedError, Output } from 'ai';
import { z } from 'zod';

globalThis.AI_SDK_LOG_WARNINGS = false;

const env = process.env;
const imagePath = env.KEPT_SPIKE_IMAGE;
if (!imagePath) throw new Error('set KEPT_SPIKE_IMAGE to a GPS-free JPEG');
const image = readFileSync(imagePath);

const schema = z.object({
  name: z.object({ value: z.string(), confidence: z.number() }),
  brand: z.object({ value: z.string(), confidence: z.number() }).optional(),
});

const candidates: Array<{ label: string; model: () => LanguageModel } | null> = [
  env.OPENAI_API_KEY && env.KEPT_SPIKE_OPENAI_MODEL
    ? {
        label: `openai ${env.KEPT_SPIKE_OPENAI_MODEL}`,
        model: () =>
          createOpenAI({ apiKey: env.OPENAI_API_KEY })(env.KEPT_SPIKE_OPENAI_MODEL as string),
      }
    : null,
  env.ANTHROPIC_API_KEY && env.KEPT_SPIKE_ANTHROPIC_MODEL
    ? {
        label: `anthropic ${env.KEPT_SPIKE_ANTHROPIC_MODEL}`,
        model: () =>
          createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })(
            env.KEPT_SPIKE_ANTHROPIC_MODEL as string,
          ),
      }
    : null,
  env.GOOGLE_GENERATIVE_AI_API_KEY && env.KEPT_SPIKE_GOOGLE_MODEL
    ? {
        label: `google ${env.KEPT_SPIKE_GOOGLE_MODEL}`,
        model: () =>
          createGoogle({ apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY })(
            env.KEPT_SPIKE_GOOGLE_MODEL as string,
          ),
      }
    : null,
  ...[true, false].map((structured) =>
    env.KEPT_SPIKE_COMPAT_BASE_URL && env.KEPT_SPIKE_COMPAT_MODEL
      ? {
          label: `openai-compatible ${env.KEPT_SPIKE_COMPAT_MODEL} supportsStructuredOutputs=${structured}`,
          model: () =>
            createOpenAICompatible({
              name: 'custom',
              baseURL: env.KEPT_SPIKE_COMPAT_BASE_URL as string,
              ...(env.KEPT_SPIKE_COMPAT_API_KEY ? { apiKey: env.KEPT_SPIKE_COMPAT_API_KEY } : {}),
              supportsStructuredOutputs: structured,
            })(env.KEPT_SPIKE_COMPAT_MODEL as string),
        }
      : null,
  ),
];

for (const c of candidates) {
  if (!c) continue;
  const t0 = Date.now();
  try {
    const r = await generateText({
      model: c.model(),
      instructions: 'Name the main object in the photo. Answer only with the requested JSON.',
      output: Output.object({ schema }),
      maxRetries: 0,
      maxOutputTokens: 1500,
      reasoning: 'low',
      abortSignal: AbortSignal.timeout(80_000),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'file', mediaType: 'image/jpeg', data: { type: 'data', data: image } },
          ],
        },
      ],
    });
    console.log(
      JSON.stringify({
        provider: c.label,
        ok: true,
        ms: Date.now() - t0,
        output: r.output,
        finishReason: r.finishReason,
        rawFinishReason: r.rawFinishReason,
        usage: r.usage,
        warnings: r.warnings,
        rateHeaders: Object.fromEntries(
          Object.entries(r.response.headers ?? {}).filter(([k]) =>
            /ratelimit|retry-after/i.test(k),
          ),
        ),
      }),
    );
  } catch (e) {
    // Never print the error object whole: APICallError.requestBodyValues holds the prompt and
    // the base64 image.
    console.log(
      JSON.stringify({
        provider: c.label,
        ok: false,
        ms: Date.now() - t0,
        kind: APICallError.isInstance(e)
          ? `APICallError ${e.statusCode}`
          : NoObjectGeneratedError.isInstance(e)
            ? `NoObjectGeneratedError finishReason=${e.finishReason}`
            : (e as Error).name,
        message: (e as Error).message.slice(0, 300),
      }),
    );
  }
}
