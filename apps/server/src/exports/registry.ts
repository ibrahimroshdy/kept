import { EXPORT_ENTITIES, type ExportEntity } from '@kept/shared';

// The export registry (D69; step-7 plan T12, Q24): every entity a Kept export writes as
// `data/<entity>.ndjson`, and every other location-scoped (or account-registry) table, left out
// with a reason. registry.test.ts walks the catalogue and fails on a table in neither list, and
// on a column of an exported table that is neither a field nor omitted with a reason, so a table
// or column steps 4–6 (or later) add can't be forgotten.
//
// - An entity's rows are read **as the requester, under row-level security** (exports/data.ts),
//   never as the owner role: what an export holds is what its creator may see.
// - Fields are the table's own columns, camelCased on the wire (`kind_key` → `kindKey`), each
//   with a kind (exports/format.ts turns them into the zod schema the Kept importer reads with).
//   A row is API-shaped: no sync bookkeeping, no users of this server, no storage keys.
// - `money` fields are left out (and the row says `moneyHidden: true`) where the requester's gate
//   hides money (serialize/gates.ts; D13, D110).
// - `thingRefs`: SQL expressions naming a thing; a row tied to a thing the export leaves out
//   (an ended or trashed one, by the options) is left out with it.
// - Secret values are never a field: they leave only in `secrets.json`, encrypted (D68).

/** A field's wire kind. `dec`, `date` and `time` are strings (exact decimals, `YYYY-MM-DD`,
 * `HH:MM:SS`); `ts` is an ISO instant; `int` a number. Every field may be null. */
export const FIELD_KINDS = [
  'uuid',
  'uuids',
  'text',
  'texts',
  'int',
  'dec',
  'float',
  'bool',
  'date',
  'time',
  'ts',
  'json',
] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

/** Why a column of an exported table isn't a field. A column omitted here needs a reason. */
export const OMIT_REASONS: Readonly<Record<string, string>> = Object.freeze({
  location_id: 'the export is one location; the importer names its own',
  owner_account_id: "an account of this server; the importer uses the target's",
  row_version: "this server's concurrency token",
  change_seq: "this server's sync bookkeeping",
  change_xid: "this server's sync bookkeeping",
  created_by: 'a user of this server (history keeps who did what, by name)',
  claimed_by: 'a user of this server',
  checked_by: 'a user of this server',
  logged_by: 'a user of this server',
  member_user_id: 'a user of this server; members travel by name in the manifest (Q23)',
  successor_user_id: 'a user of this server',
  reveal_user_ids: 'users of this server',
  trash_batch_id: "this server's undo bookkeeping",
  capture_batch_id: "this server's capture bookkeeping",
  meter_version: "this server's concurrency token",
  state_version: "this server's concurrency token",
  search_tsv: 'derived: the search index',
  search_names: 'derived: the search index',
  place_path: 'derived: re-made from the place tree',
  storage_key: "this server's storage; the original travels as files/<fileId>",
  derivative_state: 'derived: thumbnails are re-made from the original',
  deleted_at: 'a location export is of a live location',
  purge_after: 'a location export is of a live location',
  low_since: "derived: this server's day the thing ran low, re-made from its quantity",
});

export type EntityDef = Readonly<{
  entity: ExportEntity;
  /** The table in `public`. */
  table: string;
  /** `location`: `location_id = $1`; `account`: the location's account's registry,
   * `owner_account_id = $2`; `self`: the location's own row. */
  scope: 'location' | 'account' | 'self';
  /** The keyset the reader pages by, unique per row, in order. */
  key: readonly string[];
  /** `column:kind …`, in wire order. */
  fields: string;
  /** Columns that aren't fields; each needs a reason in OMIT_REASONS. */
  omit: string;
  money?: readonly string[];
  thingRefs?: readonly string[];
  /** Extra conditions on `x`, ANDed (`$1` the location, `$2` its account). `{thingOk:<expr>}`
   * stands for "names no thing, or one the export keeps". */
  where?: string;
  /** Replaces the scope's own condition. */
  scopeWhere?: string;
}>;

export const REGISTRY: readonly EntityDef[] = Object.freeze([
  {
    entity: 'location',
    table: 'locations',
    scope: 'self',
    key: ['id'],
    fields:
      'id:uuid kind:text name:text timezone:text currency:text languages:texts address:json latitude:float longitude:float suggest_radius_m:int preset:text money_visible_to_viewers:bool require_2fa:bool long_unseen_months:int created_at:ts updated_at:ts',
    omit: 'owner_account_id successor_user_id deleted_at purge_after row_version change_seq',
  },
  {
    entity: 'places',
    table: 'places',
    scope: 'location',
    key: ['id'],
    fields:
      'id:uuid parent_id:uuid name:text kind_key:text is_unplaced:bool deleted_at:ts created_at:ts updated_at:ts icon:text sort:int custom:json',
    omit: 'location_id row_version change_seq trash_batch_id created_by change_xid',
  },
  {
    entity: 'things',
    table: 'things',
    scope: 'location',
    key: ['id'],
    fields:
      'id:uuid place_id:uuid container_id:uuid type_id:uuid name:text brand_id:uuid model:text serial:text barcode:text colour:text quantity:dec condition:text notes:text aliases:json belongs_to_person_id:uuid purchase_line_id:uuid manual_url:text expires_on:date expiry_lead_days:int lifecycle:text ended_on:date ended_price:dec ended_currency:text ended_to:text ended_notes:text acquired_from:text provenance_notes:text last_seen_at:ts location_uncertain:bool custom:json archived_custom:json field_status:json review_state:text created_via:text split_from_id:uuid deleted_at:ts created_at:ts updated_at:ts merged_into_id:uuid cover_file_id:uuid',
    omit: 'location_id created_by place_path search_tsv trash_batch_id row_version change_seq capture_batch_id change_xid meter_version state_version',
    money: ['ended_price'],
    thingRefs: ['x.id'],
  },
  {
    entity: 'codes',
    table: 'short_ids',
    scope: 'location',
    key: ['code'],
    fields:
      'code:text thing_id:uuid place_id:uuid state:text is_primary:bool printed_at:ts claimed_at:ts created_at:ts updated_at:ts',
    omit: 'location_id claimed_by row_version change_seq change_xid',
    thingRefs: ['x.thing_id'],
  },
  {
    entity: 'legacy-codes',
    table: 'legacy_codes',
    scope: 'location',
    key: ['source', 'source_collection', 'code'],
    fields:
      'source:text source_collection:text code:text thing_id:uuid place_id:uuid created_at:ts updated_at:ts',
    omit: 'location_id row_version change_seq change_xid',
    thingRefs: ['x.thing_id'],
  },
  {
    entity: 'types',
    table: 'types',
    scope: 'account',
    // The account's types, and the built-in ones (no account, `builtinKey`) its things,
    // templates and copies name, so the importer can map them by key.
    scopeWhere: `(x.owner_account_id = $2
                  OR (x.owner_account_id IS NULL
                      AND (x.id IN (SELECT t.type_id FROM public.things t WHERE t.location_id = $1)
                           OR x.id IN (SELECT m.type_id FROM public.templates m
                                        WHERE m.owner_account_id = $2)
                           OR x.id IN (SELECT c.copied_from_id FROM public.types c
                                        WHERE c.owner_account_id = $2))))`,
    key: ['id'],
    fields:
      'id:uuid builtin_key:text copied_from_id:uuid parent_id:uuid name:text icon:text colour:text capabilities:texts default_meter:json is_field_group:bool field_groups:uuids default_warranty_months:int archived_at:ts created_at:ts updated_at:ts',
    omit: 'owner_account_id search_names row_version change_seq',
  },
  {
    entity: 'place-kinds',
    table: 'place_kinds',
    scope: 'account',
    key: ['id'],
    fields: 'id:uuid key:text name:text icon:text archived_at:ts created_at:ts updated_at:ts',
    omit: 'owner_account_id row_version change_seq',
  },
  {
    entity: 'brands',
    table: 'brands',
    scope: 'account',
    key: ['id'],
    fields:
      'id:uuid name:text website:text support_phone:text claim_url:text default_warranty_months:int created_at:ts updated_at:ts',
    omit: 'owner_account_id row_version change_seq',
  },
  {
    entity: 'vendors',
    table: 'vendors',
    scope: 'account',
    key: ['id'],
    fields:
      'id:uuid name:text kind:text address:text phone:text website:text created_at:ts updated_at:ts',
    omit: 'owner_account_id row_version change_seq',
  },
  {
    entity: 'people',
    table: 'people',
    scope: 'account',
    key: ['id'],
    fields: 'id:uuid display_name:text created_at:ts updated_at:ts',
    omit: 'owner_account_id member_user_id row_version change_seq',
  },
  {
    entity: 'tags',
    table: 'tags',
    scope: 'account',
    key: ['id'],
    fields: 'id:uuid name:text colour:text created_at:ts updated_at:ts',
    omit: 'owner_account_id row_version change_seq',
  },
  {
    entity: 'purchases',
    table: 'purchases',
    scope: 'location',
    key: ['id'],
    fields:
      'id:uuid vendor_id:uuid purchased_on:date currency:text total:dec tax:dec notes:text review_state:text created_via:text created_at:ts updated_at:ts',
    omit: 'location_id created_by row_version change_seq',
    // The purchase date is money too (D201).
    money: ['purchased_on', 'total', 'tax'],
  },
  {
    entity: 'purchase-lines',
    table: 'purchase_lines',
    scope: 'location',
    key: ['id'],
    fields:
      'id:uuid purchase_id:uuid description:text quantity:dec unit_price:dec sort:int created_at:ts updated_at:ts',
    omit: 'location_id row_version change_seq',
    money: ['unit_price'],
  },
  {
    entity: 'files',
    table: 'files',
    scope: 'location',
    key: ['id'],
    fields:
      'id:uuid sha256:text bytes:int mime:text class:text has_gps:bool width:int height:int created_at:ts',
    omit: 'location_id storage_key derivative_state created_by',
    // Only the originals the exported rows reference (D117): an attachment's, or a thing's cover.
    where: `(x.id IN (SELECT a.file_id FROM public.attachments a
                       WHERE a.location_id = $1 AND a.file_id IS NOT NULL AND {thingOk:a.thing_id})
             OR x.id IN (SELECT t.cover_file_id FROM public.things t
                          WHERE t.location_id = $1 AND {thingOk:t.id}))`,
  },
  {
    entity: 'attachments',
    table: 'attachments',
    scope: 'location',
    key: ['id'],
    fields:
      'id:uuid file_id:uuid url:text thing_id:uuid place_id:uuid purchase_id:uuid meter_reading_id:uuid role:text sort:int created_at:ts updated_at:ts warranty_id:uuid claim_id:uuid loan_id:uuid incident_id:uuid valuation_id:uuid service_record_id:uuid expiring_document_id:uuid fuel_entry_id:uuid',
    omit: 'location_id created_by row_version change_seq',
    thingRefs: ['x.thing_id'],
  },
  {
    entity: 'meters',
    table: 'meters',
    scope: 'location',
    key: ['id'],
    fields:
      'id:uuid thing_id:uuid kind:text unit:text label:text offset:dec max_per_day:dec created_at:ts updated_at:ts nudge_days:int',
    omit: 'location_id row_version change_seq',
    thingRefs: ['x.thing_id'],
  },
  {
    entity: 'readings',
    table: 'meter_readings',
    scope: 'location',
    key: ['id'],
    fields:
      'id:uuid meter_id:uuid value:dec taken_at:ts received_at:ts source:text state:text review_reason:text note:text created_at:ts updated_at:ts',
    omit: 'location_id logged_by row_version change_seq',
    thingRefs: ['(SELECT m.thing_id FROM public.meters m WHERE m.id = x.meter_id)'],
  },
  {
    entity: 'meter-events',
    table: 'meter_events',
    scope: 'location',
    key: ['id'],
    fields: 'id:uuid meter_id:uuid kind:text at:ts offset:dec created_at:ts updated_at:ts',
    omit: 'location_id row_version change_seq',
    thingRefs: ['(SELECT m.thing_id FROM public.meters m WHERE m.id = x.meter_id)'],
  },
  {
    entity: 'templates',
    table: 'templates',
    scope: 'account',
    key: ['id'],
    fields:
      'id:uuid name:text type_id:uuid payload:json archived_at:ts created_at:ts updated_at:ts',
    omit: 'owner_account_id created_by row_version change_seq',
  },
  {
    entity: 'box-checks',
    table: 'box_checks',
    scope: 'location',
    key: ['id'],
    fields: 'id:uuid container_id:uuid checked_at:ts created_at:ts',
    omit: 'location_id checked_by',
    thingRefs: ['x.container_id'],
  },
  {
    entity: 'stock-rules',
    table: 'stock_rules',
    scope: 'location',
    key: ['id'],
    fields: 'id:uuid thing_id:uuid min_quantity:dec created_at:ts updated_at:ts',
    omit: 'location_id created_by row_version change_seq low_since',
    thingRefs: ['x.thing_id'],
  },
  {
    entity: 'own-code-settings',
    table: 'own_code_settings',
    scope: 'location',
    key: ['location_id'],
    fields:
      'numbering:bool prefix:text pad:int rule_pattern:text rule_message:text rule_example:text created_at:ts updated_at:ts',
    omit: 'location_id row_version change_seq',
  },
  {
    entity: 'own-code-counters',
    table: 'own_code_counters',
    scope: 'location',
    key: ['prefix'],
    fields: 'prefix:text last_number:int',
    omit: 'location_id',
  },
  {
    entity: 'type-fields',
    table: 'type_fields',
    scope: 'account',
    key: ['id'],
    fields:
      'id:uuid type_id:uuid place_kind_id:uuid key:text label:text kind:text unit:text options:json repeatable:bool required:bool sort:int secret:bool archived_at:ts created_at:ts updated_at:ts',
    omit: 'owner_account_id row_version change_seq',
  },
  {
    // Row-level security leaves out the people whose details the requester may not see (D177,
    // Q22: kept.person_contact_visible()).
    entity: 'person-contacts',
    table: 'person_contacts',
    scope: 'account',
    key: ['person_id'],
    fields: 'person_id:uuid phone:text email:text notes:text created_at:ts updated_at:ts',
    omit: 'owner_account_id row_version change_seq',
  },
  {
    entity: 'thing-tags',
    table: 'thing_tags',
    scope: 'location',
    key: ['thing_id', 'tag_id'],
    fields: 'thing_id:uuid tag_id:uuid created_at:ts',
    omit: 'location_id change_seq',
    thingRefs: ['x.thing_id'],
  },
  {
    entity: 'thing-links',
    table: 'thing_links',
    scope: 'location',
    key: ['id'],
    fields: 'id:uuid from_thing_id:uuid to_thing_id:uuid kind:text created_at:ts updated_at:ts',
    omit: 'location_id created_by row_version change_seq',
    thingRefs: ['x.from_thing_id', 'x.to_thing_id'],
  },
  {
    entity: 'box-check-lines',
    table: 'box_check_lines',
    scope: 'location',
    key: ['box_check_id', 'thing_id'],
    fields: 'box_check_id:uuid thing_id:uuid expected_qty:dec found_qty:dec',
    omit: 'location_id',
    thingRefs: [
      'x.thing_id',
      '(SELECT b.container_id FROM public.box_checks b WHERE b.id = x.box_check_id)',
    ],
  },
  {
    entity: 'template-locations',
    table: 'template_locations',
    scope: 'location',
    key: ['template_id'],
    fields: 'template_id:uuid',
    omit: 'owner_account_id location_id',
  },
  {
    entity: 'secret-field-policies',
    table: 'secret_field_policies',
    scope: 'location',
    key: ['type_field_id'],
    fields: 'type_field_id:uuid reveal_roles:texts ai_allowed:bool created_at:ts updated_at:ts',
    omit: 'location_id reveal_user_ids row_version change_seq',
  },
  {
    entity: 'fx-rates',
    table: 'fx_rates',
    scope: 'account',
    key: ['from_ccy', 'to_ccy', 'valid_from'],
    fields: 'from_ccy:text to_ccy:text rate:dec valid_from:date created_at:ts updated_at:ts',
    omit: 'owner_account_id created_by row_version change_seq',
  },
  {
    entity: 'warranties',
    table: 'warranties',
    scope: 'location',
    key: ['id'],
    fields:
      'id:uuid thing_id:uuid kind:text provider:text starts_on:date ends_on:date term_months:int lifetime:bool effective_ends_on:date lead_days:int claim_contact:text registered:bool registration_deadline:date created_at:ts updated_at:ts',
    omit: 'location_id created_by row_version change_seq',
    thingRefs: ['x.thing_id'],
  },
  {
    entity: 'claims',
    table: 'claims',
    scope: 'location',
    key: ['id'],
    fields:
      'id:uuid thing_id:uuid warranty_id:uuid incident_id:uuid opened_on:date reference:text vendor_id:uuid status:text cost:dec currency:text covered_amount:dec notes:text closed_on:date created_at:ts updated_at:ts',
    omit: 'location_id created_by row_version change_seq',
    money: ['cost', 'covered_amount'],
    thingRefs: ['x.thing_id'],
  },
  {
    entity: 'loans',
    table: 'loans',
    scope: 'location',
    key: ['id'],
    fields:
      'id:uuid thing_id:uuid direction:text person_id:uuid started_at:ts due_on:date returned_at:ts return_place_id:uuid previous_place_id:uuid previous_container_id:uuid split_from_thing_id:uuid lead_days:int notes:text created_at:ts updated_at:ts return_container_id:uuid',
    omit: 'location_id created_by row_version change_seq',
    thingRefs: ['x.thing_id'],
  },
  {
    entity: 'valuations',
    table: 'valuations',
    scope: 'location',
    key: ['id'],
    fields:
      'id:uuid thing_id:uuid value:dec currency:text valued_on:date source:text notes:text created_at:ts updated_at:ts',
    omit: 'location_id created_by row_version change_seq',
    money: ['value'],
    thingRefs: ['x.thing_id'],
  },
  {
    entity: 'incidents',
    table: 'incidents',
    scope: 'location',
    key: ['id'],
    fields:
      'id:uuid kind:text occurred_on:date police_reference:text insurer_reference:text notes:text created_at:ts updated_at:ts',
    omit: 'location_id created_by row_version change_seq',
  },
  {
    entity: 'incident-things',
    table: 'incident_things',
    scope: 'location',
    key: ['incident_id', 'thing_id'],
    fields: 'incident_id:uuid thing_id:uuid',
    omit: 'location_id',
    thingRefs: ['x.thing_id'],
  },
  {
    entity: 'expiring-documents',
    table: 'expiring_documents',
    scope: 'location',
    key: ['id'],
    fields:
      'id:uuid thing_id:uuid place_id:uuid kind:text title:text expires_on:date lead_days:int superseded_by_id:uuid created_at:ts updated_at:ts issued_on:date currency:text cost:dec',
    omit: 'location_id created_by row_version change_seq',
    money: ['cost'],
    thingRefs: ['x.thing_id'],
  },
  {
    entity: 'schedules',
    table: 'schedules',
    scope: 'location',
    key: ['id'],
    fields:
      'id:uuid thing_id:uuid place_id:uuid name:text every_months:int every_units:dec meter_id:uuid due_on:date lead_days:int lead_units:dec base_on:date base_value:dec anchor_on:date anchor_value:dec snoozed_until:date snoozed_until_value:dec skip_next:bool active:bool created_at:ts updated_at:ts',
    omit: 'location_id created_by row_version change_seq',
    thingRefs: ['x.thing_id'],
  },
  {
    entity: 'service-records',
    table: 'service_records',
    scope: 'location',
    key: ['id'],
    fields:
      'id:uuid thing_id:uuid place_id:uuid serviced_on:date meter_reading_id:uuid vendor_id:uuid total:dec currency:text notes:text created_at:ts updated_at:ts review_state:text',
    omit: 'location_id logged_by row_version change_seq',
    money: ['total'],
    thingRefs: ['x.thing_id'],
  },
  {
    entity: 'service-lines',
    table: 'service_lines',
    scope: 'location',
    key: ['id'],
    fields:
      'id:uuid service_record_id:uuid kind:text description:text quantity:dec unit_cost:dec sort:int created_at:ts updated_at:ts',
    omit: 'location_id row_version change_seq',
    money: ['unit_cost'],
    thingRefs: [
      '(SELECT s.thing_id FROM public.service_records s WHERE s.id = x.service_record_id)',
    ],
  },
  {
    entity: 'service-completions',
    table: 'service_completions',
    scope: 'location',
    key: ['service_record_id', 'schedule_id'],
    fields: 'service_record_id:uuid schedule_id:uuid created_at:ts',
    omit: 'location_id',
    thingRefs: [
      '(SELECT s.thing_id FROM public.service_records s WHERE s.id = x.service_record_id)',
    ],
  },
  {
    entity: 'fuel-entries',
    table: 'fuel_entries',
    scope: 'location',
    key: ['id'],
    fields:
      'id:uuid thing_id:uuid taken_at:ts amount:dec unit:text currency:text cost:dec is_full:bool missed_before:bool vendor_id:uuid meter_reading_id:uuid note:text created_at:ts updated_at:ts',
    omit: 'location_id logged_by row_version change_seq',
    money: ['cost'],
    thingRefs: ['x.thing_id'],
  },
] satisfies EntityDef[]);

/** `history` isn't a table: it is the location's audit events, rendered (exports/history.ts). */
export const HISTORY_ENTITY = 'history' satisfies ExportEntity;

/**
 * Every other location-scoped table, and the account tables beside the exported registries, with
 * why it stays out of a Kept export (`public.` names).
 */
export const NOT_EXPORTED: Readonly<Record<string, string>> = Object.freeze({
  audit_events: 'written as data/history.ndjson, rendered for the requester (D110)',
  audit_event_subjects: "carried in each history event's `subjects`",
  llm_calls: 'written as ai-calls.csv instead (§7.15)',
  ai_budgets: "this server's AI spending limits",
  ai_usage_months: 'derived from the AI call ledger',
  ai_providers: "this server's AI keys",
  assistant_proposals: "the assistant's pending actions on this server",
  assistant_tool_results: "the assistant's working memory on this server",
  brand_logos: 'a cached logo, fetched again from the brand',
  embedding_state: 'derived: the semantic search index',
  thing_embeddings: 'derived: the semantic search index',
  export_runs: "this server's bookkeeping",
  report_runs: "this server's bookkeeping",
  import_runs: "this server's bookkeeping",
  import_source_ids: "this server's bookkeeping",
  extractions: 'derived from the attachments by AI',
  file_derivatives: 'derived: thumbnails are re-made from the originals',
  file_text: 'derived: text read from the PDFs',
  inbox_items: 'open decisions, re-made by the importer',
  invites: 'pending invitations to this server',
  label_batches: 'print jobs; the codes travel in data/codes.ndjson',
  label_batch_codes: 'print jobs; the codes travel in data/codes.ndjson',
  location_modules: "the location's modules, in the location row and the manifest",
  memberships: "members travel by name and role in the manifest (Q23); they're invited again",
  notification_preferences: "each member's own settings on this server",
  notifications: "each member's own inbox on this server",
  reminder_occurrences: 'derived from schedules, warranties, loans and documents',
  saved_views: 'each member\'s own views ("Export my data" carries the requester\'s, me.json)',
  user_hidden_modules: "each member's own settings on this server",
  secret_values: 'encrypted under this server; only in secrets.json, with a passphrase (D68)',
  sync_ops: "devices' state on this server",
  sync_tombstones: "devices' state on this server",
  token_locations: "this server's access tokens",
  webhooks: "this server's integrations and their secrets",
  webhook_deliveries: "this server's integrations",
});

const SNAKE = /_([a-z0-9])/g;
export const camelOf = (column: string): string =>
  column.replace(SNAKE, (_m, c: string) => c.toUpperCase());

export type Field = Readonly<{ column: string; name: string; kind: FieldKind }>;

/** An entity's fields, parsed from its `fields` string. */
export function fieldsOf(def: EntityDef): Field[] {
  return def.fields
    .split(/\s+/)
    .filter(Boolean)
    .map((spec) => {
      const [column = '', kind = ''] = spec.split(':');
      if (!(FIELD_KINDS as readonly string[]).includes(kind)) {
        throw new Error(`export registry: ${def.entity}.${column} has no kind`);
      }
      return { column, name: camelOf(column), kind: kind as FieldKind };
    });
}

export const omittedOf = (def: EntityDef): string[] => def.omit.split(/\s+/).filter(Boolean);

const BY_ENTITY = new Map(REGISTRY.map((d) => [d.entity, d]));

/** The registry's entry for an entity (every entity but `history`). */
export function entityDef(entity: ExportEntity): EntityDef | undefined {
  return BY_ENTITY.get(entity);
}

/** The data files, in EXPORT_ENTITIES order. */
export const EXPORTED_ENTITIES: readonly ExportEntity[] = EXPORT_ENTITIES.filter(
  (e) => e === HISTORY_ENTITY || BY_ENTITY.has(e),
);
