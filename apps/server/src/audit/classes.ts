// Field classes for audit diffs (engineering spec §7.5; D110).
//
// - `plain`: stored and shown as is.
// - `money`: stored in full, tagged, and hidden by renderAudit() from anyone `can()` refuses
//   `money.view` (viewers, unless the location allows it: D13).
// - `secret`: stored as `{changed: true}` only. Its values never reach the audit log; secret
//   history lives in the encrypted secret store (D116).
//
// Keys are `<entity type>.<field>`, with the field in snake_case: the column name, which is also
// the API's name for it and the key audited() stores in the diff. A field not listed is `plain`
// unless its name says it holds a secret (SECRET_NAME below), so a new credential-shaped column
// fails safe. Custom fields add their class per call (`type_fields.kind = 'money'`, and secret
// type fields) through audited()'s `fieldClasses`, which can raise a class but never lower one.

export const FIELD_CLASSES_ORDER = ['plain', 'money', 'secret'] as const;
export type FieldClass = (typeof FIELD_CLASSES_ORDER)[number];

/** The static map: the money columns of things and purchases (step 2), valuations and claims
 * (step 4), fills and documents (step 5). */
export const FIELD_CLASSES: Readonly<Record<string, FieldClass>> = Object.freeze({
  // The invite token is stored hashed, but a hash of a short-lived bearer token is still a
  // credential to brute-force offline: never in the log.
  'invite.token_hash': 'secret',
  // Step 2: money columns (D13, D115, D158).
  'thing.ended_price': 'money',
  'purchase.total': 'money',
  'purchase.tax': 'money',
  'purchase_line.unit_price': 'money',
  // Step 4 (T8, T9): a valuation's value, a claim's cost and what it would have cost (D158, Q18).
  'valuation.value': 'money',
  'claim.cost': 'money',
  'claim.covered_amount': 'money',
  // Step 5 (T2): a fill's cost and a document's cost (D110; plan Q5). Service records' money is
  // classed per call (schedules/services.ts).
  'fuel_entry.cost': 'money',
  'expiring_document.cost': 'money',
  // Step 6 (security review T25, M2): a webhook's URL often is its receiver's credential (a Slack
  // or Home Assistant hook id in the path), and the activity feed shows a location's events to
  // every member and read token. Only admins see hooks (webhooks.manage), so the log says
  // "changed".
  'webhook.url': 'secret',
});

/** Cache columns (engineering spec §7.9, D183): recomputed by triggers, never audited. */
export const CACHE_COLUMNS: readonly string[] = Object.freeze(['search_tsv', 'place_path']);

/** Field names that hold credentials whatever entity they're on. */
const SECRET_NAME = /(^|_)(password|secret|token|token_hash|api_key|private_key|passphrase)(_|$)/;

const rank = (c: FieldClass) => FIELD_CLASSES_ORDER.indexOf(c);

/** The more sensitive of two classes. */
export function stricter(a: FieldClass, b: FieldClass | undefined): FieldClass {
  return b !== undefined && rank(b) > rank(a) ? b : a;
}

/** The class of `field` (snake_case) on `entityType`, raised by `extra` when that is stricter. */
export function classOf(entityType: string, field: string, extra?: FieldClass): FieldClass {
  const mapped = FIELD_CLASSES[`${entityType}.${field}`];
  const base: FieldClass = mapped ?? (SECRET_NAME.test(field) ? 'secret' : 'plain');
  return stricter(base, extra);
}
