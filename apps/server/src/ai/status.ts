/**
 * The AI status line of a location (plan T9; D191, D202, D206; screens §3, §5): who would pay
 * for a photo read there, what pauses it, what the key is waiting for, and who can do something
 * about it. Read through `kept.ai_status`, which viewers may call (the assistant's line) and
 * which never returns key material; the rest is read under the caller's own policies.
 */
import { EMBEDDINGS_SOURCES, PROVIDER_KINDS } from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { isoTime } from './api-kit.js';
import type { StoredModel } from './settings.js';

export const StatusSchema = z.object({
  resolved: z.boolean(),
  source: z.enum(['instance', 'account', 'user']).nullable(),
  providerKind: z.enum(PROVIDER_KINDS).nullable(),
  model: z.string().nullable(),
  pausedUntil: z.string().nullable(),
  reason: z.enum(['manual', 'cap_money', 'cap_tokens', 'tokens_day']).nullable(),
  pausedBy: z.object({ scope: z.string(), label: z.string() }).nullable(),
  waitingProvider: z
    .object({
      until: z.string(),
      reason: z.enum(['rate_limited', 'limits', 'provider_down', 'auth']),
    })
    .nullable(),
  capPercent: z.number().nullable(),
  canResume: z.boolean(),
  canManage: z.boolean(),
  manager: z.object({ displayName: z.string() }).nullable(),
  modelMissing: z.boolean(),
  /** Where this server's search embeddings come from (step-6 T14, D207): AI settings' "Search"
   * line. GET /ai/status adds it; statusOf() leaves it out. */
  embeddingsSource: z.enum(EMBEDDINGS_SOURCES).optional(),
});
export type Status = z.infer<typeof StatusSchema>;

export const NO_PROVIDER: Status = {
  resolved: false,
  source: null,
  providerKind: null,
  model: null,
  pausedUntil: null,
  reason: null,
  pausedBy: null,
  waitingProvider: null,
  capPercent: null,
  canResume: false,
  canManage: false,
  manager: null,
  modelMissing: false,
};

type StatusRow = {
  resolved: boolean;
  source: Status['source'];
  kind: Status['providerKind'];
  model: string | null;
  paused_until: Date | number | null;
  paused_reason: Status['reason'];
  paused_scope: string | null;
  paused_label: string | null;
  waiting_until: Date | number | null;
  waiting_reason: string | null;
  cap_percent: number | null;
  can_resume: boolean;
  can_manage: boolean;
};

const WAIT: Record<string, NonNullable<Status['waitingProvider']>['reason']> = {
  rate_limited: 'rate_limited',
  quota: 'rate_limited',
  limits: 'limits',
  provider_down: 'provider_down',
  auth: 'auth',
};

/** The status of a location for the caller (42501 → 404 for one they can't see). */
export async function statusOf(client: pg.ClientBase, locationId: string): Promise<Status> {
  const { rows } = await client.query<StatusRow>('SELECT * FROM kept.ai_status($1)', [locationId]);
  const r = rows[0];
  if (!r) return NO_PROVIDER;
  const pausedUntil = isoTime(r.paused_until);
  const waitingUntil = isoTime(r.waiting_until);
  // Who can resume or fix AI here: the location's owner (the account's key and caps are theirs),
  // named for everyone else's "Ask Alfred to resume" (§3).
  let manager: Status['manager'] = null;
  if (!r.can_manage) {
    const { rows: owner } = await client.query<{ name: string | null }>(
      `SELECT p.display_name AS name FROM public.memberships m
         JOIN public.user_profiles p ON p.user_id = m.user_id
        WHERE m.location_id = $1 AND m.role = 'owner'`,
      [locationId],
    );
    if (owner[0]?.name) manager = { displayName: owner[0].name };
  }
  // A chosen model the provider no longer lists (D202): only its manager reads the list.
  let modelMissing = false;
  if (r.resolved && r.source && r.model) {
    const { rows: list } = await client.query<{ model_list: StoredModel[] | null }>(
      `SELECT p.model_list FROM public.ai_providers p
         JOIN public.locations l ON l.id = $1
        WHERE p.disabled_at IS NULL AND p.scope = $2 AND p.kind = $3
          AND (p.scope = 'instance'
               OR (p.scope = 'account' AND p.owner_account_id = l.owner_account_id)
               OR (p.scope = 'user' AND p.user_id = kept.current_user_id()))`,
      [locationId, r.source, r.kind],
    );
    const models = list[0]?.model_list;
    modelMissing = !!models && models.length > 0 && !models.some((m) => m.id === r.model);
  }
  return {
    resolved: r.resolved,
    source: r.source,
    providerKind: r.kind,
    model: r.model,
    pausedUntil,
    reason: pausedUntil ? r.paused_reason : null,
    pausedBy:
      pausedUntil && r.paused_scope ? { scope: r.paused_scope, label: r.paused_label ?? '' } : null,
    waitingProvider:
      waitingUntil && r.waiting_reason && WAIT[r.waiting_reason]
        ? { until: waitingUntil, reason: WAIT[r.waiting_reason] as 'limits' }
        : null,
    capPercent: r.cap_percent,
    canResume: r.can_resume,
    canManage: r.can_manage,
    manager,
    modelMissing,
  };
}
