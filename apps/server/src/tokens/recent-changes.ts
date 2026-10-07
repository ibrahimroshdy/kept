import { TOKEN_KINDS, type TokenKind } from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import type { Scope, Tx } from '../db/scope.js';
import { HistoryEventSchema, HistoryQuery, tokenActivity } from '../history/service.js';
import { notFound } from '../http/errors.js';

// "Recent changes by connections" (D58, D124; screens §5): the audit events the caller's own
// tokens made, rendered as history rows (renderAudit, with the caller's role and money gate in
// each event's location), with the token that made each and Undo while it is still undoable
// (7 days; the undo itself is POST /api/v1/audit/:eventId/undo, which lets a token's creator undo
// its events, audit/undo.ts).

export const ChangesQuery = HistoryQuery.extend({ tokenId: z.uuid().optional() });
export type ChangesQuery = z.infer<typeof ChangesQuery>;

export const ConnectionChangeSchema = HistoryEventSchema.extend({
  token: z.object({ id: z.uuid(), name: z.string(), kind: z.enum(TOKEN_KINDS) }),
  undo: z.object({ eventId: z.uuid(), until: z.string() }).nullable(),
});

export const ConnectionChangesPageSchema = z.object({
  items: z.array(ConnectionChangeSchema),
  next_cursor: z.string().nullable(),
});

export type ConnectionChange = z.infer<typeof ConnectionChangeSchema>;

/** GET /api/v1/connections/changes?cursor&tokenId. */
export async function connectionChanges(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  query: ChangesQuery,
  now: Date = new Date(),
): Promise<{ items: ConnectionChange[]; next_cursor: string | null }> {
  // api_tokens' policy shows the caller their own tokens only.
  const { rows: tokens } = await client.query<{ id: string; name: string; kind: TokenKind }>(
    'SELECT t.id, t.name, t.kind FROM public.api_tokens t WHERE t.user_id = kept.current_user_id()',
  );
  const wanted = query.tokenId?.toLowerCase();
  const mine = wanted ? tokens.filter((t) => t.id === wanted) : tokens;
  if (wanted && mine.length === 0) throw notFound();
  const byId = new Map(mine.map((t) => [t.id, t]));
  const page = await tokenActivity(
    tx,
    client,
    scope,
    mine.map((t) => t.id),
    query,
  );
  const ids = page.items.map((e) => e.id);
  const { rows: undone } =
    ids.length === 0
      ? { rows: [] as { undo_of: string }[] }
      : await client.query<{ undo_of: string }>(
          'SELECT e.undo_of FROM public.audit_events e WHERE e.undo_of = ANY ($1::uuid[])',
          [ids],
        );
  const done = new Set(undone.map((r) => r.undo_of));
  const items = page.items.flatMap((e): ConnectionChange[] => {
    const token = e.actor.id ? byId.get(e.actor.id) : undefined;
    if (!token) return [];
    const until = e.undoable_until;
    const open =
      until !== null &&
      e.location_id !== null &&
      !done.has(e.id) &&
      Date.parse(until) > now.getTime();
    return [
      {
        ...e,
        token: { id: token.id, name: token.name, kind: token.kind },
        undo: open ? { eventId: e.id, until } : null,
      } as ConnectionChange,
    ];
  });
  return { items, next_cursor: page.next_cursor };
}
