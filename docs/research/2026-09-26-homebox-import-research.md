# Homebox import research — 2026-09-26

The source of truth for the Homebox importer ([product design D146](../specs/2026-09-25-kept-product-design.md)).
Read from the **sysadminsmedia/homebox source at tag v0.26.2** (commit e01dd737, released
2026-06-14). Older behaviour comes from earlier tags. Paths are relative to that repository.
Anything inferred is marked *(inferred)*.

## API

- **Base and spec:**
  - Base path `/api/v1` (`backend/app/api/routes.go`). Live OpenAPI at `/swagger/doc.json`.
- **Version detection:**
  - `GET /api/v1/status` needs no auth.
  - Its `build.version` field tells the importer which code path to use (`handlers/v1/controller.go`).
- **Auth** (`backend/app/api/middleware.go`):
  - **Session:** `POST /users/login {username, password, stayLoggedIn}` returns a `Bearer` token.
    Kept uses the password once and never stores it.
  - **API keys**, from v0.26.0-rc.1 onward (commit fe0a18ba):
    - Format `hb_` + base64url(32 bytes), sent only as `Authorization: Bearer hb_…`.
    - **No scopes:** a key carries its owner's full user role.
    - Kept tells users to create a temporary key and revoke it afterwards.
- **Choosing a collection:**
  - Header `X-Tenant: <groupUUID>`, from v0.23.0 onward.
  - `GET /groups/all` lists collections; `GET /groups` returns `{id, name, currency}`.
- **Reading data (v0.26):**
  - `GET /entities` is paginated (`page`, `pageSize`; omit both for everything) and returns **items only**
    unless `isLocation=true`, and excludes archived ones unless `includeArchived=true`.
  - `GET /entities/{id}` is needed per entity for full fields and attachments.
  - `GET /entity-types`, `GET /tags` (flat, with `parentId`, `color`, `icon`).
  - `GET /maintenance?status=both`.
  - `GET /entities/{id}/attachments/{attachmentId}` streams the file; link attachments return a 302.
- **Before v0.26:**
  - Routes were `/items`, `/locations`, `/items/{id}/attachments/{aid}`.
  - Before v0.23 there was `/labels`, which became `/tags`.
  - Field names were `purchaseTime` and `soldTime`, and items had `locationId`.
- **API gap:** the entity field DTO has **no `timeValue`**, so date-type custom fields are invisible
  over the API. They appear only in the ZIP.

## Export ZIP (v0.26+)

- **Producing it:** `POST /group/exports` → poll `GET /group/exports/{id}` → `GET …/download`.
- **Contents:**
  - `manifest.json` (`schemaVersion` 1, `homeboxVersion`, counts).
  - One JSON row dump per table: `entity_types`, `entity_templates`, `template_fields`, `tags`, `entities`,
    `entity_fields`, `maintenance_entries`, `attachments`, `tag_entities`, `notifiers`.
  - Files at `attachments/<uuid>` with **no extension**; the row's `mime_type` gives the type.
- **Missing:** the group row (so **currency**), users, memberships and roles.

## Data model (`backend/internal/data/ent/schema/`)

- **Entity:**
  - `name`, `description`, `notes`, `quantity` (float), `insured`, `archived`, `asset_id`
    (int, per collection, 0 = none).
  - `serial_number`, `model_number`, `manufacturer`.
  - Warranty: `lifetime_warranty`, `warranty_expires`, `warranty_details`.
  - Purchase: `purchase_date`, `purchase_from`, `purchase_price`.
  - Sale: `sold_date`, `sold_to`, `sold_price`, `sold_notes`.
  - One `parent` edge; a required `entity_type`.
  - **Location = the nearest ancestor whose type has `is_location`.** From v0.27.0-rc.1 an override
    column, `entity_location_entities`, set only when the parent isn't a location, wins over it
    (observed 2026-09-30, below).
- **Custom fields:**
  - `text | number | boolean | time`.
  - `number_value` is an **integer**, so decimals are lost in Homebox itself.
- **Tags:** name, colour, icon, and a parent/child hierarchy.
- **Attachments:**
  - Type `photo | manual | warranty | attachment | receipt | thumbnail`; `primary`; `mime_type`.
  - `link/url` marks an external link, with the URL stored in `path`.
- **Maintenance:**
  - `date` (completed), `scheduled_date`, `name`, `description`.
  - `cost` is a float, but **serialised as a string** in the API. In the export ZIP it is a JSON
    number (observed 2026-09-30).
  - An entry with no `date` is scheduled.
- **Group:** `name`, `currency` (default `usd`; the API returns it upper-case, `USD`, observed
  2026-09-30).
- **Memberships:** role `user | owner`, but the member-list API (`GET /groups/members`) returns
  only `{id, name, email}`, no roles (observed 2026-09-30).

## Labels and QR codes

- **Asset ID format:** `%06d` shown as `000-001`, numbered **per collection** and not unique across
  collections.
- **QR payloads:**
  - Label generator page: `<baseURL>/a/<assetId>`.
  - Server label maker: `<host>/item/<uuid>`, `<host>/location/<uuid>`, `<host>/a/<assetId>`.
- **What Kept does:** stores asset IDs and UUIDs as legacy codes, and recognises all three URL
  patterns on any host in its scanner.

## Lossy or ambiguous

| Homebox | Kept |
|---|---|
| `archived` | a dry-run choice: skip, or import tagged "Archived in Homebox" |
| fractional `quantity` | imported as decimals (D183); rounding only where D10 forces quantity 1, with the original kept in notes |
| `insured` | no dedicated field; imported as a yes/no custom field *(an importer choice, not a product decision)* |
| `sync_child_entity_locations`, `import_ref` | not imported |
| tag and type icons | type icons mapped from Homebox's 16 fixed names to Lucide names; tag icons dropped (observed 2026-09-30) |
| templates → tag defaults | a known gap in Homebox's own export |
| notifiers, members, roles | not imported; the dry run lists members to invite |
| collection currency outside USD/CAD/GBP/EUR/EGP | a dry-run choice (D136) |
| link attachments in the ZIP | a row with `mime_type` `link/url` and the URL in `path`, and no file; kept as links (observed 2026-09-30) |

## Observed on 2026-09-30 (step 7, Task 0)

Real exports from Homebox v0.26.2 and v0.27.0-rc.1 in Docker, with synthetic data. Details, and
the per-table field list: [step-7 Homebox spike](../spikes/2026-09-30-step7-homebox.md). The
fixtures: `apps/server/test/fixtures/homebox/`.

- **The ZIP:** flat entry names (`<table>.json`, `attachments/<uuid>`, `manifest.json` last). Each
  table is **one JSON array**, not NDJSON. Written by Go's `archive/zip` (deflate, data descriptors,
  zero timestamps).
- **The manifest** is `{schemaVersion: 1, exportedAt, groupId, counts}`. **`homeboxVersion` is
  never set**, so the version comes only from the API.
- **One ZIP is one collection.** Every row's group column equals `manifest.groupId`, which is the
  collection's id in the API.
- **Encodings:**
  - booleans are `0`/`1` (SQLite; `true`/`false` from Postgres is *inferred*);
  - timestamps are RFC 3339 UTC;
  - dates are midnight UTC;
  - maintenance uses `0001-01-01T00:00:00Z` for "no date";
  - prices and `cost` are numbers, with `0` meaning unset;
  - `quantity` is `0` when an API client created the entity without one.
- **Column names are the SQL ones:** `entity_children` and `tag_children` hold the **parent**.
- **`notifiers.json` holds notifier URLs, which are credentials.**
- **Thumbnails** are WebP rows linked both ways to their parent attachment. Files are
  content-addressed, so rows can share one.
- **Seeded rows:** every collection starts with eight places and six tags.
- **`time` custom fields:** the API can't set an entity's `time_value`, so it is the row's creation
  time. The item editor makes only text fields.
- **v0.26.2 exports once per process** ("pubsub: Topic has been Shutdown" until a restart), fixed
  in v0.27.0-rc.1.
- **v0.27.0-rc.1** adds `entity_location_entities`, makes group administration owner-only, and
  gives new collections a default Item type. `schemaVersion` is still 1.
