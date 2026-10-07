/**
 * What alias enrichment would send, and what it would cost, before anything runs (D69, D206;
 * step-7 plan T15). Shared by the estimate route and the job, so the two agree call for call.
 *
 * - **The things** are the run's (`import_source_ids`, entity `thing`, as the things list's
 *   "Imported by" filter reads them), not deleted, named, and with **no alias in any of the
 *   location's languages**. Ordered by id, which is also the job's cursor.
 * - **The estimate is the sum of the calls' own estimates** (ai/estimate.ts `estimateCall`, the
 *   figure callModel reserves): each batch's prompt exactly as the job builds it, its input tokens,
 *   and the whole `maxOutputTokens` as the output (E1: 900 per call is the worst case to show).
 *   Its cost comes from the price table, when the model has a price; else `unknown`.
 */
import { builtinType } from '@kept/shared';
import type pg from 'pg';
import type { AiRuntime } from '../ai/call.js';
import { estimateCost } from '../ai/cost.js';
import { estimateCall } from '../ai/estimate.js';
import type { Resolved } from '../ai/ports.js';
import { callSettingsFor } from '../ai/providers.js';
import {
  batchSize,
  type EnrichName,
  enrichPrompt,
  enrichResolved,
  enrichSchema,
  expectedOutput,
  maxOutputFor,
} from './prompt.js';

export type PendingThing = EnrichName & { id: string };

/**
 * The run's things still without aliases in `languages`, after `after` (by id), at most `limit`.
 * Read under the caller's row-level security: `import_source_ids` is for owners and admins.
 */
export async function pendingThings(
  client: pg.ClientBase,
  runId: string,
  languages: readonly string[],
  opts: { after?: string | null; limit?: number } = {},
): Promise<PendingThing[]> {
  const { rows } = await client.query<{
    id: string;
    name: string;
    type_name: string | null;
    builtin_key: string | null;
  }>(
    `SELECT t.id, t.name, ty.name AS type_name,
            coalesce(ty.builtin_key, b.builtin_key) AS builtin_key
       FROM public.things t
       LEFT JOIN public.types ty ON ty.id = t.type_id
       LEFT JOIN public.types b ON b.id = ty.copied_from_id
      WHERE t.id IN (SELECT s.entity_id FROM public.import_source_ids s
                      WHERE s.run_id = $1 AND s.entity_type = 'thing')
        AND t.deleted_at IS NULL
        AND t.name IS NOT NULL AND btrim(t.name) <> ''
        AND NOT EXISTS (SELECT 1 FROM jsonb_each(t.aliases) e
                         WHERE e.key = ANY ($2::text[])
                           AND jsonb_typeof(e.value) = 'array'
                           AND jsonb_array_length(e.value) > 0)
        AND ($3::uuid IS NULL OR t.id > $3::uuid)
      ORDER BY t.id
      LIMIT $4`,
    [runId, languages, opts.after ?? null, opts.limit ?? 100_000],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type_name ?? (r.builtin_key ? (builtinType(r.builtin_key)?.names.en ?? null) : null),
  }));
}

/** One call as the job sends it. */
export type PlannedCall = {
  things: PendingThing[];
  system: string;
  text: string;
  maxOutputTokens: number;
  expectedOutputTokens: number;
  inputTokens: number;
};

/** A batch's call, from the provider as enrichment sends it (`enrichResolved`). */
export function planCall(
  resolved: Resolved,
  things: PendingThing[],
  languages: readonly string[],
): PlannedCall {
  const r = enrichResolved(resolved);
  const prompt = enrichPrompt(things, languages);
  const maxOutputTokens = maxOutputFor(r);
  const expectedOutputTokens = expectedOutput(things.length, languages);
  // callModel's own estimate (ai/call.ts): the instructions (the schema appended when the
  // provider takes it in the prompt), then the text.
  let instructions = prompt.system;
  if (callSettingsFor(r.provider).schemaInPrompt) {
    instructions += `\n\nAnswer with one JSON object matching this JSON Schema:\n${JSON.stringify(enrichSchema(languages))}`;
  }
  const est = estimateCall({
    kind: r.provider.kind,
    images: [],
    promptText: `${instructions}\n\n\n${prompt.text}`,
    maxOutputTokens,
    expectedOutputTokens,
  });
  return {
    things,
    system: prompt.system,
    text: prompt.text,
    maxOutputTokens,
    expectedOutputTokens,
    inputTokens: est.inputTokens,
  };
}

export type Estimate = {
  things: number;
  calls: number;
  tokens: { input: number; output: number };
  cost: { amount: string; currency: string } | null;
};

/** Every batch of `things`, priced. */
export async function estimateRun(
  rt: Pick<AiRuntime, 'prices' | 'now'>,
  resolved: Resolved,
  things: PendingThing[],
  languages: readonly string[],
): Promise<Estimate> {
  const size = batchSize(languages);
  let input = 0;
  let output = 0;
  let calls = 0;
  for (let i = 0; i < things.length; i += size) {
    const call = planCall(resolved, things.slice(i, i + size), languages);
    input += call.inputTokens;
    output += call.maxOutputTokens;
    calls += 1;
  }
  const price =
    calls > 0
      ? await rt.prices(resolved.provider.kind, resolved.provider.model, rt.now()).catch(() => null)
      : null;
  return {
    things: things.length,
    calls,
    tokens: { input, output },
    cost: calls > 0 ? estimateCost(price, { inputTokens: input, outputTokens: output }) : null,
  };
}
