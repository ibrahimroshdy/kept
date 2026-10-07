import { describe, expect, it } from 'vitest';
import { toToolSet } from './call.js';
import {
  conversationText,
  fromToolCalls,
  type KeptMessage,
  REMOVED,
  toModelMessages,
} from './convert.js';

const where = { query: 'drill' };
const found = { data: { items: [{ id: 't1', untrusted: { name: 'Drill' } }] }, as_of: 'x' };

/** A two-step turn as T13 stores it: the question, a tool call, its result, the answer. */
const twoSteps: KeptMessage[] = [
  { role: 'user', parts: [{ type: 'text', text: 'Where is the drill?' }] },
  {
    role: 'assistant',
    parts: [
      { type: 'reasoning', text: 'Look it up.' },
      { type: 'tool_call', callId: 'c1', tool: 'where_is', input: where },
    ],
  },
  {
    role: 'tool',
    parts: [
      { type: 'tool_result', callId: 'c1', tool: 'where_is', locationIds: ['L1'], output: found },
    ],
  },
  { role: 'assistant', parts: [{ type: 'text', text: 'In the Garage.' }] },
];

describe('toModelMessages', () => {
  it('a two-step conversation in the SDK shapes S6.3 recorded', () => {
    expect(toModelMessages(twoSteps)).toEqual([
      { role: 'user', content: 'Where is the drill?' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Look it up.' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'where_is', input: where },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'where_is',
            output: { type: 'json', value: found },
          },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'In the Garage.' }] },
    ]);
  });

  it('a redacted result still answers its call, as [removed] (D164)', () => {
    const redacted: KeptMessage[] = twoSteps.map((m) =>
      m.role === 'tool'
        ? { role: 'tool', parts: [{ type: 'redacted', reason: 'access_ended' }] }
        : m,
    );
    const out = toModelMessages(redacted);
    expect(out[2]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'c1',
          toolName: 'where_is',
          output: { type: 'text', value: REMOVED },
        },
      ],
    });
  });

  it('a redacted assistant message drops its calls, and their results with them', () => {
    const redacted: KeptMessage[] = twoSteps.map((m, i) =>
      i === 1 ? { role: 'assistant', parts: [{ type: 'redacted', reason: 'access_ended' }] } : m,
    );
    const out = toModelMessages(redacted);
    expect(out.some((m) => m.role === 'tool')).toBe(false);
    expect(out[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: REMOVED }] });
  });

  it('every call gets exactly one result, in call order, the last stored one winning', () => {
    const msgs: KeptMessage[] = [
      { role: 'user', parts: [{ type: 'text', text: 'Move it' }] },
      {
        role: 'assistant',
        parts: [
          { type: 'tool_call', callId: 'a', tool: 'get_thing', input: { thing_id: 'K7D2QX' } },
          { type: 'tool_call', callId: 'b', tool: 'move_thing', input: { thing_id: 'K7D2QX' } },
        ],
      },
      {
        role: 'tool',
        parts: [
          {
            type: 'tool_result',
            callId: 'b',
            tool: 'move_thing',
            locationIds: [],
            output: { status: 'proposed' },
          },
          { type: 'proposal', proposalId: 'p1' },
        ],
      },
      // A later result for b (the confirmed proposal), and an orphan for a call that's gone.
      {
        role: 'tool',
        parts: [
          {
            type: 'tool_result',
            callId: 'b',
            tool: 'move_thing',
            locationIds: [],
            output: { status: 'confirmed' },
          },
          { type: 'tool_result', callId: 'zz', tool: 'get_thing', locationIds: [], output: {} },
        ],
      },
    ];
    const out = toModelMessages(msgs);
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'a',
          toolName: 'get_thing',
          output: { type: 'text', value: REMOVED },
        },
        {
          type: 'tool-result',
          toolCallId: 'b',
          toolName: 'move_thing',
          output: { type: 'json', value: { status: 'confirmed' } },
        },
      ],
    });
  });

  it('counts the text it sends', () => {
    const t = conversationText(twoSteps);
    expect(t).toContain('Where is the drill?');
    expect(t).toContain('where_is');
    expect(t).toContain('Drill');
  });
});

describe('toToolSet and fromToolCalls', () => {
  it('a tool set carries no function to run (it survives JSON)', () => {
    const set = toToolSet([
      {
        name: 'where_is',
        description: 'Where is a thing?',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
        validate: (v) => ({ success: true, value: v }),
      },
    ]);
    expect(set.where_is).toBeDefined();
    expect((set.where_is as { execute?: unknown }).execute).toBeUndefined();
    expect(() => JSON.stringify(set)).not.toThrow();
  });

  it('reads calls back, flagging the invalid ones by the SDK error name', () => {
    expect(
      fromToolCalls({
        toolCalls: [
          { toolCallId: 'a', toolName: 'where_is', input: { query: 'x' } },
          {
            toolCallId: 'b',
            toolName: 'delete_everything',
            input: {},
            invalid: true,
            error: { name: 'AI_NoSuchToolError' },
          },
        ],
      }),
    ).toEqual([
      { callId: 'a', tool: 'where_is', input: { query: 'x' } },
      {
        callId: 'b',
        tool: 'delete_everything',
        input: {},
        invalid: { error: 'AI_NoSuchToolError' },
      },
    ]);
  });
});
