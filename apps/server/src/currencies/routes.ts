import { SUPPORTED_DEFAULT } from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { audited } from '../audit/audited.js';
import type { KeptApp } from '../http/app.js';
import { AppError, forbidden, notFound, pgErrorOf } from '../http/errors.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';

// Currencies (T12; D136, D168, D189; engineering spec §3.4). Shapes: the web contract's Currency,
// CurrenciesResponse and UpdateCurrencyBody (apps/web/src/api/inventory/types.ts).
//
// GET   /api/v1/currencies                → {currencies}: the enabled ones, for every picker.
//       ?all=1 (instance admins)          → every ISO 4217 row, each with `inUse` (a location's
//                                            default, deleted locations included: 0027). Anyone
//                                            else asking for all gets the enabled list.
// PATCH /api/v1/admin/currencies/:code {enabled}  → Currency (instance admins; D168). Turning off
//       one of the five defaults (D136) or one a location uses is 409 `conflict` with
//       `reason: 'default' | 'in_use'`; 0027's trigger refuses it again underneath.
//
// Nothing here picks a currency for anyone: pickers offer the enabled list with no preselection
// ("$" has no default, D189), and a purchase's amounts need an explicit currency (purchases/).

const DEFAULTS = new Set<string>(SUPPORTED_DEFAULT);

const CurrencySchema = z.object({
  code: z.string(),
  name: z.string(),
  minorUnits: z.number().int(),
  symbol: z.string(),
  enabled: z.boolean(),
  inUse: z.boolean().optional(),
});
type Currency = z.infer<typeof CurrencySchema>;

const ListQuery = z.object({ all: z.enum(['0', '1', 'true', 'false']).optional() });
const CodeParams = z.object({ code: z.string().regex(/^[A-Za-z]{3}$/) });
const PatchBody = z.strictObject({ enabled: z.boolean() });

type Row = { code: string; name: string; minor_units: number; symbol: string; enabled: boolean };

const currencyOf = (r: Row, inUse?: ReadonlySet<string>): Currency => ({
  code: r.code.trim(),
  name: r.name,
  minorUnits: r.minor_units,
  symbol: r.symbol,
  enabled: r.enabled,
  ...(inUse ? { inUse: inUse.has(r.code.trim()) } : {}),
});

async function isInstanceAdmin(client: pg.ClientBase): Promise<boolean> {
  const { rows } = await client.query<{ admin: boolean }>(
    'SELECT kept.is_instance_admin() AS admin',
  );
  return rows[0]?.admin === true;
}

/** The codes locations use as their default (0027's definer; instance admins only). */
async function inUseCodes(client: pg.ClientBase): Promise<Set<string>> {
  const { rows } = await client.query<{ code: string }>(
    'SELECT c AS code FROM kept.currencies_in_use() AS c',
  );
  return new Set(rows.map((r) => r.code.trim()));
}

const refused = (reason: 'default' | 'in_use') =>
  new AppError(
    'conflict',
    409,
    reason === 'default'
      ? 'USD, CAD, GBP, EUR and EGP always stay on.'
      : 'A location uses this currency, so it stays on.',
    { reason },
  );

export async function currencyRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;

  app.get(
    '/api/v1/currencies',
    {
      schema: {
        querystring: ListQuery,
        response: { 200: z.object({ currencies: z.array(CurrencySchema) }) },
      },
    },
    (req) =>
      scopedRead(pools, req, async (_tx, client) => {
        const wantAll = req.query.all === '1' || req.query.all === 'true';
        const all = wantAll && (await isInstanceAdmin(client));
        const { rows } = await client.query<Row>(
          `SELECT code, name, minor_units, symbol, enabled FROM public.currencies
            WHERE $1 OR enabled ORDER BY code`,
          [all],
        );
        const inUse = all ? await inUseCodes(client) : undefined;
        return { currencies: rows.map((r) => currencyOf(r, inUse)) };
      }),
  );

  app.patch(
    '/api/v1/admin/currencies/:code',
    { schema: { params: CodeParams, body: PatchBody, response: { 200: CurrencySchema } } },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => {
        // TODO(task 23): the instance-admin guard lives in admin/routes.ts, which registers only
        // with auth; this route is an inventory module, so it asks kept.is_instance_admin() itself.
        if (!(await isInstanceAdmin(client))) {
          throw forbidden('Only instance admins switch currencies.');
        }
        const code = req.params.code.toUpperCase();
        const { rows } = await client.query<Row>(
          `SELECT code, name, minor_units, symbol, enabled FROM public.currencies
            WHERE code = $1 FOR UPDATE`,
          [code],
        );
        const before = rows[0];
        if (!before) throw notFound();
        const inUse = await inUseCodes(client);
        const enabled = req.body.enabled;
        if (before.enabled === enabled) {
          return { status: 200, body: currencyOf(before, inUse) };
        }
        if (!enabled && DEFAULTS.has(code)) throw refused('default');
        if (!enabled && inUse.has(code)) throw refused('in_use');
        try {
          await client.query('UPDATE public.currencies SET enabled = $2 WHERE code = $1', [
            code,
            enabled,
          ]);
        } catch (err) {
          // A location took it up since the check above: the trigger's answer (0027).
          const pg = pgErrorOf(err);
          if (pg?.constraint === 'currencies_default_fixed') throw refused('default');
          if (pg?.constraint === 'currencies_in_use') throw refused('in_use');
          throw err;
        }
        // An instance-level event (0006: kept_app writes these only as an instance admin). The
        // diff key names the currency, so the log says which one was switched.
        const key = `enabled_${code.toLowerCase()}`;
        await audited(tx, {
          locationId: null,
          ownerAccountId: null,
          actor: { type: 'user', id: scope.userId },
          action: enabled ? 'admin.currency_enable' : 'admin.currency_disable',
          entity: { type: 'currency', id: null },
          before: { [key]: before.enabled },
          after: { [key]: enabled },
          requestId: req.id,
        });
        return { status: 200, body: currencyOf({ ...before, enabled }, inUse) };
      }),
  );
}
