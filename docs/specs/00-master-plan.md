# Kept — master plan

**This file drives the spec.** It lists every decision Kept needs across product, design,
code, stack, operations, security, open source and cloud. We go through it area by area
over several sessions, so the build doesn't iterate on things we could have decided up front.

## How we use it

- **One area per sitting**, one question at a time. Each question below has a **proposed
  default** where one exists, so most answers are "yes" or "change X".
- **Decided →** the question's status becomes `D<n>` and the decision is written into the
  [product design](2026-09-25-kept-product-design.md) decision log with its reason.
  Nothing is built from this file directly; the product design is the contract.
- **Status legend:**
  - `✅ D<n>` decided
  - `🟡` proposed default, awaiting confirmation
  - `⬜` open, no default yet
  - `⏭` explicitly deferred to later, with a reason
  - `🔬` being verified by research before deciding
  - `⛔` blocked on a maintainer decision
  - `(delegated)` decided by delegation after the maintainer said "proceed without asking" (from D74)
- **Rules carried from our previous apps** are in
  [lessons](../research/2026-09-25-lessons-from-our-apps.md). When a question touches one,
  it's cited as `L<n>`.
- **A feature enters scope only by an explicit decision** (L106). If a default here adds a
  capability, it is marked 🟡 until confirmed.

## Progress

| # | Area | Status |
|---|---|---|
| 1 | Product & positioning | decided |
| 2 | Domain model | decided (depreciation deferred) |
| 3 | Access & identity | decided |
| 4 | Capture & AI extraction | decided |
| 5 | Assistant (chat) | decided |
| 6 | Meters & vehicles | decided |
| 7 | Schedules, reminders, notifications | decided |
| 8 | MCP server | decided |
| 9 | Public API & integrations | decided (other importers deferred) |
| 10 | Search | decided |
| 11 | Files & storage | decided (malware scan deferred) |
| 12 | UX & information architecture | decided |
| 13 | Visual design & brand | decided (D131–D135); 56 screens drawn (D189) |
| 14 | Frontend architecture | decided |
| 15 | Backend architecture | decided |
| 16 | Database | decided |
| 17 | Security & privacy | decided |
| 18 | Observability | decided |
| 19 | Self-hosting & operations | decided |
| 20 | Testing & quality | decided |
| 21 | CI/CD & release | decided |
| 22 | Open-source project & community | decided |
| 23 | Cloud / SaaS | rules and billing decided; the rest deferred to the cloud phase (D91) |
| 24 | Launch & growth | decided (name: D109) |
| 25 | Non-goals | decided |

## Walkthrough — the product as stories

From 2026-09-25 the sessions change mode: **product owner and senior engineer walking the
product one user story at a time**. For each story we cover:
1. The story and who it's for.
2. What the user sees, step by step.
3. What happens underneath: data written, jobs run, permissions checked.
4. Where it breaks: edge cases and failure modes.
5. Decisions it forces, which land in the area tables below as `D<n>`.

The area tables stay the checklist; the stories are how we get through them.

| # | Story | Areas it exercises | Status |
|---|---|---|---|
| J1 | **Setting up** — install, first account, first home, rooms, AI key, phone install | 3, 12, 19 | ✅ done (D31–D33) |
| J2 | **Capturing** — snap things in the garage with no signal; sync; AI fills; review the inbox | 4, 11, 14 | ✅ done (D34–D36) |
| J3 | **Finding** — "where is the HDMI cable?" by search, by assistant, by scanning a box | 5, 10, 12 | ✅ done (D40–D42) |
| J4 | **Organising** — boxes, moving things, splitting a quantity, printing labels | 2, 4, 12 | ✅ done (D43–D45) |
| J5 | **Sharing** — invite a spouse as member, a house-sitter as viewer; secrets and money | 3, 17 | ✅ done (D46–D50) |
| J6 | **The car** — add it, readings, services, fuel, schedules, the reminder that fires | 6, 7 | ✅ done (D51–D52) |
| J7 | **The warranty claim** — the TV dies; find the invoice, the warranty, the vendor | 2, 10, 11 | ✅ done (D53–D55) |
| J8 | **Lending** — your brother borrows the drill; it's overdue | 2, 7 | ✅ done (D56–D57) |
| J9 | **Talking to it from outside** — connect Claude Desktop over MCP; a write with confirmation | 8, 9 | ✅ done (D58–D63) |
| J10 | **Running it** — backups, an upgrade, AI budget running out, a restore | 18, 19, 21 | ✅ done (D64–D66) |
| J11 | **Arriving and leaving** — import from Homebox; export everything; delete an account | 9, 3, 23 | ✅ done (D67–D69) |
| J12 | **The cloud** — sign up, pay, hit a plan limit | 23 | ✅ done (D70–D73) |

After the stories: the **engineering spec** (data model tables, contracts, numbers,
accessibility, error and empty states) is in
[2026-09-25-kept-engineering-spec.md](2026-09-25-kept-engineering-spec.md). The build plan comes after it.

---

## 1 · Product & positioning

| # | Question | Status / proposed default |
|---|---|---|
| 1.1 | Open source, license | ✅ D1, D221 — AGPL-3.0 + DCO + CLA (Apache-based, D221) |
| 1.2 | SaaS-ready from day one | ✅ D2 |
| 1.3 | Name | ✅ D109 — **Kept** (replaced the working title "Stowly", D7/D108) |
| 1.4 | Primary audience | ✅ D8 — household (phone) + owner (desktop), equally |
| 1.5 | One-line pitch | ✅ D74 (delegated) — "Everything you own, where it is, and what it needs — self-hosted, shared with your household, and askable by AI." |
| 1.6 | What does success look like 3 months after launch? | ✅ D74 (delegated) — pre-launch: the household uses it daily for 30 days, car included; after launch: public signals only (stars, registry pulls, issues, Homebox Discussions); no telemetry (D84) |
| 1.7 | The single moment that proves value in the first 5 minutes | ✅ D74 (delegated) — Scan or snap three things in a room, then ask "where is X" and get the right answer |
| 1.8 | First launch audience | ✅ D74 (delegated) — Homebox users and r/selfhosted (the importer is the hook), then families via the cloud |
| 1.9 | Positioning against Homebox / LubeLogger | ✅ D74 (delegated) — "Homebox + LubeLogger + an assistant, with real per-home roles and a UI you'd show your family" |
| 1.10 | Complexity levels | ✅ D61, D62, D75, D191 (delegated) — modules per location; presets Essentials · Household · Complete; contents per D75, re-cut by D191 (Vehicles in Household; AI follows the provider) |

## 2 · Domain model

| # | Question | Status / proposed default |
|---|---|---|
| 2.1 | Tree model | ✅ D9 — Places + Things; any thing can contain things |
| 2.2 | Quantities | ✅ D10 — quantity + split; serialized/metered/warranty ⇒ 1 |
| 2.3 | Ownership above locations | ✅ D6 — owner account |
| 2.4 | People & Vendors | ✅ D11 — registries |
| 2.5 | Types | ✅ D12 — capabilities, custom fields, full-tree inheritance (additive) |
| 2.6 | Place kinds list | ✅ D33 — location kinds: home, apartment, garage, storage unit, office, vacation home, custom · sub-place kinds: floor, room, zone, closet, custom |
| 2.7 | Final list of built-in thing fields (outside custom fields) | ✅ D76, D115, D128 (delegated) — name, short ID, type, photos, brand, model, serial, colour, quantity, condition, notes, tags, aliases, last seen, status, belongs to, purchase line, warranties, manual URL |
| 2.8 | Thing status lifecycle | ✅ D76, D119, D158, D183 (delegated) — stored: in use · sold · given away · lost (→ found) · disposed · stolen · destroyed · `returned_to_owner`; lent / borrowed / in repair derived from open loans and claims |
| 2.9 | Lending details | ✅ D56, D57 — lent to a Person, from/until dates, a reminder when overdue, a note |
| 2.10 | Kinds of links between things | ✅ D76 (delegated) — accessory of · spare part for · consumable for · bundled with · replaces · free "related" |
| 2.11 | Tags: keep them alongside types? | ✅ D76 (delegated) — tags stay: search filters, saved views and the Homebox import read and write them |
| 2.12 | Brands registry fields | ✅ D76, D172 (delegated) — name, logo (uploaded only, D172), website, support phone, warranty-claim URL |
| 2.13 | Currency conversion source | ✅ D76, D136 — native currency stored; rates entered per account; optional provider off by default and covering all five; no rate → totals grouped per currency |
| 2.14 | Value & depreciation | ✅ D158 — valuations (D158); ⏭ depreciation deferred |
| 2.15 | Duplicate detection & merging of things | ✅ D36 — suggest possible duplicates (same serial, or same brand + model + place); merge keeps both histories |
| 2.16 | Templates ("add another like this") | ✅ D76 (delegated) — duplicate a thing, or save it as a template on the account |
| 2.17 | Units system | ✅ D76 (delegated) — per user: metric/imperial; each meter stores its own unit; no silent conversion of stored readings |
| 2.18 | History granularity | ✅ D76 (delegated) — field-level changes from the central audit, rendered as a timeline per thing |
| 2.19 | Can places move between locations? | ✅ D76 (delegated) — no; move the things inside instead. Renaming or reparenting within a location is fine |
| 2.20 | Everyday surfaces & extra capabilities | ✅ D39 — home screen (attention panel), spreadsheet view, paperwork library, place-level tasks, moving-house mode, notification centre + activity feed, read-only share links, insights |
| 2.21 | Warranties per thing | ✅ D53 — a list, by kind |
| 2.22 | Claims & repairs | ✅ D54 |
| 2.23 | Warranty defaults, registration, replacement | ✅ D55 |
| 2.24 | Supported currencies | ✅ D136, D168, D189 — USD, CAD, GBP, EUR, EGP, more enabled by the admin (D168); a location default; "$" and bare "£" never auto-accepted from receipts; a bare "$" has no preselection, the person picks USD or CAD (D189) |
| 2.25 | Built-in type library | ✅ D154, D192 — furniture, appliances, electronics (phone with IMEI, computer with MAC and licence key), cables, chargers, tools, boxes, safes, vehicles, safety equipment, valuables, collectibles, consumables; a shared Device field group (OS, firmware, MAC, the tied account as a secret) per D192 |
| 2.26 | Home-level paperwork and expiries | ✅ D155 — documents and expiring documents attach to a location or place |

## 3 · Access & identity

| # | Question | Status / proposed default |
|---|---|---|
| 3.1 | Sharing boundary | ✅ D5 — top-level location |
| 3.2 | Role matrix | ✅ D49, D123 — full matrix in the product design §7.1 |
| 3.3 | Sensitive fields | ✅ D13 |
| 3.4 | Sign-in methods | ✅ D50 — password, passkeys, magic link (with SMTP), Google/Apple, OIDC |
| 3.5 | Two-factor | ✅ D49 — TOTP + passkeys; the owner can require them per location |
| 3.6 | Sessions | ✅ D49 — cookie sessions for the web, revocable device list, 30-day sliding expiry |
| 3.7 | Invites | ✅ D33 — link or email invite to a location with a preset role; expiry 7 days; an invite to someone without an account creates one |
| 3.8 | Removing a member | ✅ D49 — their tokens scoped to that location are revoked; things they added stay; audit keeps their name |
| 3.9 | Ownership transfer | ✅ D49, D128 — owner → another admin; all registries (D128) are copied into the new owner's account |
| 3.10 | Instance admin powers (self-host) | ✅ D33 — users, sign-up policy, AI defaults, storage, SMTP, backups; **no access to location data** unless also a member |
| 3.11 | Support access on cloud | ✅ D71 — none by default; owner-granted, time-boxed, read-only, audited |
| 3.12 | Deleting an account | ✅ D49 — blocked while it owns shared locations (transfer first); otherwise export offered, then hard delete after 30 days |
| 3.13 | Auth library | ✅ D93 (delegated, verified) — see the decision log |
| 3.14 | Temporary access | ✅ D46 — expiring memberships |
| 3.15 | Accounts without email | ✅ D47 — managed accounts |
| 3.16 | Who manages admins | ✅ D48 — only the owner |
| 3.17 | Deleting a location | ✅ D149 — owner, typed confirmation, export offered, 30-day grace, then purge |

## 4 · Capture & AI extraction

| # | Question | Status / proposed default |
|---|---|---|
| 4.1 | Provider strategy | ✅ D4 — any provider, vision instead of OCR |
| 4.2 | Offline | ✅ D17 — offline capture |
| 4.3 | Capture flow | ✅ D18 — capture now, review later |
| 4.4 | Required at capture | ✅ D19 — one photo *or* a name, plus where; everything else optional |
| 4.5 | Which extracted fields auto-accept | ✅ D19 — auto: name, brand, model, type, colour · confirm: price, dates (purchase, warranty), serial, meter readings, quantity > 1 |
| 4.6 | Multiple things from one photo (shelf/drawer) | ✅ D20 — full build: one photo → N cropped drafts in the same container |
| 4.7 | Receipt → several things | ✅ D19 — yes: one receipt creates N drafts sharing a purchase record and the receipt as evidence |
| 4.8 | Nameplate/label reading | ✅ D19 — a second photo of the label → brand/model/serial; suggests the manual link |
| 4.9 | Barcode lookup | ✅ D104, D126 (delegated, verified) — Open*Facts only, off by default and offered at setup; other providers opt-in with the operator's key |
| 4.10 | QR labels | ✅ D19, D43, D44, D185 — short-ID QR; blank labels claimed on first scan; print-styled HTML (save as PDF); label PNGs made on the phone (D97, D185), sized for label stock and thermal printers; direct Bluetooth printing after launch |
| 4.11 | Scanning a label | ✅ D19, D137 — Scan button on Home and Search; the capture camera recognises labels in any mode; six defined scan outcomes; works offline |
| 4.12 | Email-forwarded receipts | ✅ D21 — both: cloud forwarding address + self-hosted IMAP poller on a chosen folder |
| 4.13 | Where AI settings live | ✅ D19, D121, D167 — instance default (admin) → owner account override → user override; per task: vision model, chat model, embedding model; who pays: D121, D167 |
| 4.14 | Budgets | ✅ D19 — per task and per account: tokens per minute, per day and per month, with a clear "paused until" state (L41–L46, L62) |
| 4.15 | Provider data-use notes | ✅ D83 (delegated) — shown next to each provider in settings (L63) |
| 4.16 | Extraction eval corpus | ✅ D19 — 30+ real receipts, labels and odometers with expected fields; dated results; mock provider in CI (L61) |
| 4.17 | Re-running extraction | ✅ D19 — explicit only; replaces the draft; attempts recorded per attachment (L58) |
| 4.18 | Without any AI configured | ✅ D19 — everything works; capture shows the name field, and the inbox holds unnamed photos to finish later |

## 5 · Assistant (chat)

| # | Question | Status / proposed default |
|---|---|---|
| 5.1 | What it is for | ✅ D22 — find (where is), answer (when was the bike serviced, what did it cost), and act (add, move, log) — with confirmation |
| 5.2 | Tools | ✅ D22 — the same set as MCP (area 8), limited by the user's role |
| 5.3 | Answers cite things | ✅ D22 — every mentioned thing is a deep link; no uncited figures (L51–L52) |
| 5.4 | Confirmation UI | ✅ D22 — a card listing exactly what will change ("move 2× HDMI cable: Office drawer → Garage box 3"); bound to an argument hash; expires in 10 min (L55) |
| 5.5 | Conversation history | ✅ D23 — per-user threads, private even from admins, searchable, deletable, auto-deleted after 90 days (configurable); no learned memory |
| 5.6 | Voice input | ✅ D25 — browser dictation (built-in speech-to-text); no provider audio model |
| 5.7 | Languages | ✅ D22 — answers in the user's UI language; Arabic tested in the eval set |
| 5.8 | Style | ✅ D22 — blunt and concrete, no filler (L59) |
| 5.9 | Where it lives in the UI | ✅ D24 — a sheet reachable from every screen, aware of the current page; docks as a side panel on desktop; the command palette can hand a question to it |

## 6 · Meters & vehicles

| # | Question | Status / proposed default |
|---|---|---|
| 6.1 | Meter kinds | ✅ D26 — distance (km/mi), hours; custom unit allowed |
| 6.2 | Proof photo | ✅ D27 — always optional: attachable and encouraged, never enforced |
| 6.3 | Plausibility | ✅ D26 — lower than previous → refused at entry; sent to the Inbox when it arrives by sync; > X per day since the last reading → confirm; X is set per type (car 1,500 km/day). *(Ordering and late readings: D112.)* |
| 6.4 | Service record | ✅ D26 — date, meter reading, vendor, total cost, line items (part / labour / fluid, qty, cost), invoice, notes, which schedules it satisfies |
| 6.5 | Fuel log | ✅ D28 — full build: fills and charges (litres or kWh, cost, full or partial, station as a Vendor, odometer) → consumption, cost per km, trends |
| 6.6 | Document expiries | ✅ D26 — registration, insurance, licence renewal, inspection: date + document + reminder lead time |
| 6.7 | Schedule templates per make/model | ✅ D26 — deferred: later — manual schedules first; community template packs possible |
| 6.8 | Several drivers | ✅ D26 — readings and services record who logged them; no per-driver trip tracking |
| 6.9 | Cost reports | ✅ D26 — per vehicle: per month, per km, by category |
| 6.10 | Vehicle history report | ✅ D51 — print-styled HTML (save as PDF) (D97, D185) for buyers, insurers, mechanics |
| 6.11 | Reading sources, estimates, nudges, meter replacement | ✅ D52 |

## 7 · Schedules, reminders, notifications

| # | Question | Status / proposed default |
|---|---|---|
| 7.1 | Schedule semantics | ✅ D29 — every N units and/or M months, whichever first; anchored on the last completion |
| 7.2 | Completing a schedule | ✅ D29 — "done" creates a service record (for any thing, not only vehicles) and re-anchors |
| 7.3 | Snooze / skip | ✅ D29 — snooze until a date or a meter value; skip once |
| 7.4 | What reminds | ✅ D29 — schedules due or overdue, warranty ending, document expiring, low stock, lending overdue |
| 7.5 | Channels | ✅ D30 — built in: email, web push, webhook, ntfy, Telegram; plus an optional Apprise URL list (via the Apprise API container) for everything else |
| 7.6 | Delivery shape | ✅ D29 — a daily digest by default, immediate for overdue items; quiet hours per user |
| 7.7 | Who gets what | ✅ D29 — per user per location: opt in to kinds; admins get everything by default, viewers nothing |
| 7.8 | Exactly-once | ✅ D29, D111 — unique occurrence (subject, source, kind, due period) + unique delivery (occurrence, user, channel); a failed push never fails a write (L112) |
| 7.9 | Timezone | ✅ D29 — the location's timezone decides "today" and "overdue" (L1) |
| 7.10 | Expiring things; calendar feed | ✅ D141, D142 (delegated) |

## 8 · MCP server

| # | Question | Status / proposed default |
|---|---|---|
| 8.1 | Transport | ✅ D63 — Streamable HTTP, stateless (spec 2026-07-28) |
| 8.2 | Auth | ✅ D63 — personal tokens now; OAuth 2.1 with Client ID Metadata Documents for claude.ai/ChatGPT connectors (needs a public URL) |
| 8.3 | Token scopes | ✅ D63 — read / read+write; optional location list; never above the creator's role |
| 8.4 | Tools, first set | ✅ D63, D124, D172 — read: capabilities, search_things, where_is, get_thing, list_locations, list_contents, thing_history, upcoming, find_documents · write: add_thing, update_thing, move_thing, create_place, lend_thing/return_thing, borrow_thing, log_reading, log_service, log_fuel, complete_schedule, snooze_schedule, add_warranty, open_claim, update_claim, adjust_stock, mark_seen · attach_link; filtered per call by module and scope |
| 8.5 | Write confirmation | ✅ D58 — apply immediately + audit + 7-day undo; no destructive tools over MCP; use the spec confirmation where supported |
| 8.6 | Files over MCP | ✅ D63 — no binary over MCP; tools return an "attach it here" link |
| 8.7 | Resources & instructions | ✅ D63 — a vocabulary resource + server instructions explaining places/things/timezones (L73) |
| 8.8 | Output contract | ✅ D63 — compact JSON, units in names, `as_of`, paginated, ≤ 8 KB, `{error, hint}` (L70) |
| 8.9 | Never over MCP | ✅ D63 — provider keys, secrets (unless the field allows it), hashes, original evidence edits (L72) |
| 8.10 | Raw SQL tool | ✅ D63 — no (L66) |
| 8.11 | Rate limits per token | ✅ D63 — yes, same limiter as the API |

## 9 · Public API & integrations

| # | Question | Status / proposed default |
|---|---|---|
| 9.1 | REST API public and documented? | ✅ D63 — yes: OpenAPI generated from route schemas; the web app uses the same API |
| 9.2 | Versioning & stability | ✅ D60 — /api/v1 from day one; additive within v1; v2 for breaking changes with a deprecation window |
| 9.3 | Outbound webhooks | ✅ D63 — thing created/moved/updated, reading logged, reminder due; signed payloads; retries |
| 9.4 | Home Assistant integration | ✅ D59 — official integration in the full build (a separate Python codebase) |
| 9.5 | iOS Shortcuts / Android intents | ✅ D63 — "log odometer" shortcut via a token (L37: identity from the token) |
| 9.6 | Import formats | ✅ D67–D69, D73, D146 — Kept ZIP; CSV with column mapping; Homebox ZIP-first with API for currency, version and pre-v0.26 servers; old Homebox labels keep working |
| 9.7 | Other importers | ⏭ Snipe-IT, Grocy — later, on demand · LubeLogger: ✅ D170 (1.x) |
| 9.8 | Export formats | ✅ D67–D69, D97 — ZIP (JSON + original files + readable CSV/Markdown); reports as print-styled HTML, server PDFs via the optional sidecar |

## 10 · Search

| # | Question | Status / proposed default |
|---|---|---|
| 10.1 | Engine | ✅ D42 — Postgres full-text + `pg_trgm` fuzzy; no external search service |
| 10.2 | Languages | ✅ D42 — normalise at index and query time: alef forms → ا, ة↔ه, ى↔ي, strip diacritics and tatweel; real Arabic names in the test corpus |
| 10.3 | What is searchable | ✅ D42 — names, brands, models, serials, notes, custom fields, tags, place paths, vendor/person names, extracted receipt text |
| 10.4 | Semantic search | ✅ D42 — optional pgvector when an embedding model is set; results merged with keyword search |
| 10.5 | Saved views | ✅ D42 — URL-backed filters, savable per user or shared per location |
| 10.6 | Global search UX | ✅ D42 — search tab on phone; ⌘K command palette on desktop (search, jump, actions, hand-off to the assistant) |

## 11 · Files & storage

| # | Question | Status / proposed default |
|---|---|---|
| 11.1 | Backends | ✅ D77 (delegated) — local filesystem, S3-compatible |
| 11.2 | Originals | ✅ D77, D117 (delegated) — evidence originals kept byte-identical, members+ only; decorative photos → derivatives only |
| 11.3 | HEIC | ✅ D36 — the phone makes the display JPEG; evidence originals upload untouched; a HEIC with no preview is stored as "preview unavailable", never rejected |
| 11.4 | Limits | ✅ D77 (delegated) — per file 25 MB (configurable); per-account quota on cloud |
| 11.5 | Access | ✅ D77 (delegated) — files served through the app with permission checks, or short-lived signed URLs on S3 |
| 11.6 | Metadata | ✅ D77, D117 (delegated) — GPS stripped and rotation baked into derivatives only; dedupe by the original's content hash per location (D177) |
| 11.7 | PDFs | ✅ D77 (delegated) — thumbnail of the first page; text extracted for search |
| 11.8 | Malware scanning | ⏭ cloud only, later |

## 12 · UX & information architecture

| # | Question | Status / proposed default |
|---|---|---|
| 12.1 | Phone navigation | ✅ D78 (delegated) — bottom tabs: Home · Search · Capture (centre) · Inbox · More |
| 12.2 | Desktop navigation | ✅ D78 (delegated) — sidebar: Home, Inbox, Locations tree, Vehicles, Schedules, Paperwork, Lending, Insights, Moving, Settings (module entries hide when off; full entries in the screens spec §1); command palette |
| 12.3 | Key screens list | ✅ D78 (delegated) — enumerated in the product design §11 |
| 12.4 | Tree interactions | ✅ D45 — drag-and-drop on desktop; "move to…" picker everywhere; bulk select + move |
| 12.5 | First-run / onboarding | ✅ D33, D193, D194 — create a location → pick rooms from a template → capture the first three things → ask the assistant; three-step wizard and a findable first capture (D194); no walls on first run (D193) |
| 12.6 | Empty states | ✅ D78 (delegated) — every empty screen offers the one action that fills it |
| 12.7 | Accessibility | ✅ D78 (delegated) — WCAG 2.2 AA; full keyboard use on desktop; screen-reader labels |
| 12.8 | Right-to-left | ✅ D78 (delegated) — full RTL layout from day one (logical CSS properties only) |
| 12.9 | House UI rules | ✅ D78 (delegated) — L84–L88 adopted wholesale (frame never scrolls, no native dialogs, list standard, no truncation on phones…) |
| 12.10 | Onboarding & in-app help | ✅ D138 — Get-started checklist from real state; one-time first-use hints (driver.js, server-remembered); optional replayable tour |
| 12.11 | Install, push permission, share into Kept, gallery import | ✅ D139, D140 (delegated) |
| 12.12 | Arabic digits | ✅ D143 (delegated) — per-user Western or Eastern Arabic digits; codes always Western |
| 12.13 | In-app undo | ✅ D150 — 10-second Undo toast; audit-based; 7 days from the timeline |
| 12.14 | App/server version skew | ✅ D148 — versioned queue payloads; previous version accepted; reload prompt never mid-capture |
| 12.15 | Using the phone's location | ✅ D153 — set a location's coordinates; suggest the nearest location when capturing, computed on the device; position never sent or stored |

## 13 · Visual design & brand

| # | Question | Status / proposed default |
|---|---|---|
| 13.1 | Visual direction | ✅ D79 (delegated) — "warm utility": physical-storage cues used with restraint, photos as the hero, warm neutrals, amber accent, violet for AI values |
| 13.2 | Logo & wordmark | ✅ D135 — B · Label tape: KEPT in Plex Mono on amber tape; square tape "K" icon |
| 13.3 | Icon set | ✅ D98 (delegated, verified) — see the decision log |
| 13.4 | Typography | ✅ D79, D132 (delegated) — IBM Plex Sans / Sans Arabic / Mono; scale 28 · 20 · 15 · 13 · 11.5 |
| 13.5 | Colour tokens | ✅ D131 (delegated) — tokens for both themes, every text token ≥ 4.5:1 |
| 13.6 | Theme default | ✅ D37 — light and dark both first-class; follows the system by default; per-user override |
| 13.7 | Design tool | ✅ D79 (delegated) — designed in code with a living component page, both themes and RTL |
| 13.8 | Motion | ✅ D79 (delegated) — restrained motion; honours reduced-motion |

## 14 · Frontend architecture

| # | Question | Status / proposed default |
|---|---|---|
| 14.1 | Framework | ✅ D3 — React + Vite, TanStack Router + Query |
| 14.2 | Component primitives | ✅ D95 (delegated, verified) — see the decision log |
| 14.3 | Styling | ✅ D80 (delegated) — Tailwind with design tokens as CSS variables |
| 14.4 | Forms & validation | ✅ D80 (delegated) — react-hook-form + the shared zod schemas |
| 14.5 | Offline store | ✅ D101 (delegated, verified) — see the decision log |
| 14.6 | Camera & barcode | ✅ D80 (delegated) — `getUserMedia` + `BarcodeDetector` where supported, ZXing fallback |
| 14.7 | i18n library | ✅ D96 (delegated, verified) — see the decision log |
| 14.8 | Charts | ✅ D133 (delegated) — visx; three validated series colours, then grey "Other" |
| 14.9 | Bundle budget | ✅ D80 (delegated) — an entry-bundle weight test; every route code-split (L88) |
| 14.10 | API client | ✅ D80 (delegated) — generated from OpenAPI, typed end to end |

## 15 · Backend architecture

| # | Question | Status / proposed default |
|---|---|---|
| 15.1 | Framework | ✅ D3 — Fastify |
| 15.2 | Repo layout | ✅ D81 (delegated) — pnpm monorepo: `apps/server`, `apps/web`, `packages/shared` (schemas, types), `packages/mcp` |
| 15.3 | Validation | ✅ D81 (delegated) — zod with the Fastify type provider; OpenAPI generated from it |
| 15.4 | Auth library | ✅ D93 (delegated, verified) — see the decision log |
| 15.5 | Job queue | ✅ D94 (delegated, verified) — see the decision log |
| 15.6 | Images | ✅ D81, D99 (delegated) — stock sharp; the server never decodes HEIC (previews made on the phone) |
| 15.7 | PDF generation | ✅ D97 (delegated, verified) — see the decision log |
| 15.8 | Email | ✅ D81 (delegated) — SMTP via nodemailer; optional; templates rendered with React |
| 15.9 | Push | ✅ D81 (delegated) — web-push with VAPID keys generated at first run |
| 15.10 | AI layer | ✅ D3 — Vercel AI SDK; SDK retries off (L44) |
| 15.11 | Config | ✅ D81 (delegated) — environment variables validated at boot with a schema; a documented reference generated from it |
| 15.12 | Errors | ✅ D81 (delegated) — one error shape `{error, hint, code}`; no stack traces to clients |
| 15.13 | Logging | ✅ D81 (delegated) — pino JSON; request IDs; no secrets or argument values |
| 15.14 | Process types | ✅ D81 (delegated) — one image; `web` and `worker` roles by flag; single-process mode for small self-hosts |

## 16 · Database

| # | Question | Status / proposed default |
|---|---|---|
| 16.1 | Engine & version | ✅ D82, D128 (delegated) — PostgreSQL 18 (18.6 current; 19 adopted once GA + pgvector), glibc image with pgvector (L83) |
| 16.2 | Extensions | ✅ D82 (delegated) — pg_trgm, unaccent, pgvector (optional use) |
| 16.3 | IDs | ✅ D82 (delegated) — UUIDv7, generated on the client for offline capture (D17) + a short human ID for labels |
| 16.4 | Tenancy | ✅ D82 (delegated) — RLS on every owned table; owner role for migrations, non-superuser app role; `security_invoker` views; leak test (L25–L28) |
| 16.5 | Migrations | ✅ D82 (delegated) — drizzle-kit; additive only; drops/renames take two releases; run once per deploy (L97–L99) |
| 16.6 | Soft delete | ✅ D82 (delegated) — trash with `deleted_at`; permanent delete by admins; export/delete share one table list (L38) |
| 16.7 | Audit table | ✅ D82 (delegated) — actor (user/token), location, entity, action, before/after diff, request ID |
| 16.8 | Tree queries | ✅ D82 (delegated) — `parent_id` + recursive CTEs; no ltree (moves are the common operation) |
| 16.9 | Test database | ✅ D82 (delegated) — separate database, explicit URL; never the dev one (L91) |

## 17 · Security & privacy

| # | Question | Status / proposed default |
|---|---|---|
| 17.1 | Threat model | ✅ D83 (delegated) — write one: multi-tenant leaks, token theft, prompt injection via documents, SSRF, file uploads |
| 17.2 | SSRF | ✅ D83 (delegated) — user-supplied URLs (OpenAI-compatible base URL, webhooks, manual links) blocked from private ranges on cloud; allowed on self-host by setting |
| 17.3 | Secrets at rest | ✅ D83 (delegated) — envelope encryption with a server key; key rotation command |
| 17.4 | Web hardening | ✅ D83 (delegated) — CSP, SameSite cookies + CSRF tokens, rate limits proven by test (L34) |
| 17.5 | Prompt injection | ✅ D83 (delegated) — documents are data (L56); writes need confirmation (L55); tools limited by role |
| 17.6 | Vulnerability disclosure | ✅ D83 (delegated) — SECURITY.md + GitHub private advisories |
| 17.7 | Dependencies | ✅ D83 (delegated) — Renovate + audit in CI; SBOM per release |
| 17.8 | Privacy (cloud) | ✅ D83 (delegated) — GDPR basics: export, deletion, processors list, retention |
| 17.9 | Backups encryption | ✅ D64 — restic encryption with an admin-set passphrase |

## 18 · Observability

| # | Question | Status / proposed default |
|---|---|---|
| 18.1 | Health | ✅ D66 — `/healthz` (live), `/readyz` (DB + migrations), version + SHA endpoint (L100) |
| 18.2 | Metrics | ✅ D66 — Prometheus `/metrics` (optional token); gauges read from data (L94) |
| 18.3 | Tracing | ✅ D84 (delegated) — OpenTelemetry optional; CI runs with it pointed at a dead collector (L90) |
| 18.4 | In-app status page | ✅ D66 — admin view: job health, last reminder scan, storage use, AI usage/cost, backup freshness |
| 18.5 | Error reporting | ✅ D84 (delegated) — optional Sentry-compatible DSN, off by default |
| 18.6 | Telemetry | ✅ D84 (delegated) — none of any kind, not even opt-in |

## 19 · Self-hosting & operations

| # | Question | Status / proposed default |
|---|---|---|
| 19.1 | Packaging | ✅ D16 — image, Compose, Helm |
| 19.2 | Architectures | ✅ D85 (delegated) — amd64 + arm64 |
| 19.3 | First run | ✅ D32, D190, D193 — setup screen gated by a one-time 6-character setup code printed to the logs on first boot by the web process (D190); keys generated into a config volume when unset (D193) |
| 19.4 | Minimum hardware | ✅ D85, refined by D209 — any 2 GB, 2-core machine (amd64 or arm64) with an external AI provider; measured before 1.0 on a small VM. Not Pi-oriented |
| 19.5 | Backups | ✅ D64, D66 — built-in scheduled dump + file sync to a target (S3/local path); size check, stale alert (L79) |
| 19.6 | Restore | ✅ D64, D66 — a restore command into a new database with a verification drill (L78, L80) |
| 19.7 | Upgrades | ✅ D64, D66 — migrations run once before the new version serves; documented rollback limits |
| 19.8 | Reverse proxy & HTTPS | ✅ D31 — works over HTTP but detects it: persistent banner + docs (Caddy, Traefik, Tailscale certs, Cloudflare Tunnel); capture falls back to file upload |
| 19.9 | Compose profiles | ✅ D85 (delegated) — optional Ollama profile in Compose |
| 19.10 | Distribution channels | ✅ D85 (delegated) — Unraid, TrueNAS, CasaOS/Umbrel app templates — where self-hosters find apps |
| 19.11 | Helm chart defaults | ✅ D85, D186 — Recreate with local files (RollingUpdate only with S3 or a shared volume); startup and readiness probes, preStop sleep, migration hook; backups run in the worker (L97) |
| 19.12 | Update check | ✅ D65 — opt-in |
| 19.13 | Secret-key recovery kit | ✅ D66 |
| 19.14 | Backups with S3 file storage | ✅ D144 (delegated) — restic covers DB + manifest; bucket versioning required; restore drill checks hashes |
| 19.15 | Register of assumptions | ✅ D145 — product design §19; 33 items, each with a check and a build step |

## 20 · Testing & quality

| # | Question | Status / proposed default |
|---|---|---|
| 20.1 | Layers | ✅ D86 (delegated) — unit (Vitest), integration against real Postgres, end-to-end (Playwright, phone + desktop viewports) |
| 20.2 | Tenancy leak tests | ✅ D86 (delegated) — schema-wide RLS/view test + two-tenant scenario tests (L28) |
| 20.3 | MCP contract tests | ✅ D86 (delegated) — every tool: permission, output size, error shape |
| 20.4 | AI | ✅ D86 (delegated) — eval corpus + mock provider (4.16) |
| 20.5 | Timezone | ✅ D86 (delegated) — tests pin a non-UTC zone (L3) |
| 20.6 | Prod-config CI run | ✅ D86 (delegated) — second run with production-only settings (L90) |
| 20.7 | Visual regression | ✅ D86, D130 (delegated) — Playwright screenshots of key screens in light, dark and RTL |
| 20.8 | Offline sync tests | ✅ D86 (delegated) — queue → sync → idempotent replay |

## 21 · CI/CD & release

| # | Question | Status / proposed default |
|---|---|---|
| 21.1 | CI | ✅ D87 (delegated) — GitHub Actions; a local script that mirrors it (L104) |
| 21.2 | Versioning | ✅ D87 (delegated) — semver; conventional commits; generated changelog |
| 21.3 | Release order | ✅ D87 (delegated) — checks → image push (multi-arch) → verify `/version` → tag → Helm chart (L101) |
| 21.4 | Registries | ✅ D87 (delegated) — GHCR, mirrored to Docker Hub (1.x per D130) |
| 21.5 | Supply chain | ✅ D87 (delegated) — cosign signatures, SBOM |
| 21.6 | Helm repo | ✅ D87 (delegated) — OCI chart on GHCR |
| 21.7 | Cadence | ✅ D87 (delegated) — a minor release monthly, patches as needed |

## 22 · Open-source project & community

| # | Question | Status / proposed default |
|---|---|---|
| 22.1 | Contribution sign-off | ✅ D105, superseded 2026-10-07: the DCO, checked by `scripts/check-dco.sh` — see the decision log |
| 22.2 | Repo docs | ✅ D88 (delegated) — README, CONTRIBUTING (additive migrations, tests), CODE_OF_CONDUCT, SECURITY, issue/PR templates |
| 22.3 | Docs site | ✅ D102 (delegated, verified) — see the decision log |
| 22.4 | Demo instance | ✅ D88 (delegated) — public, seeded, reset nightly |
| 22.5 | Translations | ✅ D88, D106 (delegated) — Weblate; English and Arabic at launch |
| 22.6 | Community space | ✅ D88 (delegated) — GitHub Discussions only at launch |
| 22.7 | Public roadmap | ✅ D88 (delegated) — GitHub Projects |
| 22.8 | Governance | ✅ D88 (delegated) — maintainer-led for now |
| 22.9 | AGPL source-code offer | ✅ D147 — Source code link to the running version's exact source |
| 22.10 | Dependency licences | ✅ D151 — CI allowlist; AGPL/GPL/SSPL/BUSL rejected; third-party notices per release |
| 22.11 | Seed data & docs content | ✅ D152 |
| 22.12 | No AI attribution in history | ✅ D173 — commits, authors, co-author trailers, PRs, tags, release notes; enforced in CI |

## 23 · Cloud / SaaS

| # | Question | Status / proposed default |
|---|---|---|
| 23.1 | Who pays | ✅ D6 — the owner account; members free |
| 23.2 | Plans & limits | ⏭ D91 — plan prices and limits, in the cloud phase |
| 23.3 | Billing provider | ✅ D103 (delegated, verified) — see the decision log |
| 23.4 | Managed AI | ✅ D72 — per-plan quotas; bring-your-own-key always allowed |
| 23.5 | Hosting & region | ⏭ D91 — hosting provider and region, in the cloud phase |
| 23.6 | Email deliverability | ⏭ D91 — transactional email provider, in the cloud phase |
| 23.7 | Legal | ⏭ D91 — terms, privacy policy, DPA (needs a lawyer), in the cloud phase |
| 23.8 | Status page & support | ⏭ D91 — status page and support tooling, in the cloud phase |
| 23.9 | Abuse | ⏭ D91 — abuse controls beyond D72, designed in the cloud phase |
| 23.10 | Feature parity | ✅ D70 — full parity; cloud sells convenience only |
| 23.11 | Limits never trap data | ✅ D72 |

## 24 · Launch & growth

| # | Question | Status / proposed default |
|---|---|---|
| 24.1 | Domain | ⏭ D109 — not registering one for now (the maintainer's call, 2026-09-25) |
| 24.2 | Trademark check on "Kept" | ✅ D109 — collisions accepted knowingly; a trademark opinion for classes 9/42 before the cloud launch |
| 24.3 | Landing page | ✅ D89 (delegated) — the landing page lives on the docs site (D102) |
| 24.4 | Listings | ✅ D89 (delegated) — awesome-selfhosted, selfh.st, r/selfhosted launch post, Homebox Discussions (importer) |
| 24.5 | Demo video | ✅ D89 (delegated) — 60 s: capture a shelf, review, ask "where is X", log an odometer photo |

## 25 · Non-goals

✅ D90 (delegated):
- **Not a business tool:** no business asset management (check-out, bookings, depreciation schedules).
- **No money or project features:** no accounting or budgeting, and no home renovation/project management.
- **Not a pantry:** no grocery or food inventory. Grocy does that.
- **No native mobile apps before 1.0:** the PWA covers it.
- **No marketplace and no social sharing** of inventories.

---

## Audit fixes (2026-09-26)

| # | Question | Status |
|---|---|---|
| A.1 | Concurrent edits; revoked data on phones | ✅ D156 |
| A.2 | Hostile uploads and imports (SVG, zip-slip, bombs, PDFs) | ✅ D157 |
| A.3 | Claim day: valuations, incidents, stolen/destroyed, the insurance report, claim packs | ✅ D158 |
| A.4 | Readable off-site copy; offline values and documents by opt-in | ✅ D159 |
| A.5 | Place operations (trash, re-parent, merge, convert, label, fields) | ✅ D160 |
| A.6 | Cross-account moves; splitting a household | ✅ D161 |
| A.7 | Trash and deletion cascades; deleting a mistaken original; schedule anchors | ✅ D162 |
| A.8 | What the AI provider receives | ✅ D163 |
| A.9 | Access ending properly; managed-account resets | ✅ D164 |
| A.10 | Recovery, backup codes, admin tools, `kept admin` CLI, successor | ✅ D165 |
| A.11 | Job policies, failed jobs, pool sizing, admin alerts | ✅ D166 |
| A.12 | AI cost in money, usage per user, multi-owner billing | ✅ D167 |
| A.13 | Currencies beyond the five | ✅ D168 |
| A.14 | CSV injection; export the current list | ✅ D169 |
| A.15 | LubeLogger import, missed fill-up, service stock, video | ✅ D170 |
| A.16 | Renters, landlords, elderly parents | ✅ D171 |
| A.17 | Minor fixes (digits in search, bidi, offline ops, MCP outputs, webhooks, role rows, renewals, field changes, brand logos, rate limits, SSRF, share pages, takedown, label cap) | ✅ D172 |

## Swarm fixes (2026-09-26)

| # | Area | Status |
|---|---|---|
| S.1 | Screens and navigation | ✅ D174 — [screens spec](2026-09-26-kept-screens.md) |
| S.2 | Interaction rules and form validation | ✅ D175 |
| S.3 | Sign-in and account-linking hijack | ✅ D176 |
| S.4 | Cross-location leaks through the account | ✅ D177 |
| S.5 | Fail-closed database roles and RLS | ✅ D178 |
| S.6 | Prompt injection across locations | ✅ D179 |
| S.7 | Revocation completeness; instance-admin transparency | ✅ D180 |
| S.8 | Devices, plain HTTP, OAuth, tokens in URLs | ✅ D181 |
| S.9 | Key lifecycle and recovery kit | ✅ D182 |
| S.10 | Data-model integrity | ✅ D183 |
| S.11 | Engineering foundations (sync, audit, modules, API, inbox, auth) | ✅ D184 |
| S.12 | Build order, dev, tests, CI, migrations | ✅ D185 |
| S.13 | Self-hosting contract | ✅ D186 |
| S.14 | Release and project process | ✅ D187 |
| S.15 | Remaining lessons | ✅ D188 |

## Final review (2026-09-26)

Three reviewers read every document before build step 1.

| # | Area | Status |
|---|---|---|
| F.1 | Build-start blockers: roles, account creation, pg-boss, setup code, two-factor gate, step-1 sequencing, spike order | ✅ D190 |
| F.2 | Presets around what households own; outcome copy on preset cards; AI settings layout | ✅ D191 |
| F.3 | Smart-device fields | ✅ D192 |
| F.4 | First run: generated keys, HTTPS first, invite QR, recovery-kit timing | ✅ D193 |
| F.5 | New-location wizard and a findable first capture | ✅ D194 |
| F.6 | Small delights | ✅ D195 |
| F.7 | Receipt camera copy | ✅ D196 |
| F.8 | Better Auth and pg-boss under non-owner roles | 🔬 V33, spike S1 (D190) |
| F.9 | Personal renamed "On me" and hidden until used; the UI drops "location" for the kind word (home, garage, storage) | ⛔ the maintainer's call; nothing renamed |

## Before 1.0: scope advice — maintainer decides

**Advice from the final review, not a decision.** Nothing here changes scope until the maintainer
decides; the full build stands (D130).

**Estimate** (one developer, full time, about 35 focused hours a week):

| Step | Weeks |
|---|---|
| 1 · Foundation | 5–7 |
| 2 · Core inventory | 7–9 |
| 3 · Capture | 8–11 |
| 4 · Household modules | 7–9 |
| 5 · Vehicles | 3–4 |
| 6 · Assistant and MCP | 6–8 |
| 7 · Portability | 4–6 |
| 8 · Operations | 4–6 |
| **Total** | **44–60** (about 2 years at half time) |

**Suggested milestone:** a "0.x household alpha" after step 3, deployed to the maintainer's homelab.

**Candidates to move to 1.x** (the full build stays; only the order changes). Together they save
roughly 10–14 weeks:
- generic OIDC;
- the OAuth connectors (D125), since personal tokens cover "MCP with tokens";
- incidents, claim packs and valuations (D158), keeping the insurance report;
- the calendar feed (D142);
- place merge and convert-to-container (D160);
- share-into and gallery import (D140);
- the driver.js hints and tour, keeping the checklist;
- owner successor (D165) and the instance-admin transparency emails (D180);
- webhooks and Shortcuts;
- the Homebox API path for pre-v0.26 servers, keeping the ZIP path;
- the Helm chart and the Starlight site, keeping docs in the repo;
- three-way field merge, replaced by whole-row "keep mine / keep theirs";
- the AI cost machinery beyond one instance key plus a token budget (D121, D167);
- type-tree inheritance with impact previews (D12, D92), keeping flat custom types with icons and
  fields;
- the finer secret-policy detail (named people, the per-field AI flag, versioned secrets);
- offline blank-label claims, offline box check and offline create-area (D112, D172);
- the in-app restic UI with S3 versioning checks (D64, D144), keeping a nightly dump plus files and
  restic as a documented sidecar.

**Top risks:**

| # | Risk | Mitigation |
|---|---|---|
| 1 | One developer's time is shared with four other apps | The 1.x candidates above; the 0.x alpha |
| 2 | Better Auth's fit and churn | Spikes S1–S3 (V14, V32, V33) before step 1 |
| 3 | RLS cost on a Pi | Benchmark 10k things in step 2. ✅ Done 2026-09-27 on the laptop under Pi-class limits ([docs/perf/2026-09-26-rls-bench.md](../perf/2026-09-26-rls-bench.md)): helpers run once per statement; search fixed by migration 0030. A run on a 2 GB, 2-vCPU VM is still due before 1.0 (V5, D209) |
| 4 | iOS PWA unknowns | Test on real devices during step 2 |
| 5 | Arabic and multi-currency AI extraction quality | Start collecting real receipts now |
| 6 | MCP and CIMD churn | Pin the SDK; contract tests (D86) |
| 7 | Young libraries: the aria base, Drizzle 1.0, Serwist | Spikes S0 and S4; V16, V17 |
| 8 | CI on a private repo, given the Actions billing history | The local CI mirror is the gate; run the arm64 smoke test on the Apple Silicon laptop |
| 9 | The test matrix growing | Cap visual regression at about 10 screens |
| 10 | Spec drift | Check the spec delta at the start of each step |

**Open naming question (the maintainer's call):** Personal becoming "On me", hidden until used; and
"location" in the UI becoming the kind word (home, garage, storage). Not applied.

## UI audits (maintainer request, 2026-09-26)

A short, whole-app look at the interface. It checks the app against itself and against the
design board, not against the spec. It is written to `docs/audits/ui-<date>.md` as a list of
fixes, each with a severity.

**When**
- **First audit:** at the end of build step 3, once capture, inbox, labels and scan exist.
- **Second audit:** before 1.0.
- Plus any time the maintainer asks.

**What it covers**
- **Consistency:** spacing, type scale, buttons, sheets vs dialogs, empty/error/loading states,
  icons, and wording (D86 voice). It also covers "Off in this location" and hidden-control
  rules (screens §3).
- **Navigation:** the sidebar, the collapsed rail (D198), the tab bar, breadcrumbs, and ⌘K. Back
  and deep links behave as expected.
- **Phones:** 375 px and 390 px, with nothing trimmed to "…". Checked on the installed PWA's short
  viewport and under the iOS 26 header blur.
- **Arabic and RTL:** mirroring, bidi isolation of user text, Eastern digits, and untranslated
  strings.
- **Accessibility:** keyboard paths, focus order, target sizes (44 px), contrast in both themes,
  reduced motion, and screen-reader names (axe on every route).
- **Performance feel:** first load, route changes, long lists (10k things), and the bundle size.

**How**
1. Screenshot every route at phone, tablet and desktop, in light, dark and Arabic.
2. Run axe and a Playwright keyboard walk.
3. One reviewer pass.
4. Fixes land as a batch, and the audit file records what changed.

## Session log

| Date | Areas | Decisions |
|---|---|---|
| 2026-09-25 | Research; all 12 stories; modules; theme + logo; feature gaps; remaining areas decided by delegation; rename to Kept; full review | D1–D73 confirmed · D74–D107 delegated · D108–D109 name (maintainer) · D110–D130 review fixes (delegated) · D131–D135 design session, logo chosen · D136 currencies · D137 labels & scan · D138 onboarding · D139–D145 gap fixes + assumptions register · D146 Homebox import verified against source · D147–D152 gap fixes · D153 private device location · D154–D172 type library, home paperwork, systematic audit fixes · D173 no AI attribution · D174–D188 five-agent audit fixes · D189 design pass (56 screens) |
| 2026-09-26 | Final pre-build review (3 reviewers): D190–D196, V33, coherence fixes, scope advice recorded | D190–D196 delegated · V33 added · coherence fixes across the docs · scope advice and the naming question recorded for the maintainer |
| 2026-09-26 | Maintainer requests during the build: the collapsed sidebar, docs hosting, semantic search, the inventory report, AI providers and models | D198 icon rail (built: step 2 task 29b) · D199 docs on GitHub Pages · D200 semantic search into 1.0 (step 6) · D201 inventory report as a generated PDF (step 2 tasks 31–32, V34) · D202 named AI providers and a model picker (step 3 tasks 8, 9, 29); all delegated |
| 2026-09-26 | Maintainer request: be open about AI use and cost, keep an audit log of every AI call, let users cap AI spend, and say whether AI is per account, per location or per instance | D206 AI keys, usage, spend limits and the AI call ledger (delegated; refines D19, D121, D167, D191, D202): keys at instance, owner account or user, never per location; Groq `qwen/qwen3.8-27b` recommended; `llm_calls` with no prompts, images, replies or keys, 13 months; versioned price table; caps per instance, account, location, person and personal key with 80%/100% warnings and Resume now; "What uses AI in Kept", the AI line, usage pages with CSV. Product design §8a, V35–V37; engineering spec §3.5, §7.15; screens §5, §10; step-3 plan tasks 5, 6, 8, 9, 10, 29 and new 29a |
