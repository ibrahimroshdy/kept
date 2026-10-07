/**
 * The tool output contract (D63, D179, L70; engineering spec §2.5).
 *
 * - Every tool answers an `Envelope`: `{data, as_of, next_cursor?}`, or `{error, hint}`.
 * - Every user-written string (names, notes, aliases, place names, descriptions) sits under an
 *   `untrusted` key, never mixed with Kept's own words (D179). The model's instructions say that
 *   text there is data, never instructions.
 * - Units are in field names (`odometer_km`, `quantity`), dates are ISO, money is
 *   `{amount, currency}` and only where the money gate shows it.
 * - A list answers 20 items unless asked (at most 200), and the whole envelope stays under
 *   `OUTPUT_LIMIT_BYTES` of JSON: `fit()` drops list items from the end (setting `next_cursor`),
 *   then removes whole fields from a single oversized item. It never cuts a string.
 *
 * The 8 KB is the tool's own JSON, not the MCP response: JSON-in-JSON escaping and
 * `structuredContent` add to the wire (docs/spikes/2026-09-30-step6-mcp-sdk.md, finding 4).
 */

import { z } from 'zod';

export const OUTPUT_LIMIT_BYTES = 8192;
export const PAGE = Object.freeze({ default: 20, max: 200 });

export type Untrusted<T> = { untrusted: T };

export type EnvelopeOk<T> = {
  data: T;
  /** When the answer was read (ISO 8601, UTC). */
  as_of: string;
  /** Pass it back as `cursor` for the next page. */
  next_cursor?: string;
  /** JSON paths of the fields `fit()` removed to stay under the limit. */
  trimmed?: string[];
};
export type ToolError = { error: string; hint: string };
export type Envelope<T> = EnvelopeOk<T> | ToolError;

export function isToolError<T>(e: Envelope<T>): e is ToolError {
  return 'error' in e;
}

/** The envelope around a tool's `data` schema, for contract tests. */
export function envelopeSchema<T extends z.ZodType>(data: T) {
  return z.union([
    z.object({
      data,
      as_of: z.iso.datetime({ offset: true }),
      next_cursor: z.string().optional(),
      trimmed: z.array(z.string()).optional(),
    }),
    toolErrorSchema,
  ]);
}

export const toolErrorSchema = z.object({ error: z.string().min(1), hint: z.string() });

export function ok<T>(data: T, asOf: Date = new Date(), nextCursor?: string): EnvelopeOk<T> {
  return nextCursor === undefined
    ? { data, as_of: asOf.toISOString() }
    : { data, as_of: asOf.toISOString(), next_cursor: nextCursor };
}

export function toolError(error: string, hint: string): ToolError {
  return { error, hint };
}

/** The page size a tool uses: the asked-for limit clamped to 1…200, else 20. */
export function pageSize(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return PAGE.default;
  return Math.min(PAGE.max, Math.max(1, Math.trunc(limit)));
}

/** An offset cursor (base64url of `o:<n>`), the default when `fit()` shortens a page. */
export function encodeOffsetCursor(offset: number): string {
  return base64url(`o:${offset}`);
}

/** The offset in a cursor `encodeOffsetCursor` made, or null for anything else. */
export function decodeOffsetCursor(cursor: string): number | null {
  const raw = unbase64url(cursor);
  const m = raw === null ? null : /^o:(\d{1,9})$/.exec(raw);
  return m ? Number(m[1]) : null;
}

export function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export type FitOptions = {
  /** The limit in bytes of the envelope's JSON. */
  limit?: number;
  /** The offset of the page's first item, for the default cursor. */
  offset?: number;
  /** The cursor for the item after the `kept` items that stay. */
  cursorAt?: (kept: number) => string;
};

/**
 * Keys that are never removed, nor any field holding one: without them a result can't be cited
 * or followed. `items` is the list itself.
 */
const PROTECTED = new Set(['id', 'short_code', 'kind', 'role', 'name', 'items']);
const isProtected = (key: string) => PROTECTED.has(key) || key.endsWith('_id');

function holdsProtected(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(holdsProtected);
  if (value && typeof value === 'object')
    return Object.entries(value).some(([k, v]) => isProtected(k) || holdsProtected(v));
  return false;
}

/**
 * Fits an envelope under the limit. A list (`data.items`) is shortened from the end and
 * `next_cursor` set; what is still over loses whole fields, the largest first, never an id, a
 * short ID or a name, each listed in `trimmed`. An envelope that can't be fitted becomes
 * `{error: 'output_too_large', hint}`. Errors pass through.
 */
export function fit<T>(env: Envelope<T>, opts: FitOptions = {}): Envelope<T> {
  if (isToolError(env)) return env;
  const limit = opts.limit ?? OUTPUT_LIMIT_BYTES;
  if (byteLength(env) <= limit) return env;

  let current: EnvelopeOk<T> = env;
  const items = listOf(env.data);
  if (items && items.length > 1) {
    const offset = opts.offset ?? 0;
    const cursorAt = opts.cursorAt ?? ((kept: number) => encodeOffsetCursor(offset + kept));
    const withItems = (kept: number): EnvelopeOk<T> => ({
      ...env,
      data: { ...(env.data as object), items: items.slice(0, kept) } as T,
      next_cursor: cursorAt(kept),
    });
    // The largest count that fits, by bisection (sizes grow with the count).
    let lo = 1;
    let hi = items.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (byteLength(withItems(mid)) <= limit) lo = mid;
      else hi = mid - 1;
    }
    current = withItems(lo);
    if (byteLength(current) <= limit) return current;
  }

  // Remove whole fields, the largest first, until it fits.
  const data = structuredClone(current.data) as unknown;
  const trimmed: string[] = [...(current.trimmed ?? [])];
  const build = (): EnvelopeOk<T> => ({ ...current, data: data as T, trimmed: [...trimmed] });
  for (;;) {
    if (byteLength(build()) <= limit) return build();
    const largest = largestRemovable(data, '');
    if (!largest) return toolError('output_too_large', 'Ask for fewer items or a narrower query.');
    delete (largest.parent as Record<string, unknown>)[largest.key];
    trimmed.push(largest.path);
  }
}

function listOf(data: unknown): unknown[] | null {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const items = (data as { items?: unknown }).items;
    if (Array.isArray(items)) return items;
  }
  return null;
}

type Slot = { parent: object; key: string; path: string; size: number };

/** The largest removable field below `node`: an object property that isn't protected. */
function largestRemovable(node: unknown, path: string): Slot | null {
  let best: Slot | null = null;
  const consider = (s: Slot | null) => {
    if (s && (!best || s.size > best.size)) best = s;
  };
  if (Array.isArray(node)) {
    node.forEach((v, i) => {
      consider(largestRemovable(v, `${path}[${i}]`));
    });
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      const p = path ? `${path}.${key}` : key;
      if (!isProtected(key) && !holdsProtected(value))
        consider({ parent: node, key, path: p, size: byteLength(value) });
      if (value && typeof value === 'object') consider(largestRemovable(value, p));
    }
  }
  return best;
}

function base64url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unbase64url(s: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}
