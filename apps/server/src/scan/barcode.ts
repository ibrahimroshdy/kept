import { KEPT_VERSION } from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { AppError } from '../http/errors.js';
import { guardedFetch } from '../net/ssrf.js';

// Product barcode lookup (plan T17; D104, D126; engineering spec §2.4, §3.2; Q22; V28).
//
// Off by default (D126). An instance admin turns it on in the admin settings (or the first-run
// options); KEPT_BARCODE_LOOKUP, when set, locks it either way (§7.11: the environment wins).
//
// When on, a lookup asks the Open*Facts databases, in order, until one knows the product:
// Open Food Facts, Open Products Facts, Open Beauty Facts. Each is asked at most once per lookup,
// and a lookup is one real scan (the phone calls `GET /barcodes/:code` once, when the person
// opens the barcode answer), which is what their terms allow: "1 API call = 1 real scan by a
// user" (https://world.openfoodfacts.org/data, read 2026-09-29).
// - The endpoint is `GET <host>/api/v2/product/<barcode>.json`, as each database's /data page
//   documents it (world.openfoodfacts.org/data, world.openproductsfacts.org/data,
//   world.openbeautyfacts.org/data, read 2026-09-29), with `fields=` to take only what Kept shows.
//   A found product answers `status: 1` with a `product` (the API tutorial,
//   openfoodfacts.github.io/openfoodfacts-server/api/tutorial-off-api/). A product it doesn't
//   have is taken as not found whether it answers `status: 0` or HTTP 404 (inferred: the docs
//   show only the found case).
// - `User-Agent: Kept/<version> (<contact>)`, the form their API docs ask for ("AppName/Version
//   (ContactEmail)"); the contact is KEPT_BARCODE_CONTACT, else the admin's `barcode_contact`
//   setting. Without either the User-Agent is `Kept/<version>` alone.
// - Through guardedFetch (net/ssrf.ts): no private addresses, no redirects; 5 s per call.
// - At most 15 lookups a minute across the instance (§3.2; their documented limit is 15 product
//   reads a minute per IP), through the shared DB limiter; the 16th is 429 with Retry-After.
// - Nothing is stored, and no product image is fetched or passed on (CSP `img-src 'self'`; Q22:
//   a shared cache would tell one household what another scanned).
//
// `barcodeTransport.fetch` is the one way out; tests replace it with a double.

export const BARCODE_LOOKUP_KEY = 'barcode_lookup';
export const BARCODE_CONTACT_KEY = 'barcode_contact';
export const LOOKUPS_PER_MINUTE = 15;
const TIMEOUT_MS = 5_000;

export const BARCODE_SOURCES = [
  { base: 'https://world.openfoodfacts.org', attribution: 'Open Food Facts (ODbL)' },
  { base: 'https://world.openproductsfacts.org', attribution: 'Open Products Facts (ODbL)' },
  { base: 'https://world.openbeautyfacts.org', attribution: 'Open Beauty Facts (ODbL)' },
] as const;

const FIELDS = 'product_name,brands,quantity';

/** Replaced by tests; production goes through guardedFetch to the fixed hosts above. */
export const barcodeTransport: { fetch: typeof fetch } = {
  fetch: guardedFetch({ allowPrivate: false }),
};

/** What Open*Facts can look up: a GTIN-8, -12, -13 or -14. Anything else is not found, with no
 * call made. */
const GTIN = /^\d{8}$|^\d{12,14}$/;

export type BarcodeEnv = {
  KEPT_BARCODE_LOOKUP?: boolean | undefined;
  KEPT_BARCODE_CONTACT?: string | undefined;
};

export type BarcodeSettings = {
  lookup: { value: boolean; locked: boolean };
  contact: { value: string | null; locked: boolean };
};

/** The instance's barcode settings, the environment winning (§7.11). `db` reads
 * instance_settings: kept_system, or an instance admin's scoped connection. */
export async function readBarcodeSettings(
  db: Pick<pg.ClientBase, 'query'>,
  env: BarcodeEnv,
): Promise<BarcodeSettings> {
  const { rows } = await db.query<{ key: string; value: unknown }>(
    'SELECT key, value FROM public.instance_settings WHERE key = ANY ($1::text[])',
    [[BARCODE_LOOKUP_KEY, BARCODE_CONTACT_KEY]],
  );
  return barcodeSettingsFrom(new Map(rows.map((r) => [r.key, r.value])), env);
}

/** The settings from the stored `instance_settings` values by key, the environment winning. */
export function barcodeSettingsFrom(
  stored: ReadonlyMap<string, unknown>,
  env: BarcodeEnv,
): BarcodeSettings {
  const contact = stored.get(BARCODE_CONTACT_KEY);
  return {
    lookup:
      env.KEPT_BARCODE_LOOKUP !== undefined
        ? { value: env.KEPT_BARCODE_LOOKUP, locked: true }
        : { value: stored.get(BARCODE_LOOKUP_KEY) === true, locked: false },
    contact: env.KEPT_BARCODE_CONTACT
      ? { value: env.KEPT_BARCODE_CONTACT, locked: true }
      : { value: typeof contact === 'string' && contact ? contact : null, locked: false },
  };
}

export const BarcodeLookupSchema = z.union([
  z.object({ enabled: z.literal(false) }),
  z.object({
    enabled: z.literal(true),
    found: z.boolean(),
    product: z
      .object({
        name: z.string().nullable(),
        brand: z.string().nullable(),
        quantity: z.string().nullable(),
      })
      .optional(),
    attribution: z.string(),
  }),
]);
export type BarcodeLookup = z.infer<typeof BarcodeLookupSchema>;

const Product = z.object({
  status: z.union([z.number(), z.string()]).optional(),
  product: z
    .object({
      product_name: z.string().nullish(),
      brands: z.string().nullish(),
      quantity: z.string().nullish(),
    })
    .nullish(),
});

const text = (v: string | null | undefined, max = 200): string | null => {
  const t = v?.trim();
  return t ? t.slice(0, max) : null;
};

/** One database's answer: the product, null for "doesn't have it", or throws when it failed. */
async function askOne(
  base: string,
  code: string,
  userAgent: string,
): Promise<NonNullable<Extract<BarcodeLookup, { enabled: true }>['product']> | null> {
  const url = `${base}/api/v2/product/${code}.json?fields=${FIELDS}`;
  const res = await barcodeTransport.fetch(url, {
    headers: { 'user-agent': userAgent, accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${base} answered ${res.status}`);
  const parsed = Product.safeParse(await res.json());
  if (!parsed.success) throw new Error(`${base} answered something unexpected`);
  const { status, product } = parsed.data;
  if (Number(status) !== 1 || !product) return null;
  return {
    name: text(product.product_name),
    // `brands` is a comma-separated list; the first is the product's own.
    brand: text(product.brands?.split(',')[0]),
    quantity: text(product.quantity, 60),
  };
}

export type LookupDeps = {
  settings: BarcodeSettings;
  /** Reserves one lookup under the instance's limit (the DB limiter); false when over it. */
  reserve: () => Promise<{ allowed: true } | { allowed: false; retryAfter: number }>;
  version?: string;
};

/** GET /api/v1/barcodes/:code. `onLimited` sets Retry-After before the 429 is thrown. */
export async function lookupBarcode(
  code: string,
  deps: LookupDeps,
  onLimited: (retryAfter: number) => AppError,
): Promise<BarcodeLookup> {
  if (!deps.settings.lookup.value) return { enabled: false };
  const first = BARCODE_SOURCES[0].attribution;
  if (!GTIN.test(code)) return { enabled: true, found: false, attribution: first };
  const limit = await deps.reserve();
  if (!limit.allowed) throw onLimited(limit.retryAfter);
  const contact = deps.settings.contact.value;
  const userAgent = `Kept/${deps.version ?? KEPT_VERSION}${contact ? ` (${contact})` : ''}`;
  let failed = false;
  for (const source of BARCODE_SOURCES) {
    try {
      const product = await askOne(source.base, code, userAgent);
      if (product) return { enabled: true, found: true, product, attribution: source.attribution };
    } catch {
      failed = true;
    }
  }
  if (failed) {
    throw new AppError(
      'internal',
      503,
      "The product database didn't answer. Add it as a new thing, or try again later.",
    );
  }
  return { enabled: true, found: false, attribution: first };
}
