import type { Role } from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { actorOf } from '../audit/actor.js';
import { audited } from '../audit/audited.js';
import { undoableUntil } from '../audit/undo.js';
import type { Scope, Tx } from '../db/scope.js';
import { checkVersion } from '../http/conventions.js';
import { AppError, conflict, invalid, notFound, pgErrorOf } from '../http/errors.js';
import { legacyCodeOf } from '../imports/csv.js';
import { requireCan, requireMembership } from '../locations/access.js';
import { CODE_MAX, checkCodes, type FormatRule, RULE_LIMITS, vetRule } from './format-rule.js';

// Own codes (T17a, D208; engineering spec §1.10, §7.16): the household's own identifiers for a
// thing or a place, kept in `legacy_codes` with `source = 'own'` (collection ''), so scan, search
// and the jump box resolve them like any legacy code. A thing or place may have several; each is
// unique in its location, whatever the source that holds it there (a CSV import's old code
// included). Adding, renaming and removing them is `things.edit`, audited as one undoable event
// per change on the thing or place (`thing.codes` / `place.codes`, the diff's `own_codes` the
// whole list before and after; codes/undo.ts reverses it).
//
// A location's options (own_code_settings, `location.settings`):
// - numbering: `<prefix><counter>`, the counter zero-padded (kept.next_own_code(), 0046). A new
//   confirmed thing is numbered by a trigger; "Next number" here numbers an existing thing or
//   place;
// - the format rule (codes/format-rule.ts): checked on every add or rename here and on import;
//   changing it never rewrites a code, `mismatches()` lists those that no longer match.

export type Target = { kind: 'thing' | 'place'; id: string };

export type OwnCode = { code: string; source: string; sourceCollection: string };

export const CodeBody = z.union([
  z.strictObject({ code: z.string().min(1).max(200) }),
  z.strictObject({ next: z.literal(true) }),
]);

export const RenameBody = z.strictObject({ code: z.string().min(1).max(200) });

export const CodesView = z.object({
  /** Every legacy code on the thing or place, own codes first: only `own` ones are editable. */
  codes: z.array(z.object({ code: z.string(), source: z.string(), sourceCollection: z.string() })),
});

export const CodeResult = z.object({ code: z.string() });

type Ctx = { tx: Tx; client: pg.PoolClient; scope: Scope; requestId: string };

const actor = (scope: Scope) => actorOf(scope);

/** A live thing or place the caller sees, with its location; 404 otherwise. */
async function locate(client: pg.ClientBase, target: Target): Promise<string> {
  const table = target.kind === 'thing' ? 'things' : 'places';
  const { rows } = await client.query<{ location_id: string }>(
    `SELECT location_id FROM public.${table} WHERE id = $1 AND deleted_at IS NULL`,
    [target.id],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row.location_id;
}

const column = (target: Target) => (target.kind === 'thing' ? 'thing_id' : 'place_id');

/** The legacy codes on `target`, own codes first, then by source and code. */
async function codesOf(client: pg.ClientBase, target: Target): Promise<OwnCode[]> {
  const { rows } = await client.query<{
    code: string;
    source: string;
    source_collection: string;
  }>(
    `SELECT code, source, source_collection FROM public.legacy_codes
      WHERE ${column(target)} = $1
      ORDER BY source <> 'own', source, source_collection, code`,
    [target.id],
  );
  return rows.map((r) => ({
    code: r.code,
    source: r.source,
    sourceCollection: r.source_collection,
  }));
}

/** The own codes on `target`, sorted: the audited list. */
export async function ownCodesOf(client: pg.ClientBase, target: Target): Promise<string[]> {
  return (await codesOf(client, target))
    .filter((c) => c.source === 'own')
    .map((c) => c.code)
    .sort();
}

export async function listCodes(client: pg.ClientBase, target: Target) {
  await locate(client, target);
  return { codes: await codesOf(client, target) };
}

// ---------------------------------------------------------------------------------------------
// The location's options
// ---------------------------------------------------------------------------------------------

export type OwnCodeSettings = {
  numbering: { enabled: boolean; prefix: string; pad: number };
  rule: FormatRule | null;
};

const NumberingSchema = z.strictObject({
  enabled: z.boolean(),
  prefix: z.string().max(40),
  pad: z.number().int().min(1).max(8),
});
const RuleSchema = z.strictObject({
  pattern: z.string().min(1).max(RULE_LIMITS.pattern),
  message: z.string().trim().min(1).max(RULE_LIMITS.message),
  example: z.string().trim().min(1).max(RULE_LIMITS.example),
});

export const SettingsBody = z.strictObject({
  numbering: NumberingSchema,
  rule: RuleSchema.nullable(),
});

export const SettingsView = z.object({
  locationId: z.uuid(),
  numbering: z.object({
    enabled: z.boolean(),
    prefix: z.string(),
    pad: z.number().int(),
    /** The code the next numbered thing gets (a code already taken is skipped then). */
    next: z.string(),
  }),
  rule: z.object({ pattern: z.string(), message: z.string(), example: z.string() }).nullable(),
  /** 0 before the options were first saved; send it back as If-Match. */
  rowVersion: z.number().int(),
});
export type SettingsView = z.infer<typeof SettingsView>;

type SettingsRow = {
  numbering: boolean;
  prefix: string;
  pad: number;
  rule_pattern: string | null;
  rule_message: string | null;
  rule_example: string | null;
  row_version: number;
};

async function settingsRow(client: pg.ClientBase, locationId: string) {
  const { rows } = await client.query<SettingsRow>(
    `SELECT numbering, prefix, pad, rule_pattern, rule_message, rule_example, row_version
       FROM public.own_code_settings WHERE location_id = $1`,
    [locationId],
  );
  return rows[0] ?? null;
}

const ruleOf = (r: SettingsRow | null): FormatRule | null =>
  r?.rule_pattern && r.rule_message && r.rule_example
    ? { pattern: r.rule_pattern, message: r.rule_message, example: r.rule_example }
    : null;

/** `<prefix><n>`, n zero-padded to `pad` digits (never cut: as kept.next_own_code()). */
export const numbered = (prefix: string, pad: number, n: number) =>
  `${prefix}${String(n).padStart(pad, '0')}`;

/** The location's own-code options, for any member. */
export async function readSettings(
  client: pg.ClientBase,
  locationId: string,
): Promise<SettingsView> {
  await requireMembership(client, locationId);
  const row = await settingsRow(client, locationId);
  const prefix = row?.prefix ?? '';
  const pad = row?.pad ?? 4;
  const { rows } = await client.query<{ last_number: number }>(
    'SELECT last_number FROM public.own_code_counters WHERE location_id = $1 AND prefix = $2',
    [locationId, prefix],
  );
  return {
    locationId,
    numbering: {
      enabled: row?.numbering ?? false,
      prefix,
      pad,
      next: numbered(prefix, pad, (rows[0]?.last_number ?? 0) + 1),
    },
    rule: ruleOf(row),
    rowVersion: row?.row_version ?? 0,
  };
}

/** A code as stored (`upper(btrim())`, Eastern digits folded), or 400. */
export function codeOf(value: string, what = 'code'): string {
  const code = legacyCodeOf(value);
  if (code.length === 0) throw invalid(`The ${what} is empty.`);
  if (code.length > CODE_MAX) throw invalid(`The ${what} is longer than ${CODE_MAX} characters.`);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters
  if (/[\u0000-\u001f\u007f]/.test(code)) throw invalid(`The ${what} has a control character.`);
  return code;
}

/** 400 with the owner's message when `code` breaks the location's rule (`rule` given). */
export function requireRule(rule: FormatRule | null, code: string): void {
  if (!rule) return;
  const [verdict] = checkCodes(rule, [code]);
  if (verdict === 'ok') return;
  throw new AppError(
    'validation',
    400,
    verdict === 'slow' ? 'The format rule took too long to check this code.' : rule.message,
    { rule: { message: rule.message, example: rule.example }, reason: verdict },
  );
}

/** PUT the options: owners and admins; If-Match the row version (0 before the first save). */
export async function writeSettings(
  c: Ctx,
  locationId: string,
  body: z.infer<typeof SettingsBody>,
  expected: number,
): Promise<SettingsView> {
  const { role } = await requireMembership(c.client, locationId);
  requireCan(role, 'location.settings');
  const before = await settingsRow(c.client, locationId);
  checkVersion({ rowVersion: before?.row_version ?? 0 }, expected, ['numbering', 'rule']);

  const prefix = body.numbering.prefix.trim() === '' ? '' : codeOf(body.numbering.prefix, 'prefix');
  if (prefix.length > 20) throw invalid('The prefix is longer than 20 characters.');
  let rule: FormatRule | null = null;
  if (body.rule) {
    rule = {
      pattern: body.rule.pattern,
      message: body.rule.message.trim(),
      example: body.rule.example.trim(),
    };
    const vet = vetRule(rule);
    if (!vet.ok) throw new AppError('validation', 400, vet.hint, { reason: vet.reason });
  }
  if (body.numbering.enabled && rule) {
    // The numbering's codes must pass the rule, or every new thing would carry a code it breaks.
    const { rows } = await c.client.query<{ last_number: number }>(
      'SELECT last_number FROM public.own_code_counters WHERE location_id = $1 AND prefix = $2',
      [locationId, prefix],
    );
    const next = numbered(prefix, body.numbering.pad, (rows[0]?.last_number ?? 0) + 1);
    if (checkCodes(rule, [next])[0] !== 'ok') {
      throw new AppError(
        'validation',
        400,
        `The numbering's next code, ${next}, doesn't match the format rule.`,
        { reason: 'numbering', next },
      );
    }
  }

  const image = (r: {
    numbering: boolean;
    prefix: string;
    pad: number;
    rule_pattern: string | null;
    rule_message: string | null;
    rule_example: string | null;
  }) => ({
    numbering: r.numbering,
    prefix: r.prefix,
    pad: r.pad,
    rule_pattern: r.rule_pattern,
    rule_message: r.rule_message,
    rule_example: r.rule_example,
  });
  const after = {
    numbering: body.numbering.enabled,
    prefix,
    pad: body.numbering.pad,
    rule_pattern: rule?.pattern ?? null,
    rule_message: rule?.message ?? null,
    rule_example: rule?.example ?? null,
  };
  await c.client.query(
    `INSERT INTO public.own_code_settings (location_id, numbering, prefix, pad, rule_pattern,
                                           rule_message, rule_example)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (location_id) DO UPDATE
       SET numbering = EXCLUDED.numbering, prefix = EXCLUDED.prefix, pad = EXCLUDED.pad,
           rule_pattern = EXCLUDED.rule_pattern, rule_message = EXCLUDED.rule_message,
           rule_example = EXCLUDED.rule_example`,
    [
      locationId,
      after.numbering,
      after.prefix,
      after.pad,
      after.rule_pattern,
      after.rule_message,
      after.rule_example,
    ],
  );
  await audited(c.tx, {
    locationId,
    actor: actor(c.scope),
    action: 'location.own_codes',
    entity: { type: 'location', id: locationId },
    before: before ? image(before) : null,
    after,
    requestId: c.requestId,
  });
  return readSettings(c.client, locationId);
}

export const MismatchesView = z.object({
  rule: z.object({ pattern: z.string(), message: z.string(), example: z.string() }).nullable(),
  items: z.array(
    z.object({
      code: z.string(),
      kind: z.enum(['thing', 'place']),
      id: z.uuid(),
      name: z.string(),
      /** `slow`: the rule couldn't check it in time. */
      reason: z.enum(['mismatch', 'slow']),
    }),
  ),
});

/** The own codes of the location that don't match its rule now (changing a rule rewrites
 * nothing, D208). At most 500, by code. */
export async function mismatches(client: pg.ClientBase, locationId: string) {
  await requireMembership(client, locationId);
  const rule = ruleOf(await settingsRow(client, locationId));
  if (!rule) return { rule: null, items: [] };
  const { rows } = await client.query<{
    code: string;
    thing_id: string | null;
    place_id: string | null;
    name: string | null;
  }>(
    `SELECT g.code, t.id AS thing_id, p.id AS place_id, coalesce(t.name, p.name) AS name
       FROM public.legacy_codes g
       LEFT JOIN public.things t ON t.id = g.thing_id AND t.deleted_at IS NULL
       LEFT JOIN public.places p ON p.id = g.place_id AND p.deleted_at IS NULL
      WHERE g.location_id = $1 AND g.source = 'own' AND (t.id IS NOT NULL OR p.id IS NOT NULL)
      ORDER BY g.code`,
    [locationId],
  );
  const verdicts = checkCodes(
    rule,
    rows.map((r) => r.code),
  );
  const items: z.infer<typeof MismatchesView>['items'] = [];
  rows.forEach((r, i) => {
    const v = verdicts[i];
    if (v === 'ok' || v === undefined || items.length >= 500) return;
    items.push({
      code: r.code,
      kind: r.thing_id ? 'thing' : 'place',
      id: (r.thing_id ?? r.place_id) as string,
      name: r.name ?? '',
      reason: v,
    });
  });
  return { rule, items };
}

// ---------------------------------------------------------------------------------------------
// Adding, renaming, removing
// ---------------------------------------------------------------------------------------------

/** 409 when the location already has `code` under any source; says on what, when visible. */
async function requireFree(client: pg.ClientBase, locationId: string, code: string) {
  const { rows } = await client.query<{ thing_id: string | null; place_id: string | null }>(
    `SELECT thing_id, place_id FROM public.legacy_codes
      WHERE location_id = $1 AND code = $2 LIMIT 1`,
    [locationId, code],
  );
  const taken = rows[0];
  if (!taken) return;
  throw new AppError('conflict', 409, `${code} is already on something else here.`, {
    taken: taken.thing_id
      ? { kind: 'thing', id: taken.thing_id }
      : { kind: 'place', id: taken.place_id },
  });
}

/** Inserts one own code; a racing insert of the same code is the same 409. */
async function insertCode(c: Ctx, locationId: string, target: Target, code: string) {
  await c.client.query('SAVEPOINT own_code');
  try {
    await c.client.query(
      `INSERT INTO public.legacy_codes (location_id, source, source_collection, code, ${column(target)})
       VALUES ($1, 'own', '', $2, $3)`,
      [locationId, code, target.id],
    );
    await c.client.query('RELEASE SAVEPOINT own_code');
  } catch (err) {
    await c.client.query('ROLLBACK TO SAVEPOINT own_code');
    if (pgErrorOf(err)?.code === '23505') {
      throw conflict(`${code} is already on something else here.`);
    }
    throw err;
  }
}

async function writable(c: Ctx, target: Target): Promise<{ locationId: string; role: Role }> {
  const locationId = await locate(c.client, target);
  const { role } = await requireMembership(c.client, locationId);
  requireCan(role, 'things.edit');
  return { locationId, role };
}

/** One audited change of the own codes: the whole list before and after. */
async function auditChange(c: Ctx, locationId: string, target: Target, before: string[]) {
  const after = await ownCodesOf(c.client, target);
  await audited(c.tx, {
    locationId,
    actor: actor(c.scope),
    action: `${target.kind}.codes`,
    entity: { type: target.kind, id: target.id },
    before: { own_codes: before },
    after: { own_codes: after },
    ...(target.kind === 'thing' ? { rootThingId: target.id, subjects: [target.id] } : {}),
    requestId: c.requestId,
    undoableUntil: undoableUntil(),
  });
}

/** POST …/codes: a typed code (checked against the rule), or the next number. */
export async function addCode(c: Ctx, target: Target, body: z.infer<typeof CodeBody>) {
  const { locationId } = await writable(c, target);
  const before = await ownCodesOf(c.client, target);
  let code: string;
  if ('next' in body) {
    const { rows } = await c.client.query<{ code: string | null }>(
      'SELECT kept.next_own_code($1) AS code',
      [locationId],
    );
    const next = rows[0]?.code;
    if (!next) throw conflict("This location doesn't number its codes. Turn numbering on first.");
    code = next;
  } else {
    code = codeOf(body.code);
    requireRule(ruleOf(await settingsRow(c.client, locationId)), code);
    await requireFree(c.client, locationId, code);
  }
  await insertCode(c, locationId, target, code);
  await auditChange(c, locationId, target, before);
  return { code };
}

async function requireOwn(c: Ctx, target: Target, raw: string): Promise<string> {
  const code = legacyCodeOf(raw);
  const { rowCount } = await c.client.query(
    `SELECT 1 FROM public.legacy_codes
      WHERE ${column(target)} = $1 AND source = 'own' AND code = $2`,
    [target.id, code],
  );
  if (!rowCount) throw notFound();
  return code;
}

/** PUT …/codes/:code: one own code renamed (a delete and an insert: the code is the key). */
export async function renameCode(
  c: Ctx,
  target: Target,
  raw: string,
  body: z.infer<typeof RenameBody>,
) {
  const { locationId } = await writable(c, target);
  const old = await requireOwn(c, target, raw);
  const code = codeOf(body.code);
  if (code === old) return { code };
  const before = await ownCodesOf(c.client, target);
  requireRule(ruleOf(await settingsRow(c.client, locationId)), code);
  await requireFree(c.client, locationId, code);
  await c.client.query(
    `DELETE FROM public.legacy_codes
      WHERE location_id = $1 AND source = 'own' AND source_collection = '' AND code = $2`,
    [locationId, old],
  );
  await insertCode(c, locationId, target, code);
  await auditChange(c, locationId, target, before);
  return { code };
}

/** DELETE …/codes/:code. The number it held is never given out again (the counter moves on). */
export async function removeCode(c: Ctx, target: Target, raw: string): Promise<void> {
  const { locationId } = await writable(c, target);
  const code = await requireOwn(c, target, raw);
  const before = await ownCodesOf(c.client, target);
  await c.client.query(
    `DELETE FROM public.legacy_codes
      WHERE location_id = $1 AND source = 'own' AND source_collection = '' AND code = $2`,
    [locationId, code],
  );
  await auditChange(c, locationId, target, before);
}
