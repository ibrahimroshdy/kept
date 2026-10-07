import type { CaptureMode } from '@kept/shared';
import type { BuiltPrompt, PromptContext } from './common.js';
import { PROMPT_VERSION as LABEL_VERSION, labelPrompt } from './label.js';
import { PROMPT_VERSION as READING_VERSION, readingPrompt } from './reading.js';
import {
  PROMPT_VERSION as RECEIPT_VERSION,
  RECEIPT_VERSIONS,
  type ReceiptVersion,
  receiptPrompt,
} from './receipt.js';
import { PROMPT_VERSION as THING_VERSION, thingPrompt } from './thing.js';

export type { BuiltPrompt, PromptContext } from './common.js';

/** Each mode's prompt version in use, as `llm_calls.prompt_version` stores it. */
export const PROMPT_VERSIONS: Readonly<Record<CaptureMode, string>> = Object.freeze({
  thing: THING_VERSION,
  receipt: RECEIPT_VERSION,
  label: LABEL_VERSION,
  reading: READING_VERSION,
});

/**
 * Every version each mode can still build, the one in use included. Older versions stay
 * selectable so the evaluation harness (T11) can compare them on the same photos; the worker
 * always uses `PROMPT_VERSIONS`.
 */
export const PROMPT_CHOICES: Readonly<Record<CaptureMode, readonly string[]>> = Object.freeze({
  thing: [THING_VERSION],
  receipt: RECEIPT_VERSIONS,
  label: [LABEL_VERSION],
  reading: [READING_VERSION],
});

/** The prompt for `mode`: the version in use, or `version` when given (T11). An unknown version
 * throws: a report must never name a prompt that wasn't the one sent. */
export function promptFor(mode: CaptureMode, ctx: PromptContext, version?: string): BuiltPrompt {
  const v = version ?? PROMPT_VERSIONS[mode];
  if (!PROMPT_CHOICES[mode].includes(v)) {
    throw new Error(`no ${mode} prompt ${v}; choices: ${PROMPT_CHOICES[mode].join(', ')}`);
  }
  switch (mode) {
    case 'thing':
      return thingPrompt(ctx);
    case 'receipt':
      return receiptPrompt(ctx, v as ReceiptVersion);
    case 'label':
      return labelPrompt(ctx);
    case 'reading':
      return readingPrompt(ctx);
  }
}
