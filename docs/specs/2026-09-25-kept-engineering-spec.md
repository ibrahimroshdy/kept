# Kept — engineering spec

> **§7 Foundations** (added 2026-09-26) answers the build-readiness, data-integrity and security findings; §7.14 holds the build-start answers (D190); §7.15 the AI keys, usage, spend and call ledger (D206); where it differs from a table row in §1, §7 wins. Screens are specified in [the screens spec](2026-09-26-kept-screens.md).

**Status: draft for implementation planning; nothing is built.** This document turns the
[product design](2026-09-25-kept-product-design.md) into what an implementer needs: tables,
contracts, numbers, accessibility, and error and empty states. It adds **no product decisions**. Where it
must choose something the product design leaves open (a column type, a default number), it says so,
and every such default is tunable. Decisions are cited as `D<n>`, lessons as `L<n>`.

---

## 1. Data model

PostgreSQL 18 (D82, D128). All IDs are UUIDv7 unless noted; offline-created rows get their ID on the
client (D17). Every owned row carries `location_id` or `owner_account_id` (L15), **including child
tables**, so row-level security never needs a join. Moving a thing to another location updates
`location_id` on the thing and all its children in one transaction. Money is `numeric(14,2)` plus a
`char(3)` currency, constrained to the supported set **USD · CAD · GBP · EUR · EGP** by a check against
a `currencies` reference table (D136), so adding one is a row, not a migration. Calendar facts are `date`; instants are `timestamptz`. Soft delete is `deleted_at`. **Every mutable table also has `updated_at` and `row_version`**; writes carry
the version they started from, and a mismatch returns **412** with the conflicting fields (§7.7, D156).

### 1.1 RLS scopes

| Scope | Rule | Tables |
|---|---|---|
| **location** | row's `location_id` ∈ the current user's active (unexpired) memberships | most tables below |
| **account** | row's `owner_account_id` owns a location the user is a member of | types, brands, vendors, people, tags, templates, files |
| **user** | row's `user_id` = current user | profile, threads, tokens, channels, preferences |
| **instance** | instance-admin paths only, on `kept_app` behind `kept.is_instance_admin()` (D190); never the app role's normal queries | instance settings, backup runs |

The request pool logs in as `kept_app`; the wrapper only sets `app.user_id` inside a transaction
(§7.1, D178). A test fails if any query path bypasses it. Instance-scope paths also run on
`kept_app`, gated by `kept.is_instance_admin()` (§7.14, D190). Views are `security_invoker` (L28).

### 1.2 Identity and tenancy

| Table | Key columns | Notes |
|---|---|---|
| Better Auth tables | user, session, account (OAuth links), verification, passkey, two_factor | Managed by Better Auth (D93); managed accounts get a synthetic `…@managed.invalid` email |
| `user_profiles` | `user_id` PK, `display_name`, `timezone`, `locale`, `units` (metric/imperial), `theme`, `digits` (western · eastern, D143), `suggest_location` bool default false (D153; the user's position itself is never stored), `digest_time`, `quiet_from`, `quiet_to`, `managed` bool, `created_by_user_id` | D47, D122 |
| `owner_accounts` | `id`, `user_id` UNIQUE, `billable` (derived: owns a non-personal location), `created_at` | One per user (D114) |
| `locations` | `id`, `owner_account_id`, `kind` (personal · home · apartment · garage · storage_unit · office · vacation_home · custom), `name`, `timezone`, `currency` (default, from enabled currencies, D168), `languages` text[], `address` jsonb null, `latitude` null, `longitude` null, `suggest_radius_m` int default 150, `preset`, `money_visible_to_viewers` bool, `require_2fa` bool, `long_unseen_months` int default 12, `deleted_at`, `purge_after` null | One `personal` per account (partial unique); deletion has a 30-day grace period (D149) |
| `location_modules` | PK (`location_id`, `module`), `enabled` | D61, D113 |
| `user_hidden_modules` | PK (`user_id`, `location_id`, `module`) | Users can hide, never enable |
| `memberships` | `id`, `location_id`, `user_id`, `role` (owner · admin · member · viewer), `expires_at` null, `invited_by` | UNIQUE (`location_id`, `user_id`); one `owner` per location (partial unique); none but the owner on `personal` |
| `invites` | `id`, `location_id`, `role`, `membership_expires_at`, `email` null, `token_hash`, `expires_at` (7 days), `created_by`, `accepted_by`, `accepted_at` | D33 |
| `support_grants` | `id`, `location_id`, `granted_by`, `starts_at`, `ends_at`, `revoked_at` | D71; default 48 h, max 7 days |
| `instance_settings` | `key` PK, `value` jsonb | `signup_open`, `barcode_lookup`, `update_check`, `ssrf_allow_private`, `oidc_autoprovision_issuers`, `public_url`, `former_hostnames`, `setup_code_hash` |

### 1.3 The tree

| Table | Key columns | Notes |
|---|---|---|
| `places` | `id`, `location_id`, `parent_id` null, `kind`, `name`, `icon`, `sort`, `is_unplaced` bool, `custom` jsonb (fields from the place kind, D160), `deleted_at` | One `is_unplaced` per location (partial unique, D118); trees via `parent_id` + recursive CTE (D82) |
| `things` | `id`, `location_id`, `place_id` null, `container_id` null (→ things), `type_id`, `name`, `brand_id`, `model`, `serial`, `barcode` null, `colour`, `quantity` int >0, `condition`, `notes`, `aliases` jsonb (`{lang: [..]}`), `belongs_to_person_id`, `purchase_line_id`, `manual_url`, `expires_on` date null, `expiry_lead_days` int null, `lifecycle` (in_use · sold · given_away · lost · disposed · stolen · destroyed, D119, D158), `ended_on` date null, `ended_price` null, `ended_currency` null, `ended_to` text null, `ended_notes` null, `last_seen_at`, `location_uncertain` bool, `custom` jsonb, `field_status` jsonb, `review_state` (draft · confirmed), `created_via` (app · mcp · assistant · import · email), `split_from_id`, `place_path` text (cached), `search_tsv` tsvector, `deleted_at` | CHECK exactly one of `place_id` / `container_id`; loops refused by a trigger (D45); lent/borrowed/in-repair derived (D119) |
| `short_ids` | `code` char(6) PK (Crockford base32), `location_id`, `thing_id` null, `place_id` null (D160), `state` (blank · assigned · retired), `is_primary`, `printed_at`, `claimed_at`, `claimed_by` | Instance-unique, server-allocated (D112, D120); a claimed blank label on an existing thing is a second code resolving to it |
| `thing_links` | `id`, `location_id`, `from_thing_id`, `to_thing_id`, `kind` (accessory_of · spare_part_for · consumable_for · bundled_with · replaces · related) | D76 |
| `tags`, `thing_tags` | `tags(id, owner_account_id, name, colour)`; PK (`thing_id`, `tag_id`) | D76 |
| `types` | `id`, `owner_account_id` null (built-in), `parent_id`, `name`, `icon`, `colour`, `capabilities` (container · metered · warranty · serialized · consumable), `archived_at` | Cycles refused (D92) |
| `type_fields` | `id`, `type_id`, `key`, `label`, `kind`, `unit`, `options` jsonb, `required`, `sort`, `archived_at`, `secret` bool | The secret flag lives here (D116); the reveal and AI policy is per location in `secret_field_policies` (§7.13, D177) |
| `secret_values` | `id`, `location_id`, `thing_id`, `field_key`, `ciphertext`, `key_version`, `updated_by`, `updated_at` | Envelope-encrypted under `KEPT_SECRET_KEY` (D83); never indexed; never in the offline snapshot |
| `brands` | `id`, `owner_account_id` null (built-in), `name`, `logo_file_id`, `website`, `support_phone`, `claim_url`, `default_warranty_months` | D55, D76 |
| `vendors` | `id`, `owner_account_id`, `name`, `kind` (store · online · service_centre · station · other), `address`, `phone`, `website`, `logo_file_id` | D11 |
| `people` | `id`, `owner_account_id`, `display_name`, `user_id` null, `phone`, `notes` | D11 |
| `templates` | `id`, `owner_account_id`, `name`, `payload` jsonb | D76 |

### 1.4 Purchases and money

| Table | Key columns | Notes |
|---|---|---|
| `purchases` | `id`, `location_id`, `vendor_id`, `purchased_on` date, `currency`, `total`, `tax`, `notes`, `created_via` | D115 |
| `purchase_lines` | `id`, `location_id`, `purchase_id`, `description`, `quantity`, `unit_price` | Things point here via `things.purchase_line_id` (a split keeps the same line) |
| `currencies` | `code` char(3) PK, `minor_units` (2 for all five), `symbol_en`, `symbol_ar`, `enabled` | Seeded with USD, CAD, GBP, EUR, EGP (D136) |
| `valuations` | `id`, `location_id`, `thing_id`, `value`, `currency`, `valued_on`, `source` (purchase · appraisal · estimate · insurer), `document_attachment_id`, `notes` | Current value = latest (D158) |
| `incidents` | `id`, `location_id`, `kind` (burglary · fire · flood · loss · other), `occurred_on`, `police_reference`, `insurer_reference`, `notes`; `incident_things` PK (`incident_id`, `thing_id`) | Claims may reference an incident (D158) |
| `fx_rates` | `owner_account_id`, `from_ccy`, `to_ccy`, `rate`, `valid_from` | Entered by the account; optional provider off by default and must cover all five (D76, D136) |

### 1.5 Files and attachments

| Table | Key columns | Notes |
|---|---|---|
| `files` | `id`, `owner_account_id` (no direct RLS read: visible only through an attachment, §7.2), `storage_key`, `sha256` (of the original), `bytes`, `mime`, `class` (evidence · photo · document · video), `has_gps` bool, `created_by` | Dedupe is per location: see §7.13 (D177). Evidence byte-identical (D117); blobs are reference-counted across accounts and purged when unreferenced (D161, D162) |
| `file_derivatives` | PK (`file_id`, `variant`: display · thumb · share), `storage_key`, `width`, `height` | GPS stripped, rotation baked (D117) |
| `attachments` | `id`, `location_id`, `file_id`, `subject_type` (thing · place · location · purchase · warranty · claim · loan · service_record · reading), `subject_id`, `role` (photo · receipt · invoice · manual · warranty_doc · proof · condition_out · condition_in · registration), `sort` | Many subjects can reference one file |
| `file_text` | `file_id` PK, `text`, `tsv` | PDF and receipt text for search (D77) |

### 1.6 Meters, services, fuel, schedules (core, D113)

| Table | Key columns | Notes |
|---|---|---|
| `meters` | `id`, `location_id`, `thing_id`, `kind` (distance · hours · custom), `unit`, `label`, `offset` numeric default 0, `max_per_day` numeric null, `nudge_days` int null default 30 (7–365; NULL for no stale-reading nudge) | Car default 1,500 km/day (D26); `nudge_days` is per meter, set with `meters.manage` (step-5 Q19) |
| `meter_readings` | `id`, `location_id`, `meter_id`, `value`, `taken_at`, `received_at`, `source` (manual · photo · fuel · service · import · home_assistant), `logged_by`, `state` (accepted · needs_review), `note` | Ordered by `taken_at`; checked against neighbours (D112). A proof photo is an `attachments` row with `meter_reading_id` (§7.13; step-5 Q10). A reading a fill or service made is changed through its owner (409 `reading_owned`, step-5 Q11) |
| `meter_events` | `id`, `location_id`, `meter_id`, `kind` (replaced), `at`, `offset` | D52 |
| `service_records` | `id`, `location_id`, `subject_type` (thing · place), `subject_id`, `serviced_on`, `meter_reading_id`, `vendor_id`, `total`, `currency`, `notes`, `review_state` (draft · confirmed, default confirmed) | Invoices via `attachments`. A **service draft** (step 5, Q12): attaching an invoice makes a `draft` record whose RECEIPT extraction (the service-invoice prompt, each line with its kind) suggests the lines; a draft counts nowhere (costs, schedules, reminders, the report) until it is confirmed, and is discarded or confirmed from the Services tab |
| `service_lines` | `id`, `location_id`, `service_record_id`, `kind` (part · labour · fluid · other), `description`, `quantity`, `unit_cost`, `consumable_thing_id` null, `consumed_quantity` null (D170) | D26 |
| `service_completions` | PK (`service_record_id`, `schedule_id`) | Which schedules a service completes |
| `fuel_entries` | `id`, `location_id`, `thing_id`, `taken_at`, `amount`, `unit` (L · kWh · gal), `cost`, `currency`, `is_full` bool (§1.6 first called it `full`, a reserved word), `missed_before` bool (D170), `vendor_id`, `meter_reading_id`, `note` | D28. Consumption is full-to-full, partials inside counted, an interval with a missed fill, a missing reading or mixed units skipped (step-5 Q6); the fill's odometer is its own `fuel` reading (Q11) |
| `schedules` | `id`, `location_id`, `subject_type` (thing · place), `subject_id`, `name`, `every_units` null, `meter_id` null, `every_months` null, `lead_days`, `lead_units`, `due_on` date null (one-off when no interval is set, D146), `anchor_at`, `anchor_value`, `snoozed_until` date null, `snoozed_until_value` null, `skip_next` bool, `active` | D29, D39 |
| `expiring_documents` | `id`, `location_id`, `subject_type` (thing · place · location), `subject_id`, `kind` (registration · insurance · licence · inspection · lease · contract · other), `expires_on`, `lead_days`, `attachment_id`, `issued_on` date null (≤ `expires_on`), `cost` + `currency` null together | D26, D155. A renewal's cost counts in its `issued_on` month as "Fees & insurance" on a vehicle's Costs (step-5 Q5) |
| `stock_rules` | `thing_id` PK, `location_id`, `min_quantity` | Consumables (D14) |

### 1.7 Warranties, claims, loans

| Table | Key columns | Notes |
|---|---|---|
| `warranties` | `id`, `location_id`, `thing_id`, `kind` (manufacturer · extended · store · credit_card · insurance), `provider`, `starts_on`, `ends_on` null, `term_months` null, `document_attachment_id`, `claim_contact`, `registered` bool, `registration_deadline` null, `lifetime` bool | D53, D55 |
| `claims` | `id`, `location_id`, `thing_id`, `warranty_id` null, `incident_id` null, `opened_on`, `reference`, `vendor_id`, `status` (open · in_repair · resolved · rejected), `cost`, `currency`, `notes`, `closed_on` | An open claim in `in_repair` makes the thing read "at <vendor>" (D54, D119) |
| `loans` | `id`, `location_id`, `thing_id`, `direction` (out · in), `person_id`, `started_at`, `due_on` null, `returned_at` null, `return_place_id`, `notes` | Condition photos via `attachments`; an open loan derives lent / borrowed (D56, D57, D119) |

### 1.8 Capture, AI, assistant

| Table | Key columns | Notes |
|---|---|---|
| `ai_providers` | `id`, `scope` (instance · account · user; **no location scope**, D206), `scope_id`, `provider` (openai · anthropic · google · openrouter · groq · openai_compatible, D202), `base_url`, `key_ciphertext`, `models` jsonb (vision · chat · embeddings) | Keys never returned (D15); SSRF-checked (D128) |
| `ai_budgets` | `id`, `scope` (instance · instance_account · account · location · member · user), its scope ids, `task` null (all) or extraction · assistant · embeddings, `tokens_per_minute`, `tokens_per_day`, `tokens_per_month`, monthly money cap, `paused_until`, `paused_reason` | D19, L41–L46; caps and pausing: §7.15 (D206) |
| `llm_calls` | the AI call ledger: one row per call attempt, with task, location, person, payer and key scope, tokens, images (count, estimate, bytes), latency, outcome, cost and its source and price version; **never the prompt, image, reply or key** (full columns: §7.15) | D121, D206, L47; retention §3.3 |
| `ai_model_prices` | versioned price rows per provider kind and model (§7.15) | D167, D206 |
| `extractions` | `id`, `location_id`, `attachment_id`, `mode` (thing · receipt · label · reading), `attempt`, `status`, `llm_call_id`, `result` jsonb (§2.1) | Re-runs explicit (D19) |
| `assistant_threads` / `assistant_messages` | threads: `id`, `user_id`, `title`, `expires_at`; messages: `thread_id`, `role`, `content` jsonb, `tool_calls` jsonb | User scope, private (D23) |
| `assistant_proposals` | `id`, `user_id`, `location_id`, `tool`, `args` jsonb, `args_hash`, `expires_at` (10 min), `status` | D22 |
| `mailboxes` | `id`, `location_id`, `kind` (cloud_address · imap), `config_ciphertext`, `target_place_id` (default Unplaced), `last_polled_at` | D21, D118 (1.x) |

### 1.9 Reminders and notifications

| Table | Key columns | Notes |
|---|---|---|
| `reminder_occurrences` | `id`, `location_id`, `subject_type`, `subject_id`, `source_type` (schedule · warranty · document · loan · stock · reading_stale · registration · thing_expiry), `source_id`, `kind` (due · overdue · expiring), `due_period`, `due_on`, `state` | Unique per subject, source, kind and due period (D111); the exact key is in §7.13 |
| `reminder_deliveries` | PK (`occurrence_id`, `user_id`, `channel`), `status`, `sent_at`, `error` | D111 |
| `notification_preferences` | PK (`user_id`, `location_id`, `kind`, `channel`), `enabled` | D29, D122 |
| `notification_channels` | `id`, `user_id`, `kind` (email · webpush · webhook · ntfy · telegram · apprise), `config_ciphertext`, `verified_at` | D30 |
| `push_subscriptions` | `id`, `user_id`, `endpoint`, `keys`, `created_at` | Pruned on 404/410 (L112) |
| `calendar_feeds` | `id`, `user_id`, `token_hash`, `created_at`, `revoked_at` | Private iCal link; titles, dates and deep links only (D142) |
| `notifications` | `id`, `user_id`, `occurrence_id` null, `kind`, `payload` jsonb, `read_at` | In-app centre (D39) |

### 1.10 Audit, API, integration, operations

| Table | Key columns | Notes |
|---|---|---|
| `audit_events` | `id`, `at`, `actor_type` (user · token · system · import), `actor_id`, `location_id`, `entity_type`, `entity_id`, `action`, `diff` jsonb, `request_id`, `undo_of` null, `undoable_until` null | Diffs redacted per D110: secrets `{changed:true}`, money fields tagged |
| `api_tokens` | `id`, `user_id`, `name`, `prefix`, `hash`, `scope` (read · write), `location_ids` uuid[] null, `expires_at`, `last_used_at`, `revoked_at` | `kpt_` prefix (D109); OAuth tokens in Better Auth's tables |
| `idempotency_keys` | PK (`user_id`, `key`), `request_hash`, `response` jsonb, `created_at` | Scoped per user (§7.13) |
| `webhooks` / `webhook_deliveries` | hooks: `id`, `location_id`, `url`, `secret_ciphertext`, `events` text[], `active`; deliveries: `id`, `webhook_id`, `event_id`, `status`, `attempts`, `next_attempt_at` | Payload §2.6 |
| `share_links` | `id`, `location_id`, `scope_type` (thing · place · view), `scope_id` null, `filter` jsonb null, `token_hash`, `expires_at`, `revoked_at`, `created_by`, `views` | Whitelist fields only (D116) |
| `import_runs`, `import_source_ids` | runs: `id`, `location_id`, `source` (homebox_zip · homebox_api · csv · kept_zip), `source_version`, `status`, `dry_run_report` jsonb, `choices` jsonb (archived, rounding, currency); ids: UNIQUE (`source`, `source_id`) → (`entity_type`, `entity_id`) | Re-runnable; Homebox keyed on entity UUID (D146) |
| `legacy_codes` | PK (`source`, `source_collection`, `code`), `location_id`, `thing_id` null, `place_id` null; `source` ∈ homebox · csv · **own** | Homebox asset IDs and entity UUIDs, so old printed labels still resolve (D146); CSV old codes (T18); the household's **own codes** (`own`, collection `''`, D208): several per thing or place, unique per location whatever the source, resolved like any legacy code (§7.16) |
| `own_code_settings` | PK `location_id`, `numbering` bool (off), `prefix` (≤ 20, upper case), `pad` (1–8, default 4), `rule_pattern`, `rule_message`, `rule_example` (all three or none) | A location's own-code options (D208): automatic numbering and the format rule (§7.16) |
| `own_code_counters` | PK (`location_id`, `prefix`), `last_number` | The numbering's counters, moved only by `kept.next_own_code()` under the row's lock: never a number twice (§7.16) |
| `export_runs` | `id`, `location_id`, `include_secrets` bool, `status`, `file_id`, `expires_at` | D68, D69 |
| `user_hints` | PK (`user_id`, `hint_key`), `seen_at`, `dismissed` bool | One-time hints and the checklist's dismissed state, stored server-side (D138); checklist progress itself is computed from data |
| `box_checks` | `id`, `location_id`, `container_id`, `by`, `at` | D40; counted lines in `box_check_lines` (§7.13) |
| `moves`, `move_boxes` | moves: `id`, `from_location_id`, `to_location_id`, `name`, `status`; boxes: PK (`move_id`, `container_id`), `state` (packed · in_transit · unpacked) | 1.x (D130) |
| `backup_runs` | `id`, `started_at`, `finished_at`, `bytes`, `status`, `snapshot_id`, `verified_at`, `storage_mode` (local · s3), `bucket_versioning_ok` bool | Instance scope (D66, D144) |

Jobs (extraction, reminders, imports, exports, webhooks, backups) run on pg-boss (D94); its tables
live in their own schema.

## 2. Contracts

### 2.1 Extraction output (per capture mode)

The model returns **JSON only**, validated by zod. Fields that don't parse, or are out of range,
are dropped (L52). The model never returns IDs or URLs (L51). Every field carries `confidence`
0–1. A field below 0.6 always waits for review, even if its kind is normally auto-accepted
(tunable).

```ts
type Conf<T> = { value: T; confidence: number };

// THING — one or many objects (many: 1.x, D20)
{ objects: Array<{
    bbox?: [x: number, y: number, w: number, h: number];  // 0–1, relative to the photo
    name: Conf<string>; brand?: Conf<string>; model?: Conf<string>;
    colour?: Conf<string>; type_hint?: Conf<string>; quantity?: Conf<number>;
    serial?: Conf<string>;
    aliases: Record<LanguageCode, string[]>;               // location's languages (D41)
}> }

// RECEIPT
{ vendor?: { name: Conf<string>; phone?: string; address?: string };
  date?: Conf<string /* YYYY-MM-DD */>; currency?: Conf<string>;
  total?: Conf<number>; tax?: Conf<number>;
  lines: Array<{ description: Conf<string>; quantity?: Conf<number>;
                 unit_price?: Conf<number>; line_total?: Conf<number> }>;
  warranty_terms_printed?: Conf<string> }               // only if printed (D55)

// LABEL (nameplates, registration cards)
{ brand?: Conf<string>; model?: Conf<string>; serial?: Conf<string>;
  vin?: Conf<string>; plate?: Conf<string>;
  document_kind?: Conf<"registration"|"insurance"|"licence"|"inspection"|"other">;
  expires_on?: Conf<string>; manufactured_on?: Conf<string> }

// READING
{ value: Conf<number>; unit?: Conf<"km"|"mi"|"h">; display?: "digital"|"analog" }
```

**Currency rule (D136, D189):** the model returns what it saw (`"$"`, `"E£"`, `"EUR"`…) and code maps it. Unambiguous marks map directly. A bare `"$"` always waits, with **no preselection**: the person picks USD or CAD (D189). A bare `"£"` maps to GBP only when the vendor, address or language is British, and otherwise waits.

**Code checks after the model:** receipt line totals must reconcile with the total (±1%), or the
receipt is flagged. A reading is checked against its meter (D26, D112). Dates can't be in the future
(except expiries). A VIN must pass its checksum where the format has one.

### 2.2 Offline snapshot (per device, D17, D36, D101)

- **Contents per location:**
  - places `{id, parent_id, name, kind}`
  - things `{id, short_code, name, type_icon, place_id | container_id, quantity, aliases, lifecycle, derived_state, last_seen_at, thumb_ref}`
  - short IDs `{code → thing_id | place_id | blank}`, plus legacy codes (D146)
- **Never included:** secrets or people's contact details. Money and documents are included only for
  a location this device keeps offline (D159), behind the app lock (D181).
- **Caps:** 20,000 things or 10 MB of JSON per device. Thumbnails are cached lazily, least recently
  used first out, up to 200 MB.
- **Refresh:** a delta by `change_seq` (§7.4) on app open and focus when online. Wiped on logout.
  Only locations the user is a member of.

### 2.3 Offline queue item

The snapshot delta also returns `removed_ids` and `revoked_location_ids`; the phone deletes those
immediately (D156).


```ts
{ client_version: string; payload_version: number;   // D148
  client_id: UUIDv7; idempotency_key: string; op:
    | "create_thing" | "move" | "log_reading" | "claim_label"
    | "mark_seen" | "not_here" | "create_area"                         // D172
    | "box_check";                                                      // D175
  taken_at: string /* device time, clamped server-side */;
  location_id: string; payload: object; blobs: LocalBlobRef[] }
```

Replayed with the `Idempotency-Key` header. The server answers per item: `applied` ·
`needs_review` (goes to the inbox) · `dropped` (with a reason, e.g. the target was trashed, D35).

### 2.4 Label and QR

- The QR encodes `<public_url>/l/<code>`, with `code` as 6 Crockford base32 characters; the code is
  also printed as text (D120).
- The in-app scanner accepts any host and resolves by code.
- `/l/<code>` redirects to the thing or container, or to "claim this label" when the code is blank.
- Former hostnames can be configured to redirect.
- **Scan outcomes (D137)**, the same in the scanner, the capture camera and `/l/<code>`:

  | Scanned | Result |
  |---|---|
  | A code for a thing or container the user can see | Open it; update `last_seen_at` (D40) |
  | A blank code in a location the user belongs to | "Claim this label" (D43, D112) |
  | A code the user can't see, or doesn't exist | "Not in your Kept"; the response is **identical** for both, so existence never leaks |
  | A product barcode (EAN/UPC) | Lookup if enabled (D126); otherwise "Add as a new thing" with the barcode stored in a `barcode` field |
  | Any other QR | "Not a Kept label", with its text shown |
  | Offline, not in the snapshot | "Not on this phone; it will check when you're online" (queued) |
  | A Homebox label (`/a/<assetId>`, `/item/<uuid>`, `/location/<uuid>`, any host) | Resolved through `legacy_codes`; if an asset ID matches in several imported collections, ask which (D146) |

### 2.5 MCP tools (D63, D124)

All tools take `location_id` (optional where the token has one location, D179) and return
`{data, as_of, next_cursor?}` or `{error, hint}`. Lists default to 20 items, max 200, and each
response stays under about 8 KB.

| Tool | Scope | Key arguments |
|---|---|---|
| `capabilities` | read | none; returns each location's modules and the tools available per location |
| `search_things` | read | `query`, `filters` (type, place, status, tag), `cursor` |
| `where_is` | read | `query`; returns the best matches with full paths |
| `get_thing` | read | `thing_id` or `short_code` |
| `list_locations` | read | none |
| `list_contents` | read | `place_id` or `container_id`, `depth` (1–3) |
| `thing_history` | read | `thing_id`, `cursor` (redacted per D110) |
| `upcoming` | read | `within_days`, `kinds` (due · overdue · expiring · low_stock · loans) |
| `find_documents` | read | `thing_id` or `query`, `roles` (receipt · invoice · warranty_doc · manual · …); returns the attachments with their subject (D172, story J7) |
| `add_thing` | write | `name`, `place_id` or `container_id`, optional fields; returns `attach_link` when a photo or receipt is wanted |
| `update_thing` | write | `thing_id`, fields (no secrets unless allowed, D116) |
| `move_thing` | write | `thing_id`, `to_place_id` or `to_container_id`, `quantity` (splits) |
| `mark_seen` | write | `thing_id` or `short_code`; updates `last_seen_at` (D40, D172) |
| `create_place` | write | `parent_id`, `name`, `kind` |
| `lend_thing` / `return_thing` / `borrow_thing` | write | `thing_id`, `person` (name or id), `due_on` |
| `log_reading` | write | `thing_id` or `meter_id`, `value`, `taken_at` |
| `log_service` | write | `thing_id` or `place_id`, `serviced_on`, `vendor`, `total`, `lines`, `completes` (schedule ids) |
| `log_fuel` | write | `thing_id`, `amount`, `unit`, `cost`, `full`, `reading` |
| `complete_schedule` / `snooze_schedule` | write | `schedule_id`, `until_date` or `until_value` |
| `add_warranty` | write | `thing_id`, `kind`, `ends_on` or `term_months`, `provider` |
| `open_claim` / `update_claim` | write | `thing_id`, `warranty_id`, `reference`, `status` |
| `adjust_stock` | write | `thing_id`, `delta` |
| `attach_link` | write | `subject_type`, `subject_id`, `role`; returns a short URL that opens the capture sheet |

No trash, delete, merge, ownership or secret-reveal tools (D58, D124).

### 2.6 Webhooks (D63, D110)

```json
{ "id": "evt_…", "event": "thing.moved", "occurred_at": "2026-10-01T09:12:00Z",
  "location_id": "…", "entity": { "type": "thing", "id": "…" },
  "changed_fields": ["place_id"], "actor": { "type": "user", "id": "…" } }
```

- **Events:** `thing.created`, `thing.updated`, `thing.moved`, `thing.trashed`, `thing.restored`,
  `thing.lifecycle_changed`, `reading.logged`, `reminder.due` (D172).
- **Payloads never contain values.** Receivers fetch the entity through the API with their own token.
- **Signed** with HMAC-SHA256 in `Kept-Signature: t=<unix>,v1=<hex>`.
- **Retries** with exponential backoff for up to 24 h, then the webhook is marked failing.

### 2.7 Web app manifest (D139, D140)

- **Share target:** `share_target` accepts `image/*` and `application/pdf` via POST
  multipart to `/share`, which creates a RECEIPT draft (or a THING draft for images when the user picks).
- **Display:** `display: standalone`; `theme_color` equals the pre-paint theme colour (L85).
- **Icons:** the Label-tape icons from D135, including maskable variants.

### 2.8 Insurance report and claim pack (D158)

- **Scope:** a location, or one incident, as of a date.
- **Per room or place:** each thing's photo thumbnail, name, brand, model, serial, purchase
  date and price, current value (latest valuation), and links to its receipts.
- **Totals** per room and per location, **per currency**; no conversion unless rates exist (D76).
- **Header:** "as of" date, location, owner, the incident reference if any.
- **Format:** print-styled HTML (D97), also CSV (D169).
- **Claim pack:** a ZIP with the report plus every referenced receipt, photo and serial list.
  Owners and admins only; shared by an expiring **export download link** (`export_runs`), not a
  `share_links` page, with an explicit warning (the one exception to D116).

## 3. Numbers

Defaults that are **tunable**. Performance targets are **targets to measure** before release,
not claims.

### 3.1 Performance targets (the floor: 2 GB RAM, 2 cores, amd64 or arm64, external AI provider; D85, D209)

| Measure | Target |
|---|---|
| Things per location that must stay fast | 10,000 (50,000 per instance) |
| Search, p95 at 10,000 things | < 300 ms server time |
| Thing page, p95 | < 200 ms server time |
| Offline snapshot build at 10,000 things | < 2 s |
| Idle memory, web + worker in one process | < 400 MB RSS |
| Cold start to ready | < 10 s |

### 3.1b Hostile-input and resource limits (D157, D166)

| Limit | Default |
|---|---|
| Import ZIP: total uncompressed size | 5 GB |
| Import ZIP: compression ratio per entry | 100 : 1 |
| Import ZIP: entries | 200,000; symlinks rejected |
| Image decode (sharp) | 100 megapixels; concurrency 1 under 3 GB RAM, 2 elsewhere |
| PDF parse (child process) | 20 s, 256 MB |
| Video upload | 500 MB (D170) |
| Unclaimed blank labels per location | 1,000 (D172) |
| DB pool (2 GB floor) | app role 10, owner role 3 |
| Job policies | extraction: 3 attempts, 90 s timeout, exponential backoff · reminders scan: 5 attempts, 60 s · import/export: 1 attempt, 2 h, resumable · webhook: 10 attempts over 24 h · backup: 2 attempts, 4 h |

### 3.2 Rate limits

| What | Limit |
|---|---|
| Sign-in attempts | 5/min per IP; per account **and** IP 20/hour, with progressive delays rather than lockout (D172) |
| Password reset / magic link | 3/hour per account |
| API and MCP per token | 120 reads/min, 30 writes/min |
| Share-link page views | 60/min per link |
| Outbound webhooks | 10/s per location |
| AI extraction | per the caps and budgets (D19, D206); 2 concurrent calls per paying account, **1 per Groq key** (§3.5), and the provider's own rate-limit headers |
| Barcode lookups (when enabled) | 1 per real scan; ≤ 15/min per instance (Open Food Facts' limit, D104) |

### 3.3 Retention

| Data | Kept for |
|---|---|
| Trash | 30 days, then purged |
| Audit events | 2 years (self-host configurable; included in exports) |
| Undo window (MCP and assistant) | 7 days (D58) |
| Assistant threads | 90 days (D23) |
| `llm_calls` (the AI call ledger) | 13 months, as monthly partitions dropped whole; monthly totals (`ai_usage_months`) 5 years. **No prompts or replies are stored at all** (D206) |
| Idempotency keys | 30 days |
| Webhook deliveries, reminder deliveries | 30 days / 1 year |
| In-app notifications | 90 days |
| Export files | 7 days after ready |
| Invites | 7 days (D33) |
| Share links | default 30 days, max 1 year |
| Support grants | default 48 h, max 7 days (D71) |
| Backups | 7 daily / 4 weekly / 6 monthly (D66) |

### 3.4 Domain defaults

| Setting | Default |
|---|---|
| Plausible distance per day | 1,500 km (car); 24 h/day for hour meters (D26) |
| Stale-reading nudge | 30 days (D52) |
| Reminder scan | every 15 min; "not scanned" admin alarm after 2 h (D166, D189) |
| Licence and document lead time | 30 days |
| Snooze to a meter value | default +10% of the interval |
| Long unseen | 12 months (D128) |
| Starter schedules (D52): editable defaults, not manufacturer advice | oil change 10,000 km or 12 months · tyre rotation 10,000 km or 12 months · brake fluid 24 months · air filter 20,000 km or 24 months |
| Photo derivatives | display 2048 px, thumbnail 400 px, share 1200 px (GPS stripped) |
| File size | 25 MB (D77) |
| Short-ID space | 32⁶ ≈ 1.07 billion codes |
| Session | 30-day sliding (D49) |
| Assistant proposal expiry | 10 minutes (D22) |
| Extraction auto-accept confidence | ≥ 0.6 for auto-accept kinds (§2.1) |
| Currencies | USD, CAD, GBP, EUR, EGP, plus any an instance admin enables (D168); location default required; EGP shown as "EGP" (en) / "ج.م." (ar) (D136) |

### 3.5 AI usage and spend (D206)

| Setting | Default |
|---|---|
| Ledger retention | 13 months (instance setting `ai_ledger_months`, 3–60); monthly totals 5 years |
| Cap warnings | at **80%** and **100%** of each money or token cap, once per cap per month |
| Caps by default | **none** at every scope |
| Suggested cap at setup | money: the larger of 5.00 and 3 × the projected month, in the chosen model's price currency, rounded up to a whole unit; tokens (when the model has no price): 3,000,000 a month (about 1,200 photos at ~2.5k tokens) |
| Cap period | calendar month, resetting at 00:00 UTC on the 1st (D188) |
| Per-task budgets when no row exists | extraction 60,000 tokens a minute, 2,000,000 a day, 20,000,000 a month per paying account (plan Q7) |
| Concurrent calls | 2 per paying account (§3.2); **1 per Groq key** (spike 2026-09-26) |
| Pacer | holds the next call when the provider's remaining tokens are below its estimate, until the provider's reset time; waits under 60 s are not ledger rows |
| Image token estimate | per provider from `@kept/shared` `ai.ts`; Groq 2,048 per image |
| Breaker | first 429: until `retry-after`, else 60 s, doubling to 1 h; key rejected: until replaced; 3 errors in 5 min: 5 min (L45) |
| Call timeout | 80 s |
| "What uses AI" figures | the scope's last 30 days per task, once it has ≥ 5 calls of that task; otherwise the dated spike figures |
| Call list | 20 per page, 200 maximum (§7.7) |
| CSV export | up to 100,000 rows per file; 5 exports an hour per person |
| Money display | "≈", 4 decimal places below 0.01, per currency |
| Monthly summary | on the 1st at 09:00 in the owner's timezone, for account owners with a key (opt-out) |

## 4. Accessibility (beyond "WCAG 2.2 AA", D78)

- **Target size:** touch targets are 44 × 44 px, above the 2.2 minimum of 24 px.
- **Dragging:** every drag has a non-drag alternative (Move to…), per 2.5.7.
- **Never colour alone** (1.4.1):
  - AI-suggested values carry an icon and the word "Suggested" as well as violet.
  - Uncertain locations say "uncertain".
  - Amber is only a fill, with dark text at 4.5:1 or better.
- **Capture with a screen reader:**
  - The shutter announces the mode.
  - Each capture announces "Captured. 12 waiting to sync" through a polite live region.
  - The mode strip is a labelled radio group; the file-picker fallback is always reachable.
- **Status messages** (sync, AI paused, saved) use live regions (4.1.3). Errors link to their fields.
- **Keyboard:**
  - Everything works from the keyboard on desktop, including the inbox's bulk review and the tree.
  - The focus ring is always visible, and focus is never trapped except inside modals, which
    return it on close.
- **Zoom and reflow** to 200% and 320 px wide without loss (1.4.10; the house rule of no horizontal
  scroll, L88).
- **Right-to-left** mirrors layout and icons with direction. Numbers, serials and short IDs stay
  left-to-right.
- **Motion** honours `prefers-reduced-motion` (D79).
- **Testing:**
  - Automated axe checks in the e2e suite.
  - A manual pass with VoiceOver (iOS), TalkBack (Android) and NVDA (Windows) before each minor
    release.

## 5. Error and empty states

| Screen / situation | What the user sees | Action offered |
|---|---|---|
| **Home, first run** | First run: the Personal card plus **Create your first home** (screens §8, D114) | Create your first home (templates, D33) |
| **Location, no things** | "Nothing here yet" | Capture your first three things |
| **Container, empty** | "Box 3 is empty" | Scan to add · Add here · Box check |
| **Unplaced has items** | "12 things need a place" (attention panel) | Sort them |
| **Inbox, empty** | "All reviewed" | – |
| **Search, no results** | "No match for 'hmdi'", with the closest names | Did you mean… · Ask the assistant |
| **Capture over HTTP** | Banner: "Camera, offline capture and install need HTTPS" (D31) | File picker · HTTPS guide |
| **Camera permission denied** | "Kept can't use the camera" | File picker · How to allow it |
| **Offline** | "Offline: 12 captures waiting" | – (sync on open and focus, D101) |
| **iOS with pending items** | Badge: "Open to finish syncing (12)"; warning before logout (D36) | – |
| **Sync item dropped** | "1 change couldn't apply: the drill was trashed by Alfred" (D35) | Restore |
| **Reading doesn't fit** | Inbox item: "52,340 km is lower than 53,100 on 12 Oct" | Keep, edit or discard · Meter replaced |
| **Scanned label not visible to you** | "Not in your Kept" (identical for missing and forbidden codes, D137) | Scan another · Add a new thing |
| **Someone else changed it** | "Alfred changed this since you opened it", with both values (D156) | Keep mine · Keep theirs · Edit |
| **Label already claimed** | "This label was claimed on another phone for 'Camping box'" (D112) | Open that box · Use another label |
| **AI not configured** | Capture shows the name field; extraction hidden (D19) | Set up AI (admins) |
| **AI budget paused** | "AI paused until 14:00 (budget)" | Budget settings (admins) |
| **AI provider error** | "Couldn't read this photo (provider error)" | Retry · Fill in by hand |
| **Module off (deep link)** | "Vehicles is off in this location" | Ask an admin · Settings (admins) |
| **No permission** | "You can view this location but not change it" | – |
| **Share link expired or revoked** | "This link has expired" | – (no account wall) |
| **Token revoked or expired** | `{error: "token_revoked", hint: "create a new token in Settings → Connections"}` | – |
| **Undo refused** | "Can't undo: Alfred changed the location since" (D124) | Open the thing |
| **Server unreachable** | "Can't reach Kept. Offline captures still work" | Retry |
| **Backup stale (admin)** | Status banner: "Last backup 3 days ago" (D66) | Open backups |
| **Recovery kit not downloaded (admin)** | Status banner (D66); required at the first secret value, AI key or backup setup (D193) | Download recovery kit |
| **Import dry-run problems** | Per-row report: mapped, as text, skipped, why | Adjust mapping · Import anyway |
| **Export ready / expired** | Notification with link / "expired, create a new one" | Download / Export again |
| **Vehicles, none** | "No vehicles yet" | Add a vehicle (registration card in LABEL mode, D52) |
| **Schedules, none** | "Nothing scheduled" | Starter schedules (D52) |

## 6. What this spec deliberately leaves to the build

- **Exact zod schemas and OpenAPI:** generated from code (D81).
- **Visual design:** the design session (D79).
- **Chart library:** visx (D133).
- **Extraction prompts per provider:** tuned against the evaluation set (D19, D129).
- **Final numbers:** everything in §3 is a default or a target to measure, revised by measurement.

## 7. Foundations (D178, D182–D186, D190)

These answer the questions a developer would stop and ask in build steps 1–3. Where this section
differs from a table row in §1, **this section wins**.

### 7.1 Database roles and connections (D178)

| Role | Login | Used by | Rights |
|---|---|---|---|
| `kept_owner` | yes | `kept migrate`, `kept admin`, and the worker's nightly backup when a target is set (T31c) | owns every schema; never in a pool or a request |
| `kept_app` | yes | request pool, including instance-admin routes (D190) | `NOBYPASSRLS`; DML on app tables; **FORCE RLS** on every table; may only send pg-boss jobs (§7.14) |
| `kept_auth` | yes | Better Auth (its tables live in schema `auth`) | DML on `auth.*` only; on the leak-test allowlist |
| `kept_system` | yes | cross-tenant jobs (reminder scan, purge, retention, membership expiry), pg-boss workers, the setup code at boot (D190) | explicit `system` policies, and a narrow `kept.list_locations_for_job()` function |

- **Scope setting:** each request and each tenant job runs in an explicit transaction with
  `set_config('app.user_id', …, true)`.
- **Fail closed:** policies deny when `app.user_id` is unset, so a missed wrapper returns nothing.
- **Job declarations:** each job type declares `tenant` (it re-assumes the enqueuing user's scope)
  or `system`.
- **The leak test** covers request, auth and worker code paths (L30).
- **Setup:** Compose ships an initdb script that creates the roles and extensions; Helm runs a
  pre-install Job; the docs give the SQL for managed Postgres. Which extensions a non-superuser
  can create there is verified per provider (§19, V31).

### 7.2 Row-level security (D178, D183)

- **One membership function:** `kept.visible_location_ids()` (`SECURITY DEFINER`, `STABLE`)
  returns active, unexpired memberships whose location isn't in its deletion grace (D149), and
  leaves out `require_2fa` locations while `app.mfa` is false (§7.14, D190). Every
  policy uses it, which also avoids the recursion of a policy on `memberships` reading `memberships`.
- **Policies enforce tenancy** on both USING and WITH CHECK, and block viewer writes as defence in
  depth. Finer role rules live in one app function, `can(user, action, location)`, built from §7.1
  of the product design.
- **Files are never visible directly.** A file is readable only through an `attachments` row the
  user can see (D177). `file_text` and `file_derivatives` follow their file. Export ZIPs carry
  `location_id` and aren't `files` rows.
- **Account registries:** visible by account (§1.1), except people's contact details and template
  payloads, which need admin in every location that uses them (D177).
- **Purchase lines after a move:** a line and its receipt are visible through the definer
  function `kept.thing_purchase(thing_id)`, or copied on a cross-account move (D161).
- **History after a move:** readable per entity; entries from before a move into this location
  are shown as "moved in from another location", with no diff (D183).
- **Operators that aren't leakproof lose their index under a policy.** Full text (`@@`),
  trigram (`%`, `<->`), `ILIKE` and JSON containment are not leakproof, so under RLS PostgreSQL
  won't use them as an index condition, and a query filtering on them over a large table scans
  every visible row. The step-2 benchmark measured it: a text search took 214 ms at
  10,000 things ([docs/perf/2026-09-26-rls-bench.md](../perf/2026-09-26-rls-bench.md)). Such a
  match goes through a `SECURITY DEFINER` door that runs it on the index and applies the
  caller's visibility itself (`kept.search_thing_ids()`, `kept.near_thing_names()`, 0030),
  listed in the leak test like every door. **Check any new query over a large table with
  EXPLAIN as `kept_app`, never as the owner**, which bypasses RLS and shows a plan the app
  never gets.

### 7.3 Keys and encryption (D182)

- **`KEPT_SECRET_KEY`:**
  - Set by the operator, or generated on first boot (D193): if `KEPT_SECRET_KEY` or
    `KEPT_AUTH_SECRET` is unset, the container generates both into the **config volume** (never
    the data volume) and logs one line saying where they are (§7.11). Boot refuses a supplied key
    under 32 bytes.
  - `kept admin gen-key` prints one. It is never stored in the database. The recovery kit is how
    the admin keeps a copy off the server.
- **Encryption:** AES-256-GCM with a per-row data key wrapped by the master key; `key_version`
  is stored with every ciphertext. The **AAD** binds each ciphertext to its row
  (`table|row_id|field_key`), so ciphertexts can't be swapped between rows.
- **What it covers:** secret field values, AI keys, channel configs, webhook secrets, mailbox
  credentials, VAPID private key, restic password.
- **Rotation:** `kept admin rotate-key` re-wraps every ciphertext. Old key versions stay in the
  recovery kit so old backups remain readable.
  - **The keyring:** the current key has a version (`KEPT_SECRET_KEY_VERSION`, default 1) and
    the retired keys keep theirs (`KEPT_SECRET_KEYS_RETIRED`, `version:key,…`). Generated keys
    keep both in the config volume's `secrets.json`, under the same names; a file without a
    version is version 1. The current key seals; every key in the ring opens.
  - **With keys in `secrets.json`**, rotate-key refuses if a stored value uses a version the ring
    lacks, then writes the new file first (new key current at the next version, the old one
    retired), then re-wraps every sealed column in batches of 500, one transaction each, and
    audits `instance.rotate_key`. A running server re-reads the file the first time it meets
    the new version; a restart makes it seal with the new key.
  - **With keys in the environment**, it prints the three variables to set and changes nothing;
    after a restart, `rotate-key --resume` re-wraps. `--resume` also finishes an interrupted
    run and re-wraps rows restored from an old backup.
  - **Every run prints the key versions the stored values use**, before and after.
    `rotate-key --drop <version>` removes a retired version from the keyring, and refuses while
    any stored value still uses it (run `--resume` first). It warns that backups sealed under
    that version need it from an old recovery kit, and audits `instance.drop_key`. With keys in
    the environment it prints the `KEPT_SECRET_KEYS_RETIRED` to set.
  - **Sealed columns** are registered in `secrets/rotate.ts` (`CIPHERTEXTS`); AI keys and
    channels add theirs there, and a test fails on a `ciphertext` or `key_version` column the
    registry doesn't list.
- **A separate `KEPT_AUTH_SECRET`** signs sessions and tokens, so the data key and the signing key
  can be rotated independently.

### 7.4 Sync protocol (D184)

- **Change sequence:** every mutable row gets a `change_seq` (bigint from one sequence, set by
  trigger). The server hands out only sequences below the oldest in-flight transaction
  (`pg_snapshot_xmin`), so a late commit is never skipped.
  - **As built (step 3, T12; plan Q1): an xid watermark, per location.** A sequence value can't
    be compared with a transaction horizon (a transaction that took `change_seq` 100 can commit
    after one that took 101), so `change_seq` orders and pages, and beside it every synced row
    (`places`, `things`, `short_ids`, `legacy_codes`, `sync_tombstones`; migrations 0035–0036)
    carries `change_xid xid8`: `pg_current_xact_id()` of the transaction that last moved its
    `change_seq`, set by `touch_row` (a quiet update, such as `search_tsv` only, keeps both), with
    a `(location_id, change_xid)` index per table.
  - **The cursor** (`sync/cursor.ts`) is opaque to the phone: base64url JSON plus an HMAC-SHA256
    signature, keyed by HKDF from `KEPT_AUTH_SECRET` (salt `kept-sync`, info `sync-cursor`). A
    cursor that doesn't verify, including one signed before the secret changed, is 400
    `validation`, and the phone starts a full pass keeping its queue. It holds `w`, one watermark
    per location from the last complete pass, and `p`, the pass in progress: its horizon `x`
    (`pg_snapshot_xmin(pg_current_snapshot())` taken at the pass's first page), the locations it
    reads with the watermark each started from, where the last page stopped, and the truncation
    cut past `SYNC_LIMITS.snapshotThings` (Q30).
  - **A pass** reads, table by table (places, things, codes, legacy codes, tombstones), the rows
    whose `change_xid` is at or after their location's watermark, in `(location, key)` order,
    `SYNC_LIMITS.snapshotPageDefault` rows a page. When it completes, every location it read
    takes the pass's horizon as its new watermark. A row changed after the pass read it carries a
    `change_xid` at or after that horizon, so the next pass reads it again; a duplicate is
    harmless (the phone upserts). A location the person joined since the last pass has no
    watermark and is read in full (`'0'`), trash and tombstones left out, so rows older than
    their access still arrive. A location no longer visible is listed in `revokedLocationIds`.
  - **Accepted side channel:** one global sequence means a member can read, from the gaps in
    their own locations' `change_seq`, roughly how much the rest of the instance writes (never
    who or what). Accepted: per-location sequences would add a counter row to every write.
- **Tombstones:** `sync_tombstones(location_id, entity_type, entity_id, change_seq)` records purges,
  merges, moves out of a location and lost access, so deletions reach phones (D156).
- **Endpoints:**
  - `GET /api/v1/sync/snapshot?cursor=` returns changes and tombstones per location, with an
    `as_of` time.
  - `PUT /api/v1/files/{client_file_id}` uploads first; idempotent on id + sha256.
  - `POST /api/v1/sync/ops` takes an ordered batch of up to 50 ops, one transaction per op, each
    answered `applied` · `needs_review` · `dropped` (with a reason, including `parent_dropped`
    for an op whose parent failed).
- **Queue ops skip the `row_version` check;** D35 ("latest wins, visibly") applies to them.
- **Payload versions** follow D148.

### 7.5 Audit implementation (D184)

- **Writes:** every write goes through one app helper, `audited(tx, event)`. A route-catalogue
  test fails CI if any non-GET route can finish without an audit row (D188).
- **Diff shape:** `{field: {before, after, class}}`, where `class` is plain · money · secret.
  - Secret changes store `{changed: true}` only.
  - Classes come from a static map, plus `type_fields.kind = 'money'`.
- **Linking to things:** `root_thing_id` on the event. `audit_event_subjects(event_id, thing_id)`
  fans a container move out to its contents ("moved with Box 3", D45).
- **Rendering:** one `renderAudit(event, viewer)` feeds every view (history, feed, MCP, undo,
  webhooks), applying D110 and D177.

### 7.6 Modules (D184)

- **Registry:** `packages/shared/modules.ts` declares for each module: id, dependencies, route
  tags, tools, built-in fields, reminder sources and nav entries. Insights is part of Money.
- **Routes:** each route carries `config.module`. A preHandler resolves the target location from
  params or body and returns 404 `module_off` for a read, 409 `module_off` for a write.
- **Responses:** serialisers strip gated fields per row's location.
- **Effective state:** enabled ∧ dependencies met ∧ (provider resolved, for the AI modules).
- **Hidden modules:** `user_hidden_modules` affects only that user's UI and notifications.
- **Pausing:** derived at scan time, never stored. A source whose subject is trashed, or whose
  module is off, is skipped. On resume, only the current due period is created.

### 7.7 API conventions (D184)

- **URLs:** `/api/v1/locations/{id}/…` for location-scoped collections; `/api/v1/things/{id}` and
  similar for direct access.
- **Concurrency:** `If-Match: <row_version>` on writes; 412 carries the conflicting fields (D156).
- **Undo (D150):** a write that recorded an undoable change answers `X-Kept-Audit-Event: <event
  id>`, the id the Undo toast sends to `POST /api/v1/audit/{eventId}/undo`. A write that changed
  several things undoably (a bulk move) lists one id per thing, comma-separated in write order;
  a write with nothing undoable (a create, an undo itself) sends no header. An `Idempotency-Key`
  replay sends the same value (`apps/server/src/http/write.ts`, `AUDIT_EVENT_HEADER`).
- **Money on the wire:** every amount leaves in one canonical form, `parseAmount()`'s (`"150"`,
  `"1250.5"`; never `numeric(16,4)`'s `"150.0000"`), via `canonicalAmount()` /
  `canonicalMoney()` in `packages/shared/src/money.ts`; amounts sent in are stored canonical too.
- **Pagination:** cursor-based, 20 per page, 200 maximum.
- **Errors:** one error-code enum in `packages/shared`.
- **Visibility:** anything invisible under RLS returns **404**, the same as a missing row; a
  visible read-only resource returns **403**.
- **Identifiers:** client-supplied UUIDv7s are accepted only within ± 7 days of now. A duplicate
  id returns the same error whether or not the row exists elsewhere (D178).

### 7.8 Capture, inbox and extraction (D184)

- **`extractions.status`:** queued · running · succeeded · failed · paused_budget · waiting_provider · no_provider · superseded. `paused_budget` is a cap or budget (with `paused_until` and the cap that paused it); `waiting_provider` is the provider's rate limit, an open breaker or a rejected key (D206, §7.15).
- **`things.field_status`:** `{field: {state: extracted|confirmed|manual, confidence, extraction_id}}`.
- **`inbox_items`:** `id`, `location_id`, `kind` (draft · reading · label_claim · currency ·
  duplicate · receipt · sync_drop), `subject_type`, `subject_id`, `created_by`, `batch_id`,
  `resolved_at`.
- **Drafts:** `things.name` may be null only while `review_state = 'draft'`. A RECEIPT capture
  creates a draft purchase (`purchases.review_state`).
- **Registries from AI:** brands the AI proposes are created with normalised dedupe; vendors wait
  for review.

### 7.9 Built-in types and search (D184)

- **Built-in types:** `types.builtin_key` is stable. An idempotent seed step inside `kept migrate`
  upserts the library (D154). Things may reference built-ins directly. **Customise** copies the
  type into the account and re-points that account's things in one audited transaction. Names come
  from translation keys unless overridden.
- **Device field group (D192, refining D154):** the built-in types TV / display, phone, tablet,
  computer and network device share one field group, seeded once and referenced by each type:

  | Field | Kind | Notes |
  |---|---|---|
  | OS | text | |
  | OS version | text | |
  | Firmware | text | |
  | MAC address | text, repeatable | Wi-Fi and Ethernet |
  | Linked account or login | text, **secret** | the account the device is tied to |
  | IMEI | text | phone and tablet only |

  The group replaces the separate MAC and operating-system fields D154 listed on computer and
  network device; their other fields (licence key, Wi-Fi password, screen size) stay on the type.
- **Search index:** a single move refreshes that thing inline. Renaming or re-parenting a place,
  a container or a registry entry enqueues a debounced `reindex` job per location.
  **Cache columns** (`place_path`, `search_tsv`, `last_seen_at`) don't bump `row_version` or write
  audit rows (D183).
- **Arabic normalisation:** an IMMUTABLE SQL `kept.normalize()` with a JS twin for the phone,
  both checked against shared test vectors (D42).

### 7.10 Auth details (D176, D184)

- **IDs:** Better Auth is configured to issue UUIDv7 ids.
- **Instance admins:** an `instance_admins` table, checked by `kept.is_instance_admin()` (§7.14).
- **Invites:** link invites are single-use; an email invite binds to that address.
- **Account creation:** two steps across two logins (D190, refining D184). Better Auth creates the
  user as `kept_auth`; then `ensureAccount()` creates the account, the Personal location (preset
  **Household**, D191), its Unplaced area and the owner membership in one `kept_app` transaction
  (§7.14).
- **Managed usernames** are unique per instance.
- **Rate limiting:** shared across replicas through the database. Better Auth's support for a
  database store is verified in a spike (§19, V32).
- **Setup code:** 6 characters (screens §8). Generated by the web process at boot as
  `kept_system`, under an advisory lock, and inserted once behind a unique constraint; printed by
  the process that inserted it, so it appears in `docker logs`; never generated by the migrate
  job; re-issued only through the CLI (D190).

### 7.11 Environment contract (D186)

| Variable | Default | Notes |
|---|---|---|
| `KEPT_DATABASE_URL` | — | `kept_app` login (required) |
| `KEPT_AUTH_DATABASE_URL` | — | `kept_auth` login (required) |
| `KEPT_SYSTEM_DATABASE_URL` | — | `kept_system` login (required for workers) |
| `KEPT_OWNER_DATABASE_URL` | — | for `kept migrate` / `kept admin`, and on a worker with a backup target (the dump runs as kept_owner, T31c) |
| `KEPT_SECRET_KEY` · `KEPT_AUTH_SECRET` | generated on first boot | if either is unset, both are generated into the config volume and one log line says where (D193); values the operator sets are used as given; see §7.3. Rotating `KEPT_AUTH_SECRET` invalidates every phone's sync cursor: the snapshot answers 400 and the phone recovers with a full pull (its queue is kept) |
| `KEPT_SECRET_KEY_VERSION` | `1` | the version of an operator-set `KEPT_SECRET_KEY`; `kept admin rotate-key` says what to set. With generated keys, secrets.json holds it under the same name (§7.3) |
| `KEPT_SECRET_KEYS_RETIRED` | empty | earlier `KEPT_SECRET_KEY` versions, as comma-separated `version:key` pairs: they still open values and backups sealed before a rotation. Only beside an operator-set key; generated keys keep them in secrets.json. Never logged |
| `KEPT_PUBLIC_URL` | — | required; the source of truth for links and QR codes |
| `KEPT_TRUSTED_PROXIES` | empty | comma-separated IPs and CIDR ranges of reverse proxies whose `X-Forwarded-For` is believed, walked from the right to the first untrusted hop; empty means the socket address is the client. Feeds every per-IP limit (§3.2) |
| `KEPT_ROLE` | `all` | `all` · `web` · `worker` |
| `KEPT_STORAGE` | `local` | `local` · `s3` (+ `KEPT_S3_*`) |
| `KEPT_S3_ENDPOINT` | empty | S3 endpoint URL; empty for AWS itself |
| `KEPT_S3_PUBLIC_ENDPOINT` | empty | the S3 endpoint the browser reaches, when it isn't `KEPT_S3_ENDPOINT` (the server talks to the store inside Compose; the phone needs its public host). Presigned URLs are signed for it; empty means `KEPT_S3_ENDPOINT` |
| `KEPT_S3_REGION` | `us-east-1` | S3 region |
| `KEPT_S3_BUCKET` · `KEPT_S3_ACCESS_KEY_ID` · `KEPT_S3_SECRET_ACCESS_KEY` | — | required when `KEPT_STORAGE=s3`; the secret is never logged |
| `KEPT_S3_FORCE_PATH_STYLE` | `false` | `true` for path-style URLs (RustFS, MinIO, most self-hosted S3) |
| `KEPT_MAX_FILE_MB` | `25` | the largest file one upload may be (§3.4) |
| `KEPT_IMAGE_CONCURRENCY` | `1` with under 3 GB of RAM (any architecture, D209), else `2` | images resized at once, process-wide (derivatives are made in the upload request) |
| `KEPT_SMTP_URL` | empty | optional |
| `KEPT_SMTP_FROM` | `Kept <no-reply@` + the public URL's host + `>` | the From of every mail; set it to an address your SMTP server may send as |
| `KEPT_VAPID_PUBLIC_KEY` · `KEPT_VAPID_PRIVATE_KEY` | generated on first use | web push's VAPID pair (base64url, 65 and 32 bytes), both or neither, overriding the stored pair. Unset, the pair is generated once, under an advisory lock, and kept in `instance_settings` (`vapid`), the private key sealed with the envelope key (§7.3; step-4 Q11); `kept admin rotate-key` re-wraps it. The private key is never logged. Losing the pair only means each device subscribes to push again |
| `KEPT_VAPID_SUBJECT` | `KEPT_PUBLIC_URL` when it is `https:`, else `mailto:` the `KEPT_SMTP_FROM` address | who push services contact: an `https:` URL or a `mailto:` address. With none of the three, push is unavailable and Settings says so |
| `KEPT_SIGNUP_OPEN` | empty | `true` · `false`; when set, locks sign-up open or closed and the admin setting shows as locked |
| `KEPT_LOG_LEVEL` · `KEPT_LOG_FORMAT` | `info` · `json` | `pretty` for `docker logs` |
| `KEPT_SOURCE_URL` | the image's OCI `source` + `revision` labels | forks override it (D147) |
| `KEPT_SETUP_CODE` | generated | app stores may preset it (D107) |
| `KEPT_BACKUP_DIR` | empty | the nightly backup's target directory (T31c, D207): absolute, outside `KEPT_DATA_DIR` (refused inside it), ideally another disk. Unset with no bucket: nothing is backed up and the status page says "No backup configured" |
| `KEPT_BACKUP_S3_BUCKET` | empty | the backup's target bucket instead (+ the `KEPT_BACKUP_S3_*` below); an existing bucket, never created by Kept. One target, not both. A worker with a target also needs `KEPT_OWNER_DATABASE_URL`: the dump runs as kept_owner, on its own connection per run (boot refuses otherwise) |
| `KEPT_BACKUP_S3_PREFIX` | `kept-backups/` | where in the bucket the backups go |
| `KEPT_BACKUP_S3_ENDPOINT` · `KEPT_BACKUP_S3_REGION` · `KEPT_BACKUP_S3_FORCE_PATH_STYLE` | empty · `us-east-1` · `false` | as `KEPT_S3_*`, for the backup bucket |
| `KEPT_BACKUP_S3_ACCESS_KEY_ID` · `KEPT_BACKUP_S3_SECRET_ACCESS_KEY` | — | required with `KEPT_BACKUP_S3_BUCKET`; the secret is never logged |
| `KEPT_BACKUP_KEEP` | `7` | backups kept (1–366); older runs, and files only they held, are removed |
| `KEPT_BACKUP_TIME` | `02:30` | when the nightly backup starts, `HH:MM` UTC |
| `KEPT_CONFIG_DIR` | `/config` | the config volume: it holds only the generated `KEPT_SECRET_KEY` and `KEPT_AUTH_SECRET` (D193) |
| `KEPT_DATA_DIR` | `/data` | the data volume: local file storage |
| `KEPT_METRICS_TOKEN` | empty | optional bearer token required to read `/metrics` |
| `KEPT_AI_MOCK` | `0` | `1`: every AI call is answered by the mock provider (`ai/mock.ts`: tests, the e2e run, development), never a real one. **Refused in production:** with `NODE_ENV=production` the boot fails (`ai_mock_in_production`), and ci-local's `prod-boot` step asserts it. The mock looks an answer up by the SHA-256 of the image it is sent; with none it gives each mode's default answer |
| `KEPT_BARCODE_LOOKUP` | empty | `true` · `false`; when set, locks barcode lookup (Open Food Facts, Open Products Facts, Open Beauty Facts: up to three outbound requests for an unknown code, D104, D126) on or off, and the admin setting shows as locked. Unset, the admin setting decides; it is off by default |
| `KEPT_BARCODE_CONTACT` | empty | an email for the barcode lookup's User-Agent, as Open*Facts asks (D104); unset, the admin's `barcode_contact` setting |
| `KEPT_EVAL_DIR` | empty | the extraction evaluation only (`pnpm eval:extraction`, `apps/server/eval/`): the folder of labelled photos when `--dir` isn't given; unset and no `--dir`, the run says `skipped` and exits 0. The server never reads it. A real provider's key comes from `KEPT_EVAL_API_KEY` alone (never an argument or a file, never printed) |

- **Precedence:** environment variables win over `instance_settings`; the UI shows env-set values
  as locked.
- **Volumes (D193):** a **data volume** (local file storage) and a separate, small **config volume**
  that holds only the generated `KEPT_SECRET_KEY` and `KEPT_AUTH_SECRET`. The config volume is never
  inside the data volume and is ignored when both variables are set. Losing it
  without the recovery kit makes secret values unreadable, which is why the kit is required at the
  first secret value, AI key or backup setup (D193).
- **HTTPS (D193):** the Compose file ships an optional reverse-proxy profile, and the docs cover a
  Tailscale route. The proxy image is chosen at build time and its tag verified on the registry.
- **Generated reference:** `kept admin config` prints the reference from the schema (D81).
- **Test and CI tooling only** (not the server's): `KEPT_TEST_WORKERS` (vitest's workers),
  `KEPT_TEST_S3_URL`, `KEPT_E2E_INSTANCES` (the e2e servers to start, e.g. `capture`),
  `KEPT_E2E_UPDATE` (runs the update-prompt e2e, which edits the served `dist/sw.js`) and
  `KEPT_EVAL_ARGS` (ci-local's real evaluation run, with `KEPT_EVAL_DIR`).
- **Serving files (D157, Q16):** every file is fetched through a five-minute signed URL. On local
  storage that is `/f/<token>`, a route that reads no session and answers with
  `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, and
  `Content-Disposition: attachment` for originals (`inline` only for the re-encoded JPEG
  derivatives). **On S3 those headers can't all be carried:** a presigned GET can override
  `Content-Type`, `Content-Disposition` and `Cache-Control` (`response-content-*`), but not
  `nosniff` or a CSP. The mitigation is the origin: the bucket is served from its own host
  (`KEPT_S3_PUBLIC_ENDPOINT`), never Kept's, so a file that did render there has no Kept cookie
  or storage to reach; and originals still download as attachments. An operator who fronts the
  bucket with a proxy can add the two headers there.

### 7.12 Development, tests, CI, migrations (D185)

- **Local development:**
  - `compose.dev.yaml`: Postgres 18 + pgvector on **5452**, Mailpit on 8025 and 1025, local file
    storage.
  - No dev proxy: the server (`tsx watch`, on 8080) serves the built web app (`apps/web/dist`),
    rebuilt to see a web change. `vite dev` alone runs the web app on the in-memory demo API
    (`?demo=owner` and the other scenarios).
  - Phone testing over HTTPS with mkcert or a Tailscale certificate (D31).
  - Ports chosen to avoid 5442 and 5433, used by other apps on the development machine.
- **Tests:**
  - A template database cloned per Vitest worker.
  - Roles created once per cluster.
  - pg-boss runs inline.
  - `TZ=Africa/Cairo` pinned (L3).
- **CI jobs:**
  - Lint and typecheck · unit · integration + leak test + route catalogue.
  - Migration drift and ordering (L95, L98).
  - Licence allowlist (D187) · attribution check (D173).
  - A production-config run with OTel pointed at a dead collector (L90).
  - amd64 and arm64 image builds, with the arm64 smoke suite on a native arm runner (L103).
  - Every job gates on exit codes only, never on a printed summary (L89).
- **Migrations:**
  - drizzle-kit for tables; **custom SQL migrations** for functions, triggers, roles and policies.
  - `kept migrate` wraps them in `pg_advisory_lock`.
  - Enums are **text + CHECK**, not Postgres enums, so a one-version rollback survives new values
    (D183). Unknown values parse to a fallback in zod.

### 7.13 Integrity amendments to §1 (D183)

- **Scope columns added:**
  - `location_id` on `thing_tags`, `incident_things`, `service_completions`, `move_boxes`,
    `webhook_deliveries`.
  - `user_id` on `assistant_messages`.
  - `owner_account_id` on `type_fields` and `audit_events`.
- **Keys re-scoped to the tenant:**
  - `import_source_ids` UNIQUE (`location_id`, `source`, `source_id`).
  - `legacy_codes` PK (`location_id`, `source`, `source_collection`, `code`).
  - `idempotency_keys` PK (`user_id`, `key`), comparing `request_hash`.
  - `token_locations(token_id, location_id)` replaces `api_tokens.location_ids`, with ON DELETE
    CASCADE; a token whose last row goes is revoked.
- **Parent consistency:**
  - Parents expose UNIQUE (`location_id`, `id`); children use composite foreign keys
    (`location_id`, `x_id`) with **ON UPDATE CASCADE**, so a cross-location move carries
    `location_id` down.
  - A trigger requires a registry's `owner_account_id` to match the location's owner account, or
    be null for built-ins.
- **Typed subjects:** polymorphic `subject_type`/`subject_id` becomes typed nullable columns
  (`thing_id`, `place_id`, `location_id`, `incident_id`, …) with `CHECK num_nonnulls(…) = 1`, on
  `attachments`, `service_records`, `schedules`, `expiring_documents`, `reminder_occurrences` and
  `share_links`. Attachments can also belong to incidents, valuations, expiring documents and
  fuel entries.
- **ON DELETE:**
  - CASCADE from things to meters, readings, warranties, loans, valuations, schedules and stock rules.
  - SET NULL for `purchase_line_id`, `split_from_id`, `claims.warranty_id`, `claims.incident_id`,
    `belongs_to_person_id`.
  - RESTRICT on `container_id` and `places.parent_id`.
- **Short IDs are never deleted.** Purged targets turn their codes into `retired` tombstones, so no
  code is ever reissued (D45). The exactly-one-of check is relaxed when `state = 'retired'`.
- **Ownership consistency:** a deferred constraint trigger keeps `locations.owner_account_id` and
  the `owner` membership in agreement.
- **Quantities and precision:**
  - `quantity numeric(12,3)`, ≥ 0, and > 0 unless the type is consumable (D183).
  - Money columns become `numeric(16,4)`, rounded to `currencies.minor_units` at the edges (L5).
  - Precision elsewhere:

    | Column | Type |
    |---|---|
    | fuel `amount` | numeric(10,3) |
    | meter `value`, `offset` | numeric(14,3) |
    | line quantities | numeric(12,3) |
    | `fx_rates.rate` | numeric(18,8) |
- **Currencies:** a **foreign key** to `currencies(code)`, not a CHECK. Amount and currency are
  null together, and amounts are ≥ 0.
- **Lifecycle** adds `returned_to_owner`, which ends a borrowed-in thing (D56).
- **Secrets:**
  - `secret_values` keeps versions: `superseded_at`, and unique current per (`thing_id` or `place_id`, `field_key`).
  - Place fields can be secret.
  - Converting a field to secret moves its values and scrubs `custom`, `search_tsv` and past
    audit diffs.
  - `reveal_roles`, `reveal_people` and `ai_allowed` move from `type_fields` to
    `secret_field_policies(location_id, type_field_id, reveal_roles, reveal_people, ai_allowed)`,
    writable only by the location owner (D177); `type_fields.secret` stays.
- **Reminders:**
  - `due_period` is a deterministic key: `date:YYYY-MM-DD` or `meter:<value>`.
  - Uniqueness: UNIQUE NULLS NOT DISTINCT (`thing_id`, `place_id`, `location_id`, `source_type`,
    `source_id`, `kind`, `due_period`).
  - Occurrences gain states `superseded` and `cancelled`.
  - The scan cancels open occurrences that no longer match their source.
  - Terminal lifecycles pause the thing's sources.
- **New tables:**
  - `saved_views(owner_user_id, location_id null, name, query jsonb, shared bool)`.
  - `place_kinds(owner_account_id, key, name, icon)` with `place_kind_fields`.
  - `ai_model_prices(provider, model, input_per_mtok, output_per_mtok, currency)`, **versioned** by D206 (§7.15).
  - `inbox_items` (§7.8), `sync_tombstones` (§7.4), `instance_admins`, `token_locations`,
    `secret_field_policies`, `box_check_lines`.
- **New columns:**
  - `ai_budgets.monthly_cap_amount` and `cap_currency`; `llm_calls.cost_currency` (the full D206 columns: §7.15).
  - `things.acquired_from`, `provenance_notes`.
  - `types.default_warranty_months`; `locations.successor_user_id`.
  - `attachments.url` (link attachments, with `file_id` nullable).
  - `expiring_documents.superseded_by_id`.
  - `location_modules.enabled_at`.
  - `derivative` variant `poster`.
  - Import source `lubelogger_csv`.
- **Other constraints:**
  - One open loan per thing (partial unique).
  - One primary short ID per thing.
  - A Crockford regex CHECK on `code`.
  - `thing_links` UNIQUE (from, to, kind) and from ≠ to.
  - `type_fields` UNIQUE (`type_id`, `key`), plus a trigger against redefining inherited keys.
  - `fx_rates` PK (`owner_account_id`, from, to, `valid_from`).
  - The Unplaced area can't be trashed or re-parented.
  - A place-loop trigger.
  - `reminder_deliveries.channel` references `notification_channels.id`. A person's email channel
    is a row like the others, made lazily the first time it is needed (an email due to them, or
    their Notifications settings); a managed account never gets one (step-4 Q13).
  - `notification_preferences.location_id` is nullable, null only for the account-level kind
    `ai_summary` (a CHECK), and the key is `UNIQUE NULLS NOT DISTINCT (user_id, location_id, kind,
    channel)` (step-4 Q35).
  - A trigger enforcing D10 (quantity 1 when serialized, metered or under warranty, resolved
    through inheritance).
  - `warranties`: `lifetime` excludes an end date or term, and a generated `effective_ends_on`
    column.
  - `report_runs.kind` is `inventory`, `insurance` or `vehicle_history` (a CHECK from
    `REPORT_KINDS`, packages/shared/src/household.ts), and `report_runs.thing_id` is set exactly
    when the kind is `vehicle_history`, with a `location_id` (step-5 Q17).
  - `fuel_entries`, `service_records`: one owner per reading (a partial unique index on
    `meter_reading_id`, step-5 Q11); a fill's reading must be on the fill's thing (a trigger,
    `fuel_entries_reading_thing`).
- **Documents link one way:** through `attachments` rows only.
  - Removed: `proof_attachment_id`, `document_attachment_id`, `expiring_documents.attachment_id`.
  - Kept: `extractions.attachment_id` (the extraction's input).
- **Files:** `files` gains `location_id`; UNIQUE (`location_id`, `sha256`) (D177). Cross-account
  copies share the stored blob by reference count (D161).
- **Box checks count quantities (D175):** `box_check_lines(box_check_id, thing_id, expected_qty,
  found_qty)` replaces the `found`/`missing` uuid arrays. Like every child table it also carries
  `location_id`.
- **Time columns:**
  - `schedules.anchor_on` is a date.
  - A reading from a service takes `taken_at` = the service date at 12:00 in the location's timezone.
  - "Member until 12 Oct" ends at 23:59:59 in the location's timezone.
- **Append-only tables have no `row_version`:** `audit_events`, `llm_calls`, the deliveries,
  `notifications`, `idempotency_keys`.
- **Indexes:**
  - GIN on `search_tsv`; trigram on normalised name, aliases and serial; all partial on
    `deleted_at IS NULL`.
  - `things(place_id)`, `things(container_id)`, `places(parent_id)`; `things(location_id, serial)`
    and `(location_id, barcode)`.
  - `things(location_id, last_seen_at) WHERE lifecycle = 'in_use'`; partial indexes for uncertain,
    draft and `expires_on`.
  - `warranties(effective_ends_on)`, `expiring_documents(expires_on)`, `loans(due_on) WHERE open`,
    `meter_readings(meter_id, taken_at)`.
  - Audit on (`location_id`, `entity_type`, `entity_id`, `at` desc), (`location_id`, `at` desc)
    and (`actor_type`, `actor_id`, `at`).
  - `short_ids(thing_id)`, `short_ids(place_id)`, `legacy_codes(source, code)`, `files(storage_key)`,
    `memberships(user_id)`.
  - **Monthly partitions** on `audit_events` and `llm_calls`.
- **Changing identity:** converting a place ↔ container rewrites every reference in one
  transaction (short IDs, attachments, schedules, documents, occurrences, legacy codes, audit
  subjects).

### 7.14 Build-start answers (D190)

The questions a developer would hit on the first day of step 1. Where this differs from §7.1–§7.13,
this subsection wins.

- **Roles at runtime:**
  - Instance-admin routes run on `kept_app`, like every other request. Instance-scope RLS
    policies are gated by a `SECURITY DEFINER` function, `kept.is_instance_admin()`, which reads
    `instance_admins` for `app.user_id`.
  - `kept_owner` never serves requests; it is used only by `kept migrate` and `kept admin` (§7.1).
- **Account creation spans two logins, so it is two steps, not one transaction** (refines D184):
  1. Better Auth, on `kept_auth`, creates the user.
  2. `ensureAccount()` runs in **one `kept_app` transaction**: from Better Auth's user-created hook,
     and again, idempotently, on every authenticated request. It creates the owner account, the
     Personal location (preset Household, D191), its Unplaced area and the owner membership, and
     consumes any invite.
  - A `system` job repairs orphaned auth users: a user row with no owner account gets one.
- **pg-boss:**
  - `kept migrate` installs the pg-boss schema as `kept_owner`; pg-boss starts with its own
    migrations **off**.
  - `kept_app` may only **send** jobs, so a request can enqueue inside its own transaction (D94).
  - `kept_system` has the worker rights.
- **Setup code:** the web process generates it at boot as `kept_system`, under an advisory lock, so
  it appears in `docker logs`. The one-shot migrate job does not generate it. It is 6 characters
  (screens §8). Details in §7.10.
- **Location "require two-factor"** (`locations.require_2fa`):
  - A passkey with user verification counts as two-factor.
  - A member who hasn't enrolled can still sign in, but that location is hidden until they enrol.
  - The scope wrapper sets `app.mfa` alongside `app.user_id`, and `kept.visible_location_ids()`
    (§7.2) leaves out `require_2fa` locations when it is false.
- **Step-1 sequencing** (refines the build order; D185 moved currencies to step 2, this brings the
  table forward):
  - The `currencies` table is seeded in step 1, because `locations.currency` needs it.
  - A minimal `places` table ships in step 1, for the Unplaced area.
  - Step 1 ships the crypto module (§7.3) and the audit `secret` diff class (§7.5);
    `secret_values` lands with `things` in step 2.
  - The design tokens (D131), shipped fonts, Lingui with EN and AR, RTL logical CSS, the V16 spike
    and about 8 primitives move into step 1, because step 1 has screens.
- **Generic OIDC** is built in step 6, alongside the OAuth provider.
- **Spikes run first, in this order**, each proven before anything depends on it:

  | Spike | Proves | Size |
  |---|---|---|
  | **S0** | From the registries, never assumed: the pgvector PG18 glibc image tag, the current Better Auth release, the Node LTS, and whether Drizzle 1.0 is GA or still RC | ½ day |
  | **S1 (V33)** | Better Auth on the Drizzle adapter in schema `auth`, logging in as `kept_auth` with UUIDv7 ids; pg-boss with its migrations off under non-owner roles | — |
  | **S2 (V32)** | Two-factor enforced on password, magic link, passkey and OIDC; a DB-backed rate limiter shared by two processes. If Better Auth gates only password sign-in, Kept builds its own "2FA pending" session gate | — |
  | **S3 (V14)** | Managed accounts | — |
  | **S4 (V16)** | The aria base | — |

- **New assumption V33** (§19 of the product design): "Better Auth runs on the Drizzle adapter in
  its own schema under a non-owner login role with UUIDv7 ids; pg-boss runs with migrations
  disabled under non-owner roles". Links D100, D176, D190. Verified by spike S1. Blocks build
  step 1.

### 7.15 AI keys, usage, spend and the call ledger (D206)

The product side is the product design §8a; the numbers are §3.5. **Where this differs from
§1.8, §3.3 or §7.13, this subsection wins.** Step 3 builds it (plan tasks 6, 8, 9, 10, 29, 29a).

**Providers.**
- `ai_providers.kind` ∈ `openai` · `anthropic` · `google` · `openrouter` · `groq` ·
  `openai_compatible` (D202). `scope` ∈ instance · account · user. **There is no location
  scope**, and none is added.
- The concurrency a key allows comes from its kind: **1 for `groq`**, 2 otherwise (§3.5).
- Pasting a key whose prefix `detectKind` reads as `groq` pre-selects the extraction model from
  `DEFAULT_MODELS.groq` (`qwen/qwen3.8-27b`, `asOf` 2026-09-26), when the provider's model list
  still offers it (D202).

**Caps and budgets: `ai_budgets`.** One table for the per-task budgets (D19) and the monthly
caps (D167, D206).

```sql
CREATE TABLE ai_budgets (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  scope text NOT NULL CHECK (scope IN ('instance','instance_account','account','location','member','user')),
  owner_account_id uuid REFERENCES owner_accounts(id) ON DELETE CASCADE,
  location_id uuid REFERENCES locations(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth."user"(id) ON DELETE CASCADE,
  task text CHECK (task IN ('extraction','assistant','embeddings')),      -- null: every task
  tokens_per_minute int CHECK (tokens_per_minute > 0),
  tokens_per_day int CHECK (tokens_per_day > 0),
  tokens_per_month bigint CHECK (tokens_per_month > 0),                   -- the monthly token cap
  monthly_cap_amount numeric(16,4) CHECK (monthly_cap_amount >= 0),       -- the monthly money cap
  cap_currency char(3) REFERENCES currencies(code),
  paused_until timestamptz,
  paused_reason text CHECK (paused_reason IN ('manual','cap_money','cap_tokens','tokens_day')),
  warned_80_month date, warned_100_month date,    -- the month each warning went out: once per month
  set_by uuid NOT NULL, …mutable,
  CHECK ((monthly_cap_amount IS NULL) = (cap_currency IS NULL)),
  CHECK ((paused_until IS NULL) = (paused_reason IS NULL)),
  CHECK (CASE scope
    WHEN 'instance'         THEN owner_account_id IS NULL AND location_id IS NULL AND user_id IS NULL
    WHEN 'instance_account' THEN location_id IS NULL AND user_id IS NULL      -- account null: the default for every account
    WHEN 'account'          THEN owner_account_id IS NOT NULL AND location_id IS NULL AND user_id IS NULL
    WHEN 'location'         THEN owner_account_id IS NOT NULL AND location_id IS NOT NULL AND user_id IS NULL
    WHEN 'member'           THEN owner_account_id IS NOT NULL AND location_id IS NULL AND user_id IS NOT NULL
    ELSE owner_account_id IS NULL AND location_id IS NULL AND user_id IS NOT NULL END),
  CHECK ((tokens_per_minute IS NULL AND tokens_per_day IS NULL)
         OR (scope IN ('instance','account') AND task IS NOT NULL)),   -- minute and day budgets are D19's, per task
  UNIQUE NULLS NOT DISTINCT (scope, owner_account_id, location_id, user_id, task));
```

- A trigger requires a `location` row's `owner_account_id` to be the location's owner account.
- **Who writes:** `instance` and `instance_account`: an instance admin. `account`, `location` and
  `member`: the account's owner (`owner_account_id = kept.current_owner_account_id()`). `user`:
  that person. Policies on both USING and WITH CHECK.
- **Who reads:** the writers; a location's admins read its `location` row; a person reads their
  own `member` row. The pause state reaches everyone else through `kept.ai_status` only.
- **A location cap above its account's cap** in the same unit is refused by the API (400
  `cap_above_account`). Lowering the account cap below a location cap is allowed; the location
  row is flagged "capped by the account" and the tightest cap still wins.

**Counters** (definer-only, like the plan's step-3 counters; RLS forced, `owner_all` only):

```sql
CREATE TABLE ai_usage_windows (          -- tokens and calls per bucket
  bucket text NOT NULL,                  -- 'instance', 'instance:<task>', 'instance_account:<acct>',
                                         -- 'account:<acct>', 'account:<acct>:<task>', 'location:<loc>',
                                         -- 'member:<acct>:<user>', 'user:<user>'
  window_kind text NOT NULL CHECK (window_kind IN ('minute','day','month')),
  window_start timestamptz NOT NULL,
  tokens bigint NOT NULL DEFAULT 0, calls int NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_kind, window_start));
CREATE TABLE ai_cost_windows (           -- money per bucket, month and currency; never converted here
  bucket text NOT NULL, month_start date NOT NULL, currency char(3) NOT NULL,
  amount numeric(16,6) NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, month_start, currency));
CREATE TABLE ai_leases (                 -- concurrency, per payer and per key
  lease_key text NOT NULL,               -- 'payer:<scope>:<id>' (2 slots) or 'key:<provider_id>' (kind's concurrency)
  slot smallint NOT NULL CHECK (slot BETWEEN 1 AND 4),
  job_id text NOT NULL, lease_until timestamptz NOT NULL,
  PRIMARY KEY (lease_key, slot));
CREATE TABLE ai_provider_limits (        -- the provider's own rate-limit state, from its headers
  provider_id uuid PRIMARY KEY REFERENCES ai_providers(id) ON DELETE CASCADE,
  limit_tokens int, remaining_tokens int, reset_at timestamptz, updated_at timestamptz NOT NULL);
```

`ai_breakers` stays as the plan has it (rate_limited · quota · auth · provider_down).

**Prices: `ai_model_prices`, versioned.** Rows are added, never edited, except `superseded_at`.

```sql
CREATE TABLE ai_model_prices (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  provider_kind text NOT NULL, model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 120),
  version int NOT NULL,                                   -- 1, 2, … per (provider_kind, model)
  input_per_mtok numeric(16,6) NOT NULL CHECK (input_per_mtok >= 0),
  output_per_mtok numeric(16,6) NOT NULL CHECK (output_per_mtok >= 0),
  reasoning_per_mtok numeric(16,6) CHECK (reasoning_per_mtok >= 0),      -- null: the output rate
  cached_input_per_mtok numeric(16,6) CHECK (cached_input_per_mtok >= 0), -- null: the input rate
  per_image numeric(16,6) CHECK (per_image >= 0),     -- only where the provider bills images apart
  currency char(3) NOT NULL REFERENCES currencies(code),
  effective_from timestamptz NOT NULL DEFAULT now(),  -- never backdated
  superseded_at timestamptz,                          -- the next version's effective_from
  source text NOT NULL CHECK (source IN ('admin','provider_listing')),
  listing_fetched_at timestamptz,                     -- the listing's date, for a prefilled row
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_kind, model, version),
  CHECK (source = 'admin' OR listing_fetched_at IS NOT NULL),
  CHECK (superseded_at IS NULL OR superseded_at >= effective_from));
CREATE UNIQUE INDEX ai_model_prices_current_uq ON ai_model_prices (provider_kind, model)
  WHERE superseded_at IS NULL;
```

- SELECT for every signed-in user (instance reference data, not tenant data). INSERT and the
  `superseded_at` update only with `kept.is_instance_admin()`, through `kept.ai_price_set`, which
  supersedes the current row and inserts the next version in one statement.
- **Removing a price** supersedes it with no successor: calls from then on are "cost unknown".
- **Nothing is seeded** (step-3 plan Q8). A prefill proposes rows from the provider's listing
  (Groq and OpenRouter list USD per token; converted to per million; `-1` skipped); the admin
  saves them, and they carry `source = 'provider_listing'` and the listing's date.

**The ledger: `llm_calls`.** Partitioned by month (§7.13), append-only, **written only by the
`kept.ai_*` doors**: kept_app and kept_system have no INSERT policy, so no row can be forged or
mis-attributed from application code.

```sql
CREATE TABLE llm_calls (
  id uuid NOT NULL DEFAULT uuidv7(),
  at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  request_id text NOT NULL CHECK (char_length(request_id) <= 64),   -- the HTTP request id, or the job id
  attempt smallint NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 20),
  task text NOT NULL CHECK (task IN ('extract_thing','extract_receipt','extract_label','extract_reading',
    'assistant_turn','assistant_followup','embed_thing','embed_query','connection_test')),
  budget_task text GENERATED ALWAYS AS (CASE
    WHEN task LIKE 'extract\_%' THEN 'extraction' WHEN task LIKE 'assistant\_%' THEN 'assistant'
    WHEN task LIKE 'embed\_%' THEN 'embeddings' ELSE 'test' END) STORED,
  location_id uuid,                  -- null: a private thread or a cross-owner turn
  owner_account_id uuid,             -- the location's owner account (so owners read without a join, §1)
  user_id uuid,                      -- null: "Kept (background)"
  paying_scope text NOT NULL CHECK (paying_scope IN ('instance','account','user')),
  paying_account_id uuid, paying_user_id uuid,
  fell_back boolean NOT NULL DEFAULT false,         -- paid by a scope further down the cascade
  provider_id uuid, provider_kind text NOT NULL, model text NOT NULL,
  reasoning text, prompt_version text CHECK (char_length(prompt_version) <= 20),
  sent boolean NOT NULL,                            -- false: Kept held it back
  estimate_tokens int, input_tokens int, output_tokens int, reasoning_tokens int, cached_input_tokens int,
  image_count smallint NOT NULL DEFAULT 0 CHECK (image_count >= 0),
  image_tokens_each int, image_bytes int,           -- never the image itself
  attachment_ids uuid[],                            -- which attachments were sent (D163)
  latency_ms int, finish_reason text CHECK (char_length(finish_reason) <= 40),
  outcome text NOT NULL CHECK (outcome IN ('ok','refused','rate_limited','over_budget',
    'provider_error','timeout','schema_invalid','truncated')),
  error_code text CHECK (error_code ~ '^[a-z0-9_]{1,40}$'),   -- auth, quota, http_5xx, error_in_200,
                                                              -- network, content_filter, cap_money, …
  http_status smallint,
  cost_amount numeric(16,6), cost_currency char(3),
  cost_source text NOT NULL CHECK (cost_source IN ('provider','price_table','price_table_later','unknown','not_sent')),
  price_id uuid,                                    -- the ai_model_prices version used
  extraction_id uuid, thread_id uuid, thing_id uuid,
  rl_remaining_tokens int, rl_reset_at timestamptz, -- the provider's headers after this call
  PRIMARY KEY (id, at),
  CHECK ((cost_amount IS NULL) = (cost_currency IS NULL)),
  CHECK (sent OR (input_tokens IS NULL AND output_tokens IS NULL AND cost_amount IS NULL)),
  CHECK (sent = (cost_source <> 'not_sent')),
  CHECK (cost_source NOT IN ('price_table','price_table_later') OR price_id IS NOT NULL),
  CHECK (CASE paying_scope
    WHEN 'instance' THEN paying_account_id IS NULL AND paying_user_id IS NULL
    WHEN 'account'  THEN paying_account_id IS NOT NULL AND paying_user_id IS NULL
    ELSE paying_user_id IS NOT NULL AND paying_account_id IS NULL END)
) PARTITION BY RANGE (at);
CREATE INDEX llm_calls_user_idx     ON llm_calls (user_id, at DESC);
CREATE INDEX llm_calls_location_idx ON llm_calls (location_id, at DESC);
CREATE INDEX llm_calls_owner_idx    ON llm_calls (owner_account_id, at DESC);
CREATE INDEX llm_calls_payer_idx    ON llm_calls (paying_account_id, at DESC);
CREATE INDEX llm_calls_instance_idx ON llm_calls (at DESC) WHERE paying_scope = 'instance';
CREATE INDEX llm_calls_thing_idx    ON llm_calls (thing_id, at DESC) WHERE thing_id IS NOT NULL;
CREATE INDEX llm_calls_extraction_idx ON llm_calls (extraction_id) WHERE extraction_id IS NOT NULL;
```

- **Dropped** from the earlier shape: `request` and `response` jsonb, `cost_estimate`, the free
  `error` text. Nothing in the ledger can hold a prompt, a reply, an image or a key. The prompt
  version is its own column; what an extraction produced stays in `extractions.result`.
- **SELECT policy** (kept_app): `user_id = me OR paying_user_id = me OR location_id IN (SELECT
  kept.admin_location_ids()) OR owner_account_id = (SELECT kept.current_owner_account_id()) OR
  paying_account_id = (SELECT kept.current_owner_account_id())`. No UPDATE or DELETE.
- **Instance admins** have no row access to other tenants. They read `kept.ai_usage('instance',
  …)` (per-account totals) and `kept.ai_instance_calls(…)`: rows with `paying_scope =
  'instance'`, returning time, account, person, task, model, tokens, images, cost and outcome,
  **without** `location_id`, `thing_id`, `extraction_id`, `thread_id` or `attachment_ids`.
- **The serializer** also removes `thread_id` unless the caller owns the thread (D23), and
  removes the cost (with `moneyHidden: true`) unless the caller may see money in the row's
  location, the row has no location, or the caller is its payer (D13, D110).
- **Deleting a person** sets `user_id` to null in their rows (shown "a deleted person"); the
  payer's record stays.

**Monthly totals: `ai_usage_months`.** Written by the rollup before a partition is dropped;
definer-read like the ledger (same visibility rules through `kept.ai_usage`).

```sql
CREATE TABLE ai_usage_months (
  month date NOT NULL, paying_scope text NOT NULL, paying_account_id uuid, paying_user_id uuid,
  location_id uuid, owner_account_id uuid, user_id uuid, task text NOT NULL,
  provider_kind text NOT NULL, model text NOT NULL, cost_currency char(3),
  calls int NOT NULL, sent_calls int NOT NULL, tokens bigint NOT NULL, images int NOT NULL,
  cost_amount numeric(18,6), unknown_cost_calls int NOT NULL,
  UNIQUE NULLS NOT DISTINCT (month, paying_scope, paying_account_id, paying_user_id, location_id,
    user_id, task, provider_kind, model, cost_currency));
```

**Cost, worked out once, at settle** (`ai/cost.ts`, a pure function with table tests):

```
if the provider reported a cost (OpenRouter: providerMetadata.openrouter.usage.cost, USD, V35):
    cost = that; source = 'provider'
elif a current ai_model_prices row exists for (provider_kind, model):
    uncached_in = input_tokens − cached_input_tokens
    text_out    = output_tokens − reasoning_tokens        -- the AI SDK's output total includes reasoning
    cost = ( uncached_in        × input_per_mtok
           + cached_input_tokens × coalesce(cached_input_per_mtok, input_per_mtok)
           + text_out            × output_per_mtok
           + reasoning_tokens    × coalesce(reasoning_per_mtok, output_per_mtok) ) / 1e6
           + image_count × coalesce(per_image, 0)
    source = 'price_table'; price_id = that row
else:
    cost = null; source = 'unknown'
```

- `per_image` is left empty where the provider's usage already counts images as input tokens (as
  Groq's does, spike 2026-09-26); it exists for listings that price images apart.
- **Reservation:** before sending, the reserve door adds the call's **estimated** cost (estimate
  input tokens at the input rate, plus the output allowance at the output rate) to the cost
  windows; settle replaces it with the real figure. With no price, only tokens are reserved.
- **Late prices:** `kept.ai_recost_unknown(p_provider_kind, p_model, p_since)` (instance admin)
  costs this month's `unknown` rows with the current price, marks them `price_table_later`, and
  updates the cost windows. It is the only update the ledger ever takes, and it is audited.
- **Currency:** each cost window is per currency. A money cap counts its own currency, plus
  another currency only through the account's `fx_rates` for that pair (the latest `valid_from`),
  and the usage view labels converted amounts.

**The doors** (definers; each checks its caller from `app.user_id`; plan T6 has the full
signatures):

| Door | Role | Does |
|---|---|---|
| `kept.ai_provider_for(location, task)` | APP | resolves the key and the payer (plan Q5), unchanged; the only way to a key |
| `kept.ai_reserve(ctx)` | APP, SYS | takes the resolved payer, location, person, task, estimated tokens and cost, and the job id. Collects the **buckets** that apply (below), takes their advisory locks **in sorted order** (no deadlocks), and refuses on the first bucket that is paused, over a token window, or over its money cap; otherwise leases a payer slot and a key slot and adds the estimate. A refusal that pauses work (a cap, a day budget, a manual pause, an open breaker, a rejected key) **writes a `sent = false` ledger row**; a short wait (`tpm`, `concurrency`, the provider's window under 60 s) does not |
| `kept.ai_settle(ctx, usage, outcome, cost)` | APP, SYS | trues up every bucket, releases the leases, writes the ledger row, stores the provider's rate-limit headers in `ai_provider_limits`, and returns the buckets that **crossed 80% or 100%** this call (the caller enqueues `ai.cap_notice`). Reaching 100% sets `paused_until` and `paused_reason` |
| `kept.ai_status(location)` | APP | adds the pausing cap's label and scope, `waitingProvider` (breaker or limits, with until), `canResume`, and the month's percent of the tightest cap |
| `kept.ai_cap_set(…)` · `kept.ai_cap_clear(id)` | APP | the writes above, with the account-cap check |
| `kept.ai_pause(scope ids)` · `kept.ai_resume(id, raise)` | APP | a manual pause; resume clears the pause (after raising or removing the cap when asked) and **returns the paused extraction ids** for the route to re-send |
| `kept.ai_usage(scope, scope_id, from, to, group_by)` | APP | aggregates over `llm_calls` and `ai_usage_months` with the visibility rules above; per currency; `unknown_cost_calls` per group |
| `kept.ai_instance_calls(filters, cursor)` | APP (instance admin) | instance-paid rows without location detail |
| `kept.ai_price_set(…)` · `kept.ai_recost_unknown(…)` | APP (instance admin) | versioned prices; late costing |
| `kept.ai_rollover()` | SYS | at 00:05 UTC daily: clears day-budget pauses; on the 1st, clears cap pauses whose `paused_until` has passed. Returns the paused extractions to re-send, oldest first |
| `kept.ai_rollup_and_drop(p_keep_months)` | SYS | writes `ai_usage_months` for partitions older than the retention, then drops them; also ensures the next 3 partitions |
| `kept.prune_ai_windows(before)` | SYS | minute windows older than 2 hours, expired leases, cost windows older than 13 months |

`kept.prune_llm_payloads` is removed: there is nothing to prune.

**Buckets a call counts against:**

| Paid by | Buckets |
|---|---|
| any call | `location:<loc>` when it has a location; `member:<loc's acct>:<user>` when it has a location and a person |
| the account key | `account:<acct>`, `account:<acct>:<task>` |
| a personal key | `user:<user>` |
| the instance key | `instance`, `instance:<task>`, `instance_account:<acct>` (the paying location's account, or the person's own account for personal work) |

**The pacer.** Per key, shared across processes through `ai_provider_limits`:
- After every call, it stores the provider's rate-limit headers. For Groq (spike 2026-09-26):
  `x-ratelimit-limit-tokens`, `x-ratelimit-remaining-tokens` and `x-ratelimit-reset-tokens`, a
  Go duration such as `21.037s` or `1m26.4s`. Other providers' header names are read from their
  API references at build time; a provider without such headers is paced by Kept's budgets and
  the breaker only.
- Before a call, when the remaining tokens are below the call's estimate and the reset is in the
  future, the call waits: up to 10 s in the job, longer by re-sending the job with `startAfter`
  at the reset (`waiting_provider`, no attempt spent).
- Key concurrency: 1 for `groq`, 2 otherwise, through `ai_leases` (`key:<provider_id>`).

**Pause state machine.**

Per cap or budget row (`warned` is derived from the counters; the pauses are stored):

| From | Event | To | Side effects |
|---|---|---|---|
| active | settle crosses 80% | warned | `warned_80_month` set; `ai.cap_notice` (80) |
| active, warned | reserve or settle reaches 100% of a money or token cap | paused (`cap_money` · `cap_tokens`) | `paused_until` = the 1st of next month 00:00 UTC; `warned_100_month`; `ai.cap_notice` (100) |
| active, warned | a per-task day budget is spent | paused (`tokens_day`) | `paused_until` = next 00:00 UTC |
| any | the setter pauses | paused (`manual`) | `paused_until` = `infinity` |
| paused (cap) | the 1st of the month (`ai.rollover`) | active | paused work re-sent, oldest first, paced |
| paused (cap) | **Resume now**: the cap raised above what is used, or removed | active or warned | paused work re-sent |
| paused (manual) | Resume | active | paused work re-sent |
| warned | the 1st of the month | active | — |

Per key (from `ai_breakers` and `ai_provider_limits`):

| State | Entered by | Left by |
|---|---|---|
| ok | — | — |
| waiting | remaining tokens below the next estimate | the provider's reset time |
| rate-limited | a 429 or a quota error: until `retry-after`, else 60 s, doubling to 1 h | the time passes |
| down | 3 errors or timeouts within 5 minutes | 5 minutes |
| key rejected | 401 or 403 | the key is replaced |

Per extraction (§7.8): `queued → running → succeeded | failed`; `running → paused_budget`
(a cap: `paused_until` from the cap) or `running → waiting_provider` (a key state); both return
to `queued` when their job is re-sent. **Neither spends an attempt.** The assistant is refused
with 409 `ai_paused` and the same reason while paused.

**Routes.** Money follows the gate (fields omitted, `moneyHidden: true`); lists are `{items,
next_cursor}`; every non-GET is audited.

| Method and path | Who | Body → Response |
|---|---|---|
| `GET /api/v1/ai/status?locationId` | members and above; viewers for the assistant | → `{resolved, source, providerKind, model, pausedUntil, reason, pausedBy: {scope, label}, waitingProvider: {until, reason}\|null, capPercent, canResume, canManage}` |
| `GET /api/v1/ai/explain?scope&locationId` | everyone | → the "What uses AI" panel: `{actions: [{task, callsPerAction, tokensTypical, costTypical?: {amount, currency}, basis: 'history'\|'reference', referenceDate?}], projection: {days: 30, calls, tokens, cost: [{currency, amount}], unknownCostCalls}}` |
| `GET /api/v1/ai/usage?scope=me\|location\|account\|instance&locationId&from&to&groupBy=day\|task\|model\|person\|location\|account` | per scope, as the visibility table | → `{scope, from, to, soFar, groups: [{key, label, calls, sentCalls, tokens: {input, output, reasoning, cached}, images, cost: [{currency, amount}], unknownCostCalls, outcomes: {ok, refused, …}}], totals: {…}, caps: [capStatus]}`. `groupBy=account` is instance only |
| `GET /api/v1/ai/calls?scope&locationId&cursor&limit&<filters>` | per scope | → `{items: [{id, at, requestId, attempt, task, providerKind, model, location?: {id, name}, person?: {id, name}\|'background', paidBy: {scope, label, fellBack}, sent, tokens: {estimate, input, output, reasoning, cached}, images: {count, tokensEach, bytes}, latencyMs, finishReason, outcome, errorCode, cost?: {amount, currency, source, priceVersion}, links: {extractionId?, thingId?, threadId?}}], next_cursor}`. Filters, from the D205 registry in its URL form: `at` (date range), `person`, `location`, `task`, `model`, `provider`, `outcome`, `paidBy`, `hasImage` (boolean), `tokens` (number range), `cost` (number range, only where money shows), `thing` (searched), and `q` (model id or request id) |
| `GET /api/v1/ai/calls/:id` | as the list | → one row, with its attempts (the same request id) |
| `GET /api/v1/ai/calls.csv?<same filters>` | as the list | → `text/csv`, one row per call with the list's columns; money columns absent where gated; cells beginning with `=`, `+`, `-` or `@` are prefixed with `'`; audited `ai.usage_export`; §3.5 limits |
| `GET /api/v1/ai/caps?scope&locationId` | the cap's readers | → `{caps: [{id, scope, target, task, tokensPerMinute?, tokensPerDay?, tokensPerMonth?, monthlyCap?: {amount, currency}, used: {tokens, cost: [{currency, amount}], unknownCostCalls}, percent, state: 'active'\|'warned'\|'paused', pausedUntil?, reason?, cappedByAccount, rowVersion, canEdit}], suggested?: {monthlyCap?, tokensPerMonth?}}` |
| `PUT /api/v1/ai/caps` (If-Match when it exists) | the cap's writers | `{scope, accountId?, locationId?, userId?, task?, monthlyCap?: {amount, currency}\|null, tokensPerMonth?, tokensPerDay?, tokensPerMinute?}` → the cap. 400 `cap_above_account`, 400 `currency_not_enabled`; 404 for a scope you don't manage. Audited `ai.cap_set` |
| `DELETE /api/v1/ai/caps/:id` | writers | → 204. Audited `ai.cap_clear` |
| `POST /api/v1/ai/caps/:id/resume` | writers | `{raiseTo?: {amount, currency} \| {tokens}, remove?: true}` → `{cap, resumed: n}`. Audited `ai.resume` |
| `POST /api/v1/ai/pause` | writers of that scope | `{scope, accountId?, locationId?, userId?}` → the cap row, paused. Audited `ai.pause` |
| `GET /api/v1/ai/prices?history` | everyone (read-only) | → `{prices: [{providerKind, model, version, rates, currency, effectiveFrom, supersededAt, source, listingFetchedAt}]}` |
| `POST /api/v1/admin/ai/prices` | instance admin | `{providerKind, model, inputPerMtok, outputPerMtok, reasoningPerMtok?, cachedInputPerMtok?, perImage?, currency}` → the new version. Audited |
| `POST /api/v1/admin/ai/prices/prefill` | instance admin | `{providerId}` → proposed rows from the cached listing (D202), not saved |
| `DELETE /api/v1/admin/ai/prices/:providerKind/:model` | instance admin | → 204: no price from now. Audited |
| `POST /api/v1/admin/ai/prices/recost` | instance admin | `{providerKind, model, since}` → `{recosted: n}`. Audited |

The step-3 plan's `/ai/budgets/:scope` routes become `/ai/caps`: a per-task budget is a caps row
with a `task`.

**Elsewhere:**
- `GET /api/v1/things/:id/extractions` and the inbox view give each extraction a `call: {model,
  providerKind, tokens, images, cost?, costSource, paidBy: {scope, label}, outcome}`, for the
  draft's AI line.
- The thing history gains `ai_call` entries: ledger rows with that `thing_id`, or with an
  extraction of the thing's attachments, visible to whoever sees the thing (cost per the gate).
- A location export (D68) adds `ai-calls.csv` with the same columns as the list, no thread ids.

**Notices and alerts.**
- Notification kinds `ai_cap_warning`, `ai_cap_reached` and `ai_monthly_summary` (the
  notification centre is step 4; step 3 sends email and shows the in-app status line).
- Admin alert kinds (D166) `ai_instance_cap_warning`, `ai_instance_cap_reached` and
  `ai_instance_key_rejected`: a constraint change in the step that adds them.
- Mail templates for the three kinds in the five launch languages (D204).
- Jobs: `ai.cap_notice` (idempotent per cap, level and month), `ai.rollover` (daily at 00:05 UTC),
  `ai.ledger_rollup` (monthly), `ai.monthly_summary` (the 1st, §3.5).

### 7.16 Short-ID addresses and own codes (D208)

Step 3 builds it (plan task 17a). Where this differs from §1.10 or §7.13, this subsection wins.

**Addresses.** A thing's page is `/t/<short-id>` and a place's `/p/<short-id>` once the short ID
exists; both routes also take the UUIDv7. Typed input is folded by `normaliseInputCode()` (case,
hyphens, Crockford look-alikes), so `/t/2hx-9rb` opens `2HX9RB`. A UUID address whose thing or
place has a short ID is replaced in place (`history.replaceState`, no new history entry); a thing
created offline keeps its UUID address until the server allocates its short ID at sync (D112).
The web resolves a short ID from the phone's snapshot first (`OfflineStore.byCode`, as the
scanner does, D120), then `POST /api/v1/scan/resolve`. Links the app renders use the short ID when
the row carries one. The short ID's format is fixed (D120): no setting changes it.

**Own codes.** `legacy_codes` rows with `source = 'own'` and `source_collection = ''`, stored as
legacy codes are (`upper(btrim())`, Eastern digits folded). Kept refuses a code the location
already has under any source (409). Scan resolution, search (a whole-code match ranks first, as a
short ID does) and the phone's resolvers find them like any legacy code.

| Method and path | Who | Body → Response |
|---|---|---|
| `GET /api/v1/{things\|places}/:id/codes` | members | → `{codes: [{code, source, sourceCollection}]}`, own codes first |
| `POST /api/v1/{things\|places}/:id/codes` | `things.edit` | `{code}` \| `{next: true}` → 201 `{code}`. 409 `conflict` `{taken: {kind, id}}` for a code the location has; 400 `validation` with the rule's message as `hint` and `{rule: {message, example}, reason: 'mismatch'\|'slow'}`; `{next}` with numbering off: 409. Audited `thing.codes` / `place.codes`, undoable |
| `PUT /api/v1/{things\|places}/:id/codes/:code` | `things.edit` | `{code}` → `{code}`: a rename (a delete and an insert: the code is the key). Same refusals; 404 for a code that isn't the target's own. Audited, undoable |
| `DELETE /api/v1/{things\|places}/:id/codes/:code` | `things.edit` | → 204. Audited, undoable. Its number is never given out again |
| `GET /api/v1/locations/:locationId/own-codes` | members | → `{locationId, numbering: {enabled, prefix, pad, next}, rule: {pattern, message, example}\|null, rowVersion}` (`rowVersion` 0 before the first save) |
| `PUT /api/v1/locations/:locationId/own-codes` (If-Match) | `location.settings` | `{numbering: {enabled, prefix, pad}, rule: {pattern, message, example}\|null}` → the options. 400 `validation` `{reason: 'invalid'\|'slow'\|'example'\|'numbering'}`. Audited `location.own_codes` |
| `GET /api/v1/locations/:locationId/own-codes/mismatches` | members | → `{rule, items: [{code, kind, id, name, reason: 'mismatch'\|'slow'}]}`: own codes the current rule refuses (at most 500) |

The audit diff of `thing.codes` / `place.codes` is `own_codes: {before, after}`, the whole sorted
list; its undo puts the list back when the target still has exactly the `after` list and no code
it restores has gone to something else since (D124).

**Numbering** (off by default): `<prefix><counter>`, the counter zero-padded to `pad` digits and
never cut (`GAR-` + 4 → `GAR-0001`, …, `GAR-10000`). `kept.next_own_code(location)` (a definer,
for writers of the location) increments `own_code_counters` with `INSERT … ON CONFLICT DO UPDATE`,
whose row lock serialises parallel callers until they commit, and skips a code the location
already has. A new confirmed thing is numbered by `kept.number_new_thing()`, a constraint trigger
deferred to commit (so a draft is numbered when it is confirmed, and a thing that has an own code
by then, from an import row or a place turned into a box, gets none). Saving numbering with a rule
refuses a prefix and padding whose next code the rule would refuse.

**Format rule** (owners and admins): a JavaScript regular expression matched against the whole
stored code, case-insensitive, with the `u` flag; a plain-words message (≤ 200) and an example
(≤ 100). Node 24 has no linear-time engine without an experimental process flag, so every match
runs in a `node:vm` context with a timeout (`apps/server/src/codes/format-rule.ts`). When it is
set, the pattern must compile on its own (so it can't escape the anchors), its example must match,
and it must answer each of a set of long test strings (each character of the pattern and the
example repeated to 99 characters and broken by `!`) within 10 ms, or it is refused (`(a+)+$` is).
It is checked on every add and rename, and on import (the CSV `own_code` column: a code it refuses
is kept as text in the notes, issue `code_format` with the owner's message); a check that runs out
of time counts as a mismatch. Changing the rule rewrites nothing; the mismatches route lists what
no longer matches.

**Phones.** Own codes reach phones as snapshot `legacyCodes`. A deleted legacy code writes a
tombstone (`kept.tombstone_legacy_code()`, unless its location is going too) with
`entity_type = 'legacy_code'` and the text key `entity_key = legacyCodeKey()`
(`location:source:collection:code`); `entity_id` is `md5(entity_key)::uuid`, so the primary key
still holds one row per key, and a code that comes back clears it. The snapshot sends
`entity_key` as the removal's `entityId`. `code` tombstones use the same column (none are written
in step 3).

