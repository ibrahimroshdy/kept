/**
 * What an extraction writes (plan T10; D18, D19, D36, D41, D150, D196; engineering spec §6.8,
 * §7.8; Q4, Q11, Q14). Runs in one scoped transaction as the capturing person (Q4), after the
 * code checks (checks.ts), with one audit event.
 *
 * THING, and LABEL on a thing:
 * - **Auto-accepted** (D19): name, brand (through `kept.ai_ensure_brand`, the only way a member
 *   makes a brand), model, colour and type (the type hint matched against the account's types and
 *   the built-in library's English and Arabic names through `normalize`; never a new type), when
 *   the thing's value is empty or was itself filled in by AI. A value a person typed, or one
 *   already confirmed, is never overwritten. LABEL fills brand and model only.
 * - Aliases (D41) are merged per language into the thing's own, deduplicated: those in
 *   Latin-script languages. An alias in any other script (Arabic) is a suggestion instead, at most
 *   one per language, `alias_<lang>` (D214; checks.ts `scriptAliases`), unless the thing has it.
 * - Each applied field gets `field_status[field] = {state: 'extracted', confidence,
 *   extraction_id}`.
 * - **Suggestions** wait in the inbox, in the web's shape (`Suggestion`, apps/web/src/api/capture/
 *   types.ts): `serial`, `quantity` above 1 and `alias_ar` (THING); `serial`, `vin`, `plate`,
 *   `expires_on` and `manufactured_on` (LABEL). Values are strings; dates `YYYY-MM-DD`.
 * - An inbox `draft` item is opened (or kept, with the suggestions in its payload) when the thing
 *   is a draft or suggestions wait (Q14).
 * - A re-run replaces the draft's extracted fields: what a superseded attempt applied, and still
 *   holds, is put back first.
 *
 * RECEIPT: the draft purchase gets the date, the currency when the mark is unambiguous and
 * enabled, and (with a currency) the total, tax and lines as `purchase_lines`, whether or not the
 * money module is on (they are gated on the way out, not dropped). The vendor waits for review
 * (§7.8). The `receipt` item carries what was read; an ambiguous or unknown mark opens a
 * `currency` item with the options and no preselection (D189). A purchase a person has
 * confirmed meanwhile is left alone.
 *
 * READING: never applied (D19). The value becomes a `needs_review` reading (so the inbox's Keep,
 * Edit and Discard are step 2's reading actions), with the neighbours check's verdict (D112), and
 * a `reading` inbox item names it. A value that couldn't be read opens the item capture opens
 * with AI off (`needs_value`).
 */
import {
  aliasSuggestionField,
  BUILTIN_TYPES,
  type CaptureMode,
  newId,
  normalize,
} from '@kept/shared';
import type pg from 'pg';
import { actorOf } from '../audit/actor.js';
import { audited } from '../audit/audited.js';
import { undoableUntil } from '../audit/undo.js';
import type { Scope, Tx } from '../db/scope.js';
import { placementOf } from '../meters/service.js';
import { readImage, type ThingImage } from '../things/audit-image.js';
import { defaultMeterOf } from '../things/fields.js';
import type {
  Checked,
  LabelFields,
  ReadingFields,
  ReceiptFields,
  ThingFields,
  Val,
} from './checks.js';
import { cleanAliases, lineAmount } from './checks.js';

export type ApplyCtx = { tx: Tx; client: pg.PoolClient; scope: Scope; requestId: string };

/** An `extractions` row as the job reads it. */
export type ExtractionRow = {
  id: string;
  location_id: string;
  attachment_id: string;
  thing_id: string | null;
  purchase_id: string | null;
  meter_id: string | null;
  /** Step 5 (Q12): a draft service record's invoice, read on the RECEIPT path. */
  service_record_id: string | null;
  mode: CaptureMode;
  attempt: number;
  status: string;
  requested_by: string;
  created_at: Date;
};

/** A suggestion as the inbox shows it (web contract `Suggestion`). */
export type Suggestion = {
  field: string;
  value: unknown;
  confidence: number;
  source: { extractionId: string; attachmentId: string };
};

/** What `extractions.applied` records: each field written, with what it replaced. */
export type Applied = {
  fields?: Record<string, { before: unknown; after: unknown }>;
  /** THING: the default meter the type AI set brought (step 5). */
  meterId?: string;
  /** RECEIPT: the purchase lines this attempt added. */
  lineIds?: string[];
  /** READING: the needs-review reading this attempt made. */
  readingId?: string;
};

export type ApplyResult = {
  applied: Applied;
  suggestions: Suggestion[];
  /** Inbox items opened or updated. */
  inbox: string[];
  /** RECEIPT: re-crop the display to the paper (Q11), after the transaction. */
  crop?: { fileId: string; bbox: [number, number, number, number] };
  /** A service invoice (step 5): `total_mismatch`, `currency_unclear` (schedules/view.ts). */
  flags?: string[];
};

const actor = (scope: Scope) => actorOf(scope);

type FieldState = { state: string; confidence?: number; extraction_id?: string };

// ---------------------------------------------------------------------------------------------
// The inbox
// ---------------------------------------------------------------------------------------------

type InboxUpsert = {
  locationId: string;
  kind: 'draft' | 'receipt' | 'reading' | 'currency' | 'duplicate';
  thingId?: string | null;
  purchaseId?: string | null;
  meterReadingId?: string | null;
  otherThingId?: string | null;
  extractionId: string;
  batchId: string | null;
  payload: Record<string, unknown>;
};

/**
 * Opens an item, or merges `payload` into the open one for the same kind and subject
 * (`inbox_open_subject_uq` allows one). Its `extraction_id` is the attempt that opened it; the
 * payload's `extractionId` names the latest one.
 */
export async function upsertInbox(client: pg.ClientBase, item: InboxUpsert): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO public.inbox_items (id, location_id, kind, thing_id, purchase_id, meter_reading_id,
                                     other_thing_id, extraction_id, batch_id, created_by, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, kept.current_user_id(), $10)
     ON CONFLICT (kind, (coalesce(thing_id, purchase_id, meter_reading_id)),
                  (coalesce(other_thing_id, '00000000-0000-0000-0000-000000000000'::uuid)),
                  (coalesce(code, '')))
       WHERE resolved_at IS NULL
     DO UPDATE SET payload = public.inbox_items.payload || EXCLUDED.payload
     RETURNING id`,
    [
      newId(),
      item.locationId,
      item.kind,
      item.thingId ?? null,
      item.purchaseId ?? null,
      item.meterReadingId ?? null,
      item.otherThingId ?? null,
      item.extractionId,
      item.batchId,
      JSON.stringify({ ...item.payload, extractionId: item.extractionId }),
    ],
  );
  return (rows[0] as { id: string }).id;
}

// ---------------------------------------------------------------------------------------------
// Types and brands
// ---------------------------------------------------------------------------------------------

const BUILTIN_BY_NAME: ReadonlyMap<string, string> = (() => {
  const out = new Map<string, string>();
  for (const t of BUILTIN_TYPES) {
    if (t.isFieldGroup) continue;
    const names = [t.key.replace(/_/g, ' '), t.names.en, t.names.ar];
    for (const n of names) {
      for (const part of [n, ...n.split('/')]) {
        const key = normalize(part);
        if (key && !out.has(key)) out.set(key, t.key);
      }
    }
  }
  return out;
})();

/**
 * The type a hint names, or null: the account's own types first, then the built-in library (the
 * account's customised copy of a built-in when it has one). Never creates a type.
 */
export async function matchType(
  client: pg.ClientBase,
  ownerAccountId: string,
  hint: string,
): Promise<string | null> {
  const key = normalize(hint);
  if (!key) return null;
  const { rows: own } = await client.query<{ id: string; name: string }>(
    `SELECT id, name FROM public.types
      WHERE owner_account_id = $1 AND name IS NOT NULL AND archived_at IS NULL
        AND NOT is_field_group`,
    [ownerAccountId],
  );
  const mine = own.find((t) => normalize(t.name) === key);
  if (mine) return mine.id;
  const builtinKey = BUILTIN_BY_NAME.get(key);
  if (!builtinKey) return null;
  const { rows } = await client.query<{ id: string; copy_id: string | null }>(
    `SELECT b.id,
            (SELECT c.id FROM public.types c
              WHERE c.owner_account_id = $2 AND c.copied_from_id = b.id AND c.archived_at IS NULL
              ORDER BY c.created_at LIMIT 1) AS copy_id
       FROM public.types b
      WHERE b.builtin_key = $1 AND b.owner_account_id IS NULL`,
    [builtinKey, ownerAccountId],
  );
  const r = rows[0];
  return r ? (r.copy_id ?? r.id) : null;
}

async function ensureBrand(
  client: pg.ClientBase,
  locationId: string,
  name: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>('SELECT kept.ai_ensure_brand($1, $2) AS id', [
    locationId,
    name,
  ]);
  return (rows[0] as { id: string }).id;
}

// ---------------------------------------------------------------------------------------------
// THING and LABEL
// ---------------------------------------------------------------------------------------------

type ThingState = {
  id: string;
  location_id: string;
  owner_account_id: string;
  name: string | null;
  brand_id: string | null;
  model: string | null;
  colour: string | null;
  type_id: string | null;
  serial: string | null;
  quantity: string;
  expires_on: string | null;
  custom: Record<string, unknown>;
  aliases: Record<string, string[]>;
  field_status: Record<string, FieldState>;
  review_state: string;
  capture_batch_id: string | null;
};

async function lockThing(client: pg.ClientBase, id: string): Promise<ThingState | null> {
  const { rows } = await client.query<ThingState>(
    `SELECT t.id, t.location_id, l.owner_account_id, t.name, t.brand_id, t.model, t.colour,
            t.type_id, t.serial, t.quantity::text AS quantity, t.expires_on::text AS expires_on,
            t.custom, t.aliases, t.field_status, t.review_state, t.capture_batch_id
       FROM public.things t JOIN public.locations l ON l.id = t.location_id
      WHERE t.id = $1 AND t.deleted_at IS NULL
      FOR UPDATE OF t`,
    [id],
  );
  return rows[0] ?? null;
}

/** Column per auto-accepted field. */
const COLUMN: Readonly<Record<string, string>> = Object.freeze({
  name: 'name',
  brand: 'brand_id',
  model: 'model',
  colour: 'colour',
  type: 'type_id',
});

/** Puts back what superseded attempts applied, where the thing still holds their values. */
async function revertSuperseded(
  client: pg.ClientBase,
  thing: ThingState,
  current: string,
  sets: Map<string, unknown>,
  status: Record<string, FieldState>,
): Promise<void> {
  const { rows } = await client.query<{ id: string; applied: Applied }>(
    `SELECT id, applied FROM public.extractions
      WHERE thing_id = $1 AND id <> $2 AND status = 'superseded' AND applied ? 'fields'`,
    [thing.id, current],
  );
  for (const old of rows) {
    for (const [field, change] of Object.entries(old.applied.fields ?? {})) {
      const column = COLUMN[field];
      if (!column || status[field]?.extraction_id !== old.id) continue;
      sets.set(column, change.before ?? null);
      delete status[field];
    }
    await client.query(`UPDATE public.extractions SET applied = '{}'::jsonb WHERE id = $1`, [
      old.id,
    ]);
  }
}

/** Whether AI may write `field`: the thing's value is empty, or AI wrote it. */
function writable(thing: ThingState, status: Record<string, FieldState>, field: string): boolean {
  const column = COLUMN[field] as keyof ThingState;
  const now = thing[column];
  return now === null || status[field]?.state === 'extracted';
}

async function applyToThing(
  ctx: ApplyCtx,
  ex: ExtractionRow,
  thingId: string,
  mode: 'thing' | 'label',
  fields: ThingFields | LabelFields,
  sentAttachmentId: string,
): Promise<ApplyResult> {
  const { client, tx, scope } = ctx;
  const out: ApplyResult = { applied: {}, suggestions: [], inbox: [] };
  const thing = await lockThing(client, thingId);
  if (!thing) return out;
  const before = (await readImage(client, thing.id)) as ThingImage;
  const status: Record<string, FieldState> = { ...(thing.field_status ?? {}) };
  const sets = new Map<string, unknown>();
  await revertSuperseded(client, thing, ex.id, sets, status);
  // What the thing holds once reverted, for the "empty or AI-written" rule.
  const effective: ThingState = { ...thing };
  for (const [column, value] of sets) (effective as Record<string, unknown>)[column] = value;

  const changes: Record<string, { before: unknown; after: unknown }> = {};
  const put = async (field: string, v: Val<string> | undefined) => {
    if (!v || !writable(effective, status, field)) return;
    const column = COLUMN[field] as string;
    let value: string | null = v.value;
    if (field === 'brand') value = await ensureBrand(client, thing.location_id, v.value);
    if (field === 'type') {
      // A type is set only on a thing without one: changing a type re-files custom fields (the
      // PATCH's retype), which is a person's decision.
      if (effective.type_id !== null) return;
      value = await matchType(client, thing.owner_account_id, v.value);
      if (!value) return;
    }
    const prior = (effective as Record<string, unknown>)[column] ?? null;
    if (prior === value) {
      status[field] = { state: 'extracted', confidence: v.confidence, extraction_id: ex.id };
      return;
    }
    sets.set(column, value);
    changes[field] = { before: prior, after: value };
    status[field] = { state: 'extracted', confidence: v.confidence, extraction_id: ex.id };
  };

  const suggest = (field: string, v: Val<string | number> | undefined, current?: unknown) => {
    if (!v) return;
    const value = String(v.value);
    if (current !== undefined && current !== null && String(current) === value) return;
    out.suggestions.push({
      field,
      value,
      confidence: v.confidence,
      source: { extractionId: ex.id, attachmentId: sentAttachmentId },
    });
  };

  if (mode === 'thing') {
    const f = fields as ThingFields;
    await put('name', f.name);
    await put('brand', f.brand);
    await put('model', f.model);
    await put('colour', f.colour);
    await put('type', f.typeHint);
    if (Object.keys(f.aliases).length > 0) {
      const merged = cleanAliases(
        mergeAliases(effective.aliases ?? {}, f.aliases),
        Object.keys({ ...(effective.aliases ?? {}), ...f.aliases }),
      );
      if (JSON.stringify(merged) !== JSON.stringify(effective.aliases ?? {})) {
        sets.set('aliases', JSON.stringify(merged));
        status.aliases = {
          state: 'extracted',
          confidence: f.name?.confidence ?? 0,
          extraction_id: ex.id,
        };
      }
    }
    suggest('serial', f.serial, effective.serial);
    if (f.quantity && f.quantity.value > 1) suggest('quantity', f.quantity, Number(thing.quantity));
    // D214: an Arabic alias waits for review, unless the thing already has it.
    for (const a of f.aliasSuggestions ?? []) {
      const have = (effective.aliases?.[a.lang] ?? []).map(normalize);
      if (have.includes(normalize(a.value))) continue;
      suggest(aliasSuggestionField(a.lang), { value: a.value, confidence: a.confidence });
    }
  } else {
    const f = fields as LabelFields;
    await put('brand', f.brand);
    await put('model', f.model);
    suggest('serial', f.serial, effective.serial);
    suggest('vin', f.vin, thing.custom?.vin);
    suggest('plate', f.plate, thing.custom?.plate);
    // Step 5 (Q15, D52): a vehicle's registration, insurance, licence or inspection card is a
    // document to keep, with its own expiry, not the car's `expires_on` (which stays for a fire
    // extinguisher, D141). Accepting it makes the expiring document (inbox/service.ts).
    const kind = f.documentKind?.value;
    if (
      f.expiresOn &&
      kind &&
      (VEHICLE_DOCUMENT_KINDS as readonly string[]).includes(kind) &&
      (await isVehicle(client, effective.type_id))
    ) {
      out.suggestions.push({
        field: 'document',
        value: { kind, expiresOn: f.expiresOn.value },
        confidence: Math.min(f.expiresOn.confidence, f.documentKind?.confidence ?? 1),
        source: { extractionId: ex.id, attachmentId: sentAttachmentId },
      });
    } else {
      suggest('expires_on', f.expiresOn, effective.expires_on);
    }
    suggest('manufactured_on', f.manufacturedOn);
  }

  if (sets.size > 0 || JSON.stringify(status) !== JSON.stringify(thing.field_status ?? {})) {
    const cols = [...sets.keys()];
    const values = [...sets.values()];
    const assignments = cols.map((c, i) => `${c} = $${i + 2}`);
    assignments.push(`field_status = $${cols.length + 2}`);
    await client.query(`UPDATE public.things SET ${assignments.join(', ')} WHERE id = $1`, [
      thing.id,
      ...values,
      JSON.stringify(status),
    ]);
  }
  // Step-3 carry-over: a type AI set brings its default meter (D113: a car starts with its
  // odometer), as a new thing of that type does (things/service.ts), when the thing has none and
  // is a single thing (things_quantity_one). Its id is in `applied`, so undoing the extraction
  // removes it while it has no readings (undo/registry.ts).
  const meter =
    changes.type && typeof changes.type.after === 'string' && Number(thing.quantity) === 1
      ? await addDefaultMeter(ctx, thing, changes.type.after)
      : null;
  out.applied = {
    ...(Object.keys(changes).length > 0 ? { fields: changes } : {}),
    ...(meter ? { meterId: meter.id } : {}),
  };

  const after = (await readImage(client, thing.id)) as ThingImage;
  await audited(tx, {
    locationId: thing.location_id,
    actor: actor(scope),
    action: 'thing.extract',
    entity: { type: 'thing', id: thing.id },
    before,
    after: meter ? { ...after, meter_created: meter } : after,
    rootThingId: thing.id,
    subjects: [thing.id],
    requestId: ctx.requestId,
    undoableUntil: Object.keys(changes).length > 0 ? undoableUntil() : null,
  });

  // Q14: a draft waits in the inbox; a named thing only when suggestions wait.
  if (thing.review_state === 'draft' || out.suggestions.length > 0) {
    out.inbox.push(
      await upsertInbox(client, {
        locationId: thing.location_id,
        kind: 'draft',
        thingId: thing.id,
        extractionId: ex.id,
        batchId: thing.capture_batch_id,
        payload: { suggestions: out.suggestions },
      }),
    );
  }
  return out;
}

/** The document kinds a vehicle's card suggests (Q15). */
const VEHICLE_DOCUMENT_KINDS = ['registration', 'insurance', 'licence', 'inspection'] as const;

async function isVehicle(client: pg.ClientBase, typeId: string | null): Promise<boolean> {
  if (!typeId) return false;
  const { rows } = await client.query<{ yes: boolean }>('SELECT kept.is_vehicle_type($1) AS yes', [
    typeId,
  ]);
  return rows[0]?.yes === true;
}

/** The type's default meter on a thing that has none (things/fields.ts defaultMeterOf), or null. */
async function addDefaultMeter(
  ctx: ApplyCtx,
  thing: ThingState,
  typeId: string,
): Promise<{ id: string; kind: string; unit: string } | null> {
  const { rowCount } = await ctx.client.query('SELECT 1 FROM public.meters WHERE thing_id = $1', [
    thing.id,
  ]);
  if (rowCount) return null;
  const meter = await defaultMeterOf(ctx.client, typeId);
  if (!meter) return null;
  const id = newId();
  await ctx.client.query(
    `INSERT INTO public.meters (id, location_id, thing_id, kind, unit) VALUES ($1, $2, $3, $4, $5)`,
    [id, thing.location_id, thing.id, meter.kind, meter.unit],
  );
  return { id, ...meter };
}

/** `into` with `add`'s keywords appended per language (cleanAliases dedupes and caps). */
function mergeAliases(
  into: Record<string, string[]>,
  add: Record<string, string[]>,
): Record<string, string[]> {
  const out: Record<string, string[]> = { ...into };
  for (const [lang, list] of Object.entries(add)) out[lang] = [...(out[lang] ?? []), ...list];
  return out;
}

// ---------------------------------------------------------------------------------------------
// RECEIPT
// ---------------------------------------------------------------------------------------------

type PurchaseState = {
  id: string;
  location_id: string;
  purchased_on: string | null;
  currency: string | null;
  total: string | null;
  tax: string | null;
  review_state: string;
};

/** A number as numeric(16,4) text. */
const money = (n: number) => (Math.round(n * 10_000) / 10_000).toFixed(4);
const qty = (n: number) => (Math.round(n * 1000) / 1000).toFixed(3);

async function enabledCode(client: pg.ClientBase, code: string): Promise<boolean> {
  const { rows } = await client.query(
    'SELECT 1 FROM public.currencies WHERE code = $1 AND enabled',
    [code],
  );
  return rows.length > 0;
}

async function applyReceipt(
  ctx: ApplyCtx,
  ex: ExtractionRow,
  purchaseId: string,
  f: ReceiptFields,
  sent: { attachmentIds: string[]; fromDisplay: boolean[] },
): Promise<ApplyResult> {
  const { client, tx, scope } = ctx;
  const out: ApplyResult = { applied: {}, suggestions: [], inbox: [] };
  const { rows } = await client.query<PurchaseState>(
    `SELECT id, location_id, purchased_on::text AS purchased_on, currency,
            total::text AS total, tax::text AS tax, review_state
       FROM public.purchases WHERE id = $1 FOR UPDATE`,
    [purchaseId],
  );
  const p = rows[0];
  if (!p) return out;
  const { rows: batchRows } = await client.query<{ batch_id: string | null }>(
    `SELECT batch_id FROM public.inbox_items
      WHERE purchase_id = $1 AND kind = 'receipt' ORDER BY created_at LIMIT 1`,
    [purchaseId],
  );
  const batchId = batchRows[0]?.batch_id ?? null;

  const match = f.currency?.match ?? null;
  const code =
    match && 'code' in match && (await enabledCode(client, match.code)) ? match.code : null;

  if (p.review_state === 'draft') {
    const beforeImage = { ...p, line_ids: [] as string[] };
    // A superseded attempt's values go first, where the purchase still holds them.
    const state = { ...p };
    const { rows: olds } = await client.query<{ id: string; applied: Applied }>(
      `SELECT id, applied FROM public.extractions
        WHERE purchase_id = $1 AND id <> $2 AND status = 'superseded' AND applied <> '{}'::jsonb`,
      [purchaseId, ex.id],
    );
    const sets = new Map<string, unknown>();
    for (const old of olds) {
      for (const [field, change] of Object.entries(old.applied.fields ?? {})) {
        const now = (state as Record<string, unknown>)[field];
        if (String(now ?? '') === String(change.after ?? '')) {
          sets.set(field, change.before ?? null);
          (state as Record<string, unknown>)[field] = change.before ?? null;
        }
      }
      if (old.applied.lineIds?.length) {
        await client.query(
          `DELETE FROM public.purchase_lines pl
            WHERE pl.id = ANY ($1::uuid[]) AND pl.purchase_id = $2
              AND NOT EXISTS (SELECT 1 FROM public.things t WHERE t.purchase_line_id = pl.id)`,
          [old.applied.lineIds, purchaseId],
        );
      }
      await client.query(`UPDATE public.extractions SET applied = '{}'::jsonb WHERE id = $1`, [
        old.id,
      ]);
    }

    const changes: Record<string, { before: unknown; after: unknown }> = {};
    const fill = (field: keyof PurchaseState, value: string | null) => {
      if (value === null || state[field] !== null) return;
      changes[field] = { before: null, after: value };
      sets.set(field, value);
      (state as Record<string, unknown>)[field] = value;
    };
    fill('purchased_on', f.date?.value ?? null);
    fill('currency', code);
    // Amounts need the purchase's currency (purchases_money_chk); without one they stay in the
    // result, and the receipt review asks for the currency first.
    if (state.currency) {
      fill('total', f.total ? money(f.total.value) : null);
      fill('tax', f.tax ? money(f.tax.value) : null);
    }
    if (sets.size > 0) {
      const cols = [...sets.keys()];
      await client.query(
        `UPDATE public.purchases SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}
          WHERE id = $1`,
        [purchaseId, ...sets.values()],
      );
    }

    const lineIds: string[] = [];
    if (f.lines.length > 0) {
      const { rows: s } = await client.query<{ next: number }>(
        `SELECT coalesce(max(sort) + 1, 0)::int AS next FROM public.purchase_lines
          WHERE purchase_id = $1`,
        [purchaseId],
      );
      let sort = s[0]?.next ?? 0;
      for (const line of f.lines) {
        const q = line.quantity && line.quantity.value > 0 ? line.quantity.value : 1;
        const amount = lineAmount(line);
        const unit = line.unitPrice?.value ?? (amount !== null ? amount / q : null);
        const id = newId();
        await client.query(
          `INSERT INTO public.purchase_lines (id, location_id, purchase_id, description, quantity,
                                              unit_price, sort)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            id,
            p.location_id,
            purchaseId,
            line.description.value,
            qty(q),
            state.currency && unit !== null ? money(unit) : null,
            sort,
          ],
        );
        sort += 1;
        lineIds.push(id);
      }
    }
    out.applied = {
      ...(Object.keys(changes).length > 0 ? { fields: changes } : {}),
      ...(lineIds.length > 0 ? { lineIds } : {}),
    };
    await audited(tx, {
      locationId: p.location_id,
      actor: actor(scope),
      action: 'purchase.extract',
      entity: { type: 'purchase', id: purchaseId },
      before: beforeImage,
      after: { ...state, line_ids: lineIds },
      requestId: ctx.requestId,
      undoableUntil: Object.keys(out.applied).length > 0 ? undoableUntil() : null,
    });
  }

  out.inbox.push(
    await upsertInbox(client, {
      locationId: p.location_id,
      kind: 'receipt',
      purchaseId,
      extractionId: ex.id,
      batchId,
      payload: {
        vendorSeen: f.vendor?.name.value ?? null,
        flagged: f.flagged,
        currencySeen: f.currency?.seen ?? null,
      },
    }),
  );
  if (f.currency && !code) {
    const options = match && 'ambiguous' in match ? match.ambiguous : [];
    out.inbox.push(
      await upsertInbox(client, {
        locationId: p.location_id,
        kind: 'currency',
        purchaseId,
        extractionId: ex.id,
        batchId,
        payload: { seen: f.currency.seen, options },
      }),
    );
  }
  // Q11: the paper's edges, for one photographed page the server re-encoded itself (a crop of
  // the phone's display would crop again on every re-run).
  const [only] = sent.attachmentIds;
  if (f.documentBbox && sent.attachmentIds.length === 1 && only && !sent.fromDisplay[0]) {
    const { rows: fr } = await client.query<{ file_id: string }>(
      'SELECT file_id FROM public.attachments WHERE id = $1',
      [only],
    );
    if (fr[0]) out.crop = { fileId: fr[0].file_id, bbox: f.documentBbox };
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// A service invoice (step 5, T10; Q12)
// ---------------------------------------------------------------------------------------------

/** A decimal string of a number read (4 places at most, no trailing zeros). */
const decimal = (n: number) => String(Math.round(n * 10_000) / 10_000);

/**
 * A draft service record's invoice: nothing is applied (D19). The vendor, the date, the total,
 * the currency (only a mark that maps to one enabled code: a bare `$` waits with no
 * preselection, D136, D189, and flags `currency_unclear`) and each line (description, kind,
 * quantity, unit cost) become the draft's suggestions, which the Log a service form shows violet
 * and dashed until the person confirms (D131; schedules/view.ts gates the money in them). Lines
 * that don't add up to the total flag `total_mismatch`. A record confirmed or deleted meanwhile
 * gets none. No inbox item: a draft waits on its vehicle's Services tab.
 */
async function applyServiceInvoice(
  ctx: ApplyCtx,
  ex: ExtractionRow,
  serviceRecordId: string,
  f: ReceiptFields,
  attachmentId: string,
): Promise<ApplyResult> {
  const out: ApplyResult = { applied: {}, suggestions: [], inbox: [], flags: [] };
  const { rows } = await ctx.client.query<{ review_state: string }>(
    'SELECT review_state FROM public.service_records WHERE id = $1 FOR UPDATE',
    [serviceRecordId],
  );
  if (rows[0]?.review_state !== 'draft') return out;
  const source = { extractionId: ex.id, attachmentId };
  const suggest = (field: string, value: unknown, confidence: number) =>
    out.suggestions.push({ field, value, confidence, source });
  if (f.vendor) suggest('vendor', { name: f.vendor.name.value }, f.vendor.name.confidence);
  if (f.date) suggest('servicedOn', f.date.value, f.date.confidence);
  if (f.total) suggest('total', decimal(f.total.value), f.total.confidence);
  const match = f.currency?.match ?? null;
  const code =
    match && 'code' in match && (await enabledCode(ctx.client, match.code)) ? match.code : null;
  if (f.currency && code) suggest('currency', code, f.currency.confidence);
  else if (f.currency) out.flags?.push('currency_unclear');
  for (const l of f.lines) {
    const quantity = l.quantity && l.quantity.value > 0 ? l.quantity.value : null;
    const amount = lineAmount(l);
    const unit = l.unitPrice?.value ?? (amount !== null ? amount / (quantity ?? 1) : null);
    suggest(
      'line',
      {
        description: l.description.value,
        ...(l.kind ? { kind: l.kind.value } : {}),
        ...(quantity !== null ? { quantity: qty(quantity).replace(/\.?0+$/, '') } : {}),
        ...(unit !== null ? { unitCost: decimal(unit) } : {}),
      },
      l.description.confidence,
    );
  }
  if (f.flagged) out.flags?.push('total_mismatch');
  return out;
}

// ---------------------------------------------------------------------------------------------
// READING
// ---------------------------------------------------------------------------------------------

async function applyReading(
  ctx: ApplyCtx,
  ex: ExtractionRow,
  f: ReadingFields,
): Promise<ApplyResult> {
  const { client, tx, scope } = ctx;
  const out: ApplyResult = { applied: {}, suggestions: [], inbox: [] };
  if (!ex.meter_id) return out;
  const takenAt = ex.created_at;
  const common = { meterId: ex.meter_id, attachmentId: ex.attachment_id };

  if (!f.value) {
    const { rows } = await client.query<{ thing_id: string }>(
      'SELECT thing_id FROM public.meters WHERE id = $1',
      [ex.meter_id],
    );
    const thingId = rows[0]?.thing_id;
    if (!thingId) return out;
    out.inbox.push(
      await upsertInbox(client, {
        locationId: ex.location_id,
        kind: 'reading',
        thingId,
        extractionId: ex.id,
        batchId: null,
        payload: { ...common, reason: 'needs_value' },
      }),
    );
    return out;
  }

  const placed = await placementOf(client, ex.meter_id, f.value.value, takenAt);
  if (!placed) return out;
  const { meter, placement } = placed;
  // Every AI reading waits (D19): the neighbours check's verdict, or `ai_read` when it fits.
  const reason = placement.reason ?? 'ai_read';
  const readingId = newId();
  await client.query(
    `INSERT INTO public.meter_readings
       (id, location_id, meter_id, value, taken_at, source, state, review_reason)
     VALUES ($1, $2, $3, $4, $5, 'photo', 'needs_review', $6)`,
    [readingId, meter.location_id, meter.id, f.value.value, takenAt, reason],
  );
  await audited(tx, {
    locationId: meter.location_id,
    actor: actor(scope),
    action: 'reading.extract',
    entity: { type: 'meter_reading', id: readingId },
    after: {
      meter_id: meter.id,
      value: f.value.value,
      taken_at: takenAt.toISOString(),
      state: 'needs_review',
      review_reason: reason,
    },
    rootThingId: meter.thing_id,
    requestId: ctx.requestId,
  });
  out.applied = { readingId };
  const neighbour = (r: { value: string; takenAt: Date } | null) =>
    r ? { value: r.value, takenAt: r.takenAt.toISOString() } : undefined;
  out.inbox.push(
    await upsertInbox(client, {
      locationId: meter.location_id,
      kind: 'reading',
      meterReadingId: readingId,
      extractionId: ex.id,
      batchId: null,
      payload: {
        ...common,
        thingId: meter.thing_id,
        reason,
        value: f.value.value,
        confidence: f.value.confidence,
        unitSeen: f.unit?.value ?? null,
        display: f.display ?? null,
        takenAt: takenAt.toISOString(),
        neighbours: {
          ...(placement.previous ? { before: neighbour(placement.previous) } : {}),
          ...(placement.next ? { after: neighbour(placement.next) } : {}),
        },
      },
    }),
  );
  return out;
}

// ---------------------------------------------------------------------------------------------

/** Applies a checked result to the extraction's subject. */
export async function apply(
  ctx: ApplyCtx,
  ex: ExtractionRow,
  checked: Checked,
  sent: { attachmentIds: string[]; fromDisplay: boolean[] },
): Promise<ApplyResult> {
  const first = sent.attachmentIds[0] ?? ex.attachment_id;
  switch (checked.mode) {
    case 'thing':
    case 'label':
      if (!ex.thing_id) return { applied: {}, suggestions: [], inbox: [] };
      return applyToThing(ctx, ex, ex.thing_id, checked.mode, checked.fields, first);
    case 'receipt':
      if (ex.service_record_id) {
        return applyServiceInvoice(ctx, ex, ex.service_record_id, checked.fields, first);
      }
      if (!ex.purchase_id) return { applied: {}, suggestions: [], inbox: [] };
      return applyReceipt(ctx, ex, ex.purchase_id, checked.fields, sent);
    case 'reading':
      return applyReading(ctx, ex, checked.fields);
  }
}
