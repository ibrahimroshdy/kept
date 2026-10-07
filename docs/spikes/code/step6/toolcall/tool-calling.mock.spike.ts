/**
 * Spike S6.3, mock half (step-6 plan, T0): tool calling through `callModel`'s shape on AI SDK 7.0.116
 * with `MockLanguageModelV4`. Tools have NO `execute`; `stopWhen: isStepCount(1)`; retries off.
 *
 * Records: where `toolCalls` are read; the `finishReason` for a tool call; that `doGenerate` ran
 * exactly once per `generateText`; what an input failing the tool's schema, and an unknown tool
 * name, do; the message shapes for an assistant tool call and a tool result in the NEXT request
 * (as the provider receives them: `doGenerate`'s `prompt`); whether `usage` is per step.
 *
 * Run (from this folder, after `npm ci`):  node --import tsx tool-calling.mock.spike.ts
 * Prints one JSON document and writes it to mock-results.json. Exits 1 if a check fails.
 */
import { writeFileSync } from 'node:fs';
import type { LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { generateText, isStepCount, jsonSchema, type ModelMessage, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

globalThis.AI_SDK_LOG_WARNINGS = false;

const checks: { name: string; ok: boolean; detail?: unknown }[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => checks.push({ name, ok, detail });

const whereIsSchema = {
  type: 'object',
  properties: { query: { type: 'string', minLength: 1 }, location_id: { type: 'string' } },
  required: ['query'],
  additionalProperties: false,
} as const;

// Kept's ToolSpec → the SDK's ToolSet: description + JSON schema, and never an execute function.
const tools = {
  where_is: tool({ description: 'Where is a thing? Give a name or words from it.', inputSchema: jsonSchema(whereIsSchema) }),
  get_thing: tool({
    description: 'One thing by id or short code.',
    inputSchema: jsonSchema({ type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }),
  }),
};

function usage(input: number, output: number, reasoning: number): LanguageModelV4GenerateResult['usage'] {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output - reasoning, reasoning },
  };
}

function toolCallResult(name: string, input: string, id = 'call_1'): LanguageModelV4GenerateResult {
  return {
    content: [
      { type: 'reasoning', text: 'The user asks where the drill is.' },
      { type: 'tool-call', toolCallId: id, toolName: name, input },
    ],
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    usage: usage(900, 60, 40),
    response: { headers: { 'x-ratelimit-remaining-tokens': '7100' } },
    warnings: [],
  };
}

function textResult(text: string): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: usage(1300, 80, 30),
    warnings: [],
  };
}

function counting(results: LanguageModelV4GenerateResult[]) {
  const prompts: LanguageModelV4CallOptions[] = [];
  let i = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(options);
      const r = results[Math.min(i, results.length - 1)];
      i++;
      if (!r) throw new Error('no result');
      return r;
    },
  });
  return { model, prompts, calls: () => i };
}

const BASE = {
  instructions: 'You are Kept. Answer from tool results only.',
  toolChoice: 'auto' as const,
  stopWhen: isStepCount(1),
  maxRetries: 0,
  maxOutputTokens: 1200,
  reasoning: 'low' as const,
};

const out: Record<string, unknown> = {};

// 1. One tool call: one provider request, the call is read from `toolCalls`.
{
  const m = counting([toolCallResult('where_is', '{"query":"drill"}'), textResult('never reached')]);
  const question: ModelMessage[] = [{ role: 'user', content: 'Where is the drill?' }];
  const r = await generateText({ model: m.model, tools, messages: question, abortSignal: AbortSignal.timeout(80_000), ...BASE });
  check('one request for a tool-call step', m.calls() === 1, m.calls());
  check('finishReason is tool-calls', r.finishReason === 'tool-calls', { finishReason: r.finishReason, raw: r.rawFinishReason });
  check('toolCalls carries id, name, input (parsed)', r.toolCalls.length === 1 && r.toolCalls[0]?.toolCallId === 'call_1' && r.toolCalls[0]?.toolName === 'where_is' && (r.toolCalls[0]?.input as { query?: string }).query === 'drill', r.toolCalls);
  check('no tool results (no execute)', r.toolResults.length === 0, r.toolResults);
  check('steps.length is 1', r.steps.length === 1, r.steps.length);
  check('usage reported (single step: usage == totalUsage)', r.usage.inputTokens === 900 && r.totalUsage.inputTokens === 900 && r.usage.outputTokenDetails.reasoningTokens === 40, { usage: r.usage, totalUsage: r.totalUsage });
  out.toolCall = { toolCalls: r.toolCalls, finishReason: r.finishReason, rawFinishReason: r.rawFinishReason, text: r.text, reasoningText: r.reasoningText };
  out.responseMessages = r.response.messages;
  out.toolsAsSentToProvider = m.prompts[0]?.tools;
  out.toolChoiceAsSent = m.prompts[0]?.toolChoice;
  check('tool set is JSON-serialisable (no functions)', JSON.stringify(tools).length > 0 && !JSON.stringify(tools).includes('function'), null);

  // 2. The follow-up: history + response.messages + a tool result → one request, a text answer.
  const m2 = counting([textResult('The drill is in Garage › Shelf 2 [link].')]);
  const toolMessage: ModelMessage = {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'call_1',
        toolName: 'where_is',
        output: { type: 'json', value: { data: [{ id: 't1', path: ['Garage', 'Shelf 2'], untrusted: { name: 'Drill' } }], as_of: '2026-09-30T00:00:00Z' } },
      },
    ],
  };
  const messages: ModelMessage[] = [...question, ...r.response.messages, toolMessage];
  const r2 = await generateText({ model: m2.model, tools, messages, ...BASE });
  check('follow-up: one request', m2.calls() === 1, m2.calls());
  check('follow-up: text answer, finishReason stop', r2.text.startsWith('The drill') && r2.finishReason === 'stop', { text: r2.text, finishReason: r2.finishReason });
  out.followupPromptAsSentToProvider = m2.prompts[0]?.prompt;
  out.historyMessagesKeptSends = messages;
}

// 3. Input failing the tool's schema (missing required `query`).
{
  const m = counting([toolCallResult('where_is', '{"location_id":"x"}')]);
  const r = await generateText({ model: m.model, tools, prompt: 'Where is it?', ...BASE })
    .then((r) => ({ threw: false as const, r }))
    .catch((e: Error) => ({ threw: true as const, e }));
  if (r.threw) {
    out.invalidInput = { threw: true, name: r.e.name, message: r.e.message.slice(0, 200) };
    check('invalid input: behaviour recorded', true, out.invalidInput);
  } else {
    const content = r.r.content.map((p) => ({ type: p.type, ...(p.type === 'tool-error' ? { error: String((p as { error: unknown }).error).slice(0, 200), input: (p as { input: unknown }).input } : {}), ...(p.type === 'tool-call' ? { invalid: (p as { invalid?: boolean }).invalid, input: (p as { input: unknown }).input } : {}) }));
    out.invalidInput = { threw: false, requests: m.calls(), finishReason: r.r.finishReason, toolCalls: r.r.toolCalls, content };
    check('invalid input: one request, no throw', m.calls() === 1, out.invalidInput);
  }
}

// 3b. The same invalid input against a zod input schema (jsonSchema() without `validate` checks
// nothing: case 3 shows the SDK passes the input through as valid).
{
  const { z } = await import('zod');
  const zTools = { where_is: tool({ description: 'Where is a thing?', inputSchema: z.object({ query: z.string().min(1), location_id: z.string().optional() }).strict() }) };
  const m = counting([toolCallResult('where_is', '{"location_id":"x"}')]);
  const r = await generateText({ model: m.model, tools: zTools, prompt: 'Where is it?', ...BASE })
    .then((r) => ({ threw: false as const, r }))
    .catch((e: Error) => ({ threw: true as const, e }));
  if (r.threw) {
    out.invalidInputZod = { threw: true, name: r.e.name, message: r.e.message.slice(0, 200) };
  } else {
    out.invalidInputZod = {
      threw: false,
      requests: m.calls(),
      finishReason: r.r.finishReason,
      toolCalls: r.r.toolCalls.map((c) => ({ toolName: c.toolName, input: c.input, invalid: (c as { invalid?: boolean }).invalid, error: (c as { error?: { name?: string } }).error?.name })),
      content: r.r.content.map((p) => ({ type: p.type, ...(p.type === 'tool-error' ? { error: String((p as { error: unknown }).error).slice(0, 160) } : {}) })),
    };
  }
  check('invalid input (zod): one request', m.calls() === 1, out.invalidInputZod);
}

// 4. A tool name the model invented.
{
  const m = counting([toolCallResult('delete_everything', '{}')]);
  const r = await generateText({ model: m.model, tools, prompt: 'Delete it all', ...BASE })
    .then((r) => ({ threw: false as const, r }))
    .catch((e: Error) => ({ threw: true as const, e }));
  if (r.threw) {
    out.unknownTool = { threw: true, name: r.e.name, message: r.e.message.slice(0, 200) };
  } else {
    const content = r.r.content.map((p) => ({ type: p.type, ...(p.type === 'tool-error' ? { error: String((p as { error: unknown }).error).slice(0, 200) } : {}), ...(p.type === 'tool-call' ? { invalid: (p as { invalid?: boolean }).invalid, toolName: (p as { toolName: string }).toolName } : {}) }));
    out.unknownTool = { threw: false, requests: m.calls(), finishReason: r.r.finishReason, toolCalls: r.r.toolCalls, content };
  }
  check('unknown tool: one request', m.calls() === 1, out.unknownTool);
}

// 5. Two tool calls in one step (parallel calls).
{
  const m = counting([
    {
      ...toolCallResult('where_is', '{"query":"drill"}'),
      content: [
        { type: 'tool-call', toolCallId: 'a', toolName: 'where_is', input: '{"query":"drill"}' },
        { type: 'tool-call', toolCallId: 'b', toolName: 'get_thing', input: '{"id":"K00012"}' },
      ],
    },
  ]);
  const r = await generateText({ model: m.model, tools, prompt: 'Drill and K00012?', ...BASE });
  check('two calls in one step: one request, both read', m.calls() === 1 && r.toolCalls.length === 2, r.toolCalls.map((c) => c.toolName));
}

// 6. Without stopWhen set (the SDK default today) a tool-call step still stops at one request.
{
  const m = counting([toolCallResult('where_is', '{"query":"drill"}'), textResult('x')]);
  const { stopWhen: _omit, ...noStop } = BASE;
  await generateText({ model: m.model, tools, prompt: 'Where?', ...noStop });
  check('default stopWhen: one request (default is isStepCount(1))', m.calls() === 1, m.calls());
}

out.checks = checks;
const failed = checks.filter((c) => !c.ok);
writeFileSync(new URL('./mock-results.json', import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({ passed: checks.length - failed.length, failed: failed.map((f) => f.name) }, null, 2));
process.exit(failed.length ? 1 : 0);
