import type pg from 'pg';
import { type EntityDef, type Field, fieldsOf } from './registry.js';

// Reading an export's entities (plan T12): keyset pages of 1,000 rows, in the requester's scoped
// transaction, so row-level security decides what an export holds exactly as it decides what a
// request sees. Every query is built from the registry (registry.ts): its columns, its scope, the
// money gate and the "rows of things the export leaves out" rule. Nothing here takes a name from
// a request.

export const PAGE_ROWS = 1000;

export type ReadContext = {
  locationId: string;
  /** The location's owner account (account registries are read by it). */
  accountId: string;
  /** The requester's money gate there (serialize/gates.ts): false leaves money fields out. */
  showMoney: boolean;
  /** Ended things (sold, lost, …) and trashed things and places, as the options say. */
  ended: boolean;
  trashed: boolean;
};

export type ExportRow = Record<string, unknown>;

/** SQL: whether thing `t` is one the export keeps. */
export function thingKept(alias: string, ctx: Pick<ReadContext, 'ended' | 'trashed'>): string {
  const parts = [`${alias}.id IS NOT NULL`];
  if (!ctx.ended) parts.push(`${alias}.lifecycle = 'in_use'`);
  if (!ctx.trashed) parts.push(`${alias}.deleted_at IS NULL`);
  return parts.join(' AND ');
}

/** SQL: `expr` names no thing, or one the export keeps. */
export function thingOk(expr: string, ctx: Pick<ReadContext, 'ended' | 'trashed'>): string {
  return `(${expr} IS NULL OR EXISTS (SELECT 1 FROM public.things kt
                                       WHERE kt.id = ${expr} AND ${thingKept('kt', ctx)}))`;
}

const quote = (column: string) => `x."${column.replace(/"/g, '')}"`;

function selectOf(f: Field): string {
  const col = quote(f.column);
  switch (f.kind) {
    case 'dec':
    case 'date':
    case 'time':
      return `${col}::text AS "${f.name}"`;
    case 'int':
      // bigint arrives as a string from pg; every int here fits a double.
      return `${col}::float8 AS "${f.name}"`;
    default:
      return `${col} AS "${f.name}"`;
  }
}

type Built = {
  text: string;
  fields: Field[];
  money: Field[];
  keyCount: number;
};

/** The page query for an entity: `$1` location, `$2` account, `$3…` the last key seen. */
export function pageQuery(def: EntityDef, ctx: ReadContext, after: boolean): Built {
  const all = fieldsOf(def);
  const money = all.filter((f) => def.money?.includes(f.column));
  const fields = ctx.showMoney ? all : all.filter((f) => !def.money?.includes(f.column));
  const select = fields.map(selectOf);
  if (def.entity === 'location') {
    select.push(`ARRAY(SELECT m.module FROM public.location_modules m
                        WHERE m.location_id = x.id AND m.enabled ORDER BY m.module) AS "modules"`);
  }
  if (def.entity === 'types') select.push(`x.owner_account_id IS NULL AS "builtin"`);
  def.key.forEach((k, i) => {
    select.push(`${quote(k)}::text AS "__k${i}"`);
  });

  const where: string[] = [];
  if (def.scopeWhere) where.push(def.scopeWhere);
  else if (def.scope === 'self') where.push('x.id = $1');
  else if (def.scope === 'account') where.push('x.owner_account_id = $2');
  else where.push('x.location_id = $1');
  if (def.where) {
    where.push(
      def.where.replace(/\{thingOk:([a-z_.]+)\}/g, (_m, expr: string) => thingOk(expr, ctx)),
    );
  }
  if (def.entity === 'things') where.push(thingKept('x', ctx));
  else for (const ref of def.thingRefs ?? []) where.push(thingOk(ref, ctx));
  if (def.entity === 'places' && !ctx.trashed) where.push('x.deleted_at IS NULL');
  // Every parameter is used, so Postgres knows its type whatever the scope.
  where.push('$1::uuid IS NOT NULL AND $2::uuid IS NOT NULL');
  if (after) {
    const cols = def.key.map(quote).join(', ');
    const params = def.key.map((_k, i) => `$${i + 3}`).join(', ');
    where.push(`(${cols}) > (${params})`);
  }
  const text = `SELECT ${select.join(', ')}
      FROM public.${def.table} x
     WHERE ${where.join('\n       AND ')}
     ORDER BY ${def.key.map(quote).join(', ')}
     LIMIT ${PAGE_ROWS}`;
  return { text, fields, money, keyCount: def.key.length };
}

function toWire(row: Record<string, unknown>, built: Built, showMoney: boolean): ExportRow {
  const out: ExportRow = {};
  for (const f of built.fields) {
    const v = row[f.name];
    out[f.name] = v instanceof Date ? v.toISOString() : (v ?? null);
  }
  if (row.modules !== undefined) out.modules = row.modules;
  if (row.builtin !== undefined) out.builtin = row.builtin;
  if (!showMoney && built.money.length > 0) out.moneyHidden = true;
  return out;
}

/** Every row of an entity the requester sees, page by page, in `client`'s transaction. */
export async function* readEntity(
  client: pg.ClientBase,
  def: EntityDef,
  ctx: ReadContext,
): AsyncGenerator<ExportRow> {
  let last: string[] | null = null;
  for (;;) {
    const built = pageQuery(def, ctx, last !== null);
    const params: unknown[] = [ctx.locationId, ctx.accountId, ...(last ?? [])];
    const { rows } = await client.query<Record<string, unknown>>(built.text, params);
    for (const r of rows) yield toWire(r, built, ctx.showMoney);
    if (rows.length < PAGE_ROWS) return;
    const tail = rows.at(-1) as Record<string, unknown>;
    last = Array.from({ length: built.keyCount }, (_v, i) => String(tail[`__k${i}`]));
  }
}
