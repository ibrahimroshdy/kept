# Step 7: the device, data and machine checklist

Written 2026-09-30 (step-7 plan, Task 0). **Nothing here has run: every Result cell is empty,
and every row is a maintainer check pending.** The build never waits for these. Each row already
ships its fallback ("Built meanwhile"); a result either confirms the preferred path or keeps the
fallback. From the plan's "Needs the maintainer's devices (and data)", plus the rows Task 0's
spikes added (marked *T0*).

| # | Check | How | Built meanwhile | If it fails | Result |
|---|---|---|---|---|---|
| H1 | **A real Homebox export**, if you run Homebox: the dry run and import on your data, and your printed Homebox labels scanned in Kept | Export each collection from Homebox (v0.26+: its collection export, or `POST /api/v1/group/exports`); import it in Kept (Settings → Import / export) on a test location; scan three old labels with the Kept scanner | The H1 fixtures from a local Homebox with synthetic data ([homebox spike](2026-09-30-step7-homebox.md)) | Issues become fixture cases and mapping fixes | |
| H1b *T0* | Your Homebox's **version and database**. The fixtures come from SQLite; a Postgres-backed Homebox writes booleans as true/false (inferred) | `GET /api/v1/status` (`build.version`), and `HBOX_DATABASE_DRIVER` in your Homebox's environment (default `sqlite3`) | `format.ts` accepts 0/1 and true/false | A new fixture from your export | |
| H1c *T0* | Homebox v0.26.x **exports once per restart** ("Topic has been Shutdown" on the second try) | Export two collections in a row | Kept's help says "restart Homebox and export again" | — | |
| V25 | Homebox's latest stable still matches D146 when T9 starts (v0.27.0-rc.1 exists on 2026-09-30) | GitHub releases; diff as the homebox spike did | The T0 diff; `entity_location_entities` accepted as optional | A changed table or field is a schema version branch in `format.ts` | |
| — | iPhone Safari downloads a 1 GB export ZIP into Files, and picks a `.zip` from Files in the import stepper | Export a large location; download on the phone; import it back on the phone | Desktop is the primary path for exports and imports | Help says "Export and import from a computer"; the phone path stays | |
| — | `readable/index.html` opens from Files on an iPhone with its thumbnails (relative links inside an unzipped folder) | Unzip the export in Files, open `readable/index.html` | `inventory.pdf` in the same folder opens anywhere | Help points iPhone readers to the PDF | |
| Z1 *T0* | **macOS Archive Utility opens a 2 GB export** (double-click in Finder). Not run in Task 0: the laptop's disk was too full to write 2 GB | Export a location with about 2 GB of photos; double-click the ZIP; also `unzip -t` in Terminal | yazl's archives pass `unzip -t` at 300 MiB; 2 GiB and 4.1 GiB streamed within 41 MiB ([archive spike](2026-09-30-step7-archive.md)) | Note the error; T7 tries `forceZip64Format` or no data descriptors for stored entries | |
| — | Excel (Windows and Mac), Numbers and LibreOffice open the CSVs with Arabic intact and no formula evaluated | Open `things.csv` from an export of بيت العائلة, and a list export | UTF-8 with BOM, CRLF, neutralised cells (T1) | Add a "for Excel" UTF-16 variant only if the BOM isn't enough | |
| E1 | The alias batch size on your Groq tier (V36: 1,000 output tokens a minute on the development tier) | Run enrichment after an import of 40+ things; read the AI calls list | Batches of 20, two aliases per language, `max_tokens` 900, no reasoning ([enrich spike](2026-09-30-step7-enrich.md)) | Smaller batches; enrichment stays opt-in with its estimate | |
| E1b *T0* | **Your call:** Arabic aliases from `qwen/qwen3.8-27b` were wrong or non-words about a third of the time. Accept them automatically, review them, or ask for one? | Read the enrich spike's quality table | Proposed: one Arabic alias per thing, shown for review; English auto-accepted | — | |
| V5 | Export and import at 10,000 things on a real 2 GB, 2-vCPU VM (D209) | The perf suite's portability step on the VM | The laptop under `--max-old-space-size=512` and the slower-core proxy | Lower chunk sizes and file concurrency; record it | |
| P1 *T0* | **The passphrase KDF on the same VM:** scrypt N = 2^16, r = 8, p = 1 under 1 s | `node docs/spikes/code/step7/p1_scrypt.mjs` on the VM | N = 2^16, parameters stored in each export's manifest ([passphrase spike](2026-09-30-step7-passphrase.md)) | Default becomes N = 2^15; old exports still open | |

## Reports

Paste results under each row's number, with the date, the device or machine, and its OS version.
