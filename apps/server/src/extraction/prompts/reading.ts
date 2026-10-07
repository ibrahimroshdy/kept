/**
 * READING mode (engineering spec §2.1; D19, D112, D129): a meter's display. A reading is never
 * applied: it always waits for review, because the model's confidence doesn't show when it is
 * wrong (spike 2026-09-26 finding 4: the same odometer read 0.04340057 and 52340, both at 0.98).
 */
import { type BuiltPrompt, type PromptContext, systemPrompt } from './common.js';

export const PROMPT_VERSION = 'reading-v1';

const KIND_WORDS: Readonly<Record<string, string>> = Object.freeze({
  distance: 'an odometer',
  hours: 'an hour meter',
});

export function readingPrompt(ctx: PromptContext): BuiltPrompt {
  const kind = ctx.meter ? (KIND_WORDS[ctx.meter.kind] ?? 'a meter') : 'a meter';
  const unit = ctx.meter?.unit ? ` counting ${ctx.meter.unit}` : '';
  return {
    version: PROMPT_VERSION,
    system: systemPrompt('read a meter display', [
      'value: the number the main counter shows, with its digits exactly as displayed: do not add, drop or reorder digits. It is a whole count of the unit unless the display shows a decimal point or a separately marked tenths digit. Ignore trip counters, clocks, temperatures and fuel gauges.',
      'unit: km, mi or h, only when shown on the display.',
      'display: digital for a screen or segment display, analog for a rolling drum or dial.',
    ]),
    text: `This photo shows ${kind}${unit}. What does it read?`,
  };
}
