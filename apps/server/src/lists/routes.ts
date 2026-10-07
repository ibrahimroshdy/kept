import { createHash } from 'node:crypto';
import { audited } from '../audit/audited.js';
import { rateLimited, requireScope } from '../auth/http.js';
import { reserveInWindow } from '../auth/sign-in-limiter.js';
import type { KeptApp } from '../http/app.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedWrite } from '../http/write.js';
import { ListQuery } from '../things/validate.js';
import { CSV_PER_HOUR, thingsCsv } from './things-csv.js';

// GET /api/v1/things.csv?<every GET /things parameter but limit and cursor>
//   → text/csv; charset=utf-8, BOM first (D169; step-7 plan T16). The list's rows in the list's
//   order, at most 100,000; money columns only where the caller's gate shows money. Five an hour
//   per person (§3.5; 429 with retryAfter), audited `things.export_csv` with the filter and the
//   row count: one event per location the file drew from, or one on the caller's own account
//   when it is empty (none for a managed member without one). Registered from things/routes.ts.

const CsvQuery = ListQuery.omit({ limit: true, cursor: true });

/** A limiter row's key: hashed, like the AI ledger's CSV limiter (ai/api.ts). */
const limitKey = (userId: string) =>
  createHash('sha256').update(`things-csv\0${userId}`).digest('hex');

export async function listExportRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;

  app.get('/api/v1/things.csv', { schema: { querystring: CsvQuery } }, async (req, reply) => {
    const decision = await reserveInWindow(
      pools.auth,
      limitKey(requireScope(req).userId),
      CSV_PER_HOUR,
      3600,
    );
    if (!decision.allowed) throw rateLimited(reply, decision.retryAfter);

    const csv = await scopedWrite(pools, req, reply, async (tx, client, scope) => {
      const out = await thingsCsv(tx, client, scope, req.query);
      // The filter as asked (ids and enums only; `q` is the person's own search text).
      const filter = Object.fromEntries(
        Object.entries(req.query).filter(([, v]) => v !== undefined && v !== ''),
      );
      const after = { filter, truncated: out.truncated, moneyShown: out.money };
      const actor = { type: 'user' as const, id: scope.userId };
      if (out.perLocation.size === 0) {
        // Nothing left the server; recorded on the caller's own account when they have one (a
        // managed member may not, and the audit's insert policy has nowhere else to put it).
        const { rows } = await client.query<{ acct: string | null }>(
          'SELECT kept.current_owner_account_id() AS acct',
        );
        const acct = rows[0]?.acct ?? null;
        if (acct)
          await audited(tx, {
            locationId: null,
            ownerAccountId: acct,
            actor,
            action: 'things.export_csv',
            entity: { type: 'thing', id: null },
            before: null,
            after: { ...after, rows: 0 },
            requestId: req.id,
          });
      }
      for (const [locationId, rows] of out.perLocation) {
        await audited(tx, {
          locationId,
          actor,
          action: 'things.export_csv',
          entity: { type: 'thing', id: null },
          before: null,
          after: { ...after, rows, totalRows: out.rows },
          requestId: req.id,
        });
      }
      return { status: 200, body: out.csv };
    });
    reply
      .type('text/csv; charset=utf-8')
      .header(
        'content-disposition',
        `attachment; filename="kept-things-${new Date().toISOString().slice(0, 10)}.csv"`,
      )
      .header('cache-control', 'no-store');
    return csv;
  });
}
