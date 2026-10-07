// biome-ignore-all lint/suspicious/noExplicitAny: the spike inspects wire shapes
// SPIKE (step 3, T0): AI SDK v7 (ai 7.0.116) structured output with an image, on a mock model.
// No provider keys: the real-provider half (L50) is pending the maintainer's keys.
//
//   pnpm -C apps/server add -E ai@7.0.116
//   cp docs/spikes/code/step3/server/ai-sdk.spike.test.ts apps/server/src/
//   cp docs/spikes/code/step3/server/vitest.spike.config.ts apps/server/
//   cd apps/server && pnpm exec vitest run -c vitest.spike.config.ts
//
// Names read from ai/dist/index.d.ts, ai/dist/test/index.d.ts, @ai-sdk/provider 4.0.18 and
// @ai-sdk/provider-utils 5.0.49 dist/index.d.ts.
import type { LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { APICallError, generateText, NoObjectGeneratedError, Output, RetryError } from 'ai';
import { MockLanguageModelV3, MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const schema = z.object({
  objects: z.array(
    z.object({
      name: z.object({ value: z.string(), confidence: z.number() }),
    }),
  ),
});

// A few bytes that start like a JPEG: the SDK must pass bytes through untouched.
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

const GOOD = JSON.stringify({ objects: [{ name: { value: 'Drill', confidence: 0.92 } }] });

function result(
  text: string,
  unified: LanguageModelV4GenerateResult['finishReason']['unified'] = 'stop',
): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified, raw: unified === 'length' ? 'max_tokens' : 'end_turn' },
    usage: {
      inputTokens: { total: 1200, noCache: 1000, cacheRead: 200, cacheWrite: 0 },
      outputTokens: { total: 340, text: 90, reasoning: 250 },
    },
    response: { headers: { 'x-ratelimit-remaining-tokens': '7000' } },
    warnings: [],
  };
}

const imageAsFile = {
  type: 'file' as const,
  mediaType: 'image/jpeg',
  data: { type: 'data' as const, data: jpeg },
};

function call(model: MockLanguageModelV4 | MockLanguageModelV3, image: unknown = imageAsFile) {
  return generateText({
    model,
    instructions: 'Extract the thing in the photo.',
    output: Output.object({ schema }),
    maxRetries: 0,
    maxOutputTokens: 1500,
    reasoning: 'low',
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'What is this?' }, image as any],
      },
    ],
  });
}

describe('AI SDK v7 on a mock model', () => {
  it('MockLanguageModelV4: structured output from a text + image message', async () => {
    const model = new MockLanguageModelV4({ doGenerate: result(GOOD) });
    const r = await call(model);
    expect(r.output).toEqual({ objects: [{ name: { value: 'Drill', confidence: 0.92 } }] });
    expect(r.finishReason).toBe('stop');
    expect(r.rawFinishReason).toBe('end_turn');
    expect(r.usage.inputTokens).toBe(1200);
    expect(r.usage.inputTokenDetails.cacheReadTokens).toBe(200);
    expect(r.usage.outputTokens).toBe(340);
    expect(r.usage.outputTokenDetails.reasoningTokens).toBe(250);
    expect(r.response.headers?.['x-ratelimit-remaining-tokens']).toBe('7000');

    // What the provider receives (LanguageModelV4CallOptions).
    const sent = model.doGenerateCalls[0] as LanguageModelV4CallOptions;
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(sent.maxOutputTokens).toBe(1500);
    expect(sent.reasoning).toBe('low');
    expect(sent.responseFormat?.type).toBe('json');
    expect((sent.responseFormat as any).schema.type).toBe('object');
    const user = sent.prompt.find((m) => m.role === 'user');
    console.log(
      'V4 prompt as sent:',
      JSON.stringify(sent.prompt, (_k, v) => (v instanceof Uint8Array ? `<${v.length} bytes>` : v)),
    );
    const filePart = ((user?.content ?? []) as any[]).find((p) => p.type === 'file');
    expect(filePart.mediaType).toBe('image/jpeg');
    console.log('system message as sent:', JSON.stringify(sent.prompt[0]));
  });

  it('the deprecated ImagePart ({type:"image", image, mediaType}) still reaches the model as a file part', async () => {
    const model = new MockLanguageModelV4({ doGenerate: result(GOOD) });
    await call(model, { type: 'image', image: jpeg, mediaType: 'image/jpeg' });
    const user = model.doGenerateCalls[0]?.prompt.find((m) => m.role === 'user');
    const part = ((user?.content ?? []) as any[]).find((p) => p.type !== 'text');
    console.log(
      'ImagePart arrives as:',
      JSON.stringify(part, (_k, v) => (v instanceof Uint8Array ? `<${v.length} bytes>` : v)),
    );
    expect(part.type).toBe('file');
  });

  it('MockLanguageModelV3 is accepted too', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: result(GOOD) as any,
    });
    const r = await call(model);
    expect(r.output.objects[0]?.name.value).toBe('Drill');
    console.log('V3 warnings:', JSON.stringify(r.warnings));
    console.log(
      'V3 received reasoning:',
      JSON.stringify((model.doGenerateCalls[0] as any).reasoning),
      'providerOptions:',
      JSON.stringify(model.doGenerateCalls[0]?.providerOptions),
    );
  });

  it('a length stop with truncated JSON throws NoObjectGeneratedError carrying finishReason and usage', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: result('{"objects":[{"name":{"val', 'length'),
    });
    let where = 'generateText rejected';
    const err = await call(model).then(
      (r) => {
        where = 'reading result.output threw';
        try {
          return r.output;
        } catch (e) {
          return e;
        }
      },
      (e: unknown) => e,
    );
    console.log('length error thrown by:', where);
    expect(where).toBe('generateText rejected');
    expect(NoObjectGeneratedError.isInstance(err)).toBe(true);
    const e = err as NoObjectGeneratedError;
    expect(e.finishReason).toBe('length');
    expect(e.usage?.outputTokenDetails.reasoningTokens).toBe(250);
    expect(e.text).toBe('{"objects":[{"name":{"val');
    console.log('length error:', e.message, '| cause:', String(e.cause).slice(0, 120));
  });

  it('a length stop with complete, valid JSON is NOT an error: callModel must check finishReason itself', async () => {
    const model = new MockLanguageModelV4({ doGenerate: result(GOOD, 'length') });
    const r = await call(model);
    expect(r.finishReason).toBe('length');
    expect(r.output.objects).toHaveLength(1);
  });

  it('invalid JSON and a schema mismatch both give NoObjectGeneratedError (finishReason stop)', async () => {
    for (const text of ['not json', JSON.stringify({ objects: [{ name: 'Drill' }] })]) {
      const model = new MockLanguageModelV4({ doGenerate: result(text) });
      const err = await call(model).then(
        () => null,
        (e: unknown) => e,
      );
      expect(NoObjectGeneratedError.isInstance(err)).toBe(true);
      expect((err as NoObjectGeneratedError).finishReason).toBe('stop');
      expect((err as NoObjectGeneratedError).usage?.inputTokens).toBe(1200);
      console.log(
        `bad output ${JSON.stringify(text).slice(0, 30)}: cause`,
        (err as NoObjectGeneratedError).cause?.constructor?.name,
      );
    }
  });

  it('with maxRetries: 0 a 429 surfaces as the APICallError itself, after one call, with statusCode and responseHeaders', async () => {
    let calls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        calls++;
        throw new APICallError({
          message: 'Rate limit reached',
          url: 'https://api.example.test/v1/chat',
          requestBodyValues: { secret: 'the prompt and image bytes live here' },
          statusCode: 429,
          responseHeaders: { 'retry-after': '7' },
          responseBody: '{"error":"rate_limited"}',
          isRetryable: true,
        });
      },
    });
    const err = await call(model).then(
      () => null,
      (e: unknown) => e,
    );
    expect(calls).toBe(1);
    expect(APICallError.isInstance(err)).toBe(true);
    expect(RetryError.isInstance(err)).toBe(false);
    const e = err as APICallError;
    expect(e.statusCode).toBe(429);
    expect(e.responseHeaders?.['retry-after']).toBe('7');
    expect(e.isRetryable).toBe(true);
    // requestBodyValues carries the whole request (prompt, base64 image): never log the error raw.
    expect(e.requestBodyValues).toBeDefined();
  });

  it('a 401 surfaces as APICallError with isRetryable false', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new APICallError({
          message: 'Invalid API key',
          url: 'https://api.example.test/v1/chat',
          requestBodyValues: {},
          statusCode: 401,
          isRetryable: false,
        });
      },
    });
    const err = (await call(model).then(
      () => null,
      (e: unknown) => e,
    )) as APICallError;
    expect(err.statusCode).toBe(401);
    expect(err.isRetryable).toBe(false);
  });

  it('the default maxRetries (2) would retry a 5xx and wrap it in RetryError: why callModel passes 0', async () => {
    let calls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        calls++;
        throw new APICallError({
          message: 'Bad gateway',
          url: 'https://api.example.test/v1/chat',
          requestBodyValues: {},
          statusCode: 502,
          isRetryable: true,
        });
      },
    });
    const err = await generateText({
      model,
      prompt: 'hi',
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(calls).toBe(3);
    expect(RetryError.isInstance(err)).toBe(true);
    console.log(
      'default retries: reason',
      (err as RetryError).reason,
      'errors',
      (err as RetryError).errors.length,
    );
  }, 20_000);

  it('abortSignal: AbortSignal.timeout() rejects with a TimeoutError DOMException', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: (opts) =>
        new Promise((_resolve, reject) => {
          opts.abortSignal?.addEventListener('abort', () => reject(opts.abortSignal?.reason));
        }),
    });
    const err = await generateText({
      model,
      prompt: 'hi',
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(50),
    }).then(
      () => null,
      (e: unknown) => e,
    );
    console.log(
      'timeout error:',
      (err as Error)?.name,
      (err as Error)?.constructor?.name,
      APICallError.isInstance(err),
    );
    expect((err as Error).name).toBe('TimeoutError');
  });
});
