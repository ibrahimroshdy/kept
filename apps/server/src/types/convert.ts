import {
  type ConvertFieldBody,
  type ConvertPreview,
  type ConvertResult,
  canConvertKind,
  canConvertSecret,
  newId,
} from '@kept/shared';
import type pg from 'pg';
import { CryptoError, open, type Sealed, seal } from '../crypto/envelope.js';
import type { SecretKeys } from '../crypto/keyring.js';
import { enqueueEmbed } from '../embeddings/job.js';
import { checkVersion } from '../http/conventions.js';
import { AppError, forbidden, invalid, notFound } from '../http/errors.js';
import {
  accountAccess,
  auditRegistry,
  lastChangedBy,
  type WriteCtx,
} from '../registries/account.js';
import { aadOf, requireRecoveryKit } from '../secrets/service.js';
import { FIELD_COLUMNS, type FieldRow } from './graph.js';
import { typeConflict } from './service.js';

// Converting a field (step-7 plan T18; step-2 Q3, D172, D177, D193; plan Q20; engineering spec
// §7.13): to or from secret, or to another kind, always previewed first. The work is the three
// owner-only doors of 0085 around the app's keyring, which SQL doesn't hold:
//
// - preview: kept.field_conversion_preview(), per location of the account, how many things and
//   places hold a value, how many convert and how many go to the notes. Counts, never a value; a
//   location the caller can't see is named null (D123).
// - convert: every value read through kept.field_conversion_rows() (pages of 1,000) before any is
//   written, because the first batch flips the field's secret flag and the door then reads the
//   other store; converted in memory (sealed for a secret with a new row id in its AAD,
//   `secret_values|<id>|<key>`, or opened with the value's own row id), written through
//   kept.apply_field_conversion() in pages of 1,000, the last with `p_finish` (the field's new
//   kind, past audit diffs scrubbed to `{changed: true}` when it became secret, the search index
//   rebuilt). All of it in the request's one transaction, so nobody sees it half done.
//
// Who: the account owner only (D177). A field the caller can't see is 404; a built-in field is
// customised first (409 `builtin`); anyone else who sees it is 403. To secret needs the recovery
// kit acknowledged (409 `recovery_kit_required`, D193) and Secrets on in an affected location
// (409 `module_off`); back to plain needs the caller to be allowed to reveal every value (a
// field policy can narrow that, 403), since making it plain shows them to every member. A kind
// the field can't take is 400 `field_convert_blocked`. Audited `type.field_convert` with counts
// only, and not undoable (a secret-class change, screens §8).
//
// A kind change follows the door's rules (kept.field_value_converts) value for value, so the
// result is what the preview said: a value that doesn't fit goes to the thing's notes as
// "<label>: <value>".

export type ConvertDeps = { keys: () => SecretKeys };

type Door = 'to_secret' | 'from_secret' | 'kind';

/** A page of kept.field_conversion_rows. */
type ValueRow = {
  subject_kind: 'thing' | 'place';
  subject_id: string;
  location_id: string;
  value: unknown;
  ciphertext: Sealed | null;
  key_version: number | null;
};

const PAGE = 1000;

const blocked = () =>
  new AppError(
    'field_convert_blocked',
    400,
    "A field of this kind can't be converted to that one.",
  );

async function fieldRow(client: pg.ClientBase, id: string, lock = false): Promise<FieldRow> {
  const { rows } = await client.query<FieldRow>(
    `SELECT ${FIELD_COLUMNS} FROM public.type_fields f WHERE f.id = $1${lock ? ' FOR UPDATE' : ''}`,
    [id],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

/** The field, when the caller owns its account: 404, 409 builtin, then 403 (D177). */
async function ownedField(client: pg.ClientBase, id: string, lock = false): Promise<FieldRow> {
  const seen = await fieldRow(client, id);
  if (seen.owner_account_id === null) {
    throw typeConflict('builtin');
  }
  const access = await accountAccess(client, seen.owner_account_id);
  if (!access) throw notFound();
  if (!access.isOwn) throw forbidden('Only the account owner converts a field.');
  return lock ? fieldRow(client, id, true) : seen;
}

/** Which door `body` asks of `field`; 400 `field_convert_blocked` for what it can't become. */
function doorOf(field: FieldRow, body: ConvertFieldBody): Door {
  if ('toSecret' in body) {
    if (!canConvertSecret(field.kind) || body.toSecret === field.secret) throw blocked();
    return body.toSecret ? 'to_secret' : 'from_secret';
  }
  if (field.secret || field.type_id === null || !canConvertKind(field.kind, body.kind)) {
    throw blocked();
  }
  if (body.kind === 'select' && field.kind !== 'select' && !body.options?.length) {
    throw invalid('Give the choices the field becomes (body.options).');
  }
  return 'kind';
}

// ---------------------------------------------------------------------------------------------
// A value of the new kind, by kept.field_value_converts' rules (0085)
// ---------------------------------------------------------------------------------------------

/** Postgres regex `\s`. */
const WS = '[ \\t\\n\\r\\v\\f]';
const NUMBER = new RegExp(`^${WS}*-?[0-9]+([.,][0-9]+)?${WS}*$`);
const DATE = new RegExp(`^${WS}*[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])${WS}*$`);
const URL_RE = new RegExp(`^${WS}*https?://[^ \\t\\n\\r\\v\\f]+${WS}*$`, 'i');
const trimWs = (s: string) => s.replace(new RegExp(`^${WS}+|${WS}+$`, 'g'), '');
/** Postgres btrim(): spaces only. */
const btrim = (s: string) => s.replace(/^ +| +$/g, '');

type Converted = { ok: true; value: unknown } | { ok: false };
type KindBody = Extract<ConvertFieldBody, { kind: unknown }>;

/** The value as kind `to` (with `options`), or not: then it goes to the notes. */
export function convertValue(value: unknown, to: KindBody): Converted {
  switch (to.kind) {
    case 'number':
      if (typeof value === 'number') return { ok: true, value };
      if (typeof value === 'string' && NUMBER.test(value)) {
        return { ok: true, value: Number(trimWs(value).replace(',', '.')) };
      }
      return { ok: false };
    case 'date':
      return typeof value === 'string' && DATE.test(value)
        ? { ok: true, value: trimWs(value) }
        : { ok: false };
    case 'url':
      return typeof value === 'string' && URL_RE.test(value)
        ? { ok: true, value: trimWs(value) }
        : { ok: false };
    case 'select': {
      if (typeof value !== 'string') return { ok: false };
      const v = btrim(value);
      return !Array.isArray(to.options) || to.options.includes(v)
        ? { ok: true, value: v }
        : { ok: false };
    }
    case 'multi_select':
      return { ok: true, value: Array.isArray(value) ? value : value === null ? null : [value] };
    default:
      // text
      if (value === null || typeof value === 'string') return { ok: true, value };
      if (typeof value === 'boolean') return { ok: true, value: value ? 'Yes' : 'No' };
      if (typeof value === 'number') return { ok: true, value: String(value) };
      return { ok: true, value: JSON.stringify(value) };
  }
}

// ---------------------------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------------------------

async function previewOf(
  client: pg.ClientBase,
  fieldId: string,
  body: ConvertFieldBody,
): Promise<ConvertPreview> {
  const { rows } = await client.query<{
    location_id: string;
    location_name: string | null;
    values: number;
    convertible: number;
    to_notes: number;
  }>('SELECT * FROM kept.field_conversion_preview($1, $2)', [fieldId, JSON.stringify(body)]);
  // D123: a location the caller can't see is counted, never named.
  const { rows: seen } = await client.query<{ id: string }>(
    'SELECT id FROM public.locations WHERE id = ANY ($1::uuid[])',
    [rows.map((r) => r.location_id)],
  );
  const visible = new Set(seen.map((r) => r.id));
  const locations = rows.map((r) => ({
    id: r.location_id,
    name: visible.has(r.location_id) ? r.location_name : null,
    values: r.values,
    convertible: r.convertible,
    toNotes: r.to_notes,
  }));
  return { locations, total: locations.reduce((n, l) => n + l.values, 0) };
}

/** POST /api/v1/type-fields/:id/convert/preview. Read-only. */
export async function previewConversion(
  client: pg.ClientBase,
  fieldId: string,
  body: ConvertFieldBody,
): Promise<ConvertPreview> {
  const field = await ownedField(client, fieldId);
  doorOf(field, body);
  return previewOf(client, fieldId, body);
}

// ---------------------------------------------------------------------------------------------
// Convert
// ---------------------------------------------------------------------------------------------

/** Every value of the field, read before anything is written. */
async function allValues(client: pg.ClientBase, fieldId: string): Promise<ValueRow[]> {
  const out: ValueRow[] = [];
  let after: string | null = null;
  for (;;) {
    const res: pg.QueryResult<ValueRow> = await client.query<ValueRow>(
      'SELECT * FROM kept.field_conversion_rows($1, $2, $3)',
      [fieldId, after, PAGE],
    );
    const rows = res.rows;
    out.push(...rows);
    if (rows.length < PAGE) return out;
    after = rows.at(-1)?.subject_id ?? null;
  }
}

/** Opens a sealed value; picks up a rotation made while this process runs (keyring.ts). */
async function openValue(keys: SecretKeys, sealed: Sealed, rowId: string, key: string) {
  const aad = aadOf(rowId, key);
  try {
    return open(keys.get().keyring, sealed, aad).toString('utf8');
  } catch (err) {
    if (!(err instanceof CryptoError) || err.code !== 'crypto_key_missing') throw err;
    if (!(await keys.refresh())) throw err;
    return open(keys.get().keyring, sealed, aad).toString('utf8');
  }
}

/** Secrets on in any of `locations` (or, with none, any of the account's). */
async function requireSecretsOn(
  client: pg.ClientBase,
  accountId: string,
  locations: readonly string[],
): Promise<void> {
  const { rows } = await client.query<{ on: boolean | null }>(
    `SELECT bool_or(kept.module_on(l.id, 'secrets')) AS on FROM public.locations l
      WHERE CASE WHEN cardinality($2::uuid[]) > 0 THEN l.id = ANY ($2::uuid[])
                 ELSE l.owner_account_id = $1 END`,
    [accountId, locations],
  );
  if (!rows[0]?.on) {
    throw new AppError('module_off', 409, 'Turn on Secrets where this field is used first.');
  }
}

/** The batch rows apply_field_conversion takes, and how many of them go to the notes. */
async function batchOf(
  client: pg.ClientBase,
  deps: ConvertDeps,
  field: FieldRow,
  door: Door,
  body: ConvertFieldBody,
  values: readonly ValueRow[],
): Promise<{ rows: object[]; toNotes: string[] }> {
  const toNotes: string[] = [];
  if (door === 'to_secret') {
    const { current } = deps.keys().get();
    return {
      rows: values.map((v) => {
        const id = newId();
        const text = typeof v.value === 'string' ? v.value : JSON.stringify(v.value ?? '');
        return {
          subjectKind: v.subject_kind,
          subjectId: v.subject_id,
          id,
          ciphertext: seal(current, text, aadOf(id, field.key)),
          keyVersion: current.keyVersion,
        };
      }),
      toNotes,
    };
  }
  if (door === 'from_secret') {
    // Read as the caller: the reveal policy decides (kept.can_reveal_secret). Every value must be
    // one they may reveal, since making the field plain shows it to every member.
    const { rows: own } = await client.query<{
      id: string;
      thing_id: string | null;
      place_id: string | null;
      field_key: string;
      ciphertext: Sealed;
    }>(
      `SELECT id, thing_id, place_id, field_key, ciphertext FROM public.secret_values
        WHERE type_field_id = $1 AND superseded_at IS NULL AND ciphertext IS NOT NULL`,
      [field.id],
    );
    const bySubject = new Map(own.map((r) => [r.thing_id ?? r.place_id, r]));
    const keys = deps.keys();
    const rows: object[] = [];
    for (const v of values) {
      const row = bySubject.get(v.subject_id);
      if (!row) {
        throw forbidden(
          'Some values of this field are hidden from you by its reveal policy: allow yourself to reveal them first.',
        );
      }
      rows.push({
        subjectKind: v.subject_kind,
        subjectId: v.subject_id,
        value: await openValue(keys, row.ciphertext, row.id, row.field_key),
      });
    }
    return { rows, toNotes };
  }
  const to = body as KindBody;
  return {
    rows: values.map((v) => {
      const c = convertValue(v.value, to);
      if (!c.ok) {
        toNotes.push(v.subject_id);
        return { subjectKind: v.subject_kind, subjectId: v.subject_id, toNotes: true };
      }
      return { subjectKind: v.subject_kind, subjectId: v.subject_id, value: c.value };
    }),
    toNotes,
  };
}

/** POST /api/v1/type-fields/:id/convert (If-Match: the field's row version). */
export async function convertField(
  ctx: WriteCtx,
  deps: ConvertDeps,
  fieldId: string,
  expected: number,
  body: ConvertFieldBody,
): Promise<ConvertResult> {
  const { client } = ctx;
  const field = await ownedField(client, fieldId, true);
  if (field.row_version !== expected) {
    checkVersion(
      { rowVersion: field.row_version },
      expected,
      Object.keys(body),
      await lastChangedBy(client, 'type_field', fieldId),
    );
  }
  const door = doorOf(field, body);
  const accountId = field.owner_account_id as string;
  if (door === 'to_secret') {
    await requireRecoveryKit(client);
    const preview = await previewOf(client, fieldId, body);
    await requireSecretsOn(
      client,
      accountId,
      preview.locations.map((l) => l.id),
    );
  }

  const values = await allValues(client, fieldId);
  const { rows, toNotes } = await batchOf(client, deps, field, door, body, values);
  for (let at = 0; at === 0 || at < rows.length; at += PAGE) {
    const page = rows.slice(at, at + PAGE);
    await client.query('SELECT kept.apply_field_conversion($1, $2, $3, $4)', [
      fieldId,
      JSON.stringify(body),
      JSON.stringify(page),
      at + PAGE >= rows.length,
    ]);
  }
  // A value sent to the notes changes what the thing is embedded from (step-6 T14).
  for (const thingId of toNotes) await enqueueEmbed(ctx.jobs, client, thingId);

  const result: ConvertResult = {
    converted: rows.length - toNotes.length,
    toNotes: toNotes.length,
  };
  const after = 'toSecret' in body ? { secret: body.toSecret } : { kind: body.kind };
  await auditRegistry(ctx.tx, {
    accountId,
    userId: ctx.userId,
    action: 'type.field_convert',
    entity: { type: 'type_field', id: fieldId },
    before: { kind: field.kind, secret: field.secret, converted: null, to_notes: null },
    after: {
      kind: field.kind,
      secret: field.secret,
      ...after,
      converted: result.converted,
      to_notes: result.toNotes,
    },
    requestId: ctx.requestId,
  });
  return result;
}
