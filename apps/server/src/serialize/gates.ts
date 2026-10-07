import { can, canonicalMoney, type FieldKind, type ModuleId, type Role } from '@kept/shared';
import { sql } from 'drizzle-orm';
import type { Scope, Tx } from '../db/scope.js';
import { notFound } from '../http/errors.js';
import { locationModuleSet } from '../http/modules.js';

// Response gates (step 2; D13, D110, D116, D157; engineering spec §7.5, §7.13). Money and secret
// values leave the server only through here:
// - money needs the `money` module on in the row's location AND can(role, 'money.view',
//   {moneyVisibleToViewers}): a viewer sees it only when the location allows it;
// - secrets need the `secrets` module, and then the field's own policy (mayRevealSecret).
//
// Withheld money is left out of the response, never sent as null, and the object that held it
// carries `moneyHidden: true` (the web contract, T26). The marker is set whether or not there was
// a value, so its absence can't tell a viewer that nothing was paid.
//
// A route gets one Gate per location per request: gateFor() caches it on the request's Scope
// object (a new one per request, auth/http.ts), so serialising a list of rows from one location
// costs one lookup. A route that changes the caller's role, the modules or the viewer toggle and
// then serialises calls forgetGates() first.

export type Gate = Readonly<{
  locationId: string;
  role: Role;
  modules: ReadonlySet<ModuleId>;
  /** The location's "viewers may see money" toggle (D13). */
  moneyVisibleToViewers: boolean;
  showMoney: boolean;
  /** The secrets module is on; each field's policy still decides (mayRevealSecret). */
  showSecrets: boolean;
}>;

export type GateInput = {
  locationId: string;
  role: Role;
  modules: ReadonlySet<ModuleId>;
  moneyVisibleToViewers: boolean;
};

/** The gate for a known role, module set and toggle (no database). */
export function gateOf(input: GateInput): Gate {
  const showMoney =
    input.modules.has('money') &&
    can(input.role, 'money.view', { moneyVisibleToViewers: input.moneyVisibleToViewers });
  return Object.freeze({
    locationId: input.locationId,
    role: input.role,
    modules: input.modules,
    moneyVisibleToViewers: input.moneyVisibleToViewers,
    showMoney,
    showSecrets: input.modules.has('secrets'),
  });
}

const cache = new WeakMap<Scope, Map<string, Promise<Gate>>>();

async function loadGate(tx: Tx, locationId: string): Promise<Gate> {
  // Read under the caller's own policies: a location they can't see has no membership row for
  // them here, and is a 404 like any row they can't see (§7.7).
  const { rows } = await tx.execute<{ role: Role; money_visible_to_viewers: boolean }>(sql`
    SELECT m.role, l.money_visible_to_viewers
      FROM public.memberships m
      JOIN public.locations l ON l.id = m.location_id
     WHERE m.location_id = ${locationId}
       AND m.user_id = kept.current_user_id()
       AND (m.expires_at IS NULL OR m.expires_at > now())`);
  const row = rows[0];
  if (!row) throw notFound();
  const modules = await locationModuleSet(tx, locationId);
  if (!modules) throw notFound();
  return gateOf({
    locationId,
    role: row.role,
    modules,
    moneyVisibleToViewers: row.money_visible_to_viewers,
  });
}

/**
 * The caller's gate in a location, read in `tx` (the request's scoped transaction) and cached on
 * `scope` for the rest of the request. 404 when the caller can't see the location.
 */
export function gateFor(tx: Tx, locationId: string, scope: Scope): Promise<Gate> {
  const id = locationId.toLowerCase();
  let perScope = cache.get(scope);
  if (!perScope) {
    perScope = new Map();
    cache.set(scope, perScope);
  }
  const cached = perScope.get(id);
  if (cached) return cached;
  const loading = loadGate(tx, id);
  perScope.set(id, loading);
  // A failed lookup (a 404, a dropped connection) is not remembered.
  loading.catch(() => {
    if (perScope.get(id) === loading) perScope.delete(id);
  });
  return loading;
}

/** Drops the cached gates of a request: all of them, or one location's. */
export function forgetGates(scope: Scope, locationId?: string): void {
  if (locationId === undefined) cache.delete(scope);
  else cache.get(scope)?.delete(locationId.toLowerCase());
}

// ---------------------------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------------------------

export const MONEY_HIDDEN = Object.freeze({ moneyHidden: true as const });

/** `{amount, currency}` when the gate shows money and there is an amount; else undefined. */
export function moneyOf(
  gate: Gate,
  amount: string | null | undefined,
  currency: string | null | undefined,
): { amount: string; currency: string } | undefined {
  if (!gate.showMoney || amount == null || currency == null) return undefined;
  return { amount, currency };
}

/**
 * Money fields to spread into a response: the ones that are set, when the gate shows money;
 * otherwise only `{moneyHidden: true}`. Nulls are dropped either way (the contract never sends a
 * money field as null).
 */
export function moneyProps<K extends string>(
  gate: Gate,
  props: Record<K, string | null | undefined>,
): Partial<Record<K, string>> | typeof MONEY_HIDDEN {
  if (!gate.showMoney) return MONEY_HIDDEN;
  const out: Partial<Record<K, string>> = {};
  for (const [key, value] of Object.entries(props) as [K, string | null | undefined][]) {
    if (value != null) out[key] = value;
  }
  return out;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function strip(node: unknown, segments: readonly string[]): unknown {
  const [head, ...rest] = segments;
  if (head === undefined) return node;
  const many = head.endsWith('[]');
  const name = many ? head.slice(0, -2) : head;
  if (!isObject(node) || !Object.hasOwn(node, name)) return node;
  const copy: Json = { ...node };
  if (rest.length === 0) {
    if (many) throw new Error(`stripMoney: a path can't end in [] (${head})`);
    delete copy[name];
    copy.moneyHidden = true;
    return copy;
  }
  const child = copy[name];
  if (many) {
    if (Array.isArray(child)) copy[name] = child.map((item) => strip(item, rest));
  } else {
    copy[name] = strip(child, rest);
  }
  return copy;
}

/**
 * `obj` with its money fields removed when the gate hides money. `paths` are dot paths from
 * `obj` (`price`, `ended.price`); `name[]` walks each item of an array
 * (`purchase.lines[].unitPrice`). Each object that lost a field is marked `moneyHidden: true`.
 * The input is not changed; a copy is returned (or `obj` itself when money is shown).
 */
export function stripMoney<T extends object>(gate: Gate, obj: T, paths: readonly string[]): T {
  if (gate.showMoney) return obj;
  let out: unknown = obj;
  for (const path of paths) out = strip(out, path.split('.'));
  return out as T;
}

// ---------------------------------------------------------------------------------------------
// Custom fields and secrets
// ---------------------------------------------------------------------------------------------

/** What customForView needs of a field definition (a ResolvedField, or a type_fields row). */
export type GatedField = { key: string; kind: FieldKind; secret?: boolean | null };

/**
 * The custom values a viewer may see: money-kind values only when the gate shows money, secret
 * fields never (their values live in secret_values, Q3; this drops a stray key too), and keys
 * with no field definition never (fail closed: pass the definitions of every key to show,
 * archived fields included).
 */
export function customForView(
  gate: Gate,
  fields: readonly GatedField[],
  custom: Readonly<Record<string, unknown>> | null | undefined,
): Record<string, unknown> {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(custom ?? {})) {
    const field = byKey.get(key);
    if (!field || field.secret) continue;
    if (field.kind === 'money' && !gate.showMoney) continue;
    // Money in the one wire form (`"12.5"`), however it was stored.
    out[key] = field.kind === 'money' ? canonicalMoney(value) : value;
  }
  return out;
}

/** Whether the caller may reveal one secret field (D116): the secrets module, then the field's
 * policy, which only widens the admin+ default. Named people on a policy are the caller's check. */
export function mayRevealSecret(
  gate: Gate,
  policy: { revealRoles?: readonly Role[] | null },
): boolean {
  if (!gate.showSecrets) return false;
  return can(gate.role, 'secrets.reveal', { secretRevealRoles: policy.revealRoles ?? [] });
}
