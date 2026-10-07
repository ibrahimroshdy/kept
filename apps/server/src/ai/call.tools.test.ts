// callModel with tools and a conversation (step-6 plan T8): one provider request per call, every
// step one ledger row, and nothing of the conversation in the ledger or the logs (D206).
import type { LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { TOOL_DEFS } from '@kept/mcp';
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { kit, resolved } from '../../test/ai-kit.js';
import { type CallRequest, callModel } from './call.js';
import type { KeptMessage, ToolSpec } from './convert.js';
import { capRow } from './memory.js';

const MARK_Q = 'QMARKER7731';
const MARK_RESULT = 'RESULTMARKER5520';
const MARK_ARG = 'ARGMARKER9014';

/** The tool specs T13 builds from @kept/mcp: zod → JSON Schema, validated by the same zod. */
function specOf(name: keyof typeof TOOL_DEFS): ToolSpec {
  const def = TOOL_DEFS[name];
  return {
    name,
    description: def.description,
    inputSchema: z.toJSONSchema(def.input, { io: 'input' }) as ToolSpec['inputSchema'],
    validate: (v) => {
      const r = def.input.safeParse(v);
      return r.success ? { success: true, value: r.data } : { success: false, error: r.error };
    },
  };
}
const DEFS = [specOf('where_is'), specOf('get_thing')];

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 },
});

const toolStep = (
  calls: { id: string; name: string; input: unknown }[],
): LanguageModelV4GenerateResult => ({
  content: [
    { type: 'reasoning', text: 'Look it up.' },
    ...calls.map((c) => ({
      type: 'tool-call' as const,
      toolCallId: c.id,
      toolName: c.name,
      input: JSON.stringify(c.input),
    })),
  ],
  finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
  usage: usage(900, 60),
  warnings: [],
});

const answer = (text: string): LanguageModelV4GenerateResult => ({
  content: [{ type: 'text', text }],
  finishReason: { unified: 'stop', raw: 'stop' },
  usage: usage(1200, 80),
  warnings: [],
});

/** A model answering `script` in turn, counting provider requests and keeping each prompt. */
function scripted(script: (LanguageModelV4GenerateResult | Error)[], delayMs = 0) {
  const prompts: LanguageModelV4CallOptions[] = [];
  let i = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(options);
      const r = script[Math.min(i, script.length - 1)];
      i++;
      if (delayMs) await new Promise((res) => setTimeout(res, delayMs));
      if (r instanceof Error) throw r;
      if (!r) throw new Error('no scripted result');
      return r;
    },
  });
  return { model, prompts, requests: () => i };
}

function request(over: Partial<CallRequest<string>> = {}): CallRequest<string> {
  return {
    resolved: resolved('groq', { model: 'openai/gpt-oss-120b' }),
    task: 'assistant_turn',
    locationId: 'loc-1',
    userId: 'user-1',
    links: { threadId: 'thread-1' },
    instructions: 'You are Kept.',
    text: `Where is the drill? ${MARK_Q}`,
    images: [],
    output: null,
    maxOutputTokens: 3248,
    expectedOutputTokens: 400,
    promptVersion: 'assistant-1',
    requestId: 'job-1',
    attempt: 1,
    jobId: 'job-1',
    tools: { defs: DEFS, choice: 'auto' },
    ...over,
  };
}

describe('callModel with tools: one request per call', () => {
  it('a tool-call step: exactly one request, the call returned, one ok row', async () => {
    const m = scripted([toolStep([{ id: 'c1', name: 'where_is', input: { query: 'drill' } }])]);
    const { rt, ledger } = kit({ runtime: { modelFactory: () => m.model } });
    const r = await callModel(rt, request());
    expect(m.requests()).toBe(1);
    expect(r).toMatchObject({
      status: 'ok',
      value: '',
      finishReason: 'tool-calls',
      toolCalls: [{ callId: 'c1', tool: 'where_is', input: { query: 'drill' } }],
      reasoning: 'Look it up.',
    });
    expect(m.prompts[0]?.tools?.map((t) => t.name)).toEqual(['where_is', 'get_thing']);
    expect(m.prompts[0]?.toolChoice).toEqual({ type: 'auto' });
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]).toMatchObject({
      sent: true,
      outcome: 'ok',
      task: 'assistant_turn',
      threadId: 'thread-1',
      finishReason: 'tool-calls',
      inputTokens: 900,
    });
  });

  it('two parallel calls in one step are still one request', async () => {
    const m = scripted([
      toolStep([
        { id: 'a', name: 'where_is', input: { query: 'drill' } },
        { id: 'b', name: 'get_thing', input: { thing_id: 'K7D2QX' } },
      ]),
    ]);
    const { rt } = kit({ runtime: { modelFactory: () => m.model } });
    const r = await callModel(rt, request());
    expect(m.requests()).toBe(1);
    expect(r.status === 'ok' && r.toolCalls.map((c) => c.tool)).toEqual(['where_is', 'get_thing']);
  });

  it('retries are off: a retryable 500 is one request, failed and retryable', async () => {
    const err = new APICallError({
      message: 'mock 500',
      url: 'https://mock.invalid/v1/chat/completions',
      requestBodyValues: {},
      statusCode: 500,
      responseHeaders: {},
      responseBody: '',
      isRetryable: true,
    });
    const m = scripted([err]);
    const { rt, ledger, gate, pacer } = kit({ runtime: { modelFactory: () => m.model } });
    const r = await callModel(rt, request());
    expect(m.requests()).toBe(1);
    expect(r).toMatchObject({ status: 'failed', retryable: true });
    expect(ledger.rows).toHaveLength(1);
    // Every reserved call settles and releases its lease.
    expect(gate.reservations.size).toBe(0);
    expect(pacer.slots.get('prov-groq')).toEqual([null]);
  });

  it('a two-step turn: two calls, two rows (turn then follow-up), the same request id', async () => {
    const m = scripted([
      toolStep([{ id: 'c1', name: 'where_is', input: { query: `drill ${MARK_ARG}` } }]),
      answer('In the Garage.'),
    ]);
    const { rt, ledger, logs } = kit({ runtime: { modelFactory: () => m.model } });
    const first = await callModel(rt, request());
    expect(first.status).toBe('ok');
    if (first.status !== 'ok') return;
    const call = first.toolCalls[0];
    if (!call) throw new Error('no call');
    const history: KeptMessage[] = [
      { role: 'user', parts: [{ type: 'text', text: `Where is the drill? ${MARK_Q}` }] },
      {
        role: 'assistant',
        parts: [{ type: 'tool_call', callId: call.callId, tool: call.tool, input: call.input }],
      },
      {
        role: 'tool',
        parts: [
          {
            type: 'tool_result',
            callId: call.callId,
            tool: call.tool,
            locationIds: ['loc-1'],
            output: { data: { items: [{ untrusted: { name: `Drill ${MARK_RESULT}` } }] } },
          },
        ],
      },
    ];
    const second = await callModel(
      rt,
      request({
        task: 'assistant_followup',
        text: '',
        conversation: { messages: history },
        expectedOutputTokens: 800,
      }),
    );
    expect(second).toMatchObject({ status: 'ok', value: 'In the Garage.', toolCalls: [] });
    expect(m.requests()).toBe(2);
    // The provider got the question, the call and its result, in order, and no empty question.
    expect(m.prompts[1]?.prompt.map((p) => p.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
    ]);
    expect(ledger.rows.map((r) => r.task)).toEqual(['assistant_turn', 'assistant_followup']);
    expect(ledger.rows.every((r) => r.threadId === 'thread-1' && r.requestId === 'job-1')).toBe(
      true,
    );
    expect(ledger.rows.every((r) => r.attempt === 1)).toBe(true);
    // D206: no question, tool argument or tool result in any ledger column or log line.
    const dump = JSON.stringify({ rows: ledger.rows, logs });
    for (const mark of [MARK_Q, MARK_ARG, MARK_RESULT]) expect(dump).not.toContain(mark);
  });

  it('a cap reached between steps: the second call pauses with one over_budget row', async () => {
    const m = scripted([
      toolStep([{ id: 'c1', name: 'where_is', input: { query: 'drill' } }]),
      answer('never sent'),
    ]);
    const { rt, ledger } = kit({
      caps: [
        capRow({
          scope: 'location',
          ownerAccountId: 'acct-1',
          locationId: 'loc-1',
          tokensPerMonth: 5000,
        }),
      ],
      runtime: { modelFactory: () => m.model },
    });
    expect((await callModel(rt, request({ maxOutputTokens: 1200 }))).status).toBe('ok');
    const r = await callModel(rt, request({ task: 'assistant_followup', maxOutputTokens: 4000 }));
    expect(r).toMatchObject({ status: 'paused', kind: 'cap', bucket: 'location:loc-1' });
    expect(m.requests()).toBe(1);
    expect(ledger.rows).toHaveLength(2);
    expect(ledger.rows[0]).toMatchObject({ sent: true, outcome: 'ok' });
    expect(ledger.rows[1]).toMatchObject({ sent: false, outcome: 'over_budget' });
  });

  it('one Groq key: a second concurrent assistant call waits (concurrency), never sent', async () => {
    const m = scripted([answer('ok')], 40);
    const { rt, ledger } = kit({ runtime: { modelFactory: () => m.model } });
    const results = await Promise.all([
      callModel(rt, request({ jobId: 'j1' })),
      callModel(rt, request({ jobId: 'j2' })),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['ok', 'paused']);
    expect(results.find((r) => r.status === 'paused')).toMatchObject({ reason: 'concurrency' });
    expect(m.requests()).toBe(1);
    expect(ledger.rows).toHaveLength(1);
  });

  it.each([
    [
      'input failing its schema',
      'where_is',
      { location_id: 'not-a-uuid' },
      'AI_InvalidToolInputError',
    ],
    ['a tool not offered', 'delete_everything', {}, 'AI_NoSuchToolError'],
  ])(
    '%s: schema_invalid / tool_input, one row with tokens, the calls returned',
    async (_n, name, input, error) => {
      const m = scripted([
        toolStep([
          { id: 'ok1', name: 'where_is', input: { query: 'drill' } },
          { id: 'bad', name, input },
        ]),
      ]);
      const { rt, ledger } = kit({ runtime: { modelFactory: () => m.model } });
      const r = await callModel(rt, request());
      expect(m.requests()).toBe(1);
      expect(r).toMatchObject({
        status: 'failed',
        outcome: 'schema_invalid',
        errorCode: 'tool_input',
        retryable: false,
        toolCalls: [
          { callId: 'ok1', tool: 'where_is' },
          { callId: 'bad', tool: name, invalid: { error } },
        ],
      });
      expect(ledger.rows).toHaveLength(1);
      expect(ledger.rows[0]).toMatchObject({
        sent: true,
        outcome: 'schema_invalid',
        errorCode: 'tool_input',
        inputTokens: 900,
        outputTokens: 60,
      });
    },
  );

  it('a length stop is truncated, never retried', async () => {
    const m = scripted([{ ...answer('cut'), finishReason: { unified: 'length', raw: 'length' } }]);
    const { rt } = kit({ runtime: { modelFactory: () => m.model } });
    expect(await callModel(rt, request())).toMatchObject({
      status: 'failed',
      outcome: 'truncated',
      errorCode: 'length',
      retryable: false,
    });
  });

  it('extraction-style calls are unchanged: no tools are sent, toolCalls is empty', async () => {
    const m = scripted([answer('red')]);
    const { rt } = kit({ runtime: { modelFactory: () => m.model } });
    const { tools: _t, ...plain } = request();
    const r = await callModel(rt, { ...plain, task: 'connection_test' });
    expect(r).toMatchObject({ status: 'ok', value: 'red', toolCalls: [] });
    expect(m.prompts[0]?.tools).toBeUndefined();
  });
});
