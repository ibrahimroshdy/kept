import { can, newId, type Role } from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { audited } from '../audit/audited.js';
import { CryptoError, open, type Sealed, seal } from '../crypto/envelope.js';
import type { SecretKeys } from '../crypto/keyring.js';
import type { Scope, Tx } from '../db/scope.js';
import { AppError, forbidden, invalid, notFound } from '../http/errors.js';
import { requireMembership } from '../locations/access.js';
import { findPlace, placeKindOf } from '../places/view.js';
import { gateFor } from '../serialize/gates.js';
import { resolvedFields } from '../things/fields.js';

// Secret values, reveal and policies (plan T19; D13, D110, D116, D175, D177, D182, D193;
// engineering spec §7.3, §7.13; screens §8). Every function runs in the request's scoped kept_app
// transaction, so each write commits with its audit row.
//
// - A value lives only in `secret_values`, sealed with envelope encryption. Its AAD binds it to
//   its own row and field, `secret_values|<row id>|<field key>`, so a ciphertext copied onto
//   another row or field fails to open instead of showing its value there.
// - Writing needs `things.edit` (members and up) and the recovery kit acknowledged (D193, plan
//   Q24). The row is inserted without RETURNING: under the default policy a member may write a
//   value they can't read back, and the supersede trigger (0020) ends the old one for them.
// - Revealing selects the row under its RLS policy (kept.can_reveal_secret: owner and admin by
//   default, widened per field and location by roles or named people). A value that isn't set
//   and one the caller may not reveal are the same 404. A viewer reveals only what a policy
//   names them for (screens §8, "a secret's Reveal only if that field's policy names the
//   viewer").
// - The audit never holds a value (D110): a set or clear is `{changed: true}` under the field's
//   key; a reveal or a copy names the value's row (`secret_value`), whose field it is.
// - Nothing here logs; a value leaves the server only in the reveal response.

export type Ctx = { tx: Tx; client: pg.PoolClient; scope: Scope; requestId: string };

export type SubjectKind = 'thing' | 'place';

/** A live thing or place the caller can see, with the secret field `fieldKey` resolves to. */
export type Subject = {
  kind: SubjectKind;
  id: string;
  locationId: string;
  field: { id: string; key: string };
};

const AAD_TABLE = 'secret_values';
/** How long a revealed value stays on screen (D175, screens §8). */
export const REVEAL_SECONDS = 30;
/** The longest value accepted: a recovery code or a key file's contents, not a document. */
export const MAX_SECRET_CHARS = 4096;

const actor = (scope: Scope) => ({ type: 'user' as const, id: scope.userId });

export const aadOf = (rowId: string, fieldKey: string) => ({
  table: AAD_TABLE,
  rowId,
  fieldKey,
});

// ---------------------------------------------------------------------------------------------
// Subjects
// ---------------------------------------------------------------------------------------------

/**
 * The thing or place `id` and its secret field `fieldKey`: 404 when the caller can't see a live
 * one, or when its type (a thing) or place kind (a place) resolves no live secret field of that
 * key. A field only archived still has its value, but takes no new one and reveals none.
 */
export async function subjectOf(
  client: pg.ClientBase,
  kind: SubjectKind,
  id: string,
  fieldKey: string,
): Promise<Subject> {
  if (kind === 'thing') {
    const { rows } = await client.query<{ location_id: string; type_id: string | null }>(
      'SELECT location_id, type_id FROM public.things WHERE id = $1 AND deleted_at IS NULL',
      [id],
    );
    const thing = rows[0];
    if (!thing) throw notFound();
    const field = (await resolvedFields(client, thing.type_id)).find(
      (f) => f.key === fieldKey && f.secret && f.archivedAt === null,
    );
    if (!field) throw notFound(`This thing's type has no secret field "${fieldKey}".`);
    return { kind, id, locationId: thing.location_id, field: { id: field.id, key: field.key } };
  }
  const place = await findPlace(client, id);
  if (!place) throw notFound();
  const placeKind = await placeKindOf(client, place.ownerAccountId, place.kindKey);
  const { rows } = await client.query<{ id: string; key: string }>(
    `SELECT f.id, f.key FROM public.type_fields f
      WHERE f.place_kind_id = $1 AND f.key = $2 AND f.secret AND f.archived_at IS NULL`,
    [placeKind?.id ?? null, fieldKey],
  );
  const field = rows[0];
  if (!field) throw notFound(`This place's kind has no secret field "${fieldKey}".`);
  return { kind, id, locationId: place.locationId, field };
}

/** The caller's role where the subject is, 403 unless they may edit it. */
async function requireWriter(ctx: Ctx, s: Subject): Promise<Role> {
  const { role } = await requireMembership(ctx.client, s.locationId);
  if (!can(role, 'things.edit')) {
    throw forbidden('You can view this location but not change it.');
  }
  return role;
}

/** 404 unless the secrets module is on where the subject is (the route's module gate says so
 * first; this keeps the service safe on its own). */
async function requireSecretsModule(ctx: Ctx, s: Subject): Promise<void> {
  const gate = await gateFor(ctx.tx, s.locationId, ctx.scope);
  if (!gate.showSecrets) throw new AppError('module_off', 409);
}

// ---------------------------------------------------------------------------------------------
// The recovery-kit gate (D193, plan Q24)
// ---------------------------------------------------------------------------------------------

const ADMIN_KIT_HINT =
  'Save the recovery kit first: run `kept admin recovery-kit` on the server, keep it somewhere else, then confirm it on the status page.';
const MEMBER_KIT_HINT =
  'Ask your instance admin to download the recovery kit. Until they have, secret values can’t be saved.';

/**
 * 409 `recovery_kit_required` until an instance admin has acknowledged the recovery kit: without
 * a copy of the key off the server, a backup can't restore the value being written. Checked on
 * every write (it is one indexed read, and once acknowledged it stays so).
 */
export async function requireRecoveryKit(client: pg.ClientBase): Promise<void> {
  const { rows } = await client.query<{ ok: boolean; admin: boolean }>(
    'SELECT kept.recovery_kit_acknowledged() AS ok, kept.is_instance_admin() AS admin',
  );
  const row = rows[0];
  if (row?.ok) return;
  throw new AppError('recovery_kit_required', 409, row?.admin ? ADMIN_KIT_HINT : MEMBER_KIT_HINT);
}

// ---------------------------------------------------------------------------------------------
// Set, clear, reveal, copied
// ---------------------------------------------------------------------------------------------

/** When the field's current value was written, or null when none is set. Never the value. */
async function currentSetAt(client: pg.ClientBase, s: Subject): Promise<string | null> {
  const { rows } = await client.query<{ field_key: string; updated_at: Date }>(
    `SELECT field_key, updated_at FROM kept.secret_fields_set($1, $2)`,
    s.kind === 'thing' ? [s.id, null] : [null, s.id],
  );
  const row = rows.find((r) => r.field_key === s.field.key);
  return row ? row.updated_at.toISOString() : null;
}

function auditSubject(s: Subject) {
  return {
    locationId: s.locationId,
    ...(s.kind === 'thing' ? { subjects: [s.id], rootThingId: s.id } : {}),
  };
}

/** PUT …/secrets/:fieldKey: seals `value` for a new row and supersedes the current one. */
export async function setSecret(
  ctx: Ctx,
  keys: SecretKeys,
  s: Subject,
  value: string,
): Promise<void> {
  await requireSecretsModule(ctx, s);
  await requireWriter(ctx, s);
  await requireRecoveryKit(ctx.client);
  if (value.length === 0 || value.length > MAX_SECRET_CHARS) {
    throw invalid(`A secret value is 1 to ${MAX_SECRET_CHARS} characters.`);
  }
  const before = await currentSetAt(ctx.client, s);
  const id = newId();
  const { current } = keys.get();
  const sealed = seal(current, value, aadOf(id, s.field.key));
  // No RETURNING: the new row is readable only by who may reveal it, and a member may not.
  await ctx.client.query(
    `INSERT INTO public.secret_values
       (id, location_id, thing_id, place_id, type_field_id, field_key, ciphertext, key_version,
        updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, kept.current_user_id())`,
    [
      id,
      s.locationId,
      s.kind === 'thing' ? s.id : null,
      s.kind === 'place' ? s.id : null,
      s.field.id,
      s.field.key,
      JSON.stringify(sealed),
      current.keyVersion,
    ],
  );
  // D110: `{changed: true}` under the field's key. The images hold when each value was written
  // (never a value), and the class makes audited() keep nothing of them anyway.
  await audited(ctx.tx, {
    ...auditSubject(s),
    actor: actor(ctx.scope),
    action: 'secret.set',
    entity: { type: s.kind, id: s.id },
    before: { [s.field.key]: before },
    after: { [s.field.key]: id },
    fieldClasses: { [s.field.key]: 'secret' },
    requestId: ctx.requestId,
  });
}

/** DELETE …/secrets/:fieldKey: ends the current value (kept.clear_secret, 0029). Clearing an
 * unset field changes nothing and writes no audit row. */
export async function clearSecret(ctx: Ctx, s: Subject): Promise<void> {
  await requireSecretsModule(ctx, s);
  await requireWriter(ctx, s);
  const { rows } = await ctx.client.query<{ cleared: boolean }>(
    'SELECT kept.clear_secret($1, $2, $3) AS cleared',
    s.kind === 'thing' ? [s.id, null, s.field.key] : [null, s.id, s.field.key],
  );
  if (!rows[0]?.cleared) return;
  await audited(ctx.tx, {
    ...auditSubject(s),
    actor: actor(ctx.scope),
    action: 'secret.clear',
    entity: { type: s.kind, id: s.id },
    before: { [s.field.key]: 'set' },
    after: { [s.field.key]: null },
    fieldClasses: { [s.field.key]: 'secret' },
    requestId: ctx.requestId,
  });
}

type ValueRow = { id: string; ciphertext: Sealed };

/** The current value's row, read under the reveal policy: 404 when unset or not permitted. */
async function revealableRow(ctx: Ctx, s: Subject): Promise<ValueRow> {
  await requireSecretsModule(ctx, s);
  const { rows } = await ctx.client.query<ValueRow>(
    `SELECT id, ciphertext FROM public.secret_values
      WHERE ${s.kind === 'thing' ? 'thing_id' : 'place_id'} = $1
        AND field_key = $2 AND superseded_at IS NULL`,
    [s.id, s.field.key],
  );
  const row = rows[0];
  // Not set and not permitted look alike (the web mock's rule, plan T19).
  if (!row) throw notFound();
  return row;
}

/** Opens a sealed value; picks up a rotation made while this process runs (keyring.ts). */
async function openValue(keys: SecretKeys, row: ValueRow, fieldKey: string): Promise<string> {
  const aad = aadOf(row.id, fieldKey);
  try {
    return open(keys.get().keyring, row.ciphertext, aad).toString('utf8');
  } catch (err) {
    if (!(err instanceof CryptoError) || err.code !== 'crypto_key_missing') throw err;
    if (!(await keys.refresh())) throw err;
    return open(keys.get().keyring, row.ciphertext, aad).toString('utf8');
  }
}

export type RevealResult = { value: string; revealedUntil: string };

/** POST …/reveal: the value, shown for 30 s (D175), audited `secret.reveal` (D13). */
export async function revealSecret(ctx: Ctx, keys: SecretKeys, s: Subject): Promise<RevealResult> {
  const row = await revealableRow(ctx, s);
  const value = await openValue(keys, row, s.field.key);
  await audited(ctx.tx, {
    ...auditSubject(s),
    actor: actor(ctx.scope),
    action: 'secret.reveal',
    entity: { type: 'secret_value', id: row.id },
    requestId: ctx.requestId,
  });
  return { value, revealedUntil: new Date(Date.now() + REVEAL_SECONDS * 1000).toISOString() };
}

/** POST …/copied: the web copied a revealed value to the clipboard (screens §8). Audited only
 * for who may reveal it. */
export async function secretCopied(ctx: Ctx, s: Subject): Promise<void> {
  const row = await revealableRow(ctx, s);
  await audited(ctx.tx, {
    ...auditSubject(s),
    actor: actor(ctx.scope),
    action: 'secret.copied',
    entity: { type: 'secret_value', id: row.id },
    requestId: ctx.requestId,
  });
}

// ---------------------------------------------------------------------------------------------
// Policies (D116, D177): owner only, per location and field
// ---------------------------------------------------------------------------------------------

export const REVEAL_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;

export const SecretPolicySchema = z.object({
  revealRoles: z.array(z.enum(REVEAL_ROLES)),
  revealUserIds: z.array(z.uuid()),
  aiAllowed: z.boolean(),
});
export type SecretPolicy = z.infer<typeof SecretPolicySchema>;

/** The policy a field has before its owner sets one: owners and admins, no AI (D13, D116). */
export const DEFAULT_POLICY: SecretPolicy = Object.freeze({
  revealRoles: ['owner', 'admin'],
  revealUserIds: [],
  aiAllowed: false,
}) as SecretPolicy;

/** The owners and admins always reveal (D13: a policy only widens the default). */
const ALWAYS: readonly SecretPolicy['revealRoles'][number][] = ['owner', 'admin'];

type PolicyRow = { reveal_roles: string[]; reveal_user_ids: string[]; ai_allowed: boolean };

const policyOf = (r: PolicyRow): SecretPolicy => ({
  revealRoles: REVEAL_ROLES.filter((x) => r.reveal_roles.includes(x)),
  revealUserIds: [...r.reveal_user_ids].sort(),
  aiAllowed: r.ai_allowed,
});

/**
 * The location's owner, and a secret field that can hold values there (built in, or of the
 * location's account). 404 for anyone who can't see the location; for GET, 404 for anyone but
 * the owner too (the mock's rule: the policy is the owner's business), for PUT a 403.
 */
async function requirePolicyField(
  client: pg.ClientBase,
  locationId: string,
  fieldId: string,
  onNotOwner: 'hide' | 'forbid',
): Promise<void> {
  const { role } = await requireMembership(client, locationId);
  if (!can(role, 'secrets.set-policy')) {
    if (onNotOwner === 'hide') throw notFound();
    throw forbidden('Only the owner of this location sets who can reveal its secret fields.');
  }
  const { rows } = await client.query<{ id: string }>(
    `SELECT f.id FROM public.type_fields f, public.locations l
      WHERE f.id = $1 AND l.id = $2 AND f.secret
        AND (f.owner_account_id IS NULL OR f.owner_account_id = l.owner_account_id)`,
    [fieldId, locationId],
  );
  if (!rows[0]) throw notFound('No secret field with that id here.');
}

async function storedPolicy(
  client: pg.ClientBase,
  locationId: string,
  fieldId: string,
): Promise<SecretPolicy | null> {
  const { rows } = await client.query<PolicyRow>(
    `SELECT reveal_roles, reveal_user_ids, ai_allowed FROM public.secret_field_policies
      WHERE location_id = $1 AND type_field_id = $2`,
    [locationId, fieldId],
  );
  return rows[0] ? policyOf(rows[0]) : null;
}

/** GET /api/v1/locations/:locationId/secret-policies/:typeFieldId. */
export async function getPolicy(
  client: pg.ClientBase,
  locationId: string,
  fieldId: string,
): Promise<SecretPolicy> {
  await requirePolicyField(client, locationId, fieldId, 'hide');
  return (await storedPolicy(client, locationId, fieldId)) ?? DEFAULT_POLICY;
}

/** PUT …: sets the policy. Owners and admins stay on it; named people must be members. */
export async function putPolicy(
  ctx: Ctx,
  locationId: string,
  fieldId: string,
  body: SecretPolicy,
): Promise<SecretPolicy> {
  await requirePolicyField(ctx.client, locationId, fieldId, 'forbid');
  const roles = REVEAL_ROLES.filter((r) => ALWAYS.includes(r) || body.revealRoles.includes(r));
  const userIds = [...new Set(body.revealUserIds.map((u) => u.toLowerCase()))].sort();
  if (userIds.length > 0) {
    const { rows } = await ctx.client.query<{ user_id: string }>(
      `SELECT m.user_id FROM public.memberships m
        WHERE m.location_id = $1 AND m.user_id = ANY ($2::uuid[])
          AND (m.expires_at IS NULL OR m.expires_at > now())`,
      [locationId, userIds],
    );
    if (rows.length !== userIds.length) {
      throw invalid('Everyone named on a policy must be a member of this location.');
    }
  }
  const before = await storedPolicy(ctx.client, locationId, fieldId);
  const { rows } = await ctx.client.query<PolicyRow>(
    `INSERT INTO public.secret_field_policies
       (location_id, type_field_id, reveal_roles, reveal_user_ids, ai_allowed)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (location_id, type_field_id) DO UPDATE
       SET reveal_roles = EXCLUDED.reveal_roles, reveal_user_ids = EXCLUDED.reveal_user_ids,
           ai_allowed = EXCLUDED.ai_allowed
     RETURNING reveal_roles, reveal_user_ids, ai_allowed`,
    [locationId, fieldId, roles, userIds, body.aiAllowed],
  );
  const after = policyOf(rows[0] as PolicyRow);
  const image = (p: SecretPolicy) => ({
    reveal_roles: p.revealRoles,
    reveal_user_ids: p.revealUserIds,
    ai_allowed: p.aiAllowed,
  });
  await audited(ctx.tx, {
    locationId,
    actor: actor(ctx.scope),
    action: 'secret_policy.update',
    entity: { type: 'secret_field_policy', id: fieldId },
    before: image(before ?? DEFAULT_POLICY),
    after: image(after),
    requestId: ctx.requestId,
  });
  return after;
}
