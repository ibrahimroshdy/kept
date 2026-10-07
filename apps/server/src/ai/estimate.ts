/**
 * A call's token estimate before it is sent (L43: estimate high, settle on the provider's
 * reported usage), from the shared estimators in `@kept/shared` `ai.ts`.
 *
 * Two figures, for two different limits:
 * - `reserveTokens` = input + the whole `maxOutputTokens` (JSON + reasoning allowance): what
 *   Kept's own budgets and caps reserve (§7.15), trued up at settle.
 * - `paceTokens` = input + the output a call of this kind is expected to produce: what the
 *   provider's own per-minute window is checked against. Providers count what was generated,
 *   not `max_tokens` (Groq's remaining tokens fell by 585 output + ~2,220 input for a receipt,
 *   spike §4), so pacing on the full allowance would hold nearly every Groq call for a minute.
 */
import { estimateImageTokens, estimateTextTokens, type ProviderKind } from '@kept/shared';

export type CallEstimate = {
  inputTokens: number;
  /** The largest per-image figure (`llm_calls.image_tokens_each`); null without images. */
  imageTokensEach: number | null;
  reserveTokens: number;
  paceTokens: number;
};

/** Per-message framing the providers add around the text: a small, deliberately high allowance. */
const FRAMING_TOKENS = 32;

export function estimateCall(input: {
  kind: ProviderKind;
  images: readonly { width: number; height: number }[];
  promptText: string;
  maxOutputTokens: number;
  expectedOutputTokens: number;
}): CallEstimate {
  const each = input.images.map((i) => estimateImageTokens(input.kind, i.width, i.height));
  const inputTokens =
    estimateTextTokens(input.promptText) + FRAMING_TOKENS + each.reduce((a, b) => a + b, 0);
  return {
    inputTokens,
    imageTokensEach: each.length ? Math.max(...each) : null,
    reserveTokens: inputTokens + input.maxOutputTokens,
    paceTokens: inputTokens + Math.min(input.expectedOutputTokens, input.maxOutputTokens),
  };
}
