---
title: Data model
description: The main tables, how they relate, and the rules every table follows.
---

The tables are declared with Drizzle in
[`apps/server/src/db/schema/`](https://github.com/ibrahimroshdy/kept/tree/main/apps/server/src/db/schema),
one file per area. The design and every column's reasoning are in the engineering spec: §1 for the
tables and §7.13 for the integrity amendments, which win where the two differ
([engineering spec](https://github.com/ibrahimroshdy/kept/blob/main/docs/specs/2026-09-25-kept-engineering-spec.md)).
This page is the map.

## Rules every table follows

- **Ids are UUIDv7.** A phone creates rows offline with its own id; the server accepts a
  client-supplied id only within ± 7 days of now.
- **Every owned row carries its scope**: `location_id`, `owner_account_id` or `user_id`, child
  tables included, so a row-level-security policy never needs a join. Parents expose
  UNIQUE (`location_id`, `id`) and children reference them with composite foreign keys that
  cascade on update, so moving a thing to another location carries `location_id` down.
- **Mutable tables have `updated_at`, `row_version` and `change_seq`**, kept by the
  `kept.touch_row()` trigger. Writes send the `row_version` they started from. Append-only tables
  (`audit_events`, `llm_calls`, deliveries, `notifications`, `idempotency_keys`) have none.
- **Enumerations are `text` with a `CHECK`**, never Postgres enums, so a one-version rollback
  survives a new value.
- **Soft delete is `deleted_at`.** Trash is restorable; the daily `purge` job removes what has
  expired.
- **Money is `numeric(16,4)` plus a currency** with a foreign key to `currencies`, amount and
  currency null together. Calendar facts are `date`, instants `timestamptz`.

## The main tables

<figure class="kd-diagram">
<svg viewBox="0 0 760 390" role="img" aria-labelledby="d-er-t" dir="ltr">
<title id="d-er-t">Kept's main tables and how they relate</title>
<defs><marker id="d-er-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="kd-head" d="M0 0L10 5L0 10z"/></marker></defs>
<rect class="kd-box" x="20" y="20" width="180" height="56" rx="6"/>
<text class="kd-t kd-mono" x="110" y="44" text-anchor="middle">auth.user</text>
<text class="kd-t2" x="110" y="63" text-anchor="middle">Better Auth's users</text>
<rect class="kd-box" x="20" y="110" width="180" height="56" rx="6"/>
<text class="kd-t kd-mono" x="110" y="134" text-anchor="middle">memberships</text>
<text class="kd-t2" x="110" y="153" text-anchor="middle">role per location</text>
<rect class="kd-box" x="20" y="200" width="180" height="56" rx="6"/>
<text class="kd-t kd-mono" x="110" y="224" text-anchor="middle">owner_accounts</text>
<text class="kd-t2" x="110" y="243" text-anchor="middle">one per user</text>
<rect class="kd-box kd-sunken" x="20" y="300" width="180" height="56" rx="6"/>
<text class="kd-t kd-mono" x="110" y="324" text-anchor="middle">audit_events</text>
<text class="kd-t2" x="110" y="343" text-anchor="middle">every write, any table</text>
<rect class="kd-box kd-accent" x="260" y="20" width="170" height="56" rx="6"/>
<text class="kd-t kd-mono kd-on-accent" x="345" y="44" text-anchor="middle">locations</text>
<text class="kd-t2 kd-on-accent" x="345" y="63" text-anchor="middle">a household</text>
<rect class="kd-box" x="260" y="110" width="170" height="56" rx="6"/>
<text class="kd-t kd-mono" x="345" y="134" text-anchor="middle">places</text>
<text class="kd-t2" x="345" y="153" text-anchor="middle">tree by parent_id</text>
<rect class="kd-box kd-accent" x="260" y="200" width="170" height="56" rx="6"/>
<text class="kd-t kd-mono kd-on-accent" x="345" y="224" text-anchor="middle">things</text>
<text class="kd-t2 kd-on-accent" x="345" y="243" text-anchor="middle">in a place or container</text>
<rect class="kd-box" x="260" y="300" width="170" height="56" rx="6"/>
<text class="kd-t kd-mono" x="345" y="324" text-anchor="middle">attachments</text>
<text class="kd-t2 kd-mono" x="345" y="343" text-anchor="middle">→ files</text>
<rect class="kd-box" x="500" y="20" width="240" height="50" rx="6"/>
<text class="kd-t kd-mono" x="620" y="50" text-anchor="middle">purchases, purchase_lines</text>
<rect class="kd-box" x="500" y="94" width="240" height="50" rx="6"/>
<text class="kd-t kd-mono" x="620" y="124" text-anchor="middle">meters, meter_readings</text>
<rect class="kd-box" x="500" y="168" width="240" height="50" rx="6"/>
<text class="kd-t kd-mono" x="620" y="198" text-anchor="middle">schedules, service_records</text>
<rect class="kd-box" x="500" y="242" width="240" height="50" rx="6"/>
<text class="kd-t kd-mono" x="620" y="272" text-anchor="middle">warranties, claims, loans</text>
<rect class="kd-box" x="500" y="316" width="240" height="50" rx="6"/>
<text class="kd-t kd-mono" x="620" y="346" text-anchor="middle">reminder_occurrences</text>
<path class="kd-edge" d="M110 76V110" marker-end="url(#d-er-a)"/>
<path class="kd-edge" d="M200 132H225V58H260" marker-end="url(#d-er-a)"/>
<path class="kd-edge" d="M200 222H240V38H260" marker-end="url(#d-er-a)"/>
<path class="kd-edge" d="M345 76V110" marker-end="url(#d-er-a)"/>
<path class="kd-edge" d="M345 166V200" marker-end="url(#d-er-a)"/>
<path class="kd-edge" d="M345 256V300" marker-end="url(#d-er-a)"/>
<path class="kd-edge" d="M430 228L500 45" marker-end="url(#d-er-a)"/>
<path class="kd-edge" d="M430 228L500 119" marker-end="url(#d-er-a)"/>
<path class="kd-edge" d="M430 228L500 193" marker-end="url(#d-er-a)"/>
<path class="kd-edge" d="M430 228L500 267" marker-end="url(#d-er-a)"/>
<path class="kd-edge" d="M430 228L500 341" marker-end="url(#d-er-a)"/>
</svg>
<figcaption>A user belongs to locations through memberships and owns one account, which owns locations; a location holds the place tree, things sit in places or containers, and a thing's records hang off it.</figcaption>
</figure>

### People and tenancy

| Table | File | What it is |
|---|---|---|
| `auth.user`, `auth.session`, `auth.account`, `auth.passkey`, `auth.two_factor`, … | `auth.ts` | Better Auth's tables, in schema `auth`, plus Kept's `auth.session_mfa` and `auth.sign_in_failures` |
| `user_profiles` | `tenancy.ts` | Display name, locale, time zone, units, digits, quiet hours, `managed` |
| `owner_accounts` | `tenancy.ts` | One per user; owns locations and the account registries |
| `locations` | `tenancy.ts` | A household: kind, currency, time zone, `require_2fa`, `deleted_at` (30-day grace) |
| `memberships` | `tenancy.ts` | (`location_id`, `user_id`, `role`: owner · admin · member · viewer, `expires_at`) |
| `invites`, `location_modules`, `user_hidden_modules` | `tenancy.ts` | Invites; which modules a location has on; what a user hides |
| `instance_admins`, `instance_settings` | `tenancy.ts` | Who administers the instance; instance-wide settings |

Every new account gets a **Personal** location with its **Unplaced** area and the owner
membership, made by `ensureAccount()` through `kept.ensure_account()` in one transaction.

### The tree

| Table | File | What it is |
|---|---|---|
| `places` | `places.ts` | Rooms, shelves, areas; a tree by `parent_id`, one `is_unplaced` per location |
| `things` | `things.ts` | Exactly one of `place_id` or `container_id` (another thing); `type_id`, `brand_id`, `lifecycle`, `custom`, `review_state`, `search_tsv` |
| `short_ids` | `things.ts` | The six-character label codes, never deleted or reissued |
| `thing_links`, `thing_tags` | `things.ts` | Accessory-of and similar links; tags |
| `types`, `type_fields`, `place_kinds`, `brands`, `vendors`, `people`, `tags` | `registries.ts` | The account registries, scoped by `owner_account_id`; built-in types have none |
| `secret_values`, `secret_field_policies` | `secrets.ts` | Encrypted field values and who may reveal them |

Loops in the tree are refused by triggers, and moving a container moves everything inside it.

### Files

`files` (`files.ts`) holds a stored blob's key, hash, size and type, scoped by `location_id` and
deduplicated per location (UNIQUE `location_id`, `sha256`). A file is never read directly: an
`attachments` row links a file, or a URL, to at most one subject through typed nullable columns
(`thing_id`, `place_id`, `purchase_id`, `warranty_id`, `claim_id`, `loan_id`,
`service_record_id`, `meter_reading_id`, `fuel_entry_id`, `incident_id`, `valuation_id`,
`expiring_document_id`); with none set, it belongs to the location itself. `file_derivatives` holds the
display and thumbnail variants; `file_text` (`capture.ts`) the searchable text of PDFs and
receipts.

### Records about things

| Area | Tables | File |
|---|---|---|
| Purchases | `purchases`, `purchase_lines` (a thing points at its line), `currencies`, `fx_rates`, `valuations` | `purchases.ts`, `currencies.ts`, `money.ts` |
| Meters | `meters`, `meter_readings`, `meter_events` | `meters.ts` |
| Upkeep | `schedules`, `service_completions`, `expiring_documents` | `schedules.ts` |
| | `service_records`, `service_lines` | `services.ts` |
| | `fuel_entries` | `fuel.ts` |
| | `stock_rules` | `consumables.ts` |
| Cover | `warranties`, `claims` | `warranties.ts` |
| | `loans` | `lending.ts` |
| | `incidents`, `incident_things` | `money.ts` |
| Capture | `extractions`, `inbox_items`, `templates` | `capture.ts` |

`schedules`, `expiring_documents` and `service_records` name their subject with typed columns
(`thing_id` or `place_id`) and a `CHECK` on `num_nonnulls(…)`, as attachments do.

### Reminders and notifications

`reminder_occurrences` (`reminders.ts`) is the ledger of what is due: one row per subject,
source, kind and due period, unique, so the 15-minute scan can run any number of times.
`reminder_deliveries` records each channel's send; `notifications` is the in-app centre.
Channels, push subscriptions, preferences and calendar feeds are per user (`notify.ts`).

### Audit, tokens and operations

| Table | File | What it is |
|---|---|---|
| `audit_events`, `audit_event_subjects` | `audit.ts` | Every write: actor (`user` · `token` · `system` · `import`), entity, action, a redacted diff; partitioned by month. Subjects fan a container move out to its contents |
| `api_tokens`, `token_locations`, `token_rate_windows` | `tokens.ts` | Personal tokens and OAuth grants, the locations each reaches, the rate windows |
| `idempotency_keys` | `tenancy.ts` | Stored responses per (`user_id`, `key`) |
| `sync_tombstones`, `sync_ops` | `tenancy.ts`, `sync.ts` | Deletions phones must hear about; each user's ledger of applied offline ops |
| `ai_providers`, `ai_budgets`, `llm_calls`, … | `ai.ts` | AI keys (sealed), budgets and the call ledger |
| `webhooks`, `webhook_deliveries` | `webhooks.ts` | Location webhooks |
| `backup_runs`, `release_history` | `operations.ts` | Backups and the releases that touched this database |

pg-boss keeps its jobs in its own schema, `pgboss`, installed by `kept migrate`.

## Adding a table

A new table needs its scope column, row-level-security policies in a custom migration, fixture
rows in the leak test, and an audited path for every write. The steps are on
[migrations](/developers/migrations/) and [row-level security](/developers/rls/).
