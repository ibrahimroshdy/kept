/**
 * One extraction call for a capture mode (plan T8/T10; spike §3): the mode's wire schema
 * (wire.ts) sent unvalidated, `parseLenient` against the full `EXTRACTION_SCHEMAS[mode]` (L52),
 * `maxOutputTokens` = the mode's JSON allowance + the reasoning allowance (`outputTokenCap`,
 * Q6), and a `length` finish as a failure (L42, in callModel). The prompts are T10's
 * (`extraction/prompts/*.ts`); this takes them as input, with their version for the ledger.
 */
import {
  type AiTask,
  type CaptureMode,
  EXTRACTION_SCHEMAS,
  type LedgerTask,
  MAX_OUTPUT_TOKENS,
  outputTokenCap,
  parseLenient,
  type ReasoningLevel,
  ServiceInvoiceExtraction,
} from '@kept/shared';
import type { z } from 'zod';
import { type AiRuntime, type CallResult, callModel, type ImageInput } from './call.js';
import type { Resolved } from './ports.js';
import type { Reasoning } from './providers.js';
import {
  ledgerPromptVersion,
  serviceInvoiceWire,
  WIRE_IN_USE,
  type WireVariant,
  wireName,
  wireSchema,
} from './wire.js';

export type Extracted<M extends CaptureMode> = {
  value: z.output<(typeof EXTRACTION_SCHEMAS)[M]>;
  /** Dotted paths parseLenient removed (for the call log and the evaluation harness). */
  dropped: string[];
};

export type ExtractRequest<M extends CaptureMode> = {
  mode: M;
  /** GPS-free sources only (Q12): the display derivative or an in-memory re-encode. */
  images: ImageInput[];
  prompt: { system: string; text: string; version: string };
  locationId: string | null;
  userId: string | null;
  links: { extractionId?: string; thingId?: string };
  requestId: string;
  attempt: number;
  jobId: string;
  /** Resolved outside any transaction; resolved here from `rt.keys` when absent. */
  resolved?: Resolved;
  /** The wire schema variant (wire.ts); the worker leaves it to `WIRE_IN_USE`. */
  wire?: WireVariant;
  /** Step 5 (Q12): a RECEIPT read as a service invoice, each line with its kind
   * (`ServiceInvoiceExtraction`). Same ledger task and output allowance as RECEIPT. */
  schema?: 'service-invoice';
};

export type ExtractResult<M extends CaptureMode> =
  | CallResult<Extracted<M>>
  | { status: 'no_provider' };

/** The reasoning allowance for "the provider's default": unknown, so the medium allowance. */
export function allowanceLevel(r: Reasoning): ReasoningLevel {
  return r === 'provider-default' ? 'medium' : r;
}

export const EXTRACTION_TASK: AiTask = 'extraction';

export async function extract<M extends CaptureMode>(
  rt: AiRuntime,
  req: ExtractRequest<M>,
): Promise<ExtractResult<M>> {
  const resolved =
    req.resolved ??
    (await rt.keys.resolve({
      locationId: req.locationId,
      userId: req.userId,
      task: EXTRACTION_TASK,
    }));
  if (!resolved) return { status: 'no_provider' };
  const invoice = req.schema === 'service-invoice' && req.mode === 'receipt';
  const schema = invoice ? ServiceInvoiceExtraction : EXTRACTION_SCHEMAS[req.mode];
  return callModel<Extracted<M>>(rt, {
    resolved,
    task: `extract_${req.mode}` as LedgerTask,
    locationId: req.locationId,
    userId: req.userId,
    links: req.links,
    instructions: req.prompt.system,
    text: req.prompt.text,
    images: req.images,
    output: {
      name: wireName(req.mode),
      schema: invoice
        ? serviceInvoiceWire(req.wire ?? WIRE_IN_USE)
        : wireSchema(req.mode, req.wire ?? WIRE_IN_USE),
      parse: (raw) => parseLenient(schema, raw) as Extracted<M> | null,
    },
    maxOutputTokens: outputTokenCap(req.mode, allowanceLevel(resolved.provider.reasoning)),
    expectedOutputTokens: MAX_OUTPUT_TOKENS[req.mode],
    promptVersion: ledgerPromptVersion(req.prompt.version, req.mode, req.wire ?? WIRE_IN_USE),
    requestId: req.requestId,
    attempt: req.attempt,
    jobId: req.jobId,
  });
}
