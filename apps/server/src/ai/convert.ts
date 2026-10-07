/**
 * Kept's stored messages and tool specs ↔ the AI SDK's `ModelMessage[]` and `ToolSet` (step-6
 * plan T8; spike S6.3 recorded the part shapes, docs/spikes/2026-09-30-step6-tool-calling.md).
 *
 * - A tool (`ToolSpec`) is a description and a JSON Schema with Kept's own `validate` (the SDK
 *   checks nothing for a bare `jsonSchema()`, S6.3 finding 2). call.ts's `toToolSet` turns it into
 *   the SDK's tool, **never** with an `execute`: Kept runs the loop itself, one provider request
 *   per `callModel`. Only call.ts builds SDK tools (no-direct-calls.test.ts).
 * - The conversation is rebuilt so every tool call is answered exactly once, right after the
 *   assistant message that made it, whatever the stored thread holds (T13):
 *   - a result redacted after its location was lost (D164) is a `{type: 'redacted'}` part that no
 *     longer names its call, and an assistant message citing that location is redacted whole, so
 *     its calls are gone while their results may remain. Each call is answered with its stored
 *     result or, when there is none, `[removed]`; a result whose call is gone is left out.
 *   - a result stored later for the same call (a confirmed proposal's outcome, T13) replaces the
 *     earlier one: the last result per call id wins.
 * - Reasoning parts go back as the provider returned them (S6.3 finding 4); proposal parts are the
 *   web's, never the model's.
 */
import type { JSONValue } from '@ai-sdk/provider';
import type { MessageRole, Part } from '@kept/shared';
import type { AssistantModelMessage, JSONSchema7, ModelMessage, ToolModelMessage } from 'ai';

/** A stored message as callModel takes it: the thread's own shape (`@kept/shared` Part). */
export type KeptMessage = { role: MessageRole; parts: Part[] };

/** One tool as the model sees it. `validate` checks a call's input (Kept's zod contract, read by
 * the caller); without it the SDK accepts any input. */
export type ToolSpec = {
  name: string;
  description: string;
  inputSchema: JSONSchema7;
  validate?: (
    input: unknown,
  ) => { success: true; value: unknown } | { success: false; error: Error };
};

/** What the model is told about a result it may no longer see (D164), or one never stored. */
export const REMOVED = '[removed]';

type ResultPart = Extract<Part, { type: 'tool_result' }>;
type CallPart = Extract<Part, { type: 'tool_call' }>;

function textOf(parts: readonly Part[]): string {
  return parts
    .map((p) => (p.type === 'text' ? p.text : p.type === 'redacted' ? REMOVED : ''))
    .filter((s) => s.length > 0)
    .join('\n');
}

function asJson(value: unknown): JSONValue {
  // Stored outputs are JSON already (jsonb); undefined is the only value JSON can't carry.
  return (value === undefined ? null : value) as JSONValue;
}

/** The SDK's messages for a stored conversation, every tool call paired with one result. */
export function toModelMessages(messages: readonly KeptMessage[]): ModelMessage[] {
  const results = new Map<string, ResultPart>();
  for (const m of messages) {
    if (m.role !== 'tool') continue;
    for (const p of m.parts) if (p.type === 'tool_result') results.set(p.callId, p);
  }
  const out: ModelMessage[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      const text = textOf(m.parts);
      if (text) out.push({ role: 'user', content: text });
      continue;
    }
    if (m.role === 'tool') continue; // answered right after the call that asked (below)
    const content: AssistantModelMessage['content'] = [];
    const calls: CallPart[] = [];
    for (const p of m.parts) {
      if (p.type === 'reasoning' && p.text) content.push({ type: 'reasoning', text: p.text });
      else if (p.type === 'text' && p.text) content.push({ type: 'text', text: p.text });
      else if (p.type === 'redacted') content.push({ type: 'text', text: REMOVED });
      else if (p.type === 'tool_call') {
        calls.push(p);
        content.push({
          type: 'tool-call',
          toolCallId: p.callId,
          toolName: p.tool,
          input: p.input ?? {},
        });
      }
    }
    if (content.length === 0) continue;
    out.push({ role: 'assistant', content });
    if (calls.length === 0) continue;
    const answers: ToolModelMessage['content'] = calls.map((c) => {
      const r = results.get(c.callId);
      return {
        type: 'tool-result',
        toolCallId: c.callId,
        toolName: c.tool,
        output: r ? { type: 'json', value: asJson(r.output) } : { type: 'text', value: REMOVED },
      };
    });
    out.push({ role: 'tool', content: answers });
  }
  return out;
}

/** A tool call as callModel answers it. `invalid` names the SDK's error when the model asked for
 * a tool not offered (`AI_NoSuchToolError`) or with input its schema refuses
 * (`AI_InvalidToolInputError`), S6.3 finding 3. */
export type ToolCallOut = {
  callId: string;
  tool: string;
  input: unknown;
  invalid?: { error: string };
};

type SdkToolCall = {
  toolCallId: string;
  toolName: string;
  input: unknown;
  invalid?: boolean;
  error?: unknown;
};

/** The calls of one `generateText` result, in the order the model made them. */
export function fromToolCalls(result: { toolCalls: readonly SdkToolCall[] }): ToolCallOut[] {
  return result.toolCalls.map((c) => {
    const base = { callId: c.toolCallId, tool: c.toolName, input: c.input ?? {} };
    if (!c.invalid) return base;
    const name = (c.error as { name?: unknown } | undefined)?.name;
    return { ...base, invalid: { error: typeof name === 'string' ? name : 'invalid' } };
  });
}

/** The characters a conversation sends, for the estimate (L43). */
export function conversationText(messages: readonly KeptMessage[]): string {
  let s = '';
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === 'text' || p.type === 'reasoning') s += `${p.text}\n`;
      else if (p.type === 'tool_call') s += `${p.tool} ${JSON.stringify(p.input ?? {})}\n`;
      else if (p.type === 'tool_result') s += `${JSON.stringify(p.output ?? null)}\n`;
      else if (p.type === 'redacted') s += `${REMOVED}\n`;
    }
  }
  return s;
}
