/**
 * The AI call list, a call's detail and its CSV (plan T9; L47, D205, D206, D211; engineering spec
 * §7.15 "The ledger" and "Routes"). Rows come from `llm_calls` under its SELECT policy (each
 * person their own calls, admins their locations', owners their account's), narrowed to the
 * scope asked for; an instance admin's `instance` scope reads `kept.ai_instance_calls`, which has
 * no location, thing, extraction, thread or attachments at all.
 *
 * The serializer (§7.15): the cost only where the caller may see money for the row (no location,
 * the caller paid, or the location's money gate shows money), else `moneyHidden: true`; the
 * thread link only for the thread's owner (D23); names only where the caller can see them (D123).
 * Filters are the D205 strip's URL form: repeated values, `not` for "is none of", and `dir`.
 */
import {
  CSV_BOM,
  CSV_EOL,
  csvLine,
  DATE_PRESETS,
  LEDGER_OUTCOMES,
  LEDGER_TASKS,
  PROVIDER_KINDS,
  parseDateRange,
} from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import type { Scope, Tx } from '../db/scope.js';
import { decodeCursor, encodeCursor, PAGE_DEFAULT, PAGE_MAX } from '../http/conventions.js';
import { invalid, notFound } from '../http/errors.js';
import { manyOf, notOf } from '../http/list-filters.js';
import { gateFor } from '../serialize/gates.js';
import { amount, type Who } from './api-kit.js';

const Uuid = z.uuid().transform((v) => v.toLowerCase());
const Range = z
  .string()
  .trim()
  .max(60)
  .regex(/^(\d+(\.\d+)?)?\.\.(\d+(\.\d+)?)?$/, 'min..max');

export const CALL_FILTERS = [
  'person',
  'location',
  'task',
  'model',
  'provider',
  'outcome',
  'paidBy',
  'thing',
] as const;

export const CallsQuery = z.object({
  scope: z.enum(['me', 'location', 'account', 'instance']).default('me'),
  locationId: Uuid.optional(),
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_MAX).default(PAGE_DEFAULT),
  at: z.string().trim().max(40).optional(),
  person: manyOf(z.union([z.literal('background'), Uuid])).optional(),
  location: manyOf(Uuid).optional(),
  task: manyOf(z.enum(LEDGER_TASKS)).optional(),
  model: manyOf(z.string().trim().min(1).max(120)).optional(),
  provider: manyOf(z.enum(PROVIDER_KINDS)).optional(),
  outcome: manyOf(z.enum(LEDGER_OUTCOMES)).optional(),
  paidBy: manyOf(z.enum(['instance', 'account', 'user'])).optional(),
  hasImage: z.enum(['true', 'false']).optional(),
  tokens: Range.optional(),
  cost: Range.optional(),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/)
    .transform((c) => c.toUpperCase())
    .optional(),
  thing: manyOf(Uuid).optional(),
  q: z.string().trim().max(120).optional(),
  not: notOf(CALL_FILTERS).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
});
export type CallsQuery = z.infer<typeof CallsQuery>;

const CostSchema = z.object({
  amount: z.string(),
  currency: z.string(),
  source: z.enum(['provider', 'price_table', 'price_table_later', 'unknown', 'not_sent']),
  priceVersion: z.number().nullable(),
});

export const CallSchema = z.object({
  id: z.uuid(),
  at: z.string(),
  requestId: z.string(),
  attempt: z.number(),
  task: z.enum(LEDGER_TASKS),
  providerKind: z.enum(PROVIDER_KINDS),
  model: z.string(),
  location: z.object({ id: z.uuid(), name: z.string() }).optional(),
  person: z
    .union([z.object({ id: z.uuid(), name: z.string() }), z.literal('background')])
    .optional(),
  paidBy: z.object({
    scope: z.enum(['instance', 'account', 'user']),
    label: z.string(),
    fellBack: z.boolean(),
  }),
  sent: z.boolean(),
  tokens: z.object({
    estimate: z.number().nullable(),
    input: z.number().nullable(),
    output: z.number().nullable(),
    reasoning: z.number().nullable(),
    cached: z.number().nullable(),
  }),
  images: z.object({
    count: z.number(),
    tokensEach: z.number().nullable(),
    bytes: z.number().nullable(),
  }),
  latencyMs: z.number().nullable(),
  finishReason: z.string().nullable(),
  outcome: z.enum(LEDGER_OUTCOMES),
  errorCode: z.string().nullable(),
  cost: CostSchema.optional(),
  moneyHidden: z.literal(true).optional(),
  links: z.object({
    extractionId: z.uuid().optional(),
    thingId: z.uuid().optional(),
    threadId: z.uuid().optional(),
  }),
});
export type CallView = z.infer<typeof CallSchema>;
export const CallPageSchema = z.object({
  items: z.array(CallSchema),
  next_cursor: z.string().nullable(),
});
export const CallDetailSchema = CallSchema.extend({ attempts: z.array(CallSchema) });

type CallRow = {
  id: string;
  at: Date;
  request_id: string;
  attempt: number;
  task: CallView['task'];
  location_id: string | null;
  owner_account_id: string | null;
  user_id: string | null;
  paying_scope: CallView['paidBy']['scope'];
  paying_account_id: string | null;
  paying_user_id: string | null;
  fell_back: boolean;
  provider_kind: CallView['providerKind'];
  model: string;
  sent: boolean;
  estimate_tokens: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  cached_input_tokens: number | null;
  image_count: number;
  image_tokens_each: number | null;
  image_bytes: number | null;
  latency_ms: number | null;
  finish_reason: string | null;
  outcome: CallView['outcome'];
  error_code: string | null;
  cost_amount: string | null;
  cost_currency: string | null;
  cost_source: CostSchemaSource;
  price_version: number | null;
  extraction_id: string | null;
  thread_id: string | null;
  thing_id: string | null;
  location_name: string | null;
  person_name: string | null;
  payer_name: string | null;
};
type CostSchemaSource = z.infer<typeof CostSchema>['source'];

/**
 * The ledger's columns plus what the serializer names: the location (visible ones only), the
 * person, and the payer (the paying account's owner, found as the owner of the call's location,
 * which kept_app may see; or the paying person).
 */
const ROW_COLUMNS = `c.id, c.at, c.request_id, c.attempt, c.task, c.location_id, c.owner_account_id,
  c.user_id, c.paying_scope, c.paying_account_id, c.paying_user_id, c.fell_back, c.provider_kind,
  c.model, c.sent, c.estimate_tokens, c.input_tokens, c.output_tokens, c.reasoning_tokens,
  c.cached_input_tokens, c.image_count, c.image_tokens_each, c.image_bytes, c.latency_ms,
  c.finish_reason, c.outcome, c.error_code, c.cost_amount::text AS cost_amount,
  c.cost_currency::text AS cost_currency, c.cost_source,
  (SELECT pr.version FROM public.ai_model_prices pr WHERE pr.id = c.price_id) AS price_version,
  c.extraction_id, c.thread_id, c.thing_id,
  (SELECT l.name FROM public.locations l WHERE l.id = c.location_id) AS location_name,
  (SELECT p.display_name FROM public.user_profiles p WHERE p.user_id = c.user_id) AS person_name,
  CASE c.paying_scope
    WHEN 'user' THEN (SELECT p.display_name FROM public.user_profiles p
                       WHERE p.user_id = c.paying_user_id)
    WHEN 'account' THEN coalesce(
      (SELECT p.display_name FROM public.owner_accounts oa
         JOIN public.user_profiles p ON p.user_id = oa.user_id
        WHERE oa.id = c.paying_account_id),
      (SELECT p.display_name FROM public.memberships m
         JOIN public.user_profiles p ON p.user_id = m.user_id
        WHERE m.location_id = c.location_id AND m.role = 'owner'
          AND c.paying_account_id = c.owner_account_id))
    ELSE NULL END AS payer_name`;

/** Whether money shows for a row: no location, the caller paid, or the location's gate. */
async function moneyShows(
  tx: Tx,
  scope: Scope,
  who: Who,
  r: Pick<CallRow, 'location_id' | 'paying_user_id' | 'paying_account_id' | 'paying_scope'>,
): Promise<boolean> {
  if (r.location_id === null) return true;
  if (r.paying_user_id === who.userId) return true;
  if (r.paying_account_id !== null && r.paying_account_id === who.accountId) return true;
  if (r.paying_scope === 'instance' && who.instanceAdmin) return true;
  try {
    return (await gateFor(tx, r.location_id, scope)).showMoney;
  } catch {
    return false;
  }
}

export type Serializer = (r: CallRow) => Promise<CallView>;

export function serializer(tx: Tx, scope: Scope, who: Who): Serializer {
  return async (r) => {
    const shows = await moneyShows(tx, scope, who, r);
    const view: CallView = {
      id: r.id,
      at: r.at.toISOString(),
      requestId: r.request_id,
      attempt: r.attempt,
      task: r.task,
      providerKind: r.provider_kind,
      model: r.model,
      paidBy: { scope: r.paying_scope, label: r.payer_name ?? '', fellBack: r.fell_back },
      sent: r.sent,
      tokens: {
        estimate: r.estimate_tokens,
        input: r.input_tokens,
        output: r.output_tokens,
        reasoning: r.reasoning_tokens,
        cached: r.cached_input_tokens,
      },
      images: { count: r.image_count, tokensEach: r.image_tokens_each, bytes: r.image_bytes },
      latencyMs: r.latency_ms,
      finishReason: r.finish_reason,
      outcome: r.outcome,
      errorCode: r.error_code,
      links: {},
    };
    if (r.location_id && r.location_name !== null) {
      view.location = { id: r.location_id, name: r.location_name };
    }
    view.person = r.user_id === null ? 'background' : { id: r.user_id, name: r.person_name ?? '' };
    if (!shows) view.moneyHidden = true;
    else if (r.cost_amount !== null && r.cost_currency !== null) {
      view.cost = {
        amount: amount(r.cost_amount) ?? '0',
        currency: r.cost_currency.trim(),
        source: r.cost_source,
        priceVersion: r.price_version,
      };
    }
    if (r.extraction_id) view.links.extractionId = r.extraction_id;
    if (r.thing_id) view.links.thingId = r.thing_id;
    if (r.thread_id && r.user_id === who.userId) view.links.threadId = r.thread_id;
    return view;
  };
}

// ---------------------------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------------------------

/** A valid IANA zone from the request's `x-kept-timezone`, else UTC. */
export function timezoneOf(header: unknown): string {
  const tz = typeof header === 'string' ? header.trim() : '';
  if (!tz || tz.length > 64) return 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

type Sql = { where: string[]; args: unknown[] };
const push = (s: Sql, v: unknown) => {
  s.args.push(v);
  return `$${s.args.length}`;
};

/** `at` as SQL bounds, in the caller's zone (the web's dateBounds: today, the last 7 and 30
 * days, the year so far; or a range of whole days, `to` inclusive). */
export function atBounds(s: Sql, at: string | undefined, tz: string): void {
  if (!at) return;
  const zone = push(s, tz);
  const midnight = (daysBack: number) =>
    `((date_trunc('day', now() AT TIME ZONE ${zone}) - interval '${daysBack} days') AT TIME ZONE ${zone})`;
  if ((DATE_PRESETS as readonly string[]).includes(at)) {
    const from =
      at === 'today'
        ? midnight(0)
        : at === 'week'
          ? midnight(6)
          : at === 'month'
            ? midnight(29)
            : `(date_trunc('year', now() AT TIME ZONE ${zone}) AT TIME ZONE ${zone})`;
    s.where.push(`c.at >= ${from}`);
    return;
  }
  const range = parseDateRange(at);
  if (!range) throw invalid('`at` is today, week, month, year or YYYY-MM-DD..YYYY-MM-DD.');
  if (range.from) {
    s.where.push(`c.at >= (${push(s, range.from)}::date::timestamp AT TIME ZONE ${zone})`);
  }
  if (range.to) {
    s.where.push(`c.at < ((${push(s, range.to)}::date + 1)::timestamp AT TIME ZONE ${zone})`);
  }
}

const rangeOf = (v: string) => {
  const [a = '', b = ''] = v.split('..');
  return { min: a === '' ? null : a, max: b === '' ? null : b };
};

/** The list's filters as SQL over `c` (llm_calls). */
export function filterSql(s: Sql, q: CallsQuery, tz: string, moneyLocations: string[] | null) {
  const neg = (name: string) => q.not?.includes(name as (typeof CALL_FILTERS)[number]) ?? false;
  const many = (
    name: string,
    values: readonly string[] | undefined,
    cond: (p: string) => string,
  ) => {
    if (!values?.length) return;
    const c = cond(push(s, [...values]));
    s.where.push(neg(name) ? `NOT coalesce(${c}, false)` : `coalesce(${c}, false)`);
  };
  atBounds(s, q.at, tz);
  if (q.person?.length) {
    const ids = q.person.filter((p) => p !== 'background');
    const bg = q.person.includes('background');
    const c = `(c.user_id = ANY (${push(s, ids)}::uuid[])${bg ? ' OR c.user_id IS NULL' : ''})`;
    s.where.push(neg('person') ? `NOT coalesce(${c}, false)` : `coalesce(${c}, false)`);
  }
  many('location', q.location, (p) => `c.location_id = ANY (${p}::uuid[])`);
  many('task', q.task, (p) => `c.task = ANY (${p}::text[])`);
  many('model', q.model, (p) => `c.model = ANY (${p}::text[])`);
  many('provider', q.provider, (p) => `c.provider_kind = ANY (${p}::text[])`);
  many('outcome', q.outcome, (p) => `c.outcome = ANY (${p}::text[])`);
  many('paidBy', q.paidBy, (p) => `c.paying_scope = ANY (${p}::text[])`);
  many('thing', q.thing, (p) => `c.thing_id = ANY (${p}::uuid[])`);
  if (q.hasImage === 'true') s.where.push('c.image_count > 0');
  if (q.hasImage === 'false') s.where.push('c.image_count = 0');
  if (q.tokens) {
    const r = rangeOf(q.tokens);
    const total = '(coalesce(c.input_tokens, 0) + coalesce(c.output_tokens, 0))';
    if (r.min !== null) s.where.push(`${total} >= ${push(s, r.min)}::numeric`);
    if (r.max !== null) s.where.push(`${total} <= ${push(s, r.max)}::numeric`);
  }
  if (q.cost) {
    // Only rows whose money the caller may see: a cost filter must not tell a viewer what a
    // hidden call cost (§7.15, "only where money shows").
    const r = rangeOf(q.cost);
    s.where.push('c.cost_amount IS NOT NULL');
    if (r.min !== null) s.where.push(`c.cost_amount >= ${push(s, r.min)}::numeric`);
    if (r.max !== null) s.where.push(`c.cost_amount <= ${push(s, r.max)}::numeric`);
    if (q.currency) s.where.push(`c.cost_currency = ${push(s, q.currency)}`);
    if (moneyLocations) {
      s.where.push(
        `(c.location_id IS NULL OR c.paying_user_id = kept.current_user_id()
          OR c.paying_account_id = kept.current_owner_account_id()
          OR c.location_id = ANY (${push(s, moneyLocations)}::uuid[]))`,
      );
    }
  }
  if (q.q) {
    const like = push(s, `%${q.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
    s.where.push(`(c.model ILIKE ${like} OR c.request_id ILIKE ${like})`);
  }
}

/** The visible locations where the caller's gate shows money, for the cost filter. */
async function moneyLocationIds(tx: Tx, client: pg.ClientBase, scope: Scope): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    'SELECT id FROM public.locations WHERE id IN (SELECT kept.visible_location_ids())',
  );
  const out: string[] = [];
  for (const r of rows) {
    try {
      if ((await gateFor(tx, r.id, scope)).showMoney) out.push(r.id);
    } catch {}
  }
  return out;
}

/** The scope's own rows (§7.15's visibility table, narrowed to the scope asked for). */
async function scopeSql(
  s: Sql,
  client: pg.ClientBase,
  who: Who,
  q: Pick<CallsQuery, 'scope' | 'locationId'>,
): Promise<void> {
  switch (q.scope) {
    case 'me':
      s.where.push(`c.user_id = ${push(s, who.userId)}`);
      return;
    case 'location': {
      if (!q.locationId) throw notFound();
      const { rows } = await client.query<{ ok: boolean }>(
        'SELECT $1::uuid IN (SELECT kept.admin_location_ids()) AS ok',
        [q.locationId],
      );
      if (!rows[0]?.ok) throw notFound();
      s.where.push(`c.location_id = ${push(s, q.locationId)}`);
      return;
    }
    case 'account': {
      if (!who.accountId) throw notFound();
      const acct = push(s, who.accountId);
      s.where.push(`(c.owner_account_id = ${acct} OR c.paying_account_id = ${acct})`);
      return;
    }
    case 'instance':
      throw new Error('the instance scope reads kept.ai_instance_calls');
  }
}

type Ctx = { tx: Tx; client: pg.ClientBase; scope: Scope; who: Who; tz: string };

/** One page of the call list. */
export async function listCalls(
  ctx: Ctx,
  q: CallsQuery,
): Promise<{ items: CallView[]; next_cursor: string | null }> {
  if (q.scope === 'instance') return instanceCalls(ctx, q);
  const s: Sql = { where: [], args: [] };
  await scopeSql(s, ctx.client, ctx.who, q);
  filterSql(s, q, ctx.tz, q.cost ? await moneyLocationIds(ctx.tx, ctx.client, ctx.scope) : null);
  const asc = q.dir === 'asc';
  if (q.cursor) {
    const [at, id] = decodeCursor<[string, string]>(q.cursor);
    if (typeof at !== 'string' || typeof id !== 'string') throw invalid('Bad cursor.');
    s.where.push(
      `(c.at, c.id) ${asc ? '>' : '<'} (${push(s, at)}::timestamptz, ${push(s, id)}::uuid)`,
    );
  }
  const { rows } = await ctx.client.query<CallRow>(
    `SELECT ${ROW_COLUMNS} FROM public.llm_calls c
      WHERE ${s.where.join(' AND ')}
      ORDER BY c.at ${asc ? 'ASC' : 'DESC'}, c.id ${asc ? 'ASC' : 'DESC'}
      LIMIT ${q.limit + 1}`,
    s.args,
  );
  const serialize = serializer(ctx.tx, ctx.scope, ctx.who);
  const page = rows.slice(0, q.limit);
  const items: CallView[] = [];
  for (const r of page) items.push(await serialize(r));
  const last = page.at(-1);
  return {
    items,
    next_cursor:
      rows.length > q.limit && last ? encodeCursor([last.at.toISOString(), last.id]) : null,
  };
}

type InstanceRow = {
  id: string;
  at: Date;
  request_id: string;
  attempt: number;
  task: CallView['task'];
  owner_account_id: string | null;
  user_id: string | null;
  provider_kind: CallView['providerKind'];
  model: string;
  sent: boolean;
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  cached_input_tokens: number | null;
  image_count: number;
  cost_amount: string | null;
  cost_currency: string | null;
  cost_source: CostSchemaSource;
  outcome: CallView['outcome'];
  error_code: string | null;
  next_cursor: string;
};

/** Filters the instance door can't apply, checked on each row it gives. */
function instanceMatch(q: CallsQuery, r: InstanceRow): boolean {
  const neg = (name: string) => q.not?.includes(name as (typeof CALL_FILTERS)[number]) ?? false;
  const test = (name: string, values: readonly string[] | undefined, v: string | null) => {
    if (!values?.length) return true;
    const hit = v !== null && values.includes(v);
    return neg(name) ? !hit : hit;
  };
  const person = r.user_id ?? 'background';
  if (!test('person', q.person, person)) return false;
  if (!test('location', q.location, null)) return false;
  if (!test('task', q.task, r.task)) return false;
  if (!test('model', q.model, r.model)) return false;
  if (!test('provider', q.provider, r.provider_kind)) return false;
  if (!test('outcome', q.outcome, r.outcome)) return false;
  if (!test('paidBy', q.paidBy, 'instance')) return false;
  if (!test('thing', q.thing, null)) return false;
  if (q.hasImage === 'true' && r.image_count === 0) return false;
  if (q.hasImage === 'false' && r.image_count > 0) return false;
  const tokens = (r.input_tokens ?? 0) + (r.output_tokens ?? 0);
  if (q.tokens) {
    const g = rangeOf(q.tokens);
    if (g.min !== null && tokens < Number(g.min)) return false;
    if (g.max !== null && tokens > Number(g.max)) return false;
  }
  if (q.cost) {
    const g = rangeOf(q.cost);
    if (r.cost_amount === null) return false;
    const c = Number(r.cost_amount);
    if (g.min !== null && c < Number(g.min)) return false;
    if (g.max !== null && c > Number(g.max)) return false;
    if (q.currency && r.cost_currency?.trim() !== q.currency) return false;
  }
  if (q.q) {
    const needle = q.q.toLowerCase();
    if (!r.model.toLowerCase().includes(needle) && !r.request_id.toLowerCase().includes(needle))
      return false;
  }
  return true;
}

/** Bounds of `at` as instants, for the instance door's `from`/`to`. */
async function atInstants(client: pg.ClientBase, at: string | undefined, tz: string) {
  if (!at) return { from: null, to: null };
  const s: Sql = { where: [], args: [] };
  atBounds(s, at, tz);
  const from = s.where.find((w) => w.includes('>='))?.replace(/^c\.at >= /, '') ?? 'NULL';
  const to = s.where.find((w) => w.startsWith('c.at <'))?.replace(/^c\.at < /, '') ?? 'NULL';
  const { rows } = await client.query<{ f: Date | null; t: Date | null }>(
    `SELECT ${from}::timestamptz AS f, ${to}::timestamptz AS t`,
    s.args,
  );
  return { from: rows[0]?.f?.toISOString() ?? null, to: rows[0]?.t?.toISOString() ?? null };
}

/** The instance key's calls (instance admins; newest first, the door's only order). */
async function instanceCalls(
  ctx: Ctx,
  q: CallsQuery,
): Promise<{ items: CallView[]; next_cursor: string | null }> {
  if (!ctx.who.instanceAdmin) throw notFound();
  const bounds = await atInstants(ctx.client, q.at, ctx.tz);
  const single = (name: string, v: readonly string[] | undefined) =>
    v?.length === 1 && !q.not?.includes(name as (typeof CALL_FILTERS)[number]) ? v[0] : undefined;
  const filters = {
    limit: 200,
    ...(single('task', q.task) ? { task: single('task', q.task) } : {}),
    ...(single('model', q.model) ? { model: single('model', q.model) } : {}),
    ...(single('outcome', q.outcome) ? { outcome: single('outcome', q.outcome) } : {}),
    ...(bounds.from ? { from: bounds.from } : {}),
    ...(bounds.to ? { to: bounds.to } : {}),
  };
  let cursor: string | null = q.cursor ? decodeCursor<string>(q.cursor) : null;
  const picked: InstanceRow[] = [];
  let more = false;
  for (let pageNo = 0; pageNo < 50 && picked.length <= q.limit; pageNo++) {
    const { rows } = await ctx.client.query<InstanceRow>(
      `SELECT id, at, request_id, attempt, task, owner_account_id, user_id, provider_kind, model,
              sent, input_tokens, output_tokens, reasoning_tokens, cached_input_tokens,
              image_count, cost_amount::text AS cost_amount, cost_currency::text AS cost_currency,
              cost_source, outcome, error_code, next_cursor
         FROM kept.ai_instance_calls($1, $2)`,
      [JSON.stringify(filters), cursor],
    );
    for (const r of rows) {
      if (instanceMatch(q, r)) picked.push(r);
      if (picked.length > q.limit) break;
    }
    if (rows.length < 200) break;
    cursor = rows.at(-1)?.next_cursor ?? null;
  }
  if (picked.length > q.limit) more = true;
  const page = picked.slice(0, q.limit);
  const names = await personNames(
    ctx.client,
    page.map((r) => r.user_id).filter((u): u is string => !!u),
  );
  const items = page.map((r): CallView => {
    const view: CallView = {
      id: r.id,
      at: r.at.toISOString(),
      requestId: r.request_id,
      attempt: r.attempt,
      task: r.task,
      providerKind: r.provider_kind,
      model: r.model,
      person:
        r.user_id === null ? 'background' : { id: r.user_id, name: names.get(r.user_id) ?? '' },
      paidBy: { scope: 'instance', label: '', fellBack: false },
      sent: r.sent,
      tokens: {
        estimate: null,
        input: r.input_tokens,
        output: r.output_tokens,
        reasoning: r.reasoning_tokens,
        cached: r.cached_input_tokens,
      },
      images: { count: r.image_count, tokensEach: null, bytes: null },
      latencyMs: null,
      finishReason: null,
      outcome: r.outcome,
      errorCode: r.error_code,
      links: {},
    };
    if (r.cost_amount !== null && r.cost_currency !== null) {
      view.cost = {
        amount: amount(r.cost_amount) ?? '0',
        currency: r.cost_currency.trim(),
        source: r.cost_source,
        priceVersion: null,
      };
    }
    return view;
  });
  const last = page.at(-1);
  return { items, next_cursor: more && last ? encodeCursor(last.next_cursor) : null };
}

async function personNames(client: pg.ClientBase, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { rows } = await client.query<{ user_id: string; display_name: string | null }>(
    'SELECT user_id, display_name FROM public.user_profiles WHERE user_id = ANY ($1::uuid[])',
    [[...new Set(ids)]],
  );
  return new Map(rows.map((r) => [r.user_id, r.display_name ?? '']));
}

/** One call the caller may see, with the other attempts of its request (GET /ai/calls/:id). An
 * instance admin also reaches the instance key's calls, without their location detail. */
export async function callDetail(
  ctx: Ctx,
  id: string,
): Promise<CallView & { attempts: CallView[] }> {
  const { rows } = await ctx.client.query<CallRow>(
    `SELECT ${ROW_COLUMNS} FROM public.llm_calls c WHERE c.id = $1`,
    [id],
  );
  const serialize = serializer(ctx.tx, ctx.scope, ctx.who);
  const row = rows[0];
  if (row) {
    const { rows: others } = await ctx.client.query<CallRow>(
      `SELECT ${ROW_COLUMNS} FROM public.llm_calls c
        WHERE c.request_id = $1 AND c.id <> $2 ORDER BY c.attempt, c.at, c.id LIMIT 50`,
      [row.request_id, row.id],
    );
    const attempts: CallView[] = [];
    for (const o of others) attempts.push(await serialize(o));
    return { ...(await serialize(row)), attempts };
  }
  if (ctx.who.instanceAdmin) {
    // The door has no lookup by id; the id's own time (a UUIDv7) bounds the search.
    const ms = Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16);
    if (Number.isFinite(ms)) {
      const page = await instanceCalls(ctx, {
        ...CallsQuery.parse({ scope: 'instance', limit: 200 }),
        at: `${new Date(ms - 86_400_000).toISOString().slice(0, 10)}..${new Date(ms + 86_400_000).toISOString().slice(0, 10)}`,
      });
      const hit = page.items.find((c) => c.id === id);
      if (hit) return { ...hit, attempts: [] };
    }
  }
  throw notFound();
}

// ---------------------------------------------------------------------------------------------
// CSV (§3.5: at most 100,000 rows; the list's columns; money columns only where money shows)
// ---------------------------------------------------------------------------------------------

export const CSV_MAX_ROWS = 100_000;
const CSV_COLUMNS = [
  'at',
  'request_id',
  'attempt',
  'task',
  'provider',
  'model',
  'location',
  'person',
  'paid_by',
  'fell_back',
  'sent',
  'input_tokens',
  'output_tokens',
  'reasoning_tokens',
  'cached_tokens',
  'images',
  'image_bytes',
  'latency_ms',
  'outcome',
  'error_code',
] as const;
const MONEY_COLUMNS = ['cost', 'currency', 'cost_source'] as const;

/** Every call the list would show for these filters, as CSV. Never a prompt, image, reply,
 * provider message or key: the ledger has none, and only these columns are written. */
export async function callsCsv(ctx: Ctx, q: CallsQuery): Promise<{ csv: string; rows: number }> {
  const all: CallView[] = [];
  let cursor: string | null = null;
  do {
    const page = await listCalls(ctx, {
      ...q,
      limit: PAGE_MAX,
      ...(cursor ? { cursor } : {}),
    } as CallsQuery);
    all.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor && all.length < CSV_MAX_ROWS);
  const rows = all.slice(0, CSV_MAX_ROWS);
  const money = !rows.some((c) => c.moneyHidden);
  const header = [...CSV_COLUMNS, ...(money ? MONEY_COLUMNS : [])];
  const lines = rows.map((c) =>
    csvLine([
      c.at,
      c.requestId,
      c.attempt,
      c.task,
      c.providerKind,
      c.model,
      c.location?.name ?? '',
      c.person === 'background' ? 'Kept (background)' : (c.person?.name ?? ''),
      c.paidBy.label,
      c.paidBy.fellBack,
      c.sent,
      c.tokens.input,
      c.tokens.output,
      c.tokens.reasoning,
      c.tokens.cached,
      c.images.count,
      c.images.bytes,
      c.latencyMs,
      c.outcome,
      c.errorCode,
      ...(money
        ? [c.cost?.amount, c.cost?.currency, c.cost?.source ?? (c.sent ? 'unknown' : 'not_sent')]
        : []),
    ]),
  );
  // D169: safeCsvCell() for every cell (a leading tab or carriage return too), a BOM so a
  // spreadsheet reads it as UTF-8, CRLF line ends.
  return {
    csv: `${CSV_BOM}${[csvLine(header), ...lines].map((l) => l + CSV_EOL).join('')}`,
    rows: rows.length,
  };
}
