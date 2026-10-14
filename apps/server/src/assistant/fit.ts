import type { KeptMessage } from '../ai/convert.js';

// Sizing an assistant request under the provider's per-minute token limit (1.4.1). A provider
// that counts tokens per minute refuses a single request bigger than the minute's whole limit:
// Groq's free tier answers 413 "Request too large … TPM: Limit 8000" to a follow-up that carries
// the 27 tools, the instructions and a tool result (measured 2026-10-13: the first request is
// ~6,950 tokens with its output allowance; an 8 KB tool result adds ~1,700). Asking again sends
// the same request, so the turn used to fail.
//
// Before each step, with the limit the provider's headers last named (kept.ai_token_ceiling):
// 1. the output allowance comes down, never below `floor` (the step's expected output plus the
//    model's whole reasoning allowance: a reasoning model cut short answers nothing);
// 2. then tool results are replaced by TRIMMED, oldest first, the newest last, so the model
//    still sees what it just asked for when anything can be kept;
// 3. if it still doesn't fit, null: the turn fails `too_large` without sending.
// Only the request is changed; the thread keeps every result.

/** What a trimmed tool result says to the model. */
export const TRIMMED = Object.freeze({
  trimmed: true,
  note: 'Left out: too long for this provider. Ask again more narrowly if it matters.',
});

/** Under the limit with room for the estimate's error. */
const MARGIN = 0.95;

export type Fitted<M extends KeptMessage> = { messages: M[]; maxOut: number; trimmed: number };

export function fitToCeiling<M extends KeptMessage>(input: {
  messages: readonly M[];
  maxOut: number;
  floor: number;
  ceiling: number;
  /** The request's estimated tokens for these messages and output allowance. */
  measure: (messages: readonly M[], maxOut: number) => number;
}): Fitted<M> | null {
  const limit = Math.floor(input.ceiling * MARGIN);
  const floor = Math.min(input.floor, input.maxOut);
  let messages = [...input.messages];
  const fits = (maxOut: number) => input.measure(messages, maxOut) <= limit;
  /** The largest output allowance that fits these messages, if the floor does. */
  const bestOut = (): number | null => {
    if (!fits(floor)) return null;
    const room = limit - input.measure(messages, 0);
    return Math.max(floor, Math.min(input.maxOut, room));
  };

  let out = bestOut();
  if (out !== null) return { messages, maxOut: out, trimmed: 0 };

  // Every tool result, oldest first.
  const slots: [number, number][] = [];
  messages.forEach((m, i) => {
    m.parts.forEach((p, j) => {
      if (p.type === 'tool_result' && p.output !== TRIMMED) slots.push([i, j]);
    });
  });
  let trimmed = 0;
  for (const [i, j] of slots) {
    const m = messages[i] as M;
    const parts = m.parts.map((p, k) =>
      k === j && p.type === 'tool_result' ? { ...p, output: TRIMMED } : p,
    );
    messages = messages.map((x, k) => (k === i ? { ...m, parts } : x));
    trimmed += 1;
    out = bestOut();
    if (out !== null) return { messages, maxOut: out, trimmed };
  }
  return null;
}
