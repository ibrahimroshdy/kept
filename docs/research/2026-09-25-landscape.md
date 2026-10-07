# Landscape research — 2026-09-25

What already exists for home inventory and vehicle tracking, verified against each project's
repository, docs or store listing on 2026-09-25. Anything inferred rather than observed is
marked *(inferred)*. Reddit could not be searched from the research tools, so sentiment
below comes from GitHub issues, App Store reviews and Hacker News.

## Open-source / self-hosted

| Project | License · stack | Activity | What it has | What it lacks |
|---|---|---|---|---|
| **Homebox** (sysadminsmedia fork) · github.com/sysadminsmedia/homebox | AGPL-3.0 · Go, SQLite/Postgres, Nuxt *(frontend inferred)* | v0.26.2 (2026-06-14), commits to 2026-09-23, 7.4k★ | Collections (one user in several); v0.26 merged items and locations into one "entity" type; entity types; tags with icons; custom field templates; barcode lookup; QR labels; ZIP export/import; API keys | No viewer role (only owner/user); no vehicles; no built-in AI; MCP only as an unmerged read-only PR (#1485); warranty alerts an open PR (#1586); recurring maintenance is its most-requested open issue (#172) |
| Homebox (original) · github.com/hay-kot/homebox | AGPL-3.0 · Go | **Archived**; last release v0.10.3 (2024-01-04) | — | — |
| **Grocy** · github.com/grocy/grocy | MIT · PHP, SQLite | v4.7.1 (2026-09-04), 9.5k★ | Household ERP: stock, chores, batteries, equipment; REST API; barcode; PWA | No nested locations (#481, open since 2019); food-centric UI |
| **Snipe-IT** · github.com/grokability/snipe-it | AGPL-3.0 · Laravel | v8.7.2 (2026-08-19), 15.0k★ | Corporate IT assets: check-in/out, depreciation, licences, custom fields, labels, warranty alerts, maintenances API | Built for companies *(inferred)* |
| **Shelf.nu** · github.com/Shelf-nu/shelf.nu | AGPL-3.0 · React Router 7, Postgres via Supabase | shelf@2.2.1 (2026-09-23), 3.0k★ | Hierarchical locations; Owner/Admin/Base/Self-Service roles; workspaces; custom fields; kits; reminders; QR; CSV; bookings | Needs an external Supabase; self-host sign-up bugs (#2789, #2242); mobile app can't reach self-hosted instances (#2713); vehicles have no mileage log |
| **InvenTree** · github.com/inventree/InvenTree | MIT · Django | 1.5.5 (2026-09-17), 7.6k★ | Parts, stock locations, BOMs; official read-only MCP plugin (inventree/inventree-mcp) | Organised around parts and suppliers, not households |
| **Part-DB** · github.com/Part-DB/Part-DB-server | AGPL-3.0 · Symfony | v2.18.0 (2026-09-20), 1.8k★ | **Built-in MCP** (read-only in v2.14 → OAuth, usable as a claude.ai connector, in v2.15 → write tools in v2.16); OpenAI-compatible AI extractor | Electronics parts, not households — but it is **the bar for MCP in this space** |
| **Attic** · github.com/lmmendes/attic | MIT · Go, Postgres, Nuxt 4 | v2.7.0 (2026-09-21), 88★ | Nested locations; hierarchical categories whose fields are inherited; warranty on dashboard; OIDC; S3 | MCP and alerts are only feature requests (#87, #85) |
| **Nestarr** · github.com/tokendad/Nestarr | MIT · FastAPI, React | v8.1.2 (2026-09-09), 95★ | README claims roles, AI photo identification, warranty alerts, label printing | "Vehicle support" is an `is_vehicle` flag and one mileage field; release notes show brand "ford" auto-converted items to vehicles |
| **homebox-companion** · github.com/Duelion/homebox-companion | GPL-3.0 | v3.1.1 (2026-09-21), 387★ | Photo → AI catalogues into Homebox (LiteLLM, BYO key); AI chat | An add-on, not an app |

Community MCP servers exist for Homebox (e.g. dgahagan/homebox-mcp), Grocy
(saya6k/mcp-grocy-api and others) and Snipe-IT (jameshgordy/snipeit-mcp). None for Shelf.

### Vehicles

| Project | Notes |
|---|---|
| **LubeLogger** · github.com/hargata/lubelog | MIT · .NET, LiteDB/Postgres · v1.7.3 (2026-09-12), 2.9k★. Reminders by date, odometer, or whichever first; households with Viewer/Editor/Manager; OIDC; REST with role-scoped keys; attachments. **Official MCP** (hargata/lubelog_mcp, experimental) adds odometer records from dashboard photos and service records from invoices. Odometer photos are generic attachments, not required proof. Vehicles only. |
| **Hammond** · github.com/akhilrex/hammond | AGPL-3.0 · Go. Last push 2023-01-30; effectively dead. |

## Commercial / consumer

| App | Model | Notes |
|---|---|---|
| Sortly | Business inventory; free = 100 items, 1 user; roles from $149/mo; API on Enterprise | Complaints: per-item pricing, price rises, no human support |
| HomeZada | Free / $99 / $189 per year | Up to 3 properties on top plan; AI photo and video recognition; rated 2.9 — support, refunds, broken reports |
| Itemtopia | Free / $79.99 per year | Multiple locations, permissions on Premium, receipt forwarding |
| Under My Roof (iOS) | $34.99/yr | Multiple homes; iCloud sharing view/edit; "Automobiles" category with VIN; Apple Intelligence photo/receipt analysis; LiDAR room scan |
| MovingBox | Free AI recognition, no item cap; Pro adds multi-item photos | Reads brand/model/serial from photos |
| Club of Things | Free, local-first | Gemini auto-fill; **read-only MCP** for ChatGPT/Claude/Codex |
| Encircle | — | **Consumer app discontinued Dec 2025** |
| Centriq | — | **Shut down 2026-01-31**; CSV export excluded photos, receipts and documents |
| **stowly.app / stowlyapp.com** | Home inventory with barcode scanning, © 2026 WAGMI LLC, "coming soon to the App Store" | Found during the name check; same name as this project's former working title "Stowly" |
| **getstowly.app** | Home-inventory web app with paid Plus / Pro plans | Found during the name check; same name as this project's former working title "Stowly" |
| CARFAX Car Care, Drivvo, Simply Auto, Fuelly | Vehicle apps | Reminders by date or mileage are common; reading the odometer from a photo is rare in consumer apps |

## Table stakes (2026)

- **Things:** photos per item; nested locations and containers.
- **Purchase and warranty:** purchase, price and warranty with expiry reminders; receipts and manuals attached.
- **Capture:** barcode and QR labels; **AI recognition from a photo**, including brand, model and serial, now common and sometimes free.
- **Finding and sharing:** search; family sharing; offline use.
- **Getting data out:** PDF insurance report; CSV export.

## Differentiators nobody combines

1. Home inventory **and** vehicles (real mileage log, reminders by time or mileage) in one app.
2. Per-location roles including a **viewer**.
3. A built-in multi-provider assistant **and** a first-party MCP server with write tools.
4. Warranty expiry alerts and recurring maintenance for household items.
5. Odometer photo as structured proof, checked against the entered value.
6. Custom types with icons **and** per-type fields, polished.
7. Full export including files, or self-hosting — the answer to the shutdowns.

## Why people abandon these apps

1. **Entering the data takes too long.** "The biggest problem wasn't the lack of software… but putting everything in the app and then keeping it up" (Hacker News). Only 47% of US homeowners have an inventory (Triple-I).
2. **The records go stale** after the first pass *(inferred from the "keeping it up" comments)*.
3. **A video walkthrough feels good enough** for insurance.
4. **Fear the app shuts down** and takes the data with it.
5. **Privacy**: no wish to hand a company a list of what's in your home.
6. **Pricing** per item or per seat.
7. **Too many features**, and clumsy data entry.

## Name check (2026-09-25)

"Stowly" is taken for this purpose:
- **A US trademark:** STOWLY, reg. 8166630, live, class 20 (furniture, storage boxes), registered 2026-03-10.
- **Two home-inventory products:** stowly.app and getstowly.app (above).
- **Domains:** stowly.com, .app, .dev and .io are all registered.

The project was renamed **Kept** (product design D109). Kept has its own collisions, accepted knowingly; see D109.

The naming research also found more home-inventory products:
- **Apps:** *Kept: Home Inventory* (iOS), *homeshelf* (iOS), *Where is it kept?* (iOS), *Cubby – Home Inventory* (iOS), TallyHouse (desktop).
- **Open-source projects:** HomeIndex (connervieira/HomeIndex), HomeCatalogue (self-hosted, AI), HomeTory (evertsmits).

## Sources

Repositories listed in the tables were loaded directly on 2026-09-25. Commercial sources:
[Sortly pricing](https://www.sortly.com/pricing/) ·
[HomeZada pricing](https://www.homezada.com/homeowners/pricing) ·
[Under My Roof FAQ](https://binaryformations.com/support/under-my-roof-faq/) ·
[Club of Things](https://clubofthings.app/) ·
[MovingBox](https://apps.apple.com/us/app/movingbox-ai-home-inventory/id6742755218) ·
[Encircle](https://apps.apple.com/us/app/encircle/id604527488) ·
[Drivvo FAQ](https://www.drivvo.com/en-US/faq/) ·
[Triple-I facts](https://www.iii.org/fact-statistic/facts-statistics-homeowners-and-renters-insurance) ·
[HN: HomeSheet](https://news.ycombinator.com/item?id=30919445) ·
[HN: pantry tracking](https://news.ycombinator.com/item?id=36671992) ·
[DIYProject on Centriq](https://diyproject.ai/compare/centriq)

Technical sources for the stack decisions:
[MCP 2026-07-28 specification](https://blog.modelcontextprotocol.io/posts/2026-07-28/) ·
[MCP transports (SSE deprecated)](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports) ·
[MCP Go SDK](https://github.com/modelcontextprotocol/go-sdk) ·
[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) ·
[Claude custom connectors (connect from Anthropic's cloud)](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) ·
[AI SDK providers](https://ai-sdk.dev/providers/ai-sdk-providers) ·
[Seven-segment OCR limits](https://github.com/OICWS/lcd-digit-recognition) ·
[Hierarchies in Postgres: adjacency vs ltree vs closure](https://dev.to/dowerdev/implementing-hierarchical-data-structures-in-postgresql-ltree-vs-adjacency-list-vs-closure-table-2jpb)
