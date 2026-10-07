# Step 2: Core inventory. Implementation plan

**Goal:** build Kept's core inventory on the step-1 foundation. That means:
- places with an Unplaced area, plus every place operation (D160): create, re-parent, trash with a contents choice, restore, merge, convert to a container and back, label, and place fields;
- things with their built-in fields, quantity and split, lifecycle, links, tags, aliases, last seen and not here, moves (including across locations and accounts), permanent short IDs, and secret fields in their own encrypted store;
- purchases with lines, the currencies (D136, D168), and the core meter and reading tables (D113, moved here by D185);
- types as a tree seeded from the built-in library (D154, with D192's Device group), place kinds, and the brand, vendor, people and tag registries;
- row versions with field-level conflicts (D156), and trash cascades and purge (D162);
- attachments and storage with byte-identical evidence (D117), local and S3;
- search with Arabic normalisation (D42, plus the screens-spec §8 prefix rule), saved views, and a ⌘K palette;
- trash, history and the activity feed;
- Home with the Get-started checklist (D138) and the step-2 rows of the attention panel;
- the inventory report as a generated PDF, after a spike picks the engine (D201, V34);
- the short-ID chip, status pills and the Label-tape brand (D131–D135);
- a 10,000-thing benchmark of row-level security (RLS), which answers risk #3 in the master plan.

**Architecture:** unchanged from step 1.
- Every request runs in `withScope()` on `kept_app`.
- Location rows are gated by `kept.visible_location_ids()` and `kept.writable_location_ids()`. Account registries are gated by three new definer functions: `kept.visible_account_ids()`, `kept.writable_account_ids()` and `kept.admin_account_ids()`.
- Whatever crosses a boundary the policies can't express goes through a named `SECURITY DEFINER` door, listed in the leak test. That covers:
  - moves across locations and accounts;
  - customising a built-in type;
  - merging registries;
  - converting between a place and a container;
  - reindexing, purging and receipts after a move.
- System jobs (reindex, purge) run on `kept_system` and only call definers. `SYSTEM_TABLES` does not grow.
- Search is Postgres full-text (`simple` config) plus `pg_trgm`, over `kept.normalize()`. Its JavaScript twin lives in `packages/shared`.
- Files sit behind one `BlobStore` interface (local, or S3). They are served through short-lived signed URLs, from a path that never reads the session.

**Before you start (step-1 status on 2026-09-26):** `git log` ends at the step-1 web screens (task 28). Step-1 tasks **22–26 are not built**: there is no `setup/`, `admin/`, `alerts/` or seed code, and `jobs/boss.ts` has only the minimal `registerJobs()`. Step 2 depends on them in four places:

| Step-2 task | Needs from step 1 | If it isn't there yet |
|---|---|---|
| T12 (admin currency switch) | task 23's instance-admin route guard | Guard the one route with `SELECT kept.is_instance_admin()` directly, and leave a `TODO(task 23)` |
| T20 (secrets) | task 22's `requireRecoveryKitAck()` | Use the new `kept.recovery_kit_acknowledged()` definer (T4) |
| T21, T22 (jobs) | task 24's `defineJob` and its policies | Register through the existing `registerJobs()`/`systemJobs()` |
| T24 (seed) | task 26's `kept admin seed` | T24 creates the skeleton itself |

The carry-over item `kept admin rotate-key` lands in T20 (secret_values exist from now on).

**Tech stack.** Step 1's pins still hold. These are the new packages, each looked up on npm on 2026-09-26. Pin them exactly.

| Package | Version | Licence | Used by |
|---|---|---|---|
| `sharp` | 0.35.4 | Apache-2.0. Its `@img/sharp-libvips-*` 1.3.3 binaries are **LGPL-3.0-or-later**: add each as a per-package `EXCEPTION` in `scripts/check-licences.mjs`, which that script already anticipates | server: derivatives, magic-byte re-encode, icon rendering |
| `file-type` | 22.1.1 | MIT. ESM only, Node ≥ 22. API: `fileTypeFromFile`, `fileTypeFromBuffer` | server: content sniffing (D157) |
| `@aws-sdk/client-s3` | 3.1141.0 | Apache-2.0 | server: S3 driver (T19 only) |
| `@aws-sdk/s3-request-presigner` | 3.1141.0 | Apache-2.0 | server: signed URLs on S3 (T19) |
| `lucide-react` | 1.48.0 | ISC | web: type and place icons (D98) |
| `@tabler/icons-react` | 3.48.0 | MIT | web: icons Lucide lacks (D98) |
| `rustfs/rustfs` (Docker image) | `1.0.0` (Docker Hub, 2026-09-16). Pin it by digest | Apache-2.0 | dev and CI S3 endpoint for T19. MinIO no longer publishes images |

These are deliberately **not** added in step 2:
- `@fastify/multipart`: uploads are a raw streamed `PUT`, and multipart share-in is step 3.
- `pdfjs-dist` / `unpdf`: PDF thumbnails and text wait for step 3's child-process extractor (see Q8).
- `driver.js`: the step-3 hints.
- `@visx/*`: the step-4 charts.

Before relying on any library API below, read its `.d.ts` in `node_modules`, as the ground rules say.

**Ground rules for every task** (step 1's, repeated):
- **Spec order:** the specs in `docs/specs/` are the contract. Engineering spec §7.14 beats §7.1–7.13, which beat §1. The screens spec §8–§9 beats older frames.
- **Library APIs:** when an API is unclear, read the installed package's `.d.ts` or README under `node_modules`. Never guess. If an API differs from what this plan shows, follow the library and note it in the commit body.
- **TDD:** failing test → minimal code → green → commit.
- **Commits** use conventional messages and the repo's local git identity. **Never add attribution lines**; the commit-msg hook rejects them (D173).
- **Node 24:** run everything with `export PATH=/opt/homebrew/opt/node@24/bin:$PATH` first.
- **Test time zone:** tests pin `TZ=Africa/Cairo`.
- **Ports:** Postgres on 5452 and Mailpit on 8025/1025, plus **RustFS on 9452** (new). Never touch 5432, 5433 or 5442.
- **No GitHub Actions.** CI is `scripts/ci-local.sh`, and it gates on exit codes only.
- **Commit after every task; do not push.** The repo stays private.

**Step-2 additions:**
- **One migration owner.** Phase A (T4–T10) is done in order by a single agent. drizzle-kit snapshots chain (`prevId`), so parallel migrations can't be merged. **Phases B and C never add a migration.** If one turns out to be needed, stop and hand it to the migration owner, who appends the next number.
- **What goes where in a migration:**
  - Drizzle (`src/db/schema/*.ts`) declares tables, columns, checks, uniques, plain and partial indexes, and composite FKs with `onUpdate`/`onDelete`.
  - The custom SQL migration that follows holds everything else: expression and GIN/trigram indexes, `ON DELETE SET NULL (col)` FKs, `DEFERRABLE` FKs, triggers, functions, policies and grants.
  - After each task, `drizzle-kit generate` must produce nothing (the CI `drift` step).
- **Every new table** gets all of these, in its task's custom migration:
  1. `ENABLE` + `FORCE ROW LEVEL SECURITY`;
  2. `owner_all` for `kept_owner`;
  3. `kept_app` policies on both USING and WITH CHECK;
  4. `REVOKE UPDATE … FROM kept_app, kept_system`, then column-level `GRANT UPDATE (…)`, **never on `id`, a primary-key column, `location_id`, `owner_account_id` or any column named `user_id`**;
  5. the `touch_row` trigger when it has `row_version`;
  6. a scope column;
  7. a fixture row in `fillTenant()` (`apps/server/test/leak.test.ts`), in the same commit.
  
  Location children use composite FKs `(location_id, x_id) → parent(location_id, id) ON UPDATE CASCADE`.
- **Every new `kept.*` function:**
  - Default privileges hand `EXECUTE` to both runtime roles. So each trigger or maintenance function gets `REVOKE EXECUTE … FROM PUBLIC, kept_app, kept_system`, and each callable one is granted to exactly the right role.
  - Add it to `FUNCTIONS` in `test/leak.test.ts` **and** to the map in `src/db/migrate.test.ts`.
  - Definers are owned by `kept_owner`, with `SET search_path = pg_catalog, public` and schema-qualified names. Each checks its caller from `app.user_id`, and raises `42501` (a 404) for anything the caller can't see.
- **API conventions:**
  - JSON is camelCase, as in step 1.
  - Money is a decimal **string** plus a `currency`. Dates are ISO strings; calendar dates are `YYYY-MM-DD`.
  - Client ids pass `assertClientId()`.
  - Every PATCH, and every POST that changes a versioned row, needs `If-Match` (`requireIfMatch`/`checkVersion`).
  - Anything invisible is a 404; a visible row the role can't change is a 403 from `can()`.
  - Every non-GET route calls `audited()`. The route-catalogue test (T2) enforces this.
- **Money and secrets:** they leave the server only through `serialize/gates.ts` (T2):
  - money needs the `money` module on in the row's location **and** `can(role,'money.view',{moneyVisibleToViewers})`;
  - secrets need the `secrets` module and the field's policy.
  - Money never enters `search_tsv`, `place_path` or a log line.
- **Custom-field audit:** `custom` is audited per key (`custom.<key>`), with `fieldClasses` from the type's field kinds (`money` → money; secret fields never reach `custom`). One nested `custom` diff would otherwise leak money past `renderAudit()`.
- **Web:**
  - Every list uses `ListSurface` (T3): search, filter, group and cursor pagination, all held in URL search params (lessons L88).
  - No native `select` or `confirm`; logical CSS only.
  - Strings go through Lingui. **Parallel web tasks never run `i18n:extract` or edit `.po` files.** T30 extracts once and writes the Arabic.
  - No new route files after T3: tasks fill the stubs it creates, so `routeTree.gen.ts` doesn't conflict.

**Parallel execution (waves).** Tasks within a wave touch disjoint files.

| Wave | Tasks | Notes |
|---|---|---|
| 0 | T1 ∥ T2 ∥ T3 | T3 can run through wave 2 against the mock server |
| 1 | T4 → T5 → T6 → T7 → T8 → T9 → T10 | one owner, sequential; T19 (S3) may start once T2's `BlobStore` exists |
| 2 | T11 ∥ T12 ∥ T13 ∥ T14 ∥ T17 ∥ T18 ∥ T19 ∥ T20 ∥ T21 ∥ T22 ∥ T23; then T15 (after T14); T16 (after T14); T24 (after T13, T14, T12); T25 (after T14, T21, T24) | each owns its own `src/<area>/` directory |
| 3 | T26 ∥ T27 ∥ T28 ∥ T29 | web by route; they start on the mock server as soon as T3 lands, and switch to the real server when the matching wave-2 task is done |
| 4 | T30 | i18n, e2e, visual, CI, docs |
| added | T29b (done); T31 → T32 | from the maintainer's requests of 2026-09-26: the rail (D198); the PDF engine spike, then the inventory report (D201). T31 can run any time; T32 needs T31's engine and the wave-2 routes |

---

## File structure (created or changed across the tasks)

```
packages/shared/src/
  normalize.ts            JS twin of kept.normalize / strip_prefixes / search terms (D42)
  normalize.vectors.json  shared test vectors, read by the JS and the SQL tests (V20)
  money.ts                parse/format amounts; five currencies × en/ar; Arabic digits (D136, D172)
  currencies.ts           ISO 4217 list (code, minor units), static
  short-code.ts           Crockford base32, 6 chars (D120)
  inventory.ts            enums: lifecycles, conditions, link kinds, attachment roles,
                          field kinds, capabilities, place-kind keys, vendor kinds
  builtin-types.ts        D154 + D192 library: keys, en/ar names, icons, capabilities, fields
  type-fields.ts          field → zod validator; resolved-field helpers (shared with web forms)
  errors.ts               + in_use, contents_choice_required, recovery_kit_required,
                          payload_too_large, unsupported_media_type, checksum_mismatch
apps/server/
  migrations/0009…0019    see Phase A
  src/db/schema/          registries.ts, things.ts, purchases.ts, meters.ts, files.ts,
                          secrets.ts, user.ts (saved_views, user_hints)
  src/db/seed-reference.ts  currencies + built-in types/place kinds, run by kept migrate
  src/http/routes.ts      registry of every route module (stubs in T2)
  src/serialize/gates.ts  money/secret/module gating for responses
  src/storage/            blob-store.ts, local.ts, s3.ts, signed-url.ts, sniff.ts, derivatives.ts
  src/currencies/  src/registries/  src/types/  src/places/  src/things/  src/purchases/
  src/meters/  src/files/  src/secrets/  src/search/  src/trash/  src/history/  src/home/
  src/seed/               households + bench scenarios
  test/perf/              rls-bench.test.ts, seed-bench.ts, vitest.config.ts
  test/route-catalogue.test.ts
apps/web/src/
  api/inventory/          paths.ts, types.ts, queries.ts, mock.ts per area
  components/list-surface.tsx  id-chip.tsx  status-pill.tsx  type-icon.tsx  brand.tsx
  components/{places,things,registries,search,files,home}/…
  lib/three-way.ts        field-level merge (D156)
  routes/_app/            p.$id.tsx t.$id.tsx trash.tsx activity.tsx types.$id.tsx
                          people.$id.tsx vendors.$id.tsx brands.$id.tsx
                          settings.account.tsx settings.account.{types,place-kinds,people,vendors,brands,tags}.tsx
                          admin.currencies.tsx   (search.tsx, loc.$id.tsx, index.tsx rewritten)
apps/web/public/          favicon.svg, favicon-32.png, apple-touch-icon.png, icon-192.png,
                          icon-512.png, icon-maskable-512.png
```

---

## Phase 0: shared contracts and scaffolding (T1–T3, parallel)

### Task 1: Shared contracts: normalisation, money, short codes, domain enums

**Files:**
- Create in `packages/shared/src/`: `normalize.ts`, `normalize.vectors.json`, `money.ts`, `currencies.ts`, `short-code.ts`, `inventory.ts`, `builtin-types.ts`, `type-fields.ts`
- Modify: `packages/shared/src/errors.ts`, `index.ts`
- Test: `normalize.test.ts`, `money.test.ts`, `short-code.test.ts`, `builtin-types.test.ts`, `type-fields.test.ts`

- [ ] **Step 1: The test vectors,** `normalize.vectors.json`: `[{in, normalized, stripped}]`, at least 60 rows.
  - Latin: `Café`, `MÜLLER`, `Ångström`, `São Paulo`, `straße`→`strasse`, `Øresund`→`oresund`, mixed spaces and tabs.
  - Arabic:
    - alef forms `أحمد`/`إبراهيم`/`آلة`/`ٱ` → `ا…`;
    - `مكتبة`↔`مكتبه`, and `مستشفى`→`مستشفي`;
    - harakat `كِتَابٌ`→`كتاب`, dagger alef, tatweel `كـــتاب`;
    - Persian `ی`/`ک` → `ي`/`ك`;
    - Eastern and Persian digits `٣٤٥`/`۴۵` → `345`/`45`.
  - Prefixes (screens §8, extending D42): `الكابل`→`كابل`, `والكتاب`→`كتاب`, `بالبيت`→`بيت`, `للبيت`→`بيت`, `فالشاحن`→`شاحن`, `كالعادة`→`عادة`.
  - Negatives: `ورق` stays `ورق`, and `بيت` stays `بيت` (the one-letter prefixes are stripped only together with `ال`; Q20).
  - Real names from the seed (V20): `كابل HDMI`, `شاحن سامسونج`, `ثلاجة توشيبا`.
- [ ] **Step 2: `normalize.ts`.**
  - `normalize(s)`: NFKC → lower-case → NFD → drop `\p{Mn}` → a small map (`ß→ss æ→ae œ→oe ø→o đ→d ł→l þ→th`) → Arabic folds (`أإآٱ→ا`, `ى→ي`, `ة→ه`, `ی→ي`, `ک→ك`) → digit folds → collapse whitespace → trim.
  - `stripPrefixes(s)`: per word, `^(?:[وبفك])?ال(\S{2,})` → `$1`, and `^لل(\S{2,})` → `$1`.
  - `searchVariants(word)`: `[normalized, stripped]`, deduplicated.
  - `tsQuery(q)`: words matching `[\p{L}\p{N}]+` only, each word `(v1:* | v2:*)`, joined with ` & `; `null` when nothing is left. This keeps tsquery syntax unreachable from input.
  - The test checks every vector's `normalized` and `stripped`. The SQL twin is tested against the same file in T4.
- [ ] **Step 3: `currencies.ts` and `money.ts`.**
  - `currencies.ts`: `ISO_CURRENCIES: {code, minorUnits}[]`. Generate it once from `Intl.supportedValuesOf('currency')` plus `new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits`, and commit it as a literal (deterministic across ICU versions). `SUPPORTED_DEFAULT = ['USD','CAD','GBP','EUR','EGP']`.
  - `parseAmount(input)`: accepts `٠–٩`, `۰–۹`, `٫` (Arabic decimal), `٬`/`,` grouping, and `.`. Returns a canonical `"1234.5"` string, or throws `invalid_amount`. At most 4 decimals, never negative, never exponent notation.
  - `formatMoney(amount, currency, {locale, digits})` uses `Intl.NumberFormat`:
    - EGP in `en*` → `currencyDisplay:'code'` ("EGP 1,200.00");
    - EGP in `ar*` → symbol ("١٬٢٠٠٫٠٠ ج.م." with eastern digits, "1,200.00 ج.م." with western);
    - never a bare "£" for EGP (D136);
    - the result is wrapped for LTR isolation (`⁦…⁩`) inside Arabic.
  - Tests: a table of the 5 currencies × `en`/`ar` × western/eastern digits, with exact expected strings, plus round-trips of `parseAmount`.
  - `roundForDisplay(amount, minorUnits)` rounds half away from zero. It is used at the edges only (display and export; Q2).
- [ ] **Step 4: `short-code.ts`.** `ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'`, `SHORT_CODE = /^[0-9A-HJKMNP-TV-Z]{6}$/`, `randomShortCode()` via `crypto.getRandomValues` (works in both Node and the browser), `normaliseInputCode()` (upper-case; `O→0`, `I/L→1`). Test: the alphabet has 32 characters, every generated code matches, and `normaliseInputCode('ab1lo0')` returns `'AB1100'`.
- [ ] **Step 5: `inventory.ts`.**
  - `LIFECYCLES = ['in_use','sold','given_away','lost','disposed','stolen','destroyed','returned_to_owner']` (D119, D158, §7.13); `ENDED = LIFECYCLES` minus `in_use`.
  - `CONDITIONS = ['new','good','fair','poor','broken']` (Q10).
  - `LINK_KINDS` (D76).
  - `ATTACHMENT_ROLES = ['photo','receipt','invoice','manual','warranty_doc','proof','condition_out','condition_in','registration','document']`.
  - `FILE_CLASSES`, `VENDOR_KINDS`.
  - `FIELD_KINDS = ['text','number','date','select','multi_select','boolean','url','money','person','vendor','file']`. "secret" is a flag, not a kind (Q3).
  - `CAPABILITIES = ['container','metered','warranty','serialized','consumable','expires']`.
  - `BUILTIN_PLACE_KINDS = ['floor','room','zone','closet']` (D33).
  - `DERIVED_STATES = ['uncertain','draft','ended']`; step 4 adds lent, borrowed and in_repair.
- [ ] **Step 6: `builtin-types.ts`, the D154 library with D192's Device group.** Each entry is `{key, parent?, icon, capabilities, defaultMeter?, groups?, names:{en, ar}, fields:[{key, kind, unit?, options?, secret?, repeatable?, names:{en,ar}}]}`. The tree:

  | Type | Capabilities and fields |
  |---|---|
  | `furniture` | material, dimensions |
  | `appliance` (W S) | `large_appliance`, `small_appliance` |
  | `electronics` (W S) | `phone` (groups device; imei, imei_2, storage), `tablet` (groups device; imei), `computer` (groups device; cpu, ram, storage, licence_key **secret**), `tv_display` (groups device; screen_size, number, unit in), `network_device` (groups device; wifi_password **secret**), `camera`, `console` |
  | `cable` (K) | connector_a, connector_b, length (number, m) |
  | `charger` | wattage (number, W), connector |
  | `tool` (W S) | `power_tool` (voltage, battery_platform) |
  | `box_bin` (C) | |
  | `safe` (C S) | combination **secret** |
  | `vehicle` (C M W S) | defaultMeter `{kind:'distance',unit:'km'}`; vin; `car` (plate), `motorbike`, `bicycle` (frame_number; no default meter), `generator` (defaultMeter `{kind:'hours',unit:'h'}`) |
  | `safety_equipment` (expires) | `fire_extinguisher`, `first_aid_kit`, `smoke_detector` |
  | `child_car_seat` (S expires) | |
  | `valuables` (W) | appraisal_value (money), appraisal_date (date) |
  | `collectible` | edition, condition_grade, provenance_notes |
  | `consumables` (K) | `batteries` (size, chemistry), `filters` (fits, text) |
  | field group `device` (`isFieldGroup:true`) | os, os_version, firmware, mac_address (text, **repeatable**), linked_account (text, **secret**) |

  Icons use the `lucide:<name>` / `tabler:<name>` form. Check each name exists in the pinned packages. Where both lack one (the safe, D98), use `kept:safe`, drawn in T3.

  The test checks:
  - keys are unique and match `^[a-z][a-z0-9_]*$`;
  - every parent exists;
  - there are no cycles;
  - no inherited field key is redefined (resolve through parents and groups);
  - every type has both an `en` and an `ar` name;
  - exactly the D154/D192 secret fields are secret.
- [ ] **Step 7: `type-fields.ts`.**
  - `resolveFields(typeChain, groups)` returns ordered fields, inherited first, each with its source.
  - `fieldValueSchema(field)` returns a zod schema per kind: money `{amount: string, currency: /^[A-Z]{3}$/}`; person/vendor a uuid; file an attachment uuid; `repeatable` → array.
  - `customSchema(fields)` gives a strict object; a secret field is rejected in `custom` ("use the secrets route").
- [ ] **Step 8: `errors.ts`.** Add `in_use`, `contents_choice_required`, `recovery_kit_required`, `payload_too_large`, `unsupported_media_type` and `checksum_mismatch`, with their English messages. The server's `MESSAGES` map (T2) mirrors them.
- [ ] **Step 9:** `pnpm test --project @kept/shared` passes. Commit: `feat(shared): inventory contracts, normalisation twin, money and short codes`.

### Task 2: Server scaffolding: route registry, gates, storage core, route catalogue

**Files:**
- Create: `apps/server/src/http/routes.ts`, and a stub `routes.ts` in `src/{currencies,registries,types,places,things,purchases,meters,files,secrets,search,trash,history,home}/`, each `export async function xRoutes(app, deps) {}`.
- Create: `apps/server/src/serialize/gates.ts`
- Create: `apps/server/src/storage/{blob-store.ts,local.ts,signed-url.ts,sniff.ts}`
- Create: `apps/server/src/jobs/inventory.ts`, exporting `inventoryJobs(deps): JobDefinition[]` and aggregating stubs `files/jobs.ts`, `search/jobs.ts` and `trash/jobs.ts` (each `[]`)
- Modify:
  - `http/app.ts`: one `await registerInventoryRoutes(app, deps)` line.
  - `http/modules.ts`: `targetLocation` also reads `body.locationId` and `query.locationId`, and adds `moduleLocation` helpers `locationOfThing`, `locationOfPlace` and `locationOfMeter` (via a scoped read).
  - `http/errors.ts`: the new codes' messages.
  - `http/conventions.ts`: `checkVersion` accepts an optional `changedBy`.
  - `jobs/boss.ts`: `systemJobs` spreads `inventoryJobs(deps)`.
  - `jobs/queue.ts`: add `'reindex'` to `REQUEST_QUEUES`.
  - `config/env.ts`: `KEPT_MAX_FILE_MB` (default 25), `KEPT_IMAGE_CONCURRENCY` (default 1 on arm64 with < 3 GB of RAM, otherwise 2), and `KEPT_S3_ENDPOINT` / `KEPT_S3_REGION` / `KEPT_S3_BUCKET` / `KEPT_S3_ACCESS_KEY_ID` / `KEPT_S3_SECRET_ACCESS_KEY` / `KEPT_S3_FORCE_PATH_STYLE`, required when `KEPT_STORAGE=s3`. Update `.env.example` and `compose.env.example`.
- Test: `apps/server/test/route-catalogue.test.ts` (step-1 carry-over, D188), `serialize/gates.test.ts`, `storage/*.test.ts`

- [ ] **Step 1: Route-catalogue test (D188, the carry-over).**
  - Build the app with every route module. Collect each non-GET route through an `onRoute` hook.
  - For each one, the file must contain a `// catalogue: <METHOD> <url>` marker comment above a case that asserts an `audit_events` row. Grep the test sources for the markers.
  - Otherwise the route must be on `ALLOWLIST` with a reason. Seed it with Better Auth `/api/v1/auth/*`, setup, and the read-only POST previews that T11/T13/T15 add (`…/preview`).
  - It fails today for any step-1 route without a marker: add the markers for step 1's existing tests in this task.
- [ ] **Step 2: `serialize/gates.ts`.** `gateFor(client, locationId, scope)` returns `{role, modules, showMoney, showSecrets}` (cached per request per location), plus:
  - `stripMoney(obj, paths)`;
  - `moneyOf(gate, amount, currency)` → `{amount, currency} | undefined`;
  - `customForView(gate, fields, custom)`, which drops money-kind values when `!showMoney` and never includes secret fields.

  Tests:
  - a viewer with `moneyVisibleToViewers=false` gets no money;
  - a member with the `money` module off gets no money;
  - a viewer with the toggle on gets money.
- [ ] **Step 3: The `BlobStore` interface** (`blob-store.ts`):

  ```ts
  export type BlobStore = {
    put(key: string, file: string /* local temp path */, opts: { contentType: string; bytes: number }): Promise<void>;
    stream(key: string, range?: { start: number; end: number }): Promise<NodeJS.ReadableStream>;
    delete(key: string): Promise<void>;
    exists(key: string): Promise<boolean>;
    /** A URL the browser can fetch without a session: local → /f/<token>; S3 → presigned. */
    signedUrl(key: string, opts: { expiresIn: number; disposition: 'inline' | 'attachment';
                                    filename: string; contentType: string }): Promise<string>;
  };
  ```

  Keys are built **only from ids**: `f/<locationId>/<fileId>` for originals, `d/<fileId>/<variant>.jpg` for derivatives. Never from a user-supplied name (D157).
- [ ] **Step 4: `local.ts`.**
  - It writes under `KEPT_DATA_DIR/blobs/`: to a temp file in the same filesystem, then `rename`, with mode 0640.
  - It refuses any key containing `..`, a leading `/`, or anything outside `^[a-z]/[0-9a-f-/]+(\.jpg)?$`.
  - Tests: a round-trip; a traversal key throws; delete is idempotent.
- [ ] **Step 5: `signed-url.ts`.**
  - The token is base64url of `{k, exp, d, n, t}` + `.` + HMAC-SHA256. The HMAC key comes from `hkdfSync('sha256', env.authSecret, 'kept-files', 'signed-url', 32)`.
  - `verify(token)` compares in constant time and checks expiry. The default life is 5 minutes.
  - Tests: tampering fails; expiry fails; a URL made for another key fails.
- [ ] **Step 6: `sniff.ts`.**
  - `sniff(path)` uses `fileTypeFromFile`. The allow-list is JPEG, PNG, WebP, HEIC/HEIF, AVIF, GIF, PDF, MP4/QuickTime (MP4/QuickTime only through a flag, for the 1.x videos of D170). The declared type is ignored.
  - An SVG is refused as an attachment in step 2 (Q9).
  - Tests use tiny fixture files in `apps/server/test/fixtures/files/`: `photo.jpg` (with a GPS EXIF block), `rotated.jpg` (EXIF orientation 6), `doc.pdf`, `fake.jpg` (HTML text renamed), `image.heic`.
- [ ] **Step 7:** Run `pnpm test`, then commit: `feat(server): step-2 route registry, response gates, blob store and route catalogue`.

### Task 3: Web scaffolding, design-system additions and the brand

**Files:**
- Create: route stubs listed in the file structure (each renders `<Page title>` + `ComingLater`, so `routeTree.gen.ts` is generated once, here)
- Create: `apps/web/src/api/inventory/{paths.ts,types.ts,queries.ts}`, `apps/web/src/api/inventory/mock/{places,things,registries,search,files,home,trash}.ts`; modify `api/mock/server.ts` to compose per-area handler arrays
- Create: `components/list-surface.tsx`, `components/id-chip.tsx`, `components/status-pill.tsx`, `components/type-icon.tsx`, `components/brand.tsx`, `lib/three-way.ts`, `lib/url-state.ts`
- Create: `apps/web/public/*` icons, and `scripts/render-icons.mjs` (dev only; it uses `sharp`, added to the root devDependencies)
- Modify: `apps/web/index.html` (favicon, `apple-touch-icon`), `components/app-shell.tsx` (the lockup; sidebar entries Trash and Activity, per screens §1 and §8)
- Test: `list-surface.test.tsx`, `id-chip.test.tsx`, `three-way.test.ts`, `type-icon.test.tsx`

- [ ] **Step 1: API types.** Write `api/inventory/types.ts` from the route shapes in Phase B, verbatim. It is the web's contract; the server tasks implement the same shapes. Write `paths.ts` for every step-2 path. Mock handlers answer from fixtures that include an Arabic household. Queries use the key factories `keys.places.*`, `keys.things.*`, `keys.search(params)` and so on.
- [ ] **Step 2: `ListSurface` (L88).** Props: `{search?, filters: FilterDef[], groups?: GroupDef[], query (useInfiniteQuery over next_cursor), renderRow, empty}`.
  - State is in URL search params via `lib/url-state.ts`: a zod `validateSearch` helper for TanStack Router, carrying `q`, `f.<name>`, `group` and `sort`.
  - It shows a "Load more" button (the cursor) and keeps focus on the first new row.
  - Tests: typing updates the URL; back restores the list; filter chips with a zero count are hidden when the definition says so (D191); keyboard operation; RTL render.
- [ ] **Step 3: `IdChip` (D134).**
  - Plex Mono on an amber-tape fill (`#F0B03A`, text `#2E2100`), always LTR (`dir="ltr"`, `<bdi>`), with the full code as its accessible name.
  - The "ID pending" variant is for step 3.
  - The tape animation (D195) runs only under `prefers-reduced-motion: no-preference`, on first mount after allocation.
  - `StatusPill` shows an icon plus a word plus a colour (never colour alone, spec §4): uncertain, draft, ended, needs review.
- [ ] **Step 4: `TypeIcon`.**
  - Resolves `lucide:*`, `tabler:*` and `kept:*`.
  - A static map covers the built-in icons, imported by name so they tree-shake. The full picker loads `lucide-react`'s dynamic entry (check the 1.48.0 exports; use whichever lazy module it offers) inside the lazy type-editor chunk only.
  - Add a bundle-size check: `vite build` plus a test that fails if the entry chunk grows more than 25 KB gzip over its current size (D80, L88).
- [ ] **Step 5: Brand (D135).**
  - `Brand` renders the lockup: `KEPT` in Plex Mono SemiBold (shipped font) on the tape, with the punched hole. Adapt it from the board's "B · Label tape" SVG in `docs/design/kept-design-board.html`.
  - `public/favicon.svg` and the app icons: the full square of tape with a **heavy stroked "K" drawn as paths** (the stroke construction of concept A, heavier), so no font is needed. The hole shows at app-icon size and is dropped at 16 px.
  - `scripts/render-icons.mjs` rasterises the SVGs to PNG at 32, 180, 192 and 512, plus a maskable 512 with a 20% safe zone. Commit the outputs.
- [ ] **Step 6: `lib/three-way.ts` (D156).** `merge(base, mine, theirs, fields)` returns `{merged, conflicts: [{field, mine, theirs}]}`.
  - A field only the other person changed is taken from `theirs`.
  - A field only I changed keeps `mine`.
  - A field both changed, to different values, is a conflict.
  - Table tests cover the cases.
- [ ] **Step 7:** Commit: `feat(web): step-2 route stubs, list surface, ID chip, type icons and the Label-tape brand`.

---

## Phase A: schema, RLS and the definer paths (T4–T10, sequential, one owner)

Each task ends with `pnpm test` green, **including `test/leak.test.ts`**, and `drizzle-kit generate` producing nothing. The migration numbers below are the expected ones: generated files come from drizzle-kit, custom ones from `drizzle-kit generate --custom --name=<name>`.

### Task 4: Bookkeeping, `kept.normalize`, account scope, currencies and reference seeding (0009)

**Files:**
- Custom migration: `0009_inventory_foundations.sql`
- Create: `apps/server/src/db/seed-reference.ts`; modify `src/db/migrate.ts` (call `seedReference(client)` after `installPgBoss`)
- Test: `src/db/normalize.test.ts`, `src/db/touch-row.test.ts`, `src/db/account-scope.test.ts`, `src/db/seed-reference.test.ts`; update `leak.test.ts`, `migrate.test.ts`, `schema.test.ts`

- [ ] **Step 1: Failing tests.**
  - `normalize.test.ts` loops over `packages/shared/src/normalize.vectors.json`, checking `SELECT kept.normalize($1)` and `kept.strip_prefixes(kept.normalize($1))`, as `kept_app`.
  - `touch-row.test.ts` uses a temporary table in a rolled-back owner transaction:
    - with arguments `('quiet_col', 'seq_col')`, changing `quiet_col` changes neither `row_version` nor `change_seq`;
    - changing `seq_col` bumps `change_seq` only;
    - changing anything else bumps both;
    - with no arguments, the behaviour is unchanged (every UPDATE bumps).
- [ ] **Step 2: `kept.touch_row()` takes optional arguments (Q1).** The trigger's `tgfoid` stays `kept.touch_row()`, so `schema.test.ts` keeps passing.

  ```sql
  CREATE OR REPLACE FUNCTION kept.touch_row() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE
    book  constant text[] := ARRAY['row_version','updated_at','change_seq'];
    quiet text[] := CASE WHEN TG_NARGS > 0 THEN string_to_array(TG_ARGV[0], ',') ELSE '{}' END;
    seqc  text[] := CASE WHEN TG_NARGS > 1 THEN string_to_array(TG_ARGV[1], ',') ELSE '{}' END;
  BEGIN
    IF TG_OP = 'UPDATE' AND TG_NARGS > 0
       AND (to_jsonb(NEW) - book - quiet - seqc) = (to_jsonb(OLD) - book - quiet - seqc) THEN
      -- Only cache columns changed (§7.9, D183): no row_version, no updated_at.
      NEW.row_version := OLD.row_version;
      NEW.updated_at  := OLD.updated_at;
      NEW.change_seq  := CASE WHEN (to_jsonb(NEW) - book - quiet) = (to_jsonb(OLD) - book - quiet)
                              THEN OLD.change_seq ELSE nextval('kept.change_seq') END;
      RETURN NEW;
    END IF;
    NEW.change_seq := nextval('kept.change_seq');
    IF TG_OP = 'UPDATE' THEN
      NEW.row_version := OLD.row_version + 1;
      NEW.updated_at := now();
    END IF;
    RETURN NEW;
  END $$;
  ```

- [ ] **Step 3: Normalisation in SQL (D42, D172, screens §8).** None of these are definers. Grant `EXECUTE` to `kept_app` and `kept_system`, and list them as BOTH.

  ```sql
  CREATE FUNCTION kept.normalize(t text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT btrim(regexp_replace(
      translate(
        regexp_replace(public.unaccent('public.unaccent'::regdictionary, lower(normalize(t, NFKC))),
                       '[ً-ٰٟـ]', '', 'g'),
        'أإآٱىةیک٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹',
        'ااااي' || 'ه' || 'ي' || 'ك' || '0123456789' || '0123456789'),
      '\s+', ' ', 'g'))
  $$;
  CREATE FUNCTION kept.strip_prefixes(t text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT regexp_replace(regexp_replace(t, '(^|\s)(?:[وبفك])?ال(\S{2,})', '\1\2', 'g'),
                          '(^|\s)لل(\S{2,})', '\1\2', 'g')
  $$;
  CREATE FUNCTION kept.search_text(t text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT coalesce(kept.normalize(t) || ' ' || kept.strip_prefixes(kept.normalize(t)), '')
  $$;
  ```

  If a vector disagrees between the JavaScript and SQL twins, fix the twin, never the vector (unless the vector is wrong for real Arabic; V20).
- [ ] **Step 4: Account scope.** These are definers, APP only, following 0006's pattern.

  ```sql
  CREATE FUNCTION kept.visible_account_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
    SELECT DISTINCT l.owner_account_id FROM public.locations l
     WHERE l.id IN (SELECT kept.visible_location_ids())
  $$;
  -- writable_account_ids(): same over kept.writable_location_ids();
  -- admin_account_ids(): same over kept.admin_location_ids().
  CREATE FUNCTION kept.recovery_kit_acknowledged() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
    SELECT EXISTS (SELECT 1 FROM public.instance_settings WHERE key = 'recovery_kit_acknowledged_at')
  $$;
  ```

- [ ] **Step 5: Account-level audit events for the registries (Q15).** Drop and recreate `app_select`/`app_insert` on `audit_events`, adding one branch each while keeping every existing branch.
  - SELECT: `OR (location_id IS NULL AND entity_type = ANY (ARRAY['type','type_field','place_kind','brand','vendor','person','tag']) AND owner_account_id IN (SELECT kept.admin_account_ids()))`.
  - INSERT: the same entity list, with `actor_type='user' AND actor_id = kept.current_user_id() AND owner_account_id IN (SELECT kept.writable_account_ids())`. Members create people, vendors and tags inline.
  - `rls.test.ts` cases:
    - an admin of B's location (not the owner) can write and read a `brand.update` event on B's account;
    - they cannot write an `account.update` event there;
    - a viewer can do neither.
- [ ] **Step 6: Currencies (D136, D168).**
  - In `0009`: `CREATE POLICY app_admin_update ON public.currencies FOR UPDATE TO kept_app USING ((SELECT kept.is_instance_admin())) WITH CHECK ((SELECT kept.is_instance_admin()));` and `GRANT UPDATE (enabled) ON public.currencies TO kept_app;`.
  - `seed-reference.ts`, run as `kept_owner` inside the migrate lock, upserts every `ISO_CURRENCIES` row as `INSERT … ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, minor_units = EXCLUDED.minor_units`. It **never touches `enabled`**; new rows get `enabled = code = ANY(SUPPORTED_DEFAULT)`. `name` is the English name from `Intl.DisplayNames`; `symbol` is the narrow symbol.
  - Test: the five currencies are enabled with 2 minor units; `JPY` exists, is disabled, with 0; a second `runMigrations` changes nothing; an admin's `enabled` choice survives a re-run.
- [ ] **Step 7: Lists.** Add to `FUNCTIONS` (leak) and to the migrate map:
  - `normalize`, `strip_prefixes`, `search_text`: BOTH, invoker;
  - the three account functions and `recovery_kit_acknowledged`: APP, definer.
- [ ] **Step 8:** Commit: `feat(db): cache-aware touch_row, Arabic normalisation, account scope and currency seeding`.

### Task 5: Registries and types (0010 generated, 0011 custom)

**Files:**
- Create: `src/db/schema/registries.ts` (place_kinds, types, type_fields, brands, vendors, people, person_contacts, tags)
- Migrations: `0010_registries.sql` (drizzle-kit), `0011_registries_rls.sql` (custom)
- Modify: `seed-reference.ts` (built-in types, groups and place kinds from `@kept/shared` `builtin-types.ts`)
- Test: `src/db/registries.test.ts`; update `leak.test.ts` (`fillTenant`, `FUNCTIONS`), `migrate.test.ts`

- [ ] **Step 1: Tables.** Drizzle, with text + CHECK enums (D183) and the mutable columns.

  ```sql
  CREATE TABLE place_kinds (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    owner_account_id uuid REFERENCES owner_accounts(id) ON DELETE CASCADE,   -- NULL = built-in
    key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
    name text, icon text NOT NULL, archived_at timestamptz, …mutable,
    UNIQUE NULLS NOT DISTINCT (owner_account_id, key),
    UNIQUE (owner_account_id, id));
  CREATE TABLE types (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    owner_account_id uuid REFERENCES owner_accounts(id) ON DELETE CASCADE,   -- NULL = built-in
    builtin_key text, copied_from_id uuid REFERENCES types(id) ON DELETE SET NULL,
    parent_id uuid REFERENCES types(id) ON DELETE NO ACTION,
    name text CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 80),
    search_names text,                  -- built-ins: en + ar names, for search (§7.9)
    icon text NOT NULL CHECK (icon ~ '^(lucide|tabler|kept):[a-z0-9-]+$'),
    colour text CHECK (colour ~ '^#[0-9A-Fa-f]{6}$'),
    capabilities text[] NOT NULL DEFAULT '{}' CHECK (capabilities <@ ARRAY['container','metered','warranty','serialized','consumable','expires']),
    default_meter jsonb,                -- {kind, unit}
    is_field_group boolean NOT NULL DEFAULT false,
    field_groups uuid[] NOT NULL DEFAULT '{}',
    default_warranty_months int CHECK (default_warranty_months >= 0),
    archived_at timestamptz, …mutable,
    CHECK ((owner_account_id IS NULL) = (builtin_key IS NOT NULL)),
    UNIQUE (owner_account_id, id));
  CREATE UNIQUE INDEX types_builtin_key_uq ON types (builtin_key) WHERE owner_account_id IS NULL;
  CREATE TABLE type_fields (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    owner_account_id uuid REFERENCES owner_accounts(id) ON DELETE CASCADE,   -- §7.13; NULL = built-in
    type_id uuid, place_kind_id uuid,
    key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
    label text, kind text NOT NULL CHECK (kind IN ('text','number','date','select','multi_select','boolean','url','money','person','vendor','file')),
    unit text, options jsonb, repeatable boolean NOT NULL DEFAULT false,
    required boolean NOT NULL DEFAULT false, sort int NOT NULL DEFAULT 0,
    secret boolean NOT NULL DEFAULT false, archived_at timestamptz, …mutable,
    CHECK (num_nonnulls(type_id, place_kind_id) = 1),
    CHECK (NOT secret OR kind = 'text'),
    FOREIGN KEY (owner_account_id, type_id) REFERENCES types(owner_account_id, id) ON DELETE CASCADE,
    FOREIGN KEY (owner_account_id, place_kind_id) REFERENCES place_kinds(owner_account_id, id) ON DELETE CASCADE);
  -- partial uniques: (type_id, key) WHERE type_id IS NOT NULL; (place_kind_id, key) WHERE place_kind_id IS NOT NULL
  CREATE TABLE brands  (id, owner_account_id NOT NULL → owner_accounts CASCADE, name 1–120, website, support_phone,
                        claim_url, default_warranty_months, …mutable, UNIQUE (owner_account_id, id));
  CREATE TABLE vendors (id, owner_account_id NOT NULL, name 1–120, kind CHECK (store|online|service_centre|station|other),
                        address, phone, website, …mutable, UNIQUE (owner_account_id, id));
  CREATE TABLE people  (id, owner_account_id NOT NULL, display_name 1–120,
                        member_user_id uuid REFERENCES auth."user"(id) ON DELETE SET NULL,  -- not `user_id`: it isn't the scope
                        …mutable, UNIQUE (owner_account_id, id));
  CREATE TABLE person_contacts (person_id uuid PRIMARY KEY, owner_account_id uuid NOT NULL, phone, email, notes, …mutable,
                        FOREIGN KEY (owner_account_id, person_id) REFERENCES people(owner_account_id, id) ON DELETE CASCADE);
  CREATE TABLE tags    (id, owner_account_id NOT NULL, name 1–60, colour, …mutable, UNIQUE (owner_account_id, id));
  ```

  In the custom migration:
  - the composite `type_fields` FKs are `MATCH SIMPLE`, so a built-in (NULL owner) skips them, and a trigger covers that case (step 3);
  - add the expression uniques `brands (owner_account_id, kept.normalize(name))` and `tags (owner_account_id, kept.normalize(name))`;
  - add trigram GIN indexes on `kept.normalize(name)` for brands, vendors and people, and on `display_name` for people.
- [ ] **Step 2: RLS** (in `0011`).

  | Tables | SELECT | INSERT | UPDATE / DELETE |
  |---|---|---|---|
  | `types`, `type_fields`, `place_kinds` | `owner_account_id IS NULL OR owner_account_id IN (SELECT kept.visible_account_ids())` | `owner_account_id IN (SELECT kept.admin_account_ids())` | admin accounts (D123). Built-ins can never be written: NULL fails the check |
  | `brands` | visible accounts | admin accounts | admin accounts |
  | `vendors`, `people` | visible accounts | **writable** accounts (members create inline, D11) | admin accounts |
  | `tags` | visible accounts | writable (`tags.create`) | admin (`tags.edit-delete`) |
  | `person_contacts` | `kept.person_contact_visible(person_id)` | writable accounts | `kept.person_contact_visible(person_id)` |

  ```sql
  -- D177: contact details only for someone who administers every location that uses the person;
  -- a person used nowhere: an admin of any location of the account (Q5).
  CREATE FUNCTION kept.person_contact_visible(p_person uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
    SELECT EXISTS (SELECT 1 FROM public.people p
                    WHERE p.id = p_person AND p.owner_account_id IN (SELECT kept.admin_account_ids()))
       AND NOT EXISTS (SELECT 1 FROM public.things t
                        WHERE t.belongs_to_person_id = p_person AND t.deleted_at IS NULL
                          AND t.location_id NOT IN (SELECT kept.admin_location_ids()))
  $$;
  ```

  Create it here, but **ship it in 0011 with only the `people` clause**, because `things` does not exist yet. T6 `CREATE OR REPLACE`s it to add the `things` clause, and T6's test covers that.

  Column grants:
  - `types (parent_id, name, icon, colour, capabilities, default_meter, field_groups, default_warranty_months, archived_at, updated_at, row_version)`;
  - `type_fields (label, unit, options, repeatable, required, sort, archived_at, updated_at, row_version)`. No `key`, `kind` or `secret`: converting a kind or a secret is later work (Q3, Q11);
  - `place_kinds (name, icon, archived_at, …)`;
  - `brands (name, website, support_phone, claim_url, default_warranty_months, …)`;
  - `vendors (name, kind, address, phone, website, …)`;
  - `people (display_name, member_user_id, …)`;
  - `person_contacts (phone, email, notes, …)`;
  - `tags (name, colour, …)`.

  `touch_row` goes on all eight tables.
- [ ] **Step 3: Guards.** Invoker triggers, revoked from everyone (`OWNER_ONLY` in the migrate map). For each, first write a failing `registries.test.ts` case.
  - `kept.guard_type()`, BEFORE INSERT OR UPDATE OF `parent_id, field_groups, owner_account_id` ON `types`:
    - the parent is a non-group type, built-in or in the same account; otherwise 42501 `types_parent_account`;
    - an advisory lock `(hashtext('kept.types'), hashtext(coalesce(owner_account_id::text,'')))`, then a recursive walk up; a loop raises 23514 `types_no_loop` (D92);
    - every element of `field_groups` is an `is_field_group` type, built-in or in the same account; otherwise 42501;
    - a field group has no parent and is never itself a parent.
  - `kept.guard_type_field()`, BEFORE INSERT OR UPDATE ON `type_fields`:
    - `owner_account_id` equals its type's or kind's owner (this covers the built-in NULL case);
    - the key is not already defined by any ancestor, by any ancestor's groups or by the type's own groups, and no descendant defines it (§7.13); otherwise 23514 `type_fields_inherited_key`.
  - `kept.type_chain(p_type uuid) RETURNS TABLE(id uuid, depth int)` and `kept.type_capabilities(p_type uuid) RETURNS text[]` (the union up the chain). Both STABLE invoker, APP and BOTH.
- [ ] **Step 4: The built-in seed** (`seed-reference.ts`).
  - Upsert types by `builtin_key`, in parent-first order; then each type's own fields by `(type_id, key)`. `label` stays NULL: names come from the shared en/ar names, and `search_names` holds them.
  - `field_groups` are resolved by key.
  - A built-in field no longer in the library gets `archived_at` and is never deleted.
  - Upsert place kinds `floor, room, zone, closet` with their icons.
  - Tests: re-running is a no-op (same `row_version`); every type in `builtin-types.ts` exists; `phone` resolves to device fields plus `imei`; `computer.licence_key` is `secret`; `vehicle` has `default_meter`.
- [ ] **Step 5: `CONFLICT_HINTS`** (`http/errors.ts`) gains `types_no_loop`, `type_fields_inherited_key`, `brands_name_uq` and `tags_name_uq`.
- [ ] **Step 6: Leak test.**
  - `fillTenant()` inserts, for each tenant: a place kind; a custom type with a built-in parent (`electronics`); a type field on it; a brand, a vendor, a person; its `person_contacts` row; a tag.
  - `FUNCTIONS` gains the new functions.
  - Everything else is generated from the catalogue, so this should pass once the rows exist. If "sees its own rows" fails for `person_contacts`, the definer is wrong.
- [ ] **Step 7:** Commit: `feat(db): type tree, place kinds and account registries with RLS and built-in library`.

### Task 6: Things, short IDs, links and tags; the places extension (0012 generated, 0013 custom)

**Files:**
- Create: `src/db/schema/things.ts`; modify `src/db/schema/places.ts`
- Migrations: `0012_things.sql`, `0013_things_rls.sql`
- Modify: `audit/classes.ts` (`thing.ended_price: 'money'`; and `CACHE_COLUMNS = ['search_tsv','place_path']`, added to `audited()`'s BOOKKEEPING set)
- Test: `src/db/things.test.ts`; update `leak.test.ts`, `migrate.test.ts`

- [ ] **Step 1: Places.**
  - Add `icon text`, `sort int NOT NULL DEFAULT 0`, `custom jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(custom)='object')`, `trash_batch_id uuid`, `created_by uuid`.
  - Swap `places_parent_fk` to `ON DELETE NO ACTION` (Q12).
  - Grant UPDATE on `icon, sort, custom, trash_batch_id` in addition to the existing columns.
  - Add a trigram index on `kept.normalize(name) WHERE deleted_at IS NULL`.
- [ ] **Step 2: `things`** (the §1.3 columns with the §7.13 amendments).

  ```sql
  CREATE TABLE things (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    place_id uuid, container_id uuid,
    type_id uuid REFERENCES types(id) ON DELETE NO ACTION,
    name text CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 200),
    brand_id uuid REFERENCES brands(id) ON DELETE SET NULL,
    model text CHECK (char_length(model) <= 120), serial text CHECK (char_length(serial) <= 100),
    barcode text CHECK (char_length(barcode) <= 64), colour text CHECK (char_length(colour) <= 60),
    quantity numeric(12,3) NOT NULL DEFAULT 1 CHECK (quantity >= 0),
    condition text CHECK (condition IN ('new','good','fair','poor','broken')),
    notes text CHECK (char_length(notes) <= 5000),
    aliases jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(aliases) = 'object'),
    belongs_to_person_id uuid REFERENCES people(id) ON DELETE SET NULL,
    purchase_line_id uuid,                       -- FK added in T7
    manual_url text, expires_on date, expiry_lead_days int CHECK (expiry_lead_days BETWEEN 0 AND 3650),
    lifecycle text NOT NULL DEFAULT 'in_use' CHECK (lifecycle IN ('in_use','sold','given_away','lost','disposed','stolen','destroyed','returned_to_owner')),
    ended_on date, ended_price numeric(16,4) CHECK (ended_price >= 0),
    ended_currency char(3) REFERENCES currencies(code), ended_to text, ended_notes text,
    acquired_from text, provenance_notes text,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    location_uncertain boolean NOT NULL DEFAULT false,
    custom jsonb NOT NULL DEFAULT '{}', archived_custom jsonb NOT NULL DEFAULT '{}',
    field_status jsonb NOT NULL DEFAULT '{}',
    review_state text NOT NULL DEFAULT 'confirmed' CHECK (review_state IN ('draft','confirmed')),
    created_via text NOT NULL DEFAULT 'app' CHECK (created_via IN ('app','mcp','assistant','import','email')),
    created_by uuid, split_from_id uuid REFERENCES things(id) ON DELETE SET NULL,
    place_path text, search_tsv tsvector,        -- cache (§7.9)
    deleted_at timestamptz, trash_batch_id uuid, …mutable,
    UNIQUE (location_id, id),
    FOREIGN KEY (location_id, place_id)     REFERENCES places(location_id, id) ON UPDATE CASCADE ON DELETE NO ACTION,
    FOREIGN KEY (location_id, container_id) REFERENCES things(location_id, id) ON UPDATE CASCADE ON DELETE NO ACTION,
    CHECK (num_nonnulls(place_id, container_id) = 1),
    CHECK (container_id IS NULL OR container_id <> id),
    CHECK (name IS NOT NULL OR review_state = 'draft'),
    CHECK ((ended_price IS NULL) = (ended_currency IS NULL)),
    CHECK (lifecycle <> 'in_use' OR (ended_on IS NULL AND ended_price IS NULL AND ended_to IS NULL)));
  ```

  Indexes, in the custom migration:
  - `things_search_idx` GIN (`search_tsv`) and `things_name_trgm` GIN (`kept.normalize(name)` gin_trgm_ops), both `WHERE deleted_at IS NULL`;
  - `things_serial_idx (location_id, kept.normalize(serial))` and `(location_id, barcode)`;
  - `(place_id)`, `(container_id)`;
  - `(location_id, last_seen_at) WHERE lifecycle='in_use' AND deleted_at IS NULL`;
  - partial indexes `WHERE location_uncertain`, `WHERE review_state='draft'` and `(expires_on) WHERE expires_on IS NOT NULL`;
  - `(location_id, deleted_at) WHERE deleted_at IS NOT NULL` for trash;
  - `(location_id, lower(name) COLLATE "und-x-icu")` for sorting (D172; check that the collation exists in the pgvector image with `SELECT * FROM pg_collation WHERE collname='und-x-icu'`).

  The trigger: `CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON things FOR EACH ROW EXECUTE FUNCTION kept.touch_row('place_path,search_tsv', 'last_seen_at');`.
- [ ] **Step 3: `short_ids`** (D45, D112, D120, §7.13: never deleted).

  ```sql
  CREATE TABLE short_ids (
    code char(6) PRIMARY KEY CHECK (code ~ '^[0-9A-HJKMNP-TV-Z]{6}$'),
    location_id uuid NOT NULL,          -- no FK to locations: a retired code outlives a purged location
    thing_id uuid, place_id uuid,
    state text NOT NULL DEFAULT 'assigned' CHECK (state IN ('blank','assigned','retired')),
    is_primary boolean NOT NULL DEFAULT true,
    printed_at timestamptz, claimed_at timestamptz, claimed_by uuid, …mutable,
    CHECK (CASE state WHEN 'blank' THEN num_nonnulls(thing_id, place_id) = 0
                      WHEN 'assigned' THEN num_nonnulls(thing_id, place_id) = 1
                      ELSE num_nonnulls(thing_id, place_id) <= 1 END));
  -- custom SQL (Drizzle can't say SET NULL (col)):
  ALTER TABLE short_ids ADD CONSTRAINT short_ids_thing_fk FOREIGN KEY (location_id, thing_id)
    REFERENCES things(location_id, id) ON UPDATE CASCADE ON DELETE SET NULL (thing_id);
  ALTER TABLE short_ids ADD CONSTRAINT short_ids_place_fk FOREIGN KEY (location_id, place_id)
    REFERENCES places(location_id, id) ON UPDATE CASCADE ON DELETE SET NULL (place_id);
  CREATE UNIQUE INDEX short_ids_primary_thing_uq ON short_ids (thing_id) WHERE is_primary AND state = 'assigned';
  CREATE UNIQUE INDEX short_ids_primary_place_uq ON short_ids (place_id) WHERE is_primary AND state = 'assigned';
  -- BEFORE UPDATE: an assigned code whose target was purged becomes a retired tombstone.
  CREATE FUNCTION kept.retire_orphan_code() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW.state = 'assigned' AND NEW.thing_id IS NULL AND NEW.place_id IS NULL THEN
      NEW.state := 'retired'; NEW.is_primary := false;
    END IF;
    RETURN NEW;
  END $$;
  ```

  Policies: SELECT visible; INSERT writable; UPDATE writable, with `GRANT UPDATE (printed_at, is_primary, updated_at, row_version)`. **No DELETE policy for anyone but `kept_owner`.**
- [ ] **Step 4: `thing_links` and `thing_tags`.**
  - `thing_links (id, location_id, from_thing_id, to_thing_id, kind CHECK (accessory_of|spare_part_for|consumable_for|bundled_with|replaces|related), created_by, …mutable)`:
    - composite FKs to `things(location_id, id)`, ON UPDATE CASCADE ON DELETE CASCADE;
    - `UNIQUE (from_thing_id, to_thing_id, kind)` and `CHECK (from_thing_id <> to_thing_id)`;
    - no UPDATE grant.
  - `thing_tags (location_id, thing_id, tag_id, PRIMARY KEY (thing_id, tag_id))`: composite FK to things (CASCADE both ways), `tag_id → tags(id) ON DELETE CASCADE`, no UPDATE.
- [ ] **Step 5: Thing triggers.** All invoker and revoked (`OWNER_ONLY`), each with a failing test first.
  - `kept.guard_thing_refs()`, BEFORE INSERT OR UPDATE OF `type_id, brand_id, belongs_to_person_id, location_id`:
    - reads `locations.owner_account_id` for `NEW.location_id`;
    - every non-null reference must be visible **and** built-in-or-same-account (`types`: also `NOT is_field_group`);
    - otherwise 42501 `things_registry_account`, which answers 404. An invisible id and a missing id look the same (§7.7, D178).
  - `kept.guard_thing_tags()`, BEFORE INSERT ON `thing_tags`: the tag's account is the thing's location owner. Otherwise 42501.
  - `kept.guard_thing_quantity()`, BEFORE INSERT OR UPDATE OF `quantity, type_id` (D10, §7.13, Q11):
    - `caps := kept.type_capabilities(NEW.type_id)`;
    - quantity ≠ 1 while `caps && ARRAY['serialized','metered']`, or while a `meters` row exists, raises 23514 `things_quantity_one`. The meters check is added in T7 through `CREATE OR REPLACE`;
    - quantity = 0 without `consumable` raises 23514 `things_quantity_positive`.
  - `kept.check_thing_container()`: a container loop is refused, as with places (lock per location, walk up `container_id`), raising 23514 `things_no_loop`.
  - `kept.path_of(p_place uuid, p_container uuid) RETURNS jsonb`, STABLE invoker, APP: walks container → … → place → … → root, and returns `[{id, name, kind:'place'|'thing'}]` from the root to the leaf, capped at depth 64.
  - `kept.thing_search_doc(t public.things) RETURNS tsvector`, STABLE invoker, APP:

    ```sql
    SELECT setweight(to_tsvector('simple', kept.search_text(concat_ws(' ', t.name,
             (SELECT string_agg(v, ' ') FROM jsonb_each(t.aliases) e, jsonb_array_elements_text(e.value) v)))), 'A')
        || setweight(to_tsvector('simple', kept.search_text(concat_ws(' ', t.model, t.serial, t.barcode,
             (SELECT b.name FROM public.brands b WHERE b.id = t.brand_id),
             (SELECT coalesce(ty.name, ty.search_names) FROM public.types ty WHERE ty.id = t.type_id),
             (SELECT string_agg(g.name, ' ') FROM public.thing_tags x JOIN public.tags g ON g.id = x.tag_id
               WHERE x.thing_id = t.id)))), 'B')
        || setweight(to_tsvector('simple', kept.search_text(concat_ws(' ', t.notes, t.colour, t.place_path,
             (SELECT p.display_name FROM public.people p WHERE p.id = t.belongs_to_person_id),
             -- scalar custom values only: money is an object {amount, currency} and never indexed
             (SELECT string_agg(v #>> '{}', ' ') FROM jsonb_each(t.custom) c(k, v)
               WHERE jsonb_typeof(v) IN ('string','number'))))), 'C')
    ```

  - `kept.thing_cache()`, BEFORE INSERT OR UPDATE ON `things`: `NEW.place_path := (SELECT string_agg(e->>'name', ' › ') FROM jsonb_array_elements(kept.path_of(NEW.place_id, NEW.container_id)) e)`, then `NEW.search_tsv := kept.thing_search_doc(NEW)`.
  - `kept.refresh_thing_doc()`, AFTER INSERT OR DELETE ON `thing_tags`: `UPDATE public.things SET search_tsv = NULL WHERE id = …`. The BEFORE trigger recomputes it, and `touch_row` sees only a quiet change (no `row_version` bump; tested).
  - `CREATE OR REPLACE kept.person_contact_visible` to add the `things` clause (see T5).
- [ ] **Step 6: RLS and grants.**
  - `things`, `thing_links`, `thing_tags`: SELECT visible; INSERT/UPDATE/DELETE writable.
  - `GRANT UPDATE ON things` for: `place_id, container_id, type_id, name, brand_id, model, serial, barcode, colour, quantity, condition, notes, aliases, belongs_to_person_id, purchase_line_id, manual_url, expires_on, expiry_lead_days, lifecycle, ended_on, ended_price, ended_currency, ended_to, ended_notes, acquired_from, provenance_notes, last_seen_at, location_uncertain, custom, archived_custom, field_status, review_state, search_tsv, deleted_at, trash_batch_id, updated_at, row_version`.
  - Not granted: `id`, `location_id`, `created_via`, `created_by`, `split_from_id`, `place_path`.
- [ ] **Step 7: Tests** (`things.test.ts`, as `kept_app`):
  - exactly one of place or container;
  - a container loop is refused;
  - B's type, brand or person on A's thing → 42501, the same as a random id;
  - a built-in type is accepted;
  - a serialized type with quantity 2 is refused; a consumable with quantity 0 is accepted;
  - `search_tsv` finds `الكابل` by `كابل` and `cable` (alias), and `HDMI` by trigram typo `hmdi`;
  - renaming a thing bumps `row_version`, but a tag insert does not;
  - `last_seen_at` changes bump `change_seq` only;
  - deleting a thing (owner) turns its `short_ids` row into `retired`, keeping its `location_id`;
  - kept_app cannot DELETE a `short_ids` row (0 rows).
- [ ] **Step 8: Leak test.** `fillTenant()` inserts:
  - a thing in the room (with a tag and a short ID);
  - a container thing with a thing inside;
  - a link between the two.

  Add the new functions to both lists.
- [ ] **Step 9:** Commit: `feat(db): things, short IDs, links and tags with search and path caches`.

### Task 7: Purchases, lines and meters (0014 generated, 0015 custom)

**Files:**
- Create: `src/db/schema/purchases.ts`, `src/db/schema/meters.ts`
- Migrations: `0014_purchases_meters.sql`, `0015_purchases_meters_rls.sql`
- Modify: `audit/classes.ts`: `purchase.total`, `purchase.tax`, `purchase_line.unit_price` → `money`
- Test: `src/db/purchases.test.ts`, `src/db/meters.test.ts`; update leak and migrate lists

- [ ] **Step 1: Tables (D115, D113, §7.13).**

  ```sql
  CREATE TABLE purchases (
    id uuid PRIMARY KEY DEFAULT uuidv7(), location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    vendor_id uuid REFERENCES vendors(id) ON DELETE SET NULL,
    purchased_on date NOT NULL, currency char(3) REFERENCES currencies(code),
    total numeric(16,4) CHECK (total >= 0), tax numeric(16,4) CHECK (tax >= 0),
    notes text CHECK (char_length(notes) <= 5000),
    review_state text NOT NULL DEFAULT 'confirmed' CHECK (review_state IN ('draft','confirmed')),
    created_via text NOT NULL DEFAULT 'app' CHECK (…), created_by uuid, …mutable,
    UNIQUE (location_id, id),
    CHECK ((total IS NULL AND tax IS NULL) OR currency IS NOT NULL));
  CREATE TABLE purchase_lines (
    id uuid PRIMARY KEY DEFAULT uuidv7(), location_id uuid NOT NULL, purchase_id uuid NOT NULL,
    description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 300),
    quantity numeric(12,3) NOT NULL DEFAULT 1 CHECK (quantity > 0),
    unit_price numeric(16,4) CHECK (unit_price >= 0), sort int NOT NULL DEFAULT 0, …mutable,
    UNIQUE (location_id, id),
    FOREIGN KEY (location_id, purchase_id) REFERENCES purchases(location_id, id) ON UPDATE CASCADE ON DELETE CASCADE);
  ALTER TABLE things ADD CONSTRAINT things_purchase_line_fk
    FOREIGN KEY (purchase_line_id) REFERENCES purchase_lines(id) ON DELETE SET NULL;  -- plain: a moved thing keeps its line (D115)
  CREATE TABLE meters (
    id uuid PRIMARY KEY DEFAULT uuidv7(), location_id uuid NOT NULL, thing_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('distance','hours','custom')), unit text NOT NULL CHECK (char_length(unit) BETWEEN 1 AND 12),
    label text, "offset" numeric(14,3) NOT NULL DEFAULT 0, max_per_day numeric(14,3), …mutable,
    UNIQUE (location_id, id),
    FOREIGN KEY (location_id, thing_id) REFERENCES things(location_id, id) ON UPDATE CASCADE ON DELETE CASCADE);
  CREATE TABLE meter_readings (
    id uuid PRIMARY KEY DEFAULT uuidv7(), location_id uuid NOT NULL, meter_id uuid NOT NULL,
    value numeric(14,3) NOT NULL CHECK (value >= 0), taken_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
    source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','photo','fuel','service','import','home_assistant')),
    logged_by uuid, state text NOT NULL DEFAULT 'accepted' CHECK (state IN ('accepted','needs_review')),
    review_reason text, note text CHECK (char_length(note) <= 500), …mutable,
    UNIQUE (location_id, id),
    FOREIGN KEY (location_id, meter_id) REFERENCES meters(location_id, id) ON UPDATE CASCADE ON DELETE CASCADE);
  CREATE INDEX meter_readings_meter_taken_idx ON meter_readings (meter_id, taken_at);
  CREATE TABLE meter_events (
    id uuid PRIMARY KEY DEFAULT uuidv7(), location_id uuid NOT NULL, meter_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('replaced')), at timestamptz NOT NULL, "offset" numeric(14,3) NOT NULL, …mutable,
    FOREIGN KEY (location_id, meter_id) REFERENCES meters(location_id, id) ON UPDATE CASCADE ON DELETE CASCADE);
  ```

- [ ] **Step 2: Guards and doors.**
  - `kept.guard_purchase_line_link()`, BEFORE INSERT OR UPDATE OF `purchase_line_id` ON `things`, invoker: when the value changes and is not null, the line must be visible **and** in `NEW.location_id`. Otherwise 42501, which also answers 404 for a line in another tenant.
  - `kept.guard_purchase_vendor()`: the vendor belongs to the location's account.
  - `CREATE OR REPLACE kept.guard_thing_quantity()` adds the "has a meter" clause.
  - `kept.thing_purchase(p_thing uuid) RETURNS TABLE(purchase_id, location_id, purchased_on, vendor_name, currency, total, tax, line_id, line_description, line_quantity, unit_price, visible_purchase boolean)`, definer, APP:
    - returns rows only when `p_thing` is a thing in `kept.visible_location_ids()`;
    - `visible_purchase` says whether the caller can open the whole purchase (§7.2, D115);
    - the route strips money by the **thing's** location gate.
  - `kept.thing_receipts(p_thing uuid) RETURNS TABLE(attachment_id, file_id, role)`, definer, APP: the receipt and invoice attachments of the thing's purchase, for a visible thing. The files are then served through T18's `kept.thing_receipt_file` check, added in T8.
- [ ] **Step 3: RLS.**
  - All five tables: SELECT visible; INSERT/UPDATE/DELETE writable. The finer `logs.edit-own` and `meters.manage` rules are `can()`'s job in T17.
  - Grants: `purchases (vendor_id, purchased_on, currency, total, tax, notes, review_state, …)`, `purchase_lines (description, quantity, unit_price, sort, …)`, `meters (label, "offset", max_per_day, …)`, `meter_readings (value, taken_at, note, state, review_reason, …)`, `meter_events (at, "offset", …)`.
  - `touch_row` on all five.
- [ ] **Step 4: Tests.**
  - Linking a thing to B's line is refused (42501).
  - A thing moved (as owner) to another location keeps its line, and `thing_purchase()` still answers for a member of the new location only.
  - A second meter can't make quantity ≠ 1.
  - Money columns are classed `money` in the audit diff.
- [ ] **Step 5: Leak test.** `fillTenant()` adds a purchase with a line (linked to the room thing), a meter on the container thing, a reading and a meter event. Commit: `feat(db): purchases with lines, and core meters and readings`.

### Task 8: Files, attachments, secrets, saved views and hints (0016 generated, 0017 custom)

**Files:**
- Create: `src/db/schema/files.ts`, `src/db/schema/secrets.ts`, `src/db/schema/user.ts`
- Migrations: `0016_files_secrets.sql`, `0017_files_secrets_rls.sql`
- Test: `src/db/files.test.ts`, `src/db/secrets.test.ts`; update leak and migrate lists

- [ ] **Step 1: Files, derivatives and attachments (D117, D177, §7.13).**

  ```sql
  CREATE TABLE files (
    id uuid PRIMARY KEY DEFAULT uuidv7(), location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    storage_key text NOT NULL, sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    bytes bigint NOT NULL CHECK (bytes > 0), mime text NOT NULL,
    class text NOT NULL CHECK (class IN ('evidence','photo','document','video')),
    has_gps boolean NOT NULL DEFAULT false, width int, height int,
    derivative_state text NOT NULL CHECK (derivative_state IN ('ready','unavailable','not_applicable')),
    created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (location_id, sha256),               -- dedupe per location (D177)
    UNIQUE (location_id, id));
  CREATE INDEX files_storage_key_idx ON files (storage_key);   -- blobs shared by copies (D161)
  CREATE TABLE file_derivatives (
    file_id uuid NOT NULL, variant text NOT NULL CHECK (variant IN ('display','thumb','share','poster')),
    location_id uuid NOT NULL, storage_key text NOT NULL, width int NOT NULL, height int NOT NULL, bytes bigint NOT NULL,
    PRIMARY KEY (file_id, variant),
    FOREIGN KEY (location_id, file_id) REFERENCES files(location_id, id) ON UPDATE CASCADE ON DELETE CASCADE);
  CREATE TABLE attachments (
    id uuid PRIMARY KEY DEFAULT uuidv7(), location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    file_id uuid, url text CHECK (url ~ '^https?://'),
    thing_id uuid, place_id uuid, purchase_id uuid, meter_reading_id uuid,   -- typed subjects; none = the location (D155)
    role text NOT NULL CHECK (role IN ('photo','receipt','invoice','manual','warranty_doc','proof','condition_out','condition_in','registration','document')),
    sort int NOT NULL DEFAULT 0, created_by uuid NOT NULL, …mutable,
    CHECK (num_nonnulls(file_id, url) = 1),
    CHECK (num_nonnulls(thing_id, place_id, purchase_id, meter_reading_id) <= 1),
    FOREIGN KEY (location_id, thing_id)         REFERENCES things(location_id, id)         ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (location_id, place_id)         REFERENCES places(location_id, id)         ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (location_id, purchase_id)      REFERENCES purchases(location_id, id)      ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (location_id, meter_reading_id) REFERENCES meter_readings(location_id, id) ON UPDATE CASCADE ON DELETE CASCADE);
  -- custom: deferrable, so a cross-location move can re-home files within one transaction (T9)
  ALTER TABLE attachments ADD CONSTRAINT attachments_file_fk FOREIGN KEY (location_id, file_id)
    REFERENCES files(location_id, id) ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
  ```

  Policies:
  - `files` SELECT: `location_id IN (SELECT kept.visible_location_ids()) AND (created_by = (SELECT kept.current_user_id()) OR EXISTS (SELECT 1 FROM public.attachments a WHERE a.file_id = files.id))`. The subquery runs under the attachments policies, so a file is readable only through an attachment the user can see (§7.2, D177).
  - `files` INSERT: writable and `created_by = current_user_id()`. DELETE: writable. **No UPDATE grant.**
  - `file_derivatives` SELECT: `EXISTS (SELECT 1 FROM public.files f WHERE f.id = file_id)`; INSERT writable; DELETE writable; no UPDATE.
  - `attachments`: SELECT visible; INSERT writable with `created_by = me`; UPDATE writable, granting `(role, sort, …)`; DELETE writable. The own/any rule is `can()`'s job.
  - The trigger `kept.guard_attachment_file()`, BEFORE INSERT: a `file_id` must be visible to the caller. This stops attaching someone else's file id; the composite FK already keeps it in the same location.
  - `kept.thing_receipt_file(p_thing uuid, p_file uuid) RETURNS TABLE(storage_key, mime, bytes)`, definer, APP: the file only when it is attached as a receipt or invoice to the purchase of a thing visible to the caller (D115 after a move).
- [ ] **Step 2: Secrets (D116, D177, §7.13).**

  ```sql
  CREATE TABLE secret_values (
    id uuid PRIMARY KEY DEFAULT uuidv7(), location_id uuid NOT NULL,
    thing_id uuid, place_id uuid, type_field_id uuid NOT NULL REFERENCES type_fields(id) ON DELETE NO ACTION,
    field_key text NOT NULL, ciphertext jsonb NOT NULL, key_version int NOT NULL,
    updated_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), superseded_at timestamptz,
    CHECK (num_nonnulls(thing_id, place_id) = 1),
    FOREIGN KEY (location_id, thing_id) REFERENCES things(location_id, id) ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (location_id, place_id) REFERENCES places(location_id, id) ON UPDATE CASCADE ON DELETE CASCADE);
  CREATE UNIQUE INDEX secret_values_thing_current_uq ON secret_values (thing_id, field_key) WHERE superseded_at IS NULL AND thing_id IS NOT NULL;
  CREATE UNIQUE INDEX secret_values_place_current_uq ON secret_values (place_id, field_key) WHERE superseded_at IS NULL AND place_id IS NOT NULL;
  CREATE TABLE secret_field_policies (
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    type_field_id uuid NOT NULL REFERENCES type_fields(id) ON DELETE CASCADE,
    reveal_roles text[] NOT NULL DEFAULT ARRAY['owner','admin'] CHECK (reveal_roles <@ ARRAY['owner','admin','member','viewer']),
    reveal_user_ids uuid[] NOT NULL DEFAULT '{}', ai_allowed boolean NOT NULL DEFAULT false, …mutable,
    PRIMARY KEY (location_id, type_field_id));
  ```

  ```sql
  CREATE FUNCTION kept.can_reveal_secret(p_location uuid, p_field uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.memberships m
      LEFT JOIN public.secret_field_policies sp ON sp.location_id = m.location_id AND sp.type_field_id = p_field
       WHERE m.location_id = p_location AND m.user_id = kept.current_user_id()
         AND m.location_id IN (SELECT kept.visible_location_ids())
         AND (m.role = ANY (coalesce(sp.reveal_roles, ARRAY['owner','admin']))
              OR m.user_id = ANY (coalesce(sp.reveal_user_ids, '{}'))))
  $$;
  -- Which secret fields are set, for a thing or place the caller can see, without the values.
  CREATE FUNCTION kept.secret_fields_set(p_thing uuid, p_place uuid)
  RETURNS TABLE (type_field_id uuid, field_key text, updated_at timestamptz, can_reveal boolean) … definer, APP;
  -- Superseding the old version must work for a writer who can't reveal it (a member).
  CREATE FUNCTION kept.supersede_secret() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  BEGIN
    UPDATE public.secret_values SET superseded_at = now()
     WHERE superseded_at IS NULL AND field_key = NEW.field_key
       AND thing_id IS NOT DISTINCT FROM NEW.thing_id AND place_id IS NOT DISTINCT FROM NEW.place_id
       AND location_id = NEW.location_id;
    RETURN NEW;
  END $$;   -- BEFORE INSERT ON secret_values; NOBODY may execute it (definer: true in the leak list)
  ```

  Policies and grants:
  - `secret_values` SELECT: `location_id IN visible AND kept.can_reveal_secret(location_id, type_field_id)`.
  - `secret_values` INSERT: `location_id IN writable AND updated_by = current_user_id()`.
  - `secret_values` has no UPDATE and no DELETE for `kept_app`. History stays, and purging goes with its thing.
  - `secret_field_policies`: SELECT visible; write `kept.owns_location(location_id) AND location_id IN (SELECT kept.visible_location_ids())`, owner only (D177). Grant `(reveal_roles, reveal_user_ids, ai_allowed, …)`.
  - `kept.guard_secret_field()`, BEFORE INSERT on both tables: the type field is secret, and built-in or in the location's account.
- [ ] **Step 3: `saved_views` and `user_hints`** (D42, D138).
  - `saved_views (id, user_id NOT NULL → auth.user CASCADE, location_id → locations CASCADE NULL, name 1–80, query jsonb, shared boolean DEFAULT false, …mutable, CHECK (NOT shared OR location_id IS NOT NULL))`.
    - SELECT: `user_id = me OR (shared AND location_id IN visible)`.
    - INSERT/UPDATE/DELETE: `user_id = me AND (location_id IS NULL OR location_id IN visible) AND (NOT shared OR location_id IN writable)`.
    - Grant `(name, query, shared, …)`.
  - `user_hints (user_id, hint_key text CHECK (~ '^[a-z0-9_.:-]{1,64}$'), seen_at, dismissed boolean, PRIMARY KEY (user_id, hint_key))`: own rows only; grant `(seen_at, dismissed)`.
- [ ] **Step 4: Tests.**
  - A file is invisible without an attachment unless you created it.
  - A viewer sees a photo's derivatives, but the originals route (T18) refuses them.
  - `can_reveal_secret`: an owner can; a member can't until the policy adds `member`; a named user can.
  - A member can write a secret and supersede their own, with no RETURNING, and cannot read it back.
  - The old version is superseded.
  - A secret value never appears in `things.custom` or `search_tsv`.
- [ ] **Step 5: Leak test.** `fillTenant()` adds:
  - a file created by the tenant user, with its `thumb` derivative;
  - an attachment on the room thing;
  - a secret value on a secret field of the custom type (make one field in T5's fixture `secret`), with its policy;
  - a shared saved view on the location;
  - a user hint.

  Commit: `feat(db): files and attachments, versioned secret store, saved views and hints`.

### Task 9: Definer paths: moves, conversions, merges, customising types (0018)

**Files:**
- Custom migration: `0018_inventory_definers.sql`
- Test: `src/db/inventory-definers.test.ts`; update leak and migrate lists

Every function below is `SECURITY DEFINER`, APP only, and checks its caller first. It doesn't audit: the calling route does, in the same transaction (T15, T13, T11). Write each test first. The service tasks (Phase B) call these; they never re-implement them.

- [ ] **Step 1: `kept.move_things(p_ids uuid[], p_to_location uuid, p_place uuid, p_container uuid) RETURNS TABLE(thing_id uuid, from_location uuid)`** (D45, D161, §6.1, Q13).
  1. The caller is writable in every source location (read from the rows) **and** in `p_to_location`. Exactly one of `p_place`/`p_container` is set, and it lies in `p_to_location`. None of the moved ids may be the target container or one of its ancestors. Otherwise 42501.
  2. The set to move is the ids plus their whole container subtree (recursive CTE over `container_id`).
  3. If the source and target accounts differ, remap every registry reference in the set:
     - custom types → the matching copy in the target account (match on `copied_from_id` chain or name). If none, copy the type chain into the target account.
     - built-ins stay.
     - brands, tags, people (name only; contacts are **not** copied, D177) and vendors → matched by `kept.normalize(name)` in the target account, or created there.
     - the purchase line: copy the purchase header and that one line into the target location, and repoint.
  4. Files: for each attachment in the set whose file isn't in the target, `SET CONSTRAINTS attachments_file_fk DEFERRED`. Insert a `files` copy into the target: same `storage_key`, `sha256`, `bytes` and `mime`, reusing a target row with the same sha if one exists (D177 dedupe). Repoint `attachments.file_id`, and copy its derivatives' rows (same keys).
  5. Delete `thing_links` that would cross locations, returning their ids for the audit.
  6. `UPDATE things SET location_id = p_to_location, place_id = p_place, container_id = p_container, location_uncertain = false, last_seen_at = now() WHERE id = ANY(p_ids)`. The contents, short IDs, meters, readings, secret values and attachments follow through `ON UPDATE CASCADE`. The contents' `last_seen_at` is not touched (D45).
  7. `INSERT INTO sync_tombstones (location_id, entity_type, entity_id)` for each moved thing in its source location, `ON CONFLICT DO NOTHING` (§7.4).

  Tests:
  - A member of both A1 and A2 moves a box holding 2 things. The contents move too; their `last_seen_at` stays unchanged; the short IDs follow; tombstones are written in A1.
  - Cross-account: a member of Personal and of B's Home moves a phone with a custom type, a tag and a receipt. The type is copied into B's account, the tag matched or created, the file row copied with the same storage key, and the purchase line copied.
  - A viewer of the target is refused.
  - Moving a box into its own child is refused.
- [ ] **Step 2: Conversions (D160, §7.13, Q14).** Both keep the same UUID, so every reference by id still holds.
  - `kept.convert_place_to_container(p_place uuid, p_type uuid) RETURNS uuid`:
    - writable location; not Unplaced; the place has no child places (otherwise 23514 `places_has_children`);
    - inserts `things (id = p_place, location_id, place_id = parent (or the Unplaced area when top-level), name, type_id = p_type or built-in box_bin, custom from place fields matching the type's keys, else archived_custom)`;
    - `UPDATE things SET place_id = NULL, container_id = p_place WHERE place_id = p_place`;
    - repoints `short_ids`, `attachments` and `secret_values` from `place_id` to `thing_id`, and `audit_event_subjects` is untouched (it is keyed by the thing id);
    - deletes the place and writes a tombstone for `('place', id)`.
  - `kept.convert_container_to_place(p_thing uuid, p_parent uuid) RETURNS uuid`: the reverse. The thing must sit directly in a place, or `p_parent` is given; its contents move to `place_id = id`.
  - Tests cover both ways, including short IDs and attachments repointed, and `/p/<id>` = `/t/<id>`.
- [ ] **Step 3: Merges** (D92, D160; admin for registries).
  - `kept.merge_places(p_from uuid, p_into uuid)`: same location, writable, neither is Unplaced. It re-parents children and moves things and attachments; the `from` place's short IDs point at `into` as non-primary; then it deletes `from` and writes a tombstone.
  - `kept.merge_registry(p_kind text, p_from uuid, p_into uuid) RETURNS int`: `p_kind ∈ {type, brand, vendor, person, tag}`; both rows in the same account; caller in `kept.admin_account_ids()`. It repoints references **across every location of the account**, including those the admin can't see (D123), and deletes `from`. For types, both must share the same resolved field keys, or `from`'s extra values move to `archived_custom`. It returns the count repointed.
- [ ] **Step 4: Customising and impact (D92, D123, §7.9).**
  - `kept.customise_type(p_builtin uuid, p_account uuid) RETURNS uuid`:
    - `p_account` must be in `admin_account_ids()`;
    - copies the built-in **and its built-in subtree** (Q13b) into the account: `copied_from_id` set, `name` NULL, parent chain preserved, its own fields copied, groups kept as references;
    - repoints that account's things (all its locations) from each built-in to its copy;
    - idempotent: a second call returns the existing copy.
  - `kept.type_impact(p_type uuid) RETURNS TABLE(location_id uuid, location_name text, things int)`: one row per location of the type's account that has things of this type or a descendant. `location_id` and `location_name` are NULL for locations the caller can't see (counts only, D123).
- [ ] **Step 5:** Commit: `feat(db): definer paths for moves, conversions, merges and customising types`.

### Task 10: Maintenance doors: reindex and purges (0019)

**Files:**
- Custom migration: `0019_inventory_maintenance.sql`
- Test: `src/db/maintenance.test.ts`; update leak and migrate lists (`SYS` roles)

- [ ] **Step 1: `kept.reindex_location(p_location uuid) RETURNS int`** (definer, **kept_system only**, §7.9):

  ```sql
  UPDATE public.things t
     SET place_path = (SELECT string_agg(e->>'name', ' › ') FROM jsonb_array_elements(kept.path_of(t.place_id, t.container_id)) e)
   WHERE t.location_id = p_location AND t.deleted_at IS NULL;   -- the BEFORE trigger recomputes search_tsv
  ```

  It returns the row count. `touch_row`'s quiet columns keep `row_version`, and the test asserts this. The job's data is only a location id: reindexing any location is harmless and reads nothing out, which satisfies the rule in `jobs/boss.ts`.
- [ ] **Step 2: `kept.purge_trash(p_before timestamptz, p_limit int) RETURNS int`** (kept_system, D162, §3.3, 30 days):
  1. Deletes things with `deleted_at < p_before`, leaves first (contents trashed with a box share its `trash_batch_id`; delete children before parents).
  2. Then places with `deleted_at < p_before` that have nothing left under them.
  3. Writes `sync_tombstones` for each deletion.
  4. Short IDs retire through `retire_orphan_code()`; the children cascade.
- [ ] **Step 3: `kept.purge_deleted_locations(p_limit int) RETURNS int`** (kept_system, D149): deletes `locations` whose `purge_after < now()`. Things and places go by `ON DELETE CASCADE`; the self-references are `NO ACTION`, so the cascade succeeds (Q12). Short IDs keep their `location_id` as retired tombstones. The deferred owner check skips the vanished location.
- [ ] **Step 4: `kept.purge_orphan_files(p_older_than timestamptz, p_limit int) RETURNS TABLE(storage_key text)`** (kept_system):
  1. Deletes `files` with no attachment and `created_at < p_older_than` (unattached uploads, default 24 h).
  2. Returns the **storage keys no remaining `files` row or `file_derivatives` row references**, and only those.
  3. The job deletes those blobs after commit (D161, D162).
- [ ] **Step 5: Tests.**
  - `reindex_location` refreshes contents' paths after a container rename, without a `row_version` bump.
  - A thing trashed 31 days ago is purged; its code is `retired`; a tombstone exists.
  - A purged location's codes are still in `short_ids`.
  - A blob shared by a cross-account copy is **not** returned while the copy exists.
  - kept_app cannot execute any of these (42501).
- [ ] **Step 6:** Commit: `feat(db): reindex and purge doors for kept_system`.

---

## Phase B: services and routes (T11–T25, parallel; each owns `src/<area>/`)

All routes: `scopedRead`/`scopedWrite`; `requireMembership` + `requireCan`; module gating through `config.module` and `moduleLocation`; responses through `serialize/gates.ts`; every write through `audited()`, with `requestId: req.id`; a route-catalogue marker in the test. Pagination: `paginate()`/`pageOf()`, with `{items, next_cursor}`.

### Task 11: Types, place kinds and registries API

**Files:** `src/types/{routes.ts,service.ts,view.ts}`, `src/registries/{routes.ts,service.ts,view.ts}`; tests `types.test.ts`, `registries.test.ts`

- [ ] **Routes.** `:accountId` must be in `kept.visible_account_ids()`, otherwise 404. Writes are checked against `registries-types.manage` in *some* location of that account (the caller's highest role across the account's visible locations), or `people-vendors.create-inline` / `tags.create` for inline creation.

  | Method and path | Body → Response |
  |---|---|
  | `GET /api/v1/accounts` | → `{accounts: [{id, ownerDisplayName, isOwn, canManage}]}` (the account switcher) |
  | `GET /api/v1/accounts/:accountId/types?includeArchived` | → `{types: TypeNode[]}`: built-ins + the account's, as a flat list with `parentId`, `builtinKey`, `name` (null ⇒ translate), `icon`, `colour`, `capabilities` (own), `resolvedCapabilities`, `isFieldGroup`, `fieldGroups`, `copiedFromId`, `inUse` (count in visible locations), `rowVersion` |
  | `GET /api/v1/types/:id` | → `TypeDetail`: the node plus `fields: ResolvedField[]` (`{id, key, label, labelKey, kind, unit, options, repeatable, required, secret, sort, archivedAt, source: {typeId, via: 'own'\|'inherited'\|'group'}}`) |
  | `POST /api/v1/accounts/:accountId/types` | `{id?, parentId, name, icon, colour?, capabilities[], fieldGroups?[], defaultMeter?}` → 201 `TypeDetail` |
  | `PATCH /api/v1/types/:id` (If-Match) | `{name?, icon?, colour?, capabilities?, parentId?, fieldGroups?, defaultWarrantyMonths?}` → `TypeDetail`; 412 per D156 |
  | `POST /api/v1/types/:id/preview` | the same body as PATCH → `{descendants: [{id,name}], perLocation: [{locationId\|null, name\|null, things}], hiddenLocations: n, fieldsToArchive: [key]}` (allow-listed as read-only; uses `kept.type_impact`) |
  | `POST /api/v1/types/:id/fields` | `{key, label, kind, unit?, options?, repeatable?, required?, secret?}` → 201. `secret` is allowed only at creation, and only for the account owner (D177) |
  | `PATCH /api/v1/type-fields/:id` (If-Match) | `{label?, unit?, options?, required?, sort?}`. "Required" applies to new edits only (D172) |
  | `POST /api/v1/type-fields/:id/archive` · `/restore` | → 204 (D92: removed fields are archived) |
  | `POST /api/v1/types/:id/customise` | `{accountId}` → `{typeId}` (`kept.customise_type`) |
  | `POST /api/v1/types/:id/merge-into` | `{targetId}` → `{repointed}` |
  | `DELETE /api/v1/types/:id` | 409 `in_use` if any thing (any location of the account, counted through `type_impact`) or child type uses it (D92) |
  | `GET\|POST /api/v1/accounts/:accountId/place-kinds`, `PATCH /api/v1/place-kinds/:id`, `POST /api/v1/place-kinds/:id/fields` | the same field shapes (D160) |
  | `GET /api/v1/accounts/:accountId/{brands\|vendors\|people\|tags}?q&limit&cursor` | list-standard; `q` ranks with `kept.normalize` + trigram |
  | `POST /api/v1/accounts/:accountId/{brands\|vendors\|people\|tags}` | `{id?, name/displayName, …}` → 201 `{item, possibleDuplicates: [{id,name,similarity}]}` (D11: similarity > 0.5; a hint, never a block. For brands and tags, a normalised duplicate is 409 `conflict` with the existing id) |
  | `PATCH /api/v1/{brands\|vendors\|people\|tags}/:id` (If-Match) · `DELETE` · `POST …/:id/merge-into {targetId}` | admin |
  | `GET\|PUT /api/v1/people/:id/contact` | `{phone?, email?, notes?}`; 404 unless `person_contact_visible` (D177). Audited with every field classed `secret` (Q5) |

- [ ] **Tests:**
  - an admin of B's home creates a type in B's account; a member can't (403); a viewer gets 403 on registries;
  - a member creates a person and a vendor inline and gets `possibleDuplicates` for `Alfred`/`alfred `;
  - a type cycle answers 409 with a hint;
  - redefining an inherited key answers 409;
  - the preview shows hidden locations as counts only;
  - customise repoints things in a location the admin can't see (checked as owner);
  - DELETE of a type in use answers `in_use`;
  - a contact is invisible to an admin of only one of two locations that use the person;
  - every write writes an account-level audit row.
- [ ] **Commit:** `feat(types): type tree, place kinds and registries API`.

### Task 12: Currencies, purchases and money gating

**Files:** `src/currencies/routes.ts`, `src/purchases/{routes.ts,service.ts,view.ts}`; tests

- [ ] **Routes.**
  - `GET /api/v1/currencies` → `{currencies: [{code, name, minorUnits, symbol, enabled}]}`: enabled ones only; `?all=1` for instance admins.
  - `PATCH /api/v1/admin/currencies/:code {enabled}` (instance admin; D168). Refuse disabling one of the five, or one that a location uses as its default (409).
  - `POST /api/v1/purchases {id?, locationId, vendorId?, purchasedOn, currency?, total?, tax?, notes?, lines: [{id?, description, quantity, unitPrice?, thingId?}]}` → 201 `PurchaseView`:
    - `purchasedOn` may not be in the future in the location's time zone;
    - each amount needs a currency, which must be enabled;
    - the lines must reconcile with the total within ±1%, otherwise `flagged: true` is returned (never an error; screens §7);
    - money input is the canonical `parseAmount` string.
  - `GET /api/v1/purchases/:id` → `{id, locationId, vendor, purchasedOn, currency, total?, tax?, notes, lines:[{id, description, quantity, unitPrice?, thing:{id,name}|null}], receipts: [AttachmentView], flagged, rowVersion}`. Money fields are omitted by the gate.
  - `PATCH /api/v1/purchases/:id` (If-Match), `DELETE /api/v1/purchases/:id` (`things.edit`; lines cascade; linked things get `SET NULL`).
  - `POST /api/v1/purchase-lines/:id/link {thingId}`, `DELETE /api/v1/purchase-lines/:id/link`.
  - A thing's own view of its purchase comes from `kept.thing_purchase()` (T15 embeds it).
- [ ] **Money gate tests** (§7.1, D13, D110):
  - a viewer (toggle off) gets no `total`, `tax` or `unitPrice`;
  - with the `money` module off (Essentials), a member gets none either, but still sees date, vendor and receipt;
  - the audit diff classes money fields, and `renderAudit` hides them for a viewer.
- [ ] **Commit:** `feat(purchases): purchases with lines, currencies and money gating`.

### Task 13: Places API: every operation of D160

**Files:** `src/places/{routes.ts,service.ts,view.ts}`; test `places.test.ts`

- [ ] **Routes.**

  | Method and path | Body → Response |
  |---|---|
  | `GET /api/v1/locations/:locationId/places` | → `{places: [{id, parentId, name, kindKey, icon, sort, isUnplaced, thingCount, childCount}]}` (the whole tree; trashed excluded) |
  | `POST /api/v1/locations/:locationId/places` | `{id?, parentId?, name 1–120, kindKey, icon?}` → 201 `PlaceView` |
  | `GET /api/v1/places/:id` | → `PlaceView {id, locationId, parentId, name, kindKey, icon, isUnplaced, path, shortCode\|null, fields: ResolvedField[], custom, secrets:[{fieldKey, label, set, canReveal}], counts:{places, things}, attachments:[…], rowVersion}` |
  | `GET /api/v1/places/:id/contents?q&type&tag&state&group&sort&limit&cursor` | → `{places: [...children], things: {items: ThingRow[], next_cursor}}` (places first, then things; screens §5) |
  | `PATCH /api/v1/places/:id` (If-Match) | `{name?, kindKey?, icon?, sort?, parentId?, custom?}`. Re-parenting stays within the location; the Unplaced area is refused (409 hint); a rename or re-parent enqueues `reindex` (`singletonKey: locationId`, `singletonSeconds: 10`; check pg-boss 12's `SendOptions` in its `types.d.ts`) |
  | `POST /api/v1/places/:id/trash` | `{contents?: 'move'\|'trash', moveTo?: {placeId}\|{containerId}}` → `{trashed: [ids], moved: [ids], trashBatchId}`. With contents and no choice: 409 `contents_choice_required` with `{counts}` (D45, D160). Same `trash_batch_id` on everything it trashes |
  | `POST /api/v1/places/:id/restore` | restores the whole batch; a restored child whose parent is still trashed goes under the Unplaced area, with a hint |
  | `DELETE /api/v1/places/:id` | admin (`things.delete-permanently`); only when trashed; writes tombstones |
  | `POST /api/v1/places/:id/merge-into {targetId}` | `kept.merge_places` |
  | `POST /api/v1/places/:id/convert-to-container {typeId?}` | → `{thingId}` (same id) |
  | `POST /api/v1/places/:id/label` | `config.module: 'labels'`, `labels.use` → `{code}` (allocates a primary short ID if missing; printing is step 3) |

- [ ] **Short-ID allocation helper** (`places/short-id.ts`, reused by T15): generate `randomShortCode()`, then `INSERT INTO short_ids (code, location_id, thing_id|place_id) VALUES (…) ON CONFLICT (code) DO NOTHING RETURNING code`, up to 8 tries, then 500. A collision with another tenant's code is invisible under `DO NOTHING` (test with a pre-seeded code).
- [ ] **Tests:** each operation; trashing a container place without a choice → 409; move-contents then trash; restore brings the batch back; a viewer gets 403 on writes and 200 on reads; B's place id answers 404; a place-kind field validates `custom`; the audit rows.
- [ ] **Commit:** `feat(places): place tree with trash, restore, merge, convert and labels`.

### Task 14: Things core API

**Files:** `src/things/{routes.ts,service.ts,view.ts,audit-image.ts,validate.ts}`; tests `things.test.ts`, `things.conflict.test.ts`

- [ ] **`view.ts`**, the one serialiser that T15, T21 and T23 import:
  - `ThingRow` (for lists): `{id, locationId, shortCode|null, name, type:{id, icon, name|null, builtinKey|null}|null, quantity, lifecycle, derivedState[], path:[{id,name,kind}], containerThumbUrl|null, thumbUrl|null, lastSeenAt, matchedAlias?}`.
  - `ThingView` (for detail): `ThingRow` plus
    - `brand`, `model`, `serial`, `barcode`, `colour`, `condition`, `notes`, `aliases`, `tags[]`, `belongsTo`, `manualUrl`, `expiresOn`, `expiryLeadDays`;
    - `ended: {on, price?, currency?, to, notes}|null`, `acquiredFrom`, `provenanceNotes`, `locationUncertain`, `reviewState`, `fieldStatus`;
    - `fields: ResolvedField[]`, `custom` (gated), `archivedCustom`, `secrets: [{fieldKey,label,set,canReveal}]`;
    - `placeId`, `containerId`, `isContainer` (has the `container` capability or has contents), `contentsCount`;
    - `purchase: {purchaseId|null, purchasedOn, vendor, currency, lineDescription, quantity, unitPrice?, receipts:[…]}|null` (from `kept.thing_purchase`/`thing_receipts`);
    - `photos: AttachmentView[]`, `attachmentsCount`;
    - `meters: [{id, kind, unit, label, latest: {value, takenAt}|null, needsReview: n}]`, `links: [{id, kind, direction, thing: ThingRow}]`;
    - `rowVersion`, `createdAt`, `updatedAt`.
  - Derived states in step 2: `uncertain`, `draft` and `ended`. The array leaves room for step 4's lent, borrowed and in_repair (D119).
- [ ] **Routes.**

  | Method and path | Body → Response |
  |---|---|
  | `GET /api/v1/things?locationId&placeId&containerId&typeId&tagId&state&lifecycle&q&group&sort&limit&cursor` | list-standard, global by default (D174) → `{items: ThingRow[], next_cursor}`. `sort ∈ name` (ICU collation) `\| updated \| lastSeen`; `group ∈ type\|place\|none` sorts by the group key first |
  | `POST /api/v1/things` | `{id?, locationId, placeId\|containerId, name, typeId?, quantity?, brandId?, model?, serial?, barcode?, colour?, condition?, notes?, aliases?, tagIds?, belongsToPersonId?, manualUrl?, expiresOn?, expiryLeadDays?, custom?, purchase?: {purchasedOn, vendorId?, currency, price}}` → 201 `ThingView`. Allocates a primary short ID; creates the type's default meter; sets `last_seen_at = now()` and `created_by`; `purchase` makes a one-line purchase |
  | `GET /api/v1/things/:id` | `ThingView` (p95 < 200 ms at 10k, T25) |
  | `PATCH /api/v1/things/:id` (If-Match) | any editable field; `custom` merges per key (`null` removes); `aliases` replaces per language; `tagIds` replaces the set. On 412: `{conflicts, row_version, changedBy: {displayName}}` (D156) |
  | `POST /api/v1/things/:id/lifecycle` (If-Match) | `{lifecycle, endedOn?, endedPrice?, endedCurrency?, endedTo?, endedNotes?}`; `in_use` clears the end fields (found, D119) |
  | `POST /api/v1/things/:id/seen` | → `{lastSeenAt}`; clears `location_uncertain`; audited `thing.seen` (D40) |
  | `POST /api/v1/things/:id/not-here` | → `location_uncertain = true` (D40) |
  | `POST /api/v1/things/:id/retype` (If-Match) | `{typeId}`: maps matching keys, and moves the rest to `archived_custom` (D92) |
  | `POST /api/v1/things/:id/duplicate` | `{id?}` → 201 a new thing: no serial, a new short ID, no purchase link, same place |
  | `POST /api/v1/things/:id/split` | `{quantity, id?, to?: {placeId}\|{containerId}}` → `{originalId, newId}`. Refused for quantity-1 types; the new row gets `split_from_id` and the same `purchase_line_id` (D10, §1.4) |
  | `POST /api/v1/things/:id/links` | `{toThingId, kind}` → 201; `DELETE /api/v1/thing-links/:linkId` |
  | `POST /api/v1/things/:id/convert-to-place` | `{parentId?}` → `{placeId}` (`kept.convert_container_to_place`) |
  | `GET /api/v1/codes/:code` | → `{kind:'thing'\|'place', id}` or a 404 identical for missing and forbidden codes (D137) |

- [ ] **`audit-image.ts`** flattens `custom` into `custom.<key>` entries and passes `fieldClasses` from the resolved fields' kinds (money → `money`). The test proves that a money custom field is hidden from a viewer in `renderAudit`.
- [ ] **`validate.ts`**: `customSchema(resolvedFields)` from `@kept/shared`. Required fields are enforced only for fields the request touches (D172: required applies to new edits). Quantity rules are pre-checked with resolved capabilities, answering 400 with a hint before the trigger does.
- [ ] **Tests:**
  - create in Unplaced and in a container;
  - the short ID is allocated and matches the pattern;
  - the default meter appears for `car`;
  - a PATCH with a stale If-Match → 412 with `changedBy`;
  - a viewer: GET 200, every write 403;
  - money and secret gating;
  - split then list;
  - retype archives values;
  - a code lookup for B's code gives the same 404 as a random code;
  - list grouping and pagination are stable across pages.
- [ ] **Commit:** `feat(things): things API with fields, lifecycle, split, links and conflicts`.

### Task 15: Moves (depends on T14)

**Files:** `src/things/move.ts`, `src/things/move-routes.ts`; test `move.test.ts`

- [ ] **Routes.**
  - `POST /api/v1/things/move/preview {thingIds, to}` → `{crossLocation, crossAccount, targetLocation:{id,name}, losesSight:[{displayName}], copies:{types, tags, people, vendors, brands, purchases}}`. This is D45's "who will lose sight" warning; it is read-only and allow-listed.
  - `POST /api/v1/things/move {thingIds (≤200), to: {placeId}|{containerId}, quantity?}`:
    - `quantity` applies only with a single thing, and splits first;
    - within one location it's a plain UPDATE under RLS: `place_id/container_id`, `last_seen_at = now()` for the moved things only, `location_uncertain = false`;
    - across locations it calls `kept.move_things`;
    - one audit event per moved thing (`thing.move`, before and after path). A container move writes **one** event with `subjects` = its contents (D45, §7.5); across locations it writes that event in both locations;
    - enqueues `reindex` for each affected location when a container moved.
  - `POST /api/v1/things/:id/empty-into {to}`: moves all direct contents ("Empty Box 3 into Box 5", D45).
- [ ] **Tests:**
  - the contents' history shows "moved with Box 3" (their `audit_event_subjects` exist) and their `last_seen_at` is unchanged;
  - moving into your own descendant → 409;
  - cross-location without write access to the target → 404;
  - a cross-account move copies registries; the preview lists who loses sight;
  - a bulk move of 200 things takes under 1 s on the dev machine.
- [ ] **Commit:** `feat(things): moves within and across locations, with container fan-out`.

### Task 16: Meters and readings (core, D113) (depends on T14)

**Files:** `src/meters/{routes.ts,service.ts,check.ts}`; test

- [ ] **Routes.**
  - `POST /api/v1/things/:id/meters {kind, unit, label?, maxPerDay?}` (`meters.manage`, admin); `PATCH /api/v1/meters/:id` (If-Match).
  - `GET /api/v1/meters/:id/readings?cursor` → `{items:[{id, value, takenAt, source, state, reviewReason, loggedBy:{displayName}, note}], next_cursor}`.
  - `POST /api/v1/meters/:id/readings {id?, value, takenAt, note?}` (`logs.add`) → `{reading, state, reason?}`.
  - `PATCH /api/v1/readings/:id` / `DELETE`: `logs.edit-own` when `logged_by` = me, otherwise `logs.edit-delete-others`.
  - `POST /api/v1/readings/:id/accept` (keep a needs-review reading).
  - `POST /api/v1/meters/:id/replaced {at, offset}` (D52).
- [ ] **`check.ts` (D112, D26).**
  - `takenAt` is clamped to ≤ now.
  - The neighbours are the previous and next accepted readings by `taken_at`, adjusted by replacement offsets. A value below the previous or above the next → `needs_review` (`lower_than_previous` / `higher_than_next`).
  - A rate above `max_per_day` → `needs_review` (`implausible_jump`). The default is 1,500 km a day for distance and 24 h a day for hours (§3.4).
  - Never a silent rejection. The inbox item itself is step 3; until then the meter shows "needs review" with Keep / Edit / Discard.
- [ ] **Tests:** a late-synced reading that fits is accepted; a lower value goes to review; a replacement offset allows the drop; a member edits their own reading but not another's (403); a viewer gets 403.
- [ ] **Commit:** `feat(meters): core meters and readings with neighbour checks`.

### Task 17: Files and attachments

**Files:** `src/files/{routes.ts,upload.ts,derivatives.ts,serve.ts,attachments.ts,jobs.ts}`, `src/storage/derivatives.ts`; tests `upload.test.ts`, `serve.test.ts`, `attachments.test.ts`

- [ ] **Upload** (`PUT /api/v1/files/:fileId?locationId=&class=`), with headers `Content-Type`, `Content-Length` (required) and `X-Kept-Sha256` (hex):
  1. `assertClientId(fileId)`; the caller is writable in `locationId` (`attachments.add`).
  2. `Content-Length` > `KEPT_MAX_FILE_MB` → 413 `payload_too_large`, before reading the body.
  3. A `'*'` content-type parser passes the raw stream (Fastify `addContentTypeParser` with `parseAs` unset; check the Fastify 5 types). It is streamed to `KEPT_DATA_DIR/tmp/<uuid>`, hashing SHA-256 and counting bytes, and aborts at the limit.
  4. A hash mismatch → 400 `checksum_mismatch`. `sniff()` must pass, otherwise 415 `unsupported_media_type`.
  5. Dedupe: if `(locationId, sha256)` exists, answer 200 `{…existing, deduplicatedFrom: existingId}` and delete the temp file (D177, per location). A replay of the same `fileId` + sha → 200 with the same body; the same id with another sha → 409 `idempotency_mismatch`.
  6. `BlobStore.put('f/<loc>/<id>', tmp)`: the **original, untouched** (D117).
  7. Derivatives, inline and bounded by a process-wide semaphore of size `KEPT_IMAGE_CONCURRENCY` (D157, Q17): for JPEG/PNG/WebP/AVIF/GIF, `sharp(tmp, { limitInputPixels: 100_000_000 })`, then auto-orient (`.rotate()` or `.autoOrient()`; check the 0.35 `.d.ts`), then resize `fit:'inside', withoutEnlargement` to `display` 2048, `thumb` 400 and `share` 1200 (§3.4), then JPEG. Metadata is dropped by default, which strips GPS (D117). HEIC/HEIF → `derivative_state='unavailable'` (D36). PDF → `not_applicable` in step 2 (Q8).
  8. `has_gps`: a small IFD walker over the EXIF buffer from `sharp().metadata()` looks for tag `0x8825`.
  9. INSERT the `files` and `file_derivatives` rows; audit `file.upload` (no content, no filename).
  10. Response 201: `FileView {id, sha256, bytes, mime, class, hasGps, width, height, derivativeState, thumbUrl|null, displayUrl|null}`.
- [ ] **Serving (D157).**
  - `POST /api/v1/files/:id/url {variant: 'original'|'display'|'thumb'|'share'}` → `{url, expiresAt}`:
    - `original` needs a **member or above** in the file's location (D117). Derivatives need the file to be visible (any role).
    - A thing's receipt after a move goes through `kept.thing_receipt_file` (`?thingId=`).
  - `GET /f/:token` (`config.auth: 'none'`; it reads no session):
    - verifies the token and streams the blob with `Content-Type` from the token, `X-Content-Type-Options: nosniff`, and `Content-Security-Policy: default-src 'none'; sandbox`;
    - originals get `Content-Disposition: attachment`; derivatives (re-encoded JPEG) get `inline`;
    - `Cache-Control: private, max-age=300`.
  - On S3, `signedUrl` returns a presigned GET with the same headers (T19).
- [ ] **Attachments.**
  - `POST /api/v1/attachments {id?, locationId, fileId|url, subject: {thingId}|{placeId}|{purchaseId}|{meterReadingId}|{location:true}, role, sort?}` → 201 `AttachmentView {id, role, sort, file: FileView|null, url|null, subject, createdBy:{displayName}}`. A URL attachment is never fetched by the server (D128).
  - `PATCH /api/v1/attachments/:id` (If-Match; role, sort).
  - `DELETE /api/v1/attachments/:id`: `attachments.delete-own` when you created it, otherwise `attachments.delete-any`.
  - `GET /api/v1/{things|places|purchases|locations}/:id/attachments?role&cursor`.
  - `DELETE /api/v1/files/:id {reason}`: "delete original" (D162), admin only, audited `file.delete_original` with the reason. It deletes the row, with attachments and derivatives cascading; the blob goes with the orphan purge (T21).
- [ ] **Tests:**
  - wire formats: a raw JPEG, a PNG, and a `fake.jpg` with HTML bytes → 415;
  - a 26 MB body → 413 without buffering it;
  - dedupe per location, but not across locations;
  - replays;
  - the stored original is byte-identical (SHA-256 of the blob = the header), GPS present;
  - the thumb has no EXIF (check with `sharp(thumb).metadata()`) and is upright for `rotated.jpg`;
  - a viewer gets thumb and display URLs, and 403 for `original`;
  - `/f/` with a tampered or expired token → 404, and it never sets a cookie;
  - the CSP and disposition headers are present;
  - a path-traversal `fileId` is refused by uuid validation.
- [ ] **Commit:** `feat(files): byte-identical uploads, derivatives, signed serving and attachments`.

### Task 18: S3 driver (parallel from wave 1; only `src/storage/s3.ts`)

**Files:** `src/storage/s3.ts`, `compose.dev.yaml` (a `s3` service: `rustfs/rustfs:1.0.0` pinned by digest on 9452, with a bucket-create step), `scripts/ci-local.sh` (the compose step waits for it); test `storage/s3.test.ts` (skipped unless `KEPT_TEST_S3_URL` is set; CI sets it)

- [ ] `S3Client` with `endpoint`, `region`, `forcePathStyle` and credentials from env.
  - `put` is a `PutObjectCommand` with a file stream and `ContentLength`; `stream` is `GetObjectCommand` (with a range); then `delete`, and `exists` (`HeadObject`).
  - `signedUrl` uses `getSignedUrl(client, new GetObjectCommand({…, ResponseContentDisposition, ResponseContentType}), {expiresIn})`. Check the names in `@aws-sdk/s3-request-presigner`'s types.
- [ ] Tests: the same contract suite as `local.ts` (export a shared `blobStoreContract(makeStore)`); a presigned URL fetched with `fetch` returns the bytes and the disposition. `KEPT_STORAGE=s3` boots against RustFS in the `prod-boot` CI step.
- [ ] Commit: `feat(storage): S3-compatible blob store with presigned URLs`.

### Task 19: Secrets, reveal and key rotation (the carry-over)

**Files:** `src/secrets/{routes.ts,service.ts}`, `src/crypto/keyring.ts`, `src/cli/rotate-key.ts`; modify `config/env.ts` (the keyring) and `cli/index.ts`; tests

- [ ] **The keyring (Q19).**
  - `secrets.json` in the config volume becomes `{secretKey, secretKeyVersion, retired: {[version]: key}, authSecret}`.
  - A step-1 file without a version reads as version 1.
  - `KEPT_SECRET_KEY` from the environment is version `KEPT_SECRET_KEY_VERSION` (default 1). `KEPT_SECRET_KEYS_RETIRED` is an optional list of `v:key` pairs (comma-separated).
  - `loadKeyring(env)` → `{current: MasterKey, keyring: Keyring}`.
- [ ] **Routes.** `config.module: 'secrets'`, with `moduleLocation` resolving the thing or place.
  - `PUT /api/v1/things/:id/secrets/:fieldKey {value}` (`things.edit`) → 204:
    - the field must be a resolved secret field of the thing's type;
    - **the recovery-kit gate (D193):** `kept.recovery_kit_acknowledged()` false → 409 `recovery_kit_required` ("ask your instance admin to download the recovery kit");
    - `seal(current, value, {table:'secret_values', rowId: newId, fieldKey})`, then INSERT (no RETURNING);
    - audit `secret.set`, classed `secret`, recorded as `{changed:true}` (D110).
  - `DELETE` the same path: inserts a superseding tombstone value, or marks it cleared through a supersede-only insert. Audited.
  - `POST /api/v1/things/:id/secrets/:fieldKey/reveal` → `{value, revealedUntil: now+30s}` (D175). It SELECTs under the policy, where a missing row answers 404 (not permitted and not set look alike), then `open(keyring, …)`. Audited `secret.reveal`. Only the value and `revealedUntil` are sent; `Cache-Control: no-store`.
  - `POST …/copied` → audited `secret.copied` (screens §8).
  - The same routes for `/places/:id/secrets/:fieldKey`.
  - `GET|PUT /api/v1/locations/:id/secret-policies/:typeFieldId {revealRoles, revealUserIds, aiAllowed}`: owner only (D177).
- [ ] **`kept admin rotate-key [--new-key <b64>]`** (as `kept_owner`):
  1. Generates or takes the new key; its version is the current version + 1.
  2. For each batch of 500 `secret_values` rows, in one transaction per batch, `rewrap(sealed, keyring, next, aad)` and updates `ciphertext` and `key_version`.
  3. Writes the new keyring to the config volume, keeping the old key under `retired`. If the key came from the environment, it prints the new values for the operator.
  4. It is resumable, because it skips rows already at the new version.
- [ ] **Tests:**
  - an owner reveals; a member gets 404 until the policy adds `member`; a named user can;
  - the audit row has no plaintext (search the JSON text of every `audit_events` row for the value);
  - the value never appears in `things` rows, `search_tsv` or logs (a pino capture);
  - rotation keeps every value readable and changes `key_version`;
  - an old backup's ciphertext still opens with the retired key;
  - the recovery-kit gate is enforced.
- [ ] **Commit:** `feat(secrets): encrypted secret fields, audited reveal, policies and key rotation`.

### Task 20: Search, saved views, the ⌘K backend and the reindex job

**Files:** `src/search/{routes.ts,service.ts,query.ts,jobs.ts}`; tests `search.test.ts`, `search.arabic.test.ts`

- [ ] **`GET /api/v1/search?q&locationId&placeId&typeId&tagId&state&kind&limit&cursor`** → `{things: {items: ThingRow[], next_cursor}, places: [...], people: [...], vendors: [...], didYouMean: string[], asOf}`:
  - With a `kind`, only that group is paginated. Without one, each group gets its first 5 (things 20).
  - A `q` of 6 Crockford characters is also looked up in `short_ids` (normalised); an exact hit ranks first.
  - `placeId` means the whole place subtree (recursive CTE) plus containers within it.
  - The things query is below. The cursor is `{s, id}`.

    ```sql
    WITH q AS (SELECT to_tsquery('simple', $1) AS tsq, kept.normalize($2) AS nq)
    SELECT t.*, ts_rank_cd(t.search_tsv, q.tsq) + 0.5 * similarity(kept.normalize(t.name), q.nq) AS score
      FROM public.things t, q
     WHERE t.deleted_at IS NULL
       AND (t.search_tsv @@ q.tsq OR kept.normalize(t.name) % q.nq
            OR kept.normalize(t.serial) = q.nq)
       AND ($3::uuid IS NULL OR t.location_id = $3) …
     ORDER BY score DESC, t.id LIMIT $n + 1
    ```

  - `$1` is `tsQuery(q)` from `@kept/shared`; when it is null, the text branch is skipped.
  - `matchedAlias` is computed in TypeScript by comparing normalised aliases with the terms (screens §8, "matched: display cable").
  - `containerThumbUrl`: a lateral join to the container's first `photo` attachment → a signed thumb URL (D195).
  - Places match on a trigram of the normalised name. People and vendors match only in visible accounts.
  - `didYouMean` runs only when there are no results: `SET LOCAL pg_trgm.similarity_threshold = 0.25`, the top 3 names by similarity.
  - Money filters (screens §5 Search) are ignored unless the gate shows money.
- [ ] **Saved views:** `GET|POST /api/v1/saved-views`, `PATCH|DELETE /api/v1/saved-views/:id`. `query` is validated against the search querystring schema. Sharing needs `saved-views.share`.
- [ ] **The `reindex` job** (`search/jobs.ts`, a system job): `data.locationId` → `withSystem` → `SELECT kept.reindex_location($1)`.
- [ ] **Tests:**
  - the D74 criterion: an "HDMI cable" in Essentials is found by `hdmi`, `hmdi` (typo), `كابل`, `الكابل` and `cable`;
  - Arabic: `مكتبة` finds `مكتبه`; Eastern digits `٥٥` find `55`; harakat are ignored;
  - a secret value, money or a B thing never matches;
  - a viewer's results include no money;
  - after a place rename and the job, results show the new path;
  - `didYouMean` for `hmdi`;
  - a short code finds its thing, and a B code finds nothing.
- [ ] **Commit:** `feat(search): Arabic-aware search, saved views and reindexing`.

### Task 21: Trash, history, activity and the purge job

**Files:** `src/trash/{routes.ts,jobs.ts}`, `src/history/{routes.ts,service.ts}`; tests

- [ ] **Trash.**
  - `POST /api/v1/things/:id/trash {contents?: 'move'|'trash', moveTo?}` (`things.trash`): a container with contents and no choice → 409 `contents_choice_required` (D45). It sets `deleted_at` and `trash_batch_id`. Reminder sources pause by derivation in step 4 (D162, §7.6); nothing to store.
  - `POST /api/v1/things/:id/restore` restores the batch. If its place or container is still trashed, it goes to the Unplaced area, with a hint.
  - `DELETE /api/v1/things/:id` (`things.delete-permanently`, trashed only): writes tombstones.
  - `GET /api/v1/trash?locationId&kind&q&cursor` → `{items:[{kind:'thing'|'place', id, name, path, deletedAt, deletedBy:{displayName}, purgeAfter, batchSize}], next_cursor}`.
- [ ] **The `purge` system job** (`trash/jobs.ts`), daily at 03:17 UTC:
  - `kept.purge_trash(now() - interval '30 days', 500)`, looping while it returns 500;
  - `kept.purge_deleted_locations(10)`;
  - `kept.purge_orphan_files(now() - interval '1 day', 500)` → after commit, `BlobStore.delete(key)` for each key. Failures are logged and count toward the step-1 failed-jobs view.
- [ ] **History (D76, D110, D183).**
  - `GET /api/v1/things/:id/history?cursor` → `{items: RenderedAuditEvent + {actor:{displayName}, summary}}`: events where `entity_id = id`, or `root_thing_id = id`, or an `audit_event_subjects.thing_id = id`, in **visible** locations only.
  - A `thing.move` event arriving from another location renders as "Moved in from another location", with no diff (D183).
  - The same for `/places/:id/history`.
  - Everything goes through `renderAudit(event, viewer)`, with the viewer's role in the event's location.
  - `GET /api/v1/activity?locationId&actorId&entityType&from&to&cursor`: global across visible locations (D174); Home uses `limit=3/5`.
- [ ] **Tests:**
  - a viewer's history hides `ended_price` and `custom.<money>`, and shows secrets only as "changed";
  - a thing moved from a location the viewer can't see shows only the move-in, with no old path;
  - trash, restore and delete permanently each follow their role rules;
  - the purge job end to end, with blobs deleted from the local store;
  - the purge never touches a thing trashed 29 days ago.
- [ ] **Commit:** `feat(trash): trash, restore, purge job, history and activity feed`.

### Task 22: Home: the checklist, the attention panel and hints

**Files:** `src/home/{routes.ts,service.ts}`; test

- [ ] **`GET /api/v1/home`** → `{checklist: {dismissed, items: [{key, done}]}, attention: {toReview, uncertain, longUnseen, unplaced}, locations: [{id, thingCount, unplacedCount}]}`:
  - The checklist is computed from data (D138, screens §5 and §8):
    - `locationCreated`: the user owns a non-personal location;
    - `threeThings`: `things.created_by = me`, count ≥ 3 (Q22);
    - `labelPrinted`: any `short_ids.printed_at` in the user's locations; false until step 3;
    - `invited`: a non-personal location the user administers has another member or a pending invite;
    - `aiConnected`: always false in step 2, and omitted on Essentials (D191);
    - `installed`: `user_hints['installed_standalone']`.
    - Invited members (not owner or admin anywhere) get no `invited` and no `aiConnected` item.
    - "Put Kept on HTTPS" is added by the client over http (D193), because the server can't see the scheme behind a proxy.
  - `attention` (the step-2 rows, in the §8 order; zero rows hidden by the client):
    - `toReview` = readings needing review;
    - `uncertain`;
    - `longUnseen` = `last_seen_at < now() - long_unseen_months` and `in_use`;
    - `unplaced` = things in Unplaced areas.
  - Each count opens `/search?…` with the matching filter.
- [ ] **Hints:** `GET /api/v1/me/hints`, `PUT /api/v1/me/hints/:key {seen?, dismissed?}` (D138, server-side). Home's step-1 `localStorage` "hidden" flag migrates to `checklist` dismissed.
- [ ] **Tests:** every item flips on real data; the counts respect RLS (a B thing never counts); dismissal persists across "devices" (two sessions).
- [ ] **Commit:** `feat(home): computed Get-started checklist, attention counts and hints`.

### Task 23: Seed: households with inventory, and the bench scenario (depends on T11, T12, T13, T14)

**Files:** `src/seed/{households.ts,bench.ts,words.ts}`, `src/cli/index.ts` (`kept admin seed --scenario households|bench [--things N]`); test `seed.test.ts`

- [ ] **`households`**, through the service layer (D152, D185). If step-1 task 26 is missing, create its accounts part here: the instance admin; household 1 in English (owner Ibrahim, admin Alfred, a member, a viewer, a managed child, an expiring member); household 2 in Arabic (`بيت العائلة`, EGP, `ar-EG`).
  - Add rooms from the location templates (screens §8).
  - About 60 things: an HDMI cable (the D74 test), a phone with device fields, a car with a meter and 3 readings, a safe with a combination secret, boxes holding things, Arabic names with harakat and `ال`, tags, a brand, a vendor, a person, and a purchase with 2 lines and a receipt photo (a fixture JPEG).
  - A second run is a no-op (idempotent by fixed UUIDv7s derived from a namespace).
  - It refuses to run with `NODE_ENV=production`.
- [ ] **`bench --things 10000`**, fast SQL as `kept_owner` (not the service layer; this is a load fixture):
  - 3 locations (10,000, 2,000 and 500 things); a place tree 4 levels deep with about 200 places; 300 containers;
  - 30% Arabic names from `words.ts`; tags on half; 2,000 files and attachments (thumbnail rows only, no blobs);
  - then `ANALYZE`.
- [ ] **Commit:** `feat(seed): household inventory and 10k bench scenarios`.

### Task 24: The RLS benchmark at 10,000 things (risk #3) (depends on T14, T20, T23)

**Files:** `apps/server/test/perf/{vitest.config.ts,rls-bench.test.ts}`; root `package.json` script `bench:rls`; `scripts/ci-local.sh` (a new `perf` step after `test`, full mode only); `docs/spikes/2026-xx-rls-bench.md` (the result note)

- [ ] A separate vitest project (`@kept/server-perf`), excluded from `pnpm test`. It seeds `bench` into a fresh clone, then measures through the **service functions** (not HTTP), with 20 warm-ups and 200 runs each, for three actors:
  1. the owner of the 10k location;
  2. a member of all three locations;
  3. a viewer.

  | Measure | Pi target (§3.1) | Dev-laptop gate (fails CI) |
  |---|---|---|
  | Search p95 (a mix of Latin, Arabic, typo, serial and code queries) | < 300 ms | < 100 ms |
  | Thing page p95 (`ThingView` with purchase, meters, photos, links) | < 200 ms | < 60 ms |
  | Place contents page p95 (the 200-thing room) | — | < 80 ms |
  | Things list page, global, 3 locations, p95 | — | < 80 ms |

- [ ] Plan checks: `EXPLAIN (ANALYZE, BUFFERS)` for search and contents, as `kept_app` through `withScope`, must show:
  - `visible_location_ids` as an **InitPlan** (evaluated once, not a SubPlan per row);
  - a Bitmap Index Scan on `things_search_idx` for text queries, and on `things_name_trgm` for a typo query;
  - no Seq Scan on `things` for a place-contents query.
- [ ] If a gate fails: fix indexes or policies in a Phase A follow-up migration (the migration owner), not here.
- [ ] Record p50, p95 and p99, the machine, and the plans in the spike note. Update the product design §19 **V5** row with "laptop proxy measured in step 2; Pi run still due before 1.0".
- [ ] **Commit:** `test(perf): RLS benchmark at 10,000 things`.

---

## Phase C: web (T25–T29, parallel by route; each starts on the mock server)

Shared rules for these tasks:
- Build to the screens spec §5 and the frames in `docs/design/screens/02-browse-things.html`, `04-search-assistant.html` and `06-people-types.html`.
- Every list uses `ListSurface`. Forms are bottom sheets on phones with an explicit Save (L88).
- Controls that can't be used follow screens §3: hidden for the role; "Off in this location" for a module; disabled with the reason when offline.
- User text is bidi-isolated (`dir="auto"`, `<bdi>`).
- Tests use Vitest and Testing Library against the mock server (`src/test/render.tsx`): keyboard operation, RTL render (`dir="rtl"`), the viewer variant, and the module-off variant.
- Check each screen at 375, 768 and 1280 px in both themes before calling it done (L88).

### Task 25: Browse: Location, Place and Container views (D45, D118, D160)

**Files:** `routes/_app/loc.$id.tsx` (rewrite), `routes/_app/p.$id.tsx`; `components/places/{tree.tsx, add-here-sheet.tsx, move-picker.tsx, trash-contents-dialog.tsx, merge-dialog.tsx, convert-dialog.tsx, place-fields.tsx, breadcrumb.tsx, unplaced-sort.tsx}`; tests `browse.test.tsx`

- [ ] **Location page:** the breadcrumb, then children with places first and things second (`GET /places/:id/contents`). The screen's actions:
  - "Add here": **Thing · Box / container · Room or spot** (D45, §6.2 wording);
  - Unplaced's **Sort them**: one-at-a-time triage with the move picker, or a bulk select and move;
  - the existing Members, What to track and Leave links;
  - for Personal, no members or leave (D114).
- [ ] **Place page:** place fields (D160) with Edit/Save, attachments, label (`labels` module), rename, re-parent (the move picker, places only), merge, convert to container, and trash with the contents choice dialog (D45, D160).
- [ ] **Container view:** `/t/<id>` opens on **Contents** for containers (T26 hosts it and imports `ContentsList` from here). A container opened by scanning leads with a photo grid (D195; the scan entry is step 3, so the grid is reachable here through `?view=photos`).
- [ ] **Move picker:** recent places, a tree search, and a cross-location warning drawn from `move/preview` ("Alfred and 2 others will lose sight of it"). The drag-and-drop move on desktop (D45) has the picker as its non-drag alternative (WCAG 2.5.7).
- [ ] **Empty states** (§5): "Nothing here yet" → Add here; "Box 3 is empty".
- [ ] **Commit:** `feat(web): location, place and container views with every place operation`.

### Task 26: Thing detail, create and edit (D76, D156, D195)

**Files:** `routes/_app/t.$id.tsx`; `components/things/{header.tsx, overview.tsx, edit-form.tsx, conflict-sheet.tsx, create-sheet.tsx, lifecycle-sheet.tsx, split-sheet.tsx, retype-sheet.tsx, links.tsx, purchase-section.tsx, meters-section.tsx, photos.tsx, upload.tsx, secrets.tsx, action-menu.tsx}`; tests `thing.test.tsx`, `conflict.test.tsx`, `upload.test.tsx`

- [ ] **Header:** a photo carousel, the name, the `IdChip`, the full path (with `<bdi>`), derived-state pills, and the lifecycle when ended.
- [ ] **Layout:** sections with anchored chips on the phone; tabs on desktop (`?tab=`). The tabs:
  - Overview (resolved type fields; archived fields collapsed);
  - Paperwork (attachments by role; warranties come in step 4);
  - Meters (only when metered): readings list, "Log a reading", needs-review Keep/Edit/Discard;
  - Links;
  - History (T27's timeline component).
- [ ] **Action menu:** Move · Label · Split (hidden at quantity 1, screens §8) · Duplicate · Mark seen · Not here · Change lifecycle · Re-type · Convert to place (containers) · Trash. Viewers get **Copy link only** (screens §5, A viewer's thing detail).
- [ ] **Edit:** an explicit Edit → fields in place → Save/Cancel. On 412: `GET` the latest version, `three-way.merge(base, mine, theirs)`, and silently apply fields only the other person changed. Only fields both changed open the conflict sheet: "Alfred changed this since you opened it", showing both values, with Keep mine, Keep theirs, or Edit (D156).
- [ ] **Create sheet** (desktop and phone): name, type (a Combobox with type icons), place (the move picker), quantity (hidden or forced for quantity-1 types), brand, model, serial, a photo upload, and the optional purchase quick fields (date, vendor, price + currency; hidden without money). Money input accepts Arabic digits and `٫` (D172).
- [ ] **Upload:**
  - hash with `crypto.subtle.digest('SHA-256')` before upload;
  - `PUT /files/:id` with `X-Kept-Sha256` and progress;
  - then `POST /attachments`;
  - HEIC shows "preview unavailable", never an error (D36).
- [ ] **Secrets:** a "Reveal" button (when `canReveal`) shows the value for 30 s with "Revealed · logged", then hides it again, including when leaving the page. Copy posts `/copied`. Setting a value is a write-only "Replace" field (D116, D175).
- [ ] **Commit:** `feat(web): thing detail, create, edit with field-level conflicts, uploads and secrets`.

### Task 27: Search, the ⌘K palette, trash, history and activity (D42, D174, D195)

**Files:** `routes/_app/search.tsx` (rewrite), `routes/_app/trash.tsx`, `routes/_app/activity.tsx`; `components/search/{results.tsx, filters.tsx, saved-views.tsx, palette.tsx}`, `components/history/timeline.tsx`; tests

- [ ] **Search:**
  - Results grouped by kind (things, places, people, vendors), then by location. Each thing row shows the container photo beside its path (D195), and "matched: <alias>" (screens §8).
  - Filters: location, place subtree, type, tags, state. Money filters appear only for members and above.
  - Recent searches are kept in `localStorage`, per user id. Saved views can be personal or shared.
  - Zero results: "No match for 'hmdi'" plus did-you-mean (§5).
  - Everything is URL state, so any search can be linked.
- [ ] **⌘K palette** (desktop; `react-aria-components` Dialog + ComboBox): search as you type (debounced 150 ms, `kind=things&limit=8`), jump to a location or place, and actions: Add thing, Trash, Settings. The hand-off to the assistant comes in step 6.
- [ ] **Trash:** a list-standard view with restore (members and above) and delete permanently (admins and above, through `useConfirm`). It shows the purge date.
- [ ] **History timeline** (exported for T26): rendered events with actor, time, and before → after. Money shows as "hidden" for viewers; secrets show as "changed" (D110). "Moved in from another location" appears as its own row.
- [ ] **Activity page:** global, with a location chip and filters for person, kind and date (screens §5).
- [ ] **Commit:** `feat(web): search with saved views, command palette, trash, history and activity`.

### Task 28: Registries and the type editor (D11, D92, D123, D160, D177, D192)

**Files:** `routes/_app/types.$id.tsx`, `people.$id.tsx`, `vendors.$id.tsx`, `brands.$id.tsx`, `settings.account*.tsx`, `admin.currencies.tsx`; `components/registries/{type-tree.tsx, type-editor.tsx, field-list.tsx, field-sheet.tsx, impact-preview.tsx, icon-picker.tsx, registry-list.tsx, merge-sheet.tsx, contact-card.tsx, account-switcher.tsx}`; tests

- [ ] **Account settings:** an account switcher (accounts where you can manage), then tabs for Types, Place kinds, Brands, Vendors, People and Tags (screens §5 Settings → Account).
- [ ] **Type editor** (desktop): the tree on the left; the selected type on the right, in order:
  - identity (name + icon picker, lazy-loaded);
  - capabilities;
  - the field list, inherited fields first, marked with their source; a lock icon on secret fields;
  - field groups (the built-in Device group shown read-only).

  Before saving, the impact preview lists things per visible location, hidden locations as counts, descendant types, and the fields to archive (D92, D123). Also: "Customise" on a built-in, merge, archive and restore a field. A cycle is refused with its message. Secret creation, and the policy link, show for the owner only (D177).
- [ ] **Place kinds** reuse the same field list and field sheet (D160).
- [ ] **People, vendors, brands, tags:** list-standard lists; inline creation with the duplicate hint (D11); merge (admin). The person page shows what belongs to them (screens §5 Person page); its contact card is shown only when the server returns it (D177).
- [ ] **Admin → Currencies:** a switch per currency; the five defaults and currencies in use can't be switched off (D168).
- [ ] **Commit:** `feat(web): type editor with impact preview, place kinds, registries and currencies`.

### Task 29: Home (D138, D185, D191, D193)

**Files:** `routes/_app/index.tsx` (rewrite), `components/home/{checklist.tsx, attention.tsx, recent-activity.tsx, location-card.tsx}`; tests `home.test.tsx` (extending step 1's)

- [ ] **The checklist** from `/api/v1/home`:
  - "Put Kept on HTTPS" first for admins over http (`servedOverHttp()`);
  - "Install on your phone" completes in standalone display mode and posts the `installed_standalone` hint;
  - dismiss and restore go through hints; Help restores it (screens §8);
  - hidden in the first-run state;
  - no AI item on Essentials (D191).
- [ ] **The attention panel:** the step-2 rows only, in the fixed §8 order, with zero rows hidden. Each opens `/search?…`. Later steps plug more rows in through an ordered registry in `attention.tsx` (D185).
- [ ] **Recent activity:** 3 items on the phone, 5 on desktop. **Location cards:** thing counts; the Unplaced count ("12 things need a place", §5).
- [ ] **Commit:** `feat(web): Home with computed checklist, attention panel and recent activity`.

### Task 29b: Collapsed sidebar (D198) — done

Added on the maintainer's request (2026-09-26); built in `feat(web): collapsible sidebar rail (D198)`.

**Files:** `components/app-shell.tsx`, `components/ui/tooltip.tsx` (new), `components/page.tsx` (top-bar icon buttons), `components/icons.tsx` (panel and code icons), `lib/prefs.ts` (`kept.sidebar`), `index.html` (pre-paint), `styles/index.css` (the `rail:` variant), `routes/_app.tsx` (the loading frame's width), `locales/{en,ar}/messages.po`; tests `test/screens/sidebar.test.tsx`

- [x] **The rail:** 64 px; each entry and location an icon with its accessible name (sr-only label) and a React Aria tooltip on hover and keyboard focus; later-step entries muted and focusable in the rail; the square K mark for the lockup; a rule for the Locations heading; the source code link as an icon with the version in its tooltip (D147).
- [x] **Counts:** `MainShell` takes `counts`; after the label in the full sidebar, a badge on the rail icon ("99+" past 99). Step 3 passes the Inbox's.
- [x] **Toggle:** a pinned foot button ("Collapse sidebar" / "Expand sidebar", `aria-expanded`, `aria-controls`) and `⌘\` / `Ctrl+\`, ignored in text fields; focus returns to the same entry, or to the toggle.
- [x] **Memory and first paint:** `kept.sidebar` in localStorage (guarded); the pre-paint script sets `data-sidebar`; no stored choice → the rail at 768–1023 px and expanded from 1024 px, following the width live. The width animates (off under reduced motion) while the content is laid out at its final width.
- [x] **Top bar at 768–1023 px:** search and Capture as icon buttons with tooltips; search opens the palette.
- [x] **RTL:** logical CSS only; the panel icons flip.
- [x] **Tests:** toggle by button and by shortcut, the text-field guard, persistence, the tablet default, tooltip names on keyboard focus, the source link's tooltip, RTL with logical CSS only, and rail badges. Checked at 1280 and 900 px, expanded and collapsed, light, dark and Arabic.

---

## Phase D: finish

### Task 30: i18n, e2e, visual checks, CI and docs

**Files:** `apps/web/src/locales/{en,ar}/messages.po`; `apps/web/e2e/step2.spec.ts`; `scripts/ci-local.sh`; `README.md`; `docs/plans/step-2-carryover.md`; product design §19 (V5, V20, V29)

- [ ] **i18n:** run `pnpm --filter @kept/web i18n:extract` once and write the Arabic for every new string.
  - Built-in type, field and place-kind names come from `builtin-types.ts` (en/ar), not the catalogue.
  - A test fails when an `ar` msgstr is empty.
- [ ] **Contract check:** a server test loads `/api/v1/openapi.json` and asserts that every path in `apps/web/src/api/inventory/paths.ts` exists, with that method.
- [ ] **Playwright, at 375×780 and 1280×800, on the `households` seed:**
  1. sign in as Ibrahim → create a place → add a thing with a photo (fixture JPEG) → it gets an ID chip → search for it in English and in Arabic → move it into a box → the box's history shows one event, and the thing's shows "moved with";
  2. Alfred edits the same thing in a second context → Ibrahim saves → the conflict sheet shows both values;
  3. trash a box with contents → the choice dialog → restore;
  4. the viewer: the thing page has Copy link only, and no prices;
  5. the type editor: add a field to a custom type, and see the preview;
  6. Arabic, RTL: the ID chip stays LTR, and paths are isolated;
  7. axe checks on every page visited.
- [ ] **Visual regression**, capped at about 10 screens (D86): Home, the location page, thing detail, search results, the type editor, and trash. Light, dark and RTL for thing detail only.
- [ ] **CI** (`scripts/ci-local.sh`):
  - `compose` waits for the `s3` service;
  - `test` sets `KEPT_TEST_S3_URL`;
  - a new `perf` step (T24) runs in full mode;
  - `prod-boot` also boots once with `KEPT_STORAGE=s3`;
  - `licences` passes with the sharp libvips exception.
- [ ] **Docs and spec rows:**
  - the README's quickstart mentions `kept admin seed --scenario households` and `pnpm bench:rls`;
  - write `docs/plans/step-2-carryover.md`;
  - update §19: V20 (the corpus result), V5 (the laptop proxy), and V29 (not used in step 2; Nominatim stays off).
- [ ] **Gate:** `bash scripts/ci-local.sh` exits 0. **Commit:** `chore: step-2 i18n, e2e, visual checks and CI`.

### Task 31: PDF engine spike (V34)

Added by D201 (2026-09-26). Nothing that renders a report depends on an engine until this passes.

**Files:** `docs/spikes/2026-09-26-step2-pdf-engine.md`; a throwaway harness under `docs/spikes/code/pdf/` (not shipped); product design §19 (V34, and V19 folded into it)

- [ ] **One sample document, three engines:** a cover, a table of contents, 3 places × 20 things with photo thumbnails, short IDs and QR codes, per-currency totals, page numbers and a footer; in English and in Arabic (RTL). Engines: a React-to-PDF library, a headless-Chromium sidecar, and Typst. Versions are looked up on the registries, never assumed.
- [ ] **Arabic shaping decides:** joined letter forms, lam-alef ligatures, digits in both settings (D143), mixed Arabic and Latin runs (a brand inside an Arabic name), and right-aligned tables. Compare against the same text rendered by the browser; any wrong join fails the engine.
- [ ] **Fonts and photos:** the shipped IBM Plex Sans, Sans Arabic and Mono embedded (subset is fine); JPEG and WebP thumbnails from the display derivatives (never originals).
- [ ] **Budget:** peak memory and time for 500 things with thumbnails, measured on the laptop and, if reachable, on a Pi 4 (2 GB) — within the Pi's memory budget (engineering spec §3.1) with the app running. Image size added to the container (or the sidecar's own size).
- [ ] **Licences:** each candidate passes the dependency licence policy (D151).
- [ ] **Write-up:** the result per engine, the choice and why, and the V34 row updated (verified, with the note's link). If no engine passes, say so and stop: the report waits for a decision.
- [ ] **Commit:** `docs(spikes): step-2 PDF engine for the inventory report (V34)`.

### Task 32: The inventory report (D201) (depends on T31)

**Files:** server `src/reports/{routes.ts, service.ts, jobs.ts, render/*.ts, reports.test.ts}`, a `report_runs` table in the next free migration (with RLS and the leak test's list), `src/jobs/policies.ts` (the `report` job); web `components/reports/{print-sheet.tsx, progress.tsx}`, `routes/_app/loc.$id.tsx` and `routes/_app/settings.account*.tsx` (the action), `api/inventory/{paths.ts, reports.ts}`, the mock server; tests `reports.test.tsx`

- [ ] **`POST /api/v1/reports/inventory`** `{scope: {locationId} | {accountId}, placeIds?, typeIds?, tags?, includeEnded?, includeTrashed?, locale: 'en'|'ar', qr?: boolean}` → `202 {id, status: 'queued'}`. Members and above of the location (or of every location in the account scope); viewers may generate it too, but it carries no money for them. Audited (`reports.inventory`).
- [ ] **The `report` job** (pg-boss, paced like other heavy jobs): reads under the requester's scope (`withScope`), so RLS decides what's in it; money only when the requester's role and the `money` module allow it (the API's own gates, D110); **never secrets**. Progress is written as `{done, total}`; the PDF goes to the blob store; the run expires after **24 hours** and the purge removes the file.
- [ ] **`GET /api/v1/reports/:id`** → `{status: 'queued'|'running'|'done'|'failed', progress, fileUrl?, expiresAt}`. `fileUrl` is a five-minute signed URL (the files route's signing, attachment disposition). Only the requester sees the run.
- [ ] **Content** (D201): the cover (the Label-tape brand, the location or account, the date, who generated it); things grouped by place path with thumbnail, short ID (and QR when asked), type, brand and model, serial and condition; purchase date, price and per-currency totals where allowed; a table of contents, page numbers, and the instance and generation time in the footer. English or Arabic, from the design tokens and the shipped fonts.
- [ ] **Web:** "Print inventory" on the location page's actions and on Settings → Account. A filter sheet (places, types, tags, include ended, include trashed, QR codes), then a progress state that polls the run, then "Download". Offline: disabled with the reason (screens §3).
- [ ] **Tests:**
  - a viewer's report has no prices or totals; a member's has them; the money module off removes them for everyone;
  - an account-scope report leaves out locations the requester can't see;
  - secrets never appear (the text of the generated PDF is extracted and searched);
  - Arabic output: the extracted text matches the source strings (shaping checked in T31);
  - the run expires and its file is purged; another user's run id is a 404.
- [ ] **Commit:** `feat(reports): the inventory report as a generated PDF`.

---

## Definition of done for step 2

- `bash scripts/ci-local.sh` exits 0, including `drift`, `licences`, `perf` and `e2e`.
- The leak test covers every new table (with `fillTenant` rows) and lists every new function. `SYSTEM_TABLES` is unchanged. kept_app holds UPDATE on no id, primary-key or scope column.
- Every non-GET route writes an audit row, or is on the route catalogue's allowlist with a reason.
- On a fresh `docker compose up` plus `kept admin seed --scenario households`, in the browser:
  - browse a home's places;
  - add a thing with a photo, get its short ID, and find it by search in English and Arabic (the D74 test on Essentials);
  - move a box with contents across locations and across accounts;
  - trash and restore with the contents choice;
  - edit with a field-level conflict;
  - reveal a secret, owner only by default, with an audited reveal;
  - see the Home checklist and attention counts;
  - manage types, with the impact preview.
- Uploaded originals are byte-identical (SHA-256 checked). Derivatives have no GPS. The originals route refuses viewers. Files are served only through signed URLs with nosniff, a sandbox CSP and attachment disposition.
- Money never appears to a viewer (toggle off) or where the `money` module is off: not in responses, history, search or activity. Secrets never appear in `custom`, `search_tsv`, the audit or logs.
- The 10k benchmark meets the laptop gates, and its note records the numbers and plans.
- `kept admin rotate-key` works, and the carry-over item is closed.
- `docs/plans/step-2-carryover.md` lists anything deferred, each with the step that takes it.

---

## Spec questions that are genuinely ambiguous, with proposed answers (adopt these)

1. **Cache columns and `change_seq` (§7.9 vs §7.4).** §7.9 says `place_path`, `search_tsv` and `last_seen_at` don't bump `row_version`, but the offline snapshot needs `last_seen_at`. **Proposal:** `last_seen_at` bumps `change_seq` only; `place_path` and `search_tsv` bump nothing. This is `kept.touch_row('place_path,search_tsv','last_seen_at')`.
2. **"Rounded to minor units at the edges" (§7.13, L5).** **Proposal:** store what the API receives (at most 4 decimals, `numeric(16,4)`), and compute totals at full precision. Round half away from zero to `minor_units` only at the output edges (display, export, reports). Never round silently on input.
3. **"Secret" as a field kind (§6.4) vs `type_fields.secret` (§7.13).** **Proposal:** a flag on a `text` field. "secret" is not a kind. Converting a field to or from secret, and changing a field's kind (D172, D177), are deferred to step 7's secret-field UI. In step 2, fields are made secret only at creation, by the owner, or come from the built-ins.
4. **How to model the D192 Device "field group".** **Proposal:** a built-in type with `is_field_group = true`, referenced from `types.field_groups uuid[]` and resolved alongside inheritance. There is no separate group table, and the key-redefinition guard covers groups.
5. **D177 "admins of every location that uses them" (people's contacts).** **Proposal:** "uses" means a non-deleted thing in that location belongs to the person (loans join in step 4). A person used nowhere is visible to admins of any location of the account. Contact fields are audited as `secret` (`{changed:true}`), so history can't leak them.
6. **Templates (§11 Registries).** Core scope §5 lists "Quick add and templates" under Capture. **Proposal:** templates and "Save as template" move to step 3. Step 2 ships Duplicate.
7. **Box check (D40) in step 2 or 3?** **Proposal:** step 3, with its offline queue op and scanning (D175). Step 2 ships Mark seen and Not here.
8. **PDF thumbnails and extracted text (D77).** They need the child-process parser (D157). **Proposal:** step 3, with the extraction pipeline and `file_text`. Step 2 stores PDFs as `derivative_state='not_applicable'`, with a document icon.
9. **Brand logos and SVG uploads (D157, D172).** **Proposal:** no logo upload in step 2. It lands with warranties and claims (step 4), together with SVG rasterisation. SVG uploads are refused until then.
10. **The `condition` values.** Not enumerated anywhere. **Proposal:** `new · good · fair · poor · broken` (text + CHECK), localised in the UI.
11. **D10 "with a warranty".** **Proposal:** in step 2, quantity is forced to 1 by the `serialized` or `metered` capability (through inheritance) or an existing meter. Step 4 adds "has a warranty record" to the trigger. The `warranty` capability alone doesn't force it: it means "can carry warranties".
12. **RESTRICT on `places.parent_id` and `things.container_id` (§7.13).** Immediate RESTRICT breaks the cascade when a location is purged. **Proposal:** use `NO ACTION`, which gives the same guarantee at statement end and lets a single cascading delete succeed. `things.place_id` gets the same.
13. **Moving across owner accounts (§6.1, D161).**
    - **Proposal:** the move definer copies what's missing into the destination account: custom types (the whole chain), brands, tags, vendors, and people (name only, never contacts). Built-ins stay. The purchase line and its receipt are copied, and file rows are copied sharing the blob (reference-counted). Links that would cross locations are dropped, and audited.
    - **13b.** "Customise" on a built-in with built-in children copies its **built-in subtree**, so the account's descendants keep inheriting its edits.
14. **Converting a place to a container and back (§7.13 "rewrites every reference").** **Proposal:** keep the same UUID across the conversion, so routes, short IDs, audit subjects and client caches stay valid, and write a tombstone for the old entity type.
15. **Who reads account-level registry history?** **Proposal:** registry events (types, fields, place kinds, brands, vendors, people, tags) are account-level audit rows. They are insertable by writable accounts and readable by admins of the account. Every other account-level event stays owner-only.
16. **D157 "a separate files path that has no session cookie access".** **Proposal:** every file is fetched through a 5-minute signed URL (`/f/<token>` locally, presigned on S3). That route never reads the session, and sends nosniff, `CSP: default-src 'none'; sandbox`, and attachment disposition for originals.
17. **Derivatives: inline or as a job?** **Proposal:** inline in the upload request, behind a process-wide semaphore (`KEPT_IMAGE_CONCURRENCY`, 1 on a Pi). There's no system job and no extra definer. Step 3's phone-made display JPEG (D34) replaces the server's `display` when present.
18. **S3 in step 2?** **Proposal:** yes, as a separable driver behind `BlobStore`, tested against `rustfs/rustfs:1.0.0` (MinIO stopped publishing images). Switching storage stays a CLI migration for step 8 (D186).
19. **Where `rotate-key` keeps its versions (the carry-over).** **Proposal:** the config-volume `secrets.json` gains `secretKeyVersion` and `retired`. Environment users set `KEPT_SECRET_KEY_VERSION` and `KEPT_SECRET_KEYS_RETIRED`. The recovery kit (step 8) exports the whole keyring. Add the two variables to §7.11.
20. **Arabic prefix stripping (screens §8) vs false positives (`ورق`).** **Proposal:** strip `و/ب/ف/ك` only together with `ال` (plus `لل`), and index **both** the normalised and the stripped forms, so recall never drops. Queries also match both forms. The test vectors are the contract (V20).
21. **Which account "Account settings" edits** when you administer someone else's home. **Proposal:** an account switcher over the accounts where you are an admin in at least one location. Registry routes are `/api/v1/accounts/:accountId/…`.
22. **"3 things captured" (D138).** **Proposal:** at least 3 non-deleted things with `created_by` = the user. This adds `things.created_by`, which step 3's inbox "Mine" filter also needs.
23. **File size configurability (§3.4 "25 MB, configurable").** **Proposal:** add `KEPT_MAX_FILE_MB` (default 25), plus `KEPT_IMAGE_CONCURRENCY`, to the §7.11 environment contract.
24. **Recovery-kit gate for a non-admin (D193).** **Proposal:** the instance-wide gate also applies when a member writes the first secret value: 409 `recovery_kit_required`, with "ask your instance admin". Admins see the status-page banner.

---

### Critical files for implementation
- apps/server/migrations/0006_rls.sql (the policy, definer and grant patterns every Phase-A migration copies)
- apps/server/test/leak.test.ts (`fillTenant`, `FUNCTIONS`, `SYSTEM_TABLES`; must stay green after every Phase-A task), together with apps/server/src/db/migrate.test.ts (the kept.* function map)
- apps/server/migrations/0000_foundation_schemas.sql and 0005_tenancy_triggers.sql (`kept.touch_row`, the place-loop and Unplaced triggers extended in T4 and T6)
- apps/server/src/http/write.ts, conventions.ts, errors.ts and apps/server/src/audit/audited.ts, classes.ts, render.ts (the write, conflict, error and redaction helpers every Phase-B route uses)
- packages/shared/src/roles.ts, modules.ts, errors.ts (`can()`, module gating, error codes), and apps/web/src/api/mock/server.ts (the mock the parallel web tasks build against)
