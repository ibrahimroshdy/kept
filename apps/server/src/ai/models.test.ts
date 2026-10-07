import { describe, expect, it } from 'vitest';
import { ListModelsError, listModels, splitForPicker } from './models.js';

const now = new Date('2026-09-26T12:00:00Z');

/** A fetch that answers from `routes` (url → [status, body]) and records what was asked. */
function stub(routes: Record<string, [number, unknown]>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const hit = routes[url];
    if (!hit) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(hit[1]), {
      status: hit[0],
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('listModels: Groq (top-level input_modalities)', () => {
  // Recorded shapes from the spike's listing (docs/spikes/code/step3/server/models-groq-2026-09-26.json).
  const body = {
    object: 'list',
    data: [
      {
        id: 'qwen/qwen3.8-27b',
        active: true,
        context_window: 131072,
        input_modalities: ['text', 'image'],
        output_modalities: ['text'],
        pricing: { prompt: '0.0000008', completion: '0.000004', input_cache_read: '0.0000004' },
      },
      {
        id: 'openai/gpt-oss-120b',
        active: true,
        context_window: 131072,
        input_modalities: ['text'],
        output_modalities: ['text'],
      },
      {
        id: 'meta-llama/llama-prompt-guard-2-22m',
        active: true,
        context_window: 512,
        input_modalities: ['text'],
        output_modalities: ['text'],
      },
      {
        id: 'whisper-large-v3',
        active: true,
        context_window: 448,
        input_modalities: ['audio'],
        output_modalities: ['transcription'],
      },
      {
        id: 'retired-model',
        active: false,
        input_modalities: ['text', 'image'],
        output_modalities: ['text'],
      },
    ],
  };

  it('reads vision from input_modalities, drops inactive models, and keeps prices', async () => {
    const { f, calls } = stub({ 'https://api.groq.com/openai/v1/models': [200, body] });
    const models = await listModels({ kind: 'groq', baseUrl: null }, 'test-key-groq', f, now);
    expect(calls[0]?.headers).toEqual({ authorization: 'Bearer test-key-groq' });
    expect(models.map((m) => m.id)).not.toContain('retired-model');
    expect(models.find((m) => m.id === 'qwen/qwen3.8-27b')).toEqual({
      id: 'qwen/qwen3.8-27b',
      vision: true,
      text: true,
      embeddings: false,
      pricing: { prompt: '0.0000008', completion: '0.000004', cachedInput: '0.0000004' },
    });
    const split = splitForPicker(models);
    expect(split.vision.map((m) => m.id)).toEqual(['qwen/qwen3.8-27b']);
    // The prompt guard (512 tokens of context) and whisper are not text models (spike §7).
    expect(split.text.map((m) => m.id)).toEqual(['qwen/qwen3.8-27b', 'openai/gpt-oss-120b']);
  });
});

describe('listModels: OpenRouter (architecture.input_modalities)', () => {
  const m = (id: string, inputs: string[], extra: Record<string, unknown> = {}) => ({
    id,
    context_length: 1_000_000,
    architecture: { input_modalities: inputs, output_modalities: ['text'] },
    pricing: { prompt: '0.0000001', completion: '0.0000005' },
    ...extra,
  });
  const body = {
    data: [
      m('openai/gpt-6-luna', ['text', 'image']),
      m('qwen/qwen3.8-27b:free', ['text', 'image']),
      m('openai/gpt-6-luna:batch', ['text', 'image']),
      m('~openai/gpt-luna-latest', ['text', 'image']),
      m('openrouter/free', ['text', 'image']),
      m('google/gemini-2.5-flash', ['text', 'image'], { expiration_date: '2026-10-20' }),
      m('bytedance-seed/seed-2.0-code', ['text', 'image'], { expiration_date: '2026-11-11' }),
      m('typesafe/jev-router', ['text', 'image'], { pricing: { prompt: '-1', completion: '-1' } }),
      m('deepseek/text-only', ['text']),
    ],
  };

  it('leaves out :free, :batch, routers and models retiring within 30 days', async () => {
    const { f } = stub({ 'https://openrouter.ai/api/v1/models': [200, body] });
    const models = await listModels(
      { kind: 'openrouter', baseUrl: null },
      'test-key-openrouter',
      f,
      now,
    );
    expect(models.map((x) => x.id)).toEqual([
      'openai/gpt-6-luna',
      'bytedance-seed/seed-2.0-code',
      'typesafe/jev-router',
      'deepseek/text-only',
    ]);
    expect(models.find((x) => x.id === 'typesafe/jev-router')?.pricing).toEqual({
      prompt: null,
      completion: null,
      cachedInput: null,
    });
    expect(models.find((x) => x.id === 'deepseek/text-only')?.vision).toBe(false);
  });
});

describe('listModels: kinds without modality metadata', () => {
  it('OpenAI: vision unknown (null) until a Test call; shutdown within 30 days dropped', async () => {
    const { f } = stub({
      'https://api.openai.com/v1/models': [
        200,
        {
          object: 'list',
          data: [
            { id: 'gpt-6-luna', object: 'model', owned_by: 'openai' },
            { id: 'old', shutdown_date: '2026-10-01' },
          ],
        },
      ],
    });
    const models = await listModels({ kind: 'openai', baseUrl: null }, 'sk-x', f, now);
    expect(models).toEqual([
      { id: 'gpt-6-luna', vision: null, text: null, embeddings: null, pricing: null },
    ]);
  });

  it('Anthropic: capabilities.image_input, paged by after_id, with its headers', async () => {
    const { f, calls } = stub({
      'https://api.anthropic.com/v1/models?limit=1000': [
        200,
        {
          data: [{ id: 'claude-sonnet-5', capabilities: { image_input: { supported: true } } }],
          has_more: true,
          last_id: 'claude-sonnet-5',
        },
      ],
      'https://api.anthropic.com/v1/models?limit=1000&after_id=claude-sonnet-5': [
        200,
        {
          data: [{ id: 'claude-old', capabilities: null }],
          has_more: false,
          last_id: 'claude-old',
        },
      ],
    });
    const models = await listModels(
      { kind: 'anthropic', baseUrl: null },
      'test-key-anthropic',
      f,
      now,
    );
    expect(calls[0]?.headers).toEqual({
      'x-api-key': 'test-key-anthropic',
      'anthropic-version': '2023-06-01',
    });
    expect(models).toEqual([
      { id: 'claude-sonnet-5', vision: true, text: true, embeddings: false, pricing: null },
      { id: 'claude-old', vision: null, text: true, embeddings: false, pricing: null },
    ]);
  });

  it('Google: generation methods, names without models/, paged by pageToken', async () => {
    const { f, calls } = stub({
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000': [
        200,
        {
          models: [
            {
              name: 'models/gemini-3.8-flash',
              supportedGenerationMethods: ['generateContent', 'countTokens'],
            },
          ],
          nextPageToken: 't2',
        },
      ],
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&pageToken=t2': [
        200,
        {
          models: [
            { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
          ],
        },
      ],
    });
    const models = await listModels({ kind: 'google', baseUrl: null }, 'test-key-google', f, now);
    expect(calls[0]?.headers).toEqual({ 'x-goog-api-key': 'test-key-google' });
    expect(models).toEqual([
      { id: 'gemini-3.8-flash', vision: null, text: true, embeddings: false, pricing: null },
      { id: 'gemini-embedding-001', vision: null, text: false, embeddings: true, pricing: null },
    ]);
    expect(splitForPicker(models).embeddings.map((m) => m.id)).toEqual(['gemini-embedding-001']);
  });

  it('an OpenAI-compatible server without a list endpoint → [] (the picker offers a custom id)', async () => {
    const { f } = stub({});
    expect(
      await listModels(
        { kind: 'openai_compatible', baseUrl: 'http://ollama.lan:11434/v1/' },
        null,
        f,
        now,
      ),
    ).toEqual([]);
  });

  it('an OpenAI-compatible listing is read verbatim, vision unknown', async () => {
    const { f, calls } = stub({
      'http://ollama.lan:11434/v1/models': [200, { data: [{ id: 'llava:13b' }] }],
    });
    expect(
      await listModels(
        { kind: 'openai_compatible', baseUrl: 'http://ollama.lan:11434/v1' },
        null,
        f,
        now,
      ),
    ).toEqual([{ id: 'llava:13b', vision: null, text: null, embeddings: null, pricing: null }]);
    expect(calls[0]?.headers).toEqual({});
  });
});

describe('listModels: errors', () => {
  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'retryable'],
    [503, 'retryable'],
    [400, 'provider_error'],
  ] as const)('HTTP %d → %s', async (status, code) => {
    const { f } = stub({ 'https://api.groq.com/openai/v1/models': [status, { error: 'x' }] });
    await expect(listModels({ kind: 'groq', baseUrl: null }, 'k', f, now)).rejects.toMatchObject({
      code,
    });
  });

  it('a network failure is retryable', async () => {
    const f = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(listModels({ kind: 'groq', baseUrl: null }, 'k', f, now)).rejects.toBeInstanceOf(
      ListModelsError,
    );
  });
});
