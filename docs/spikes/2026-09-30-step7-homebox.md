# Step 7, Task 0: Homebox re-check (V25), the export format (H1), icons (H2), the connection (H3)

Run on 2026-09-30 against real Homebox servers in Docker on the laptop, thrown away afterwards.
Plan: [step 7](../plans/2026-09-30-step-7-portability.md), Task 0. Research it checks:
[Homebox import research](../research/2026-09-26-homebox-import-research.md). Decision:
[D146](../specs/2026-09-25-kept-product-design.md).

**Results.**

| Spike | Result |
|---|---|
| V25 | **Pass.** v0.26.2 is still the latest stable release; v0.27.0-rc.1 changes four things the importer relies on, each now an amendment (below) |
| H1 | **Pass.** Two real export ZIPs committed under `apps/server/test/fixtures/homebox/`; a zod schema per table parses every row of both, strictly |
| H2 | **Decided.** Homebox has 16 fixed icon names; a table maps each to a Lucide name. Anything else: `hb_icon_dropped`, the Kept type's own icon |
| H3 | **Pass.** Version, collections with currency, and **members** (a route exists: names and emails, no roles) |

## How it was run

- **Image:** `ghcr.io/sysadminsmedia/homebox`, the name in Homebox's README and install docs. The
  release workflow tags images with `type=semver,pattern={{version}}`, so the tags are `0.26.2` and
  `0.27.0-rc.1`, without the `v`. Both were checked on the GHCR registry API before pulling
  (`0.26.2` and `0.27.0-rc.1` answered 200, `v0.26.2` 404).
- **Run:** one container at a time on `127.0.0.1:3197`, a throwaway volume, `TZ=Africa/Cairo`,
  `HBOX_OPTIONS_ALLOW_ANALYTICS=false`. **v0.26.2 refuses to start without
  `HBOX_AUTH_API_KEY_PEPPER`** (a panic asking for at least 32 bytes). The rc also needed an
  explicit `HBOX_STORAGE_CONN_STRING=file:///data?no_tmp_dir=true` and
  `HBOX_STORAGE_PREFIX_PATH=files`: with the image's default storage, every upload and every export
  failed with `fileblob: key "data/…" escapes bucket root`. That is a release-candidate bug, not
  something Kept sees.
- **Data:** `docs/spikes/code/step7/make_homebox_fixture.py` (stdlib Python, through Homebox's own
  API; routes from `backend/app/api/routes.go` at v0.26.2, bodies from the server's
  `/swagger/doc.json`). Passwords were random per run and never written down. What the fixtures
  cover is in their [README](../../apps/server/test/fixtures/homebox/README.md).
- **Afterwards:** containers, volumes and both images removed.

## V25: v0.26.2 against v0.27.0-rc.1

Releases from the GitHub API on 2026-09-30: **v0.26.2** (2026-06-14) is the latest stable,
**v0.27.0-rc.1** (2026-09-28, commit 3d84c421) is a pre-release. 61 commits between them. The paths
the research cites, diffed:

| Path | Change in v0.27.0-rc.1 | Affects D146 or the research? |
|---|---|---|
| `ent/schema/entity.go` | A second self-edge, `location` (column `entity_location_entities`), "only set when parent is a non-location entity" (#1688). Migration `20260821000000_entity_location_override.sql`: nullable, no backfill | **Yes.** The research says an entity's location is "the nearest ancestor whose type has `is_location`". From v0.27 an override beats that. **Amended** (research note, plan T9). Observed in an rc export: the key is present on every entity row, null in our data |
| `ent/schema/group.go`, `user.go` | Field order inside two mixins only | None |
| `core/services/service_exports.go` | (1) The pubsub topic is cached instead of shut down after each send (#1592). (2) The import side coerces booleans stored as 0/1 | **Yes, for help text.** In v0.26.2 **a second export fails until Homebox restarts** ("pubsub: Topic has been Shutdown", observed below). (2) confirms booleans in the ZIP depend on the database engine |
| `app/api/routes.go` | Group administration (`PUT`/`DELETE /groups`, removing members, invitations) becomes owner-only; `POST /users/logout/all`; the swagger host fix | None: the importer only reads. `GET /groups`, `/groups/all`, `/groups/members` are unchanged |
| `app/api/middleware.go` | `mwGroupOwner` added | None |
| `handlers/v1/controller.go` | `WithMaxParseMemory`, a 413 for oversize imports, struct field order, the currency route's doc comment (`/currency` → `/currencies`; the route itself was `/currencies` in both) | None |
| `handlers/v1/v1_ctrl_exports.go` | Slow downloads allowed past the 10 s write timeout | None (it helps the user download a large ZIP) |
| `services/service_user_defaults.go` | A new collection also gets a default **Item** type (v0.26.2 creates only **Location**) | None for the mapping; noted because fixtures from each version differ |

The export layout itself did not change: `schemaVersion` is still 1, the entry names and the
row encoding are the same (compared field by field between the two versions' exports). Latest
stable unchanged, so nothing blocks T9; the override is a schema branch in `format.ts` (an
optional field), as the plan's device table already foresaw.

## H1: the export ZIP, observed

Produced with `POST /api/v1/group/exports`, polled at `GET /group/exports/{id}` until
`status: "completed"`, downloaded from `GET /group/exports/{id}/download`
(`Content-Disposition: attachment; filename="homebox-export-<id>.zip"`). As the research says.

**v0.26.2 exports once per process.** After one export, the next `POST /group/exports` answers
500 `pubsub: Topic has been Shutdown (code=FailedPrecondition)` until the server restarts
(observed twice: a restart, one export, a second export refused). In the first fill run, even the
first export failed the same way after attachments were uploaded (inferred: an earlier publish on
the shared in-memory driver). Kept's help and dry run say: "If Homebox says 'Topic has been
Shutdown', restart Homebox and export again." Fixed in v0.27.0-rc.1 (two exports in a row worked).

### The archive

- Written by Go's `archive/zip`: every entry deflated, general-purpose bit 3 (sizes in a data
  descriptor after the data), DOS time 1980-01-01 00:00 (zero), "made by" FAT, no Unix mode, no
  comments, no directories.
- **Entry names, exactly:** `entity_types.json`, `entity_templates.json`, `template_fields.json`,
  `tags.json`, `entities.json`, `entity_fields.json`, `maintenance_entries.json`,
  `attachments.json`, `tag_entities.json`, `notifiers.json`, then `attachments/<uuid>` (one per
  attachment row with a stored file, no extension), then `manifest.json` last. No `data/` prefix.
- **Each table is one JSON array** on a single line with a trailing newline (Go's
  `json.Encoder`), **not NDJSON**. An empty table is `[]`. Arabic is raw UTF-8.
- **`manifest.json`:** `{"schemaVersion":1,"exportedAt":"<RFC 3339>","groupId":"<uuid>","counts":{<table>:<rows>}}`.
  **No `homeboxVersion`** in v0.26.2 or the rc: the Go struct declares it, but the export never
  sets it. The version comes only from the connection, or stays unknown.
- **One ZIP holds exactly one collection.** Every row's group column (`group_entity_types`,
  `group_entity_templates`, `group_tags`, `group_entities`, `group_id`) equals `manifest.groupId`,
  and that id is the collection's id in `GET /groups` and `/groups/all`. Plan Q4 is settled: the
  collection of an asset ID is `manifest.groupId`, and a connection maps each ZIP to its currency
  by that id.
- Row values are the raw database columns (`SELECT *`), so column names are the SQL names, not the
  API's.

### Encodings (Homebox on SQLite, its default)

- **Booleans are `0` and `1`.** A Postgres-backed Homebox writes `true`/`false` *(inferred from the
  rc's import fix, not observed)*. The schema accepts both.
- **Timestamps:** RFC 3339 in UTC, up to nine fractional digits (`2026-09-29T22:42:55.96472826Z`).
- **Dates** (`purchase_date`, `warranty_expires`, `sold_date`, maintenance dates) are midnight UTC
  (`2024-11-03T00:00:00Z`). The importer takes the UTC date part, never a local-time conversion.
- **"No date":** null on entities; **`0001-01-01T00:00:00Z` (Go's zero time) in
  `maintenance_entries`**, where both `date` and `scheduled_date` are always strings.
- **Money:** `purchase_price`, `sold_price` and maintenance `cost` are JSON numbers (`12999.99`,
  `40`, `350.5`). **`cost` is a number in the ZIP**; the research's "serialised as a string" holds
  for the API only. `0` means unset for both prices.
- **Quantity:** a JSON number, fractional kept (`2.5`). **`0` for an entity an API client created
  without a quantity** (observed on every entity our script created without one; the seeded places
  have 1).
- **Optional text:** `null` and `""` both occur for the same column.
- **`asset_id`:** an integer (`5` → label `000-005`), 0 = none.
- **Confusing column names:** `entities.entity_children` holds the entity's **parent**;
  `tags.tag_children` holds the tag's **parent**; `entity_fields.entity_fields` is the entity;
  `template_fields.entity_template_fields` the template; `attachments.entity_attachments` the
  entity; `entity_type_entities` the type.

### Per table

| Table | Fields (JSON types) | Notes |
|---|---|---|
| `entity_types` | `id, created_at, updated_at, name, description (str/null), is_location (0/1), icon (str/null), group_entity_types, entity_type_default_template (uuid/null)` | The seeded Location type has `icon: null` |
| `entity_templates` | `id, created_at, updated_at, name, description, notes, default_name, default_description, default_quantity (num), default_insured, default_lifetime_warranty, default_manufacturer, default_model_number, default_warranty_details, default_tag_ids, include_purchase_fields, include_sold_fields, include_warranty_fields, entity_template_location (uuid/null), group_entity_templates` | **`default_tag_ids` is a JSON array encoded as a string** (`"[\"1a0b…\"]"`) |
| `template_fields` | `id, created_at, updated_at, name, description, type, text_value, number_value (int/null), boolean_value, time_value, entity_template_fields` | `numberValue` and `timeValue` sent to `POST /templates` were not stored (number null, time = the row's creation) |
| `tags` | `id, created_at, updated_at, name, description, color, icon, tag_children (parent), group_tags` | `color` is free text: `#1e88e5` and `red` both stored |
| `entities` | `id, created_at, updated_at, name, description, notes, import_ref, quantity, insured, archived, asset_id, serial_number, model_number, manufacturer, lifetime_warranty, warranty_expires, warranty_details, purchase_date, purchase_from, purchase_price, sold_date, sold_to, sold_price, sold_notes, sync_child_entity_locations, entity_children (parent), entity_type_entities, group_entities` (+ `entity_location_entities` from v0.27) | Places and things in one table; which is which comes from the type's `is_location` |
| `entity_fields` | `id, created_at, updated_at, name, description, type, text_value, number_value (int/null), boolean_value, time_value, entity_fields` | `type` is `text · number · boolean · time`; every row carries all four value columns |
| `maintenance_entries` | `id, created_at, updated_at, name, description, date, scheduled_date, cost (num), entity_id` | Done: `date` real, `scheduled_date` zero. Scheduled: the reverse |
| `attachments` | `id, created_at, updated_at, type, primary (0/1), title, path, mime_type, entity_attachments (uuid/null), attachment_thumbnail (uuid/null)` | See below |
| `tag_entities` | `tag_id, entity_id` | No id, no timestamps |
| `notifiers` | `id, created_at, updated_at, name, url, is_active, group_id, user_id` | **`url` is a notifier's credentials in plain text.** Never read (see amendments) |

### Attachments and files

- A stored file's `path` is `<groupId>/documents/<sha256>`: content-addressed, so **two rows can
  share one file** (our manual and warranty PDFs, and two identical photos). The ZIP still writes
  the bytes once per row, under each row's id. Kept's per-location dedupe (D177) folds them.
- `title` is what the uploader named it (`espresso-front.jpg`, `تلفزيون.jpg`).
- `mime_type` is **sniffed by Homebox**, not taken from the name: our `.docx` is
  `application/zip`, a text file `text/plain; charset=utf-8`. Kept sniffs again anyway (D157).
- **Thumbnails:** Homebox makes a WebP thumbnail for each image (photos and a JPEG receipt).
  A thumbnail row has `type: "thumbnail"`, `entity_attachments: null`, a title `<title>-thumb`,
  and `attachment_thumbnail` pointing **back** at its parent; the parent's
  `attachment_thumbnail` points at the thumbnail. D146 skips them; nothing is lost.
- **Link attachments (research: inferred → observed):** created with
  `POST /entities/{id}/attachments/external` (`source_type: "link"`). The row has
  **`mime_type: "link/url"`, `path` = the URL itself** (query and fragment kept), the chosen `type`
  (`manual` here) and title, `attachment_thumbnail: null`, and **no entry in the ZIP**. The
  exporter skips rows with an empty path and copies the rest by path, so a link row, whose path is
  a URL, is skipped as a missing blob *(the log line wasn't read; the missing entry was observed)*.
- One row per file, one entry per stored file: 13 rows and 12 files in Home (8 uploads, 4
  thumbnails, 1 link).

### What else a real collection carries

- **Seeded rows.** Every new Homebox collection gets eight places (Living Room, Garage, Kitchen,
  Bedroom, Bathroom, Office, Attic, Basement) and six tags (Appliances, IOT, Electronics, Servers,
  General, Important). Unless the owner deleted them, every export has them, usually empty.
- **Custom fields in practice.** In v0.26.2's item editor the field-type selector is commented out
  (`frontend/pages/item/[id]/index/edit.vue`), so people only ever create **text** fields; number,
  boolean and time fields come only from API clients. The entity field DTO has no `timeValue`, so a
  `time` field's value is the moment its row was created (observed: `time_value` within a
  microsecond of the row's `created_at`).

### The research's "(inferred)" lines

| Research line | Now |
|---|---|
| Tag and type icons "matched by name where possible; icon naming not verified" | **Observed:** 16 fixed names in `frontend/lib/icons.ts`, stored as free text (H2) |
| Link attachments "no file; kept as links" | **Observed:** `link/url` rows, URL in `path`, no ZIP entry |
| `insured` as a yes/no custom field (an importer choice) | Unchanged: a choice, not a fact (plan Q25) |
| Location = nearest `is_location` ancestor (not marked inferred) | **Amended:** true in v0.26; v0.27 adds an override |
| `cost` serialised as a string | **API only.** A number in the ZIP |
| Group currency "lowercase, default `usd`" | **The API returns uppercase** (`"USD"`, `"SAR"`); normalise case |
| Members API "returns no roles" | **Observed:** `GET /groups/members` → `[{id, name, email}]`, no roles (H3) |
| Booleans (not stated) | 0/1 from SQLite; true/false from Postgres *(inferred)* |

**Still unknown:** a Postgres-backed Homebox's export bytes (not run; the schema accepts both
boolean forms); how a `time` field set by some other client looks (the value is a timestamp
either way).

### The schema, checked

`docs/spikes/code/step7/h1_format.ts` holds a zod schema per table (zod 4.6.5, the server's), with
`.strict()` so an unexpected column fails. Over both fixtures:

```
homebox-0.26.2-home.zip: manifest ok · entity_types 7/7 · entity_templates 1/1 · template_fields 4/4 · tags 10/10 · entities 21/21 · entity_fields 8/8 · maintenance_entries 2/2 · attachments 13/13 · tag_entities 4/4 · notifiers 1/1
homebox-0.26.2-family.zip: manifest ok · entity_types 2/2 · entity_templates 0/0 · template_fields 0/0 · tags 7/7 · entities 13/13 · entity_fields 0/0 · maintenance_entries 1/1 · attachments 2/2 · tag_entities 1/1 · notifiers 0/0
```

T9 starts `imports/homebox/format.ts` from it. (The notifiers schema is there only to prove the
file's shape; T9 doesn't read the file.)

## H2: icons

Homebox v0.26.2's icon picker (`frontend/components/Form/IconSelector.vue`) offers exactly the
16 names in `frontend/lib/icons.ts` (`availableIcons`); the API stores any string up to 255
characters, and the UI shows the default tag icon for anything it doesn't know. Unchanged in the rc.
Tags have icons too; D146 drops them.

Kept's type icons are `lucide:<name>` (D98, `packages/shared/src/builtin-types.ts`); each name
below was checked against the installed lucide-react 1.48.0's `iconNames`.

| Homebox icon | Kept icon | |
|---|---|---|
| `tag-outline` | `lucide:tag` | |
| `tree-outline` | `lucide:tree-deciduous` | |
| `bag-suitcase-outline` | `lucide:luggage` | |
| `bed-outline` | `lucide:bed` | |
| `kitchen-counter-outline` | `lucide:cooking-pot` | closest; Lucide has no counter |
| `book-open-variant-outline` | `lucide:book-open` | |
| `laptop` | `lucide:laptop` | |
| `sofa-outline` | `lucide:sofa` | |
| `toolbox-outline` | `lucide:toolbox` | |
| `file-cabinet-outline` | `lucide:folder` | Homebox draws it with MDI's folder icon |
| `dresser-outline` | `lucide:archive` | closest; Lucide has no dresser |
| `lightbulb-outline` | `lucide:lightbulb` | |
| `power-plug-outline` | `lucide:plug` | |
| `wrench-outline` | `lucide:wrench` | |
| `dumbbell` | `lucide:dumbbell` | |
| `palette-outline` | `lucide:palette` | |
| `null`, `""` | the Kept type's own icon | no issue |
| anything else (fixture: `not-a-homebox-icon`) | the Kept type's own icon | issue `hb_icon_dropped` |

## H3: the optional connection

Against v0.26.2 with an `hb_` API key made by `POST /users/self/api-keys` (`{name}` →
`{id, userId, name, createdAt, expiresAt: null, lastUsedAt: null, token: "hb_…"}`), sent as
`Authorization: Bearer hb_…`. Keys redacted here and the key revoked afterwards.

| Request | Response shape |
|---|---|
| `GET /api/v1/status` (no auth) | `{health, versions, title, message, build: {version: "v0.26.2", commit, buildTime}, latest: {version, date}, demo, allowRegistration, labelPrinting, oidc: {…}, telemetry: {enabled}}` |
| `GET /api/v1/groups/all` | `[{id, name, createdAt, updatedAt, currency}]`: **every collection the key's owner is in** (Home and بيت العائلة here) |
| `GET /api/v1/groups` with `X-Tenant: <id>` | `{id, name, createdAt, updatedAt, currency}` for that collection; **without** `X-Tenant`, the owner's default collection |
| `GET /api/v1/groups/members` with `X-Tenant` | **`[{name, email, id}]`**: every member, **no role** (`backend/app/api/handlers/v1/v1_ctrl_group.go`, `HandleGroupMembersGetAll`) |
| `X-Tenant` of a collection the key can't see | 403 `{"error":"user does not have access to the requested tenant"}` |
| A wrong key, or the key after `DELETE /users/self/api-keys/{id}` | 401 `{"error":"valid authorization token is required"}` |

- `currency` is an **upper-case** ISO code (`USD`, `SAR`; `/currencies` lists 162).
- A member list gives Kept names **and emails**, so T11's "people to invite" can prefill each email
  (no roles: the dry run asks for one, default member).
- The route exists in v0.26.2 and is unchanged in the rc, so T11's fallback sentence ("Homebox's
  export doesn't list members…") is needed only when there is no connection.

## Amendments made

- **Research note** (`docs/research/2026-09-26-homebox-import-research.md`): an "Observed on
  2026-09-30" section with the corrections above.
- **Plan T9 and T11** (`docs/plans/2026-09-30-step-7-portability.md`): the rc location override, the
  restart message, skipping `notifiers.json`, the seeded-places choice, quantity 0, the zero-time
  dates, the `time_value` heuristic (untested), members with emails.
