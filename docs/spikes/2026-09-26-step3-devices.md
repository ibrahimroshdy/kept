# Step 3: the device and credentials checklist

Written 2026-09-26 (step-3 plan, Task 0); made runnable 2026-09-29 (Task 32). **Not run yet on a
device: every Result cell is empty.** L50 has partial results for Groq and OpenRouter
(2026-09-26).

The build never waits for these. Every row already ships its fallback (the "In use now" column);
a result either confirms the device-preferred path or keeps the fallback (plan, "Needs the
maintainer's real iPhone"). What you paste back is the Diagnostics report and, where a row asks,
one line of what you saw.

## Before you start (once)

1. **Kept over HTTPS on your LAN or tailnet.** Plain HTTP turns off the camera, install and
   location on a phone (D31). Follow README → "Testing on a phone (HTTPS)" (Tailscale, or
   mkcert with its root installed and trusted on each phone). `KEPT_PUBLIC_URL` must be the HTTPS
   address the phones open.
2. **Seed it:** `pnpm --filter @kept/server kept admin seed --scenario households` on a fresh
   database. Sign in as `ibrahim@kept.test` (password `kept-seed-password`). For the AI rows,
   paste a Groq key in Settings → AI.
3. **Print one A4 sheet of labels** from a desktop: Garage › Tool wall → Select → tick the three
   things → Print labels → "A4 sheet · 24 labels" → Print, then "Yes, printed OK". Print a blank
   sheet too (Labels → Garage → "Blank sheet (24)"). The rows below scan these.
4. **The devices:** your iPhone (and an older one if you have it, for V12) and an Android phone.
   Write each model and OS version once, at the top of its report.
5. **Two ways on each phone:** in the browser (Safari; Chrome on Android) **and** installed.
   iPhone: Share → Add to Home Screen, then open Kept from the icon. Android: Chrome's menu →
   Install app. Rows marked *installed* need the icon; *both* needs a result from each.

## The Diagnostics report (first, on each phone and each way)

Settings → **Diagnostics** → **Run the checks** (the camera check asks for permission: allow
it) → **Copy report**. Paste each report under "Reports" at the end of this file, labelled
`<phone>, <OS>, browser|installed`. Nothing is sent anywhere; the report is text you copy.

Each line answers *Works*, *Doesn't work* or *For information*, with facts:

| Diagnostics line | Facts | Rows it answers |
|---|---|---|
| Secure connection (HTTPS) | `protocol` | all (must be Works) |
| Opened as the installed app | `display-mode` | tells browser from installed |
| Offline support (service worker) | whether a worker controls the page | Offline, Update |
| Storage kept by the phone | `persisted`, `usage`, `quota` | V11 |
| Saving on this device | an IndexedDB round trip | Offline |
| Barcode scanner | `native` and its formats, the wasm decode's timings | V12, T0 |
| Camera | `best` resolution, `facing` | Cam |
| iPhone photos (HEIC) | `decoded` size | V10 |
| Location permission | `permission` | V30 |
| Print page sizes | `page-rule` | Print |

## The checks

"Paste" is the one line the row asks for; the Diagnostics report (once per phone and way) goes
under Reports. A row passes when "Pass when" holds.

| # | Device, way | What to do | Paste | Pass when | In use now (the fallback) | Result |
|---|---|---|---|---|---|---|
| V6 | iPhone | Close Kept. Point the **system Camera** app at a thing's label from the A4 sheet; tap the banner | Which app opened (Safari or Kept), and whether the thing showed after sign-in | Safari opens `/l/<code>` and shows the thing (after sign-in if asked) | `/l/<code>` works in Safari with sign-in; Scan in Kept is the main path (D137); Help says "use Scan in Kept" | |
| V7 | Android | As V6, with the system camera (or Google Lens) | Which app opened | The installed app or the browser opens the thing | As V6 | |
| V9 | iPhone, installed | In Photos, Share a photo; look for Kept in the share sheet | Is Kept there? (expected: no) | Kept is absent, and Capture → Gallery adds the photo instead | The manifest `share_target` (Android only); Help and the install sheet say to save it, then use Gallery in Capture | |
| V9a | Android, installed | Share a photo from the gallery app to Kept | What Kept showed | Kept opens Capture with the shared photo offered | As V9 | |
| V10 | iPhone, both | Capture → Gallery → pick an iPhone camera photo (HEIC) | Whether the capture shows a preview or "Preview unavailable" | A preview appears (Diagnostics "iPhone photos (HEIC)" Works) | "Preview unavailable" (D36); the original still uploads as evidence | Diagnostics: HEIC decodes on iPhone 16 Pro, iOS 18.7, installed (2026-09-29). Capture preview not tried yet |
| V11 | iPhone and Android, installed | Capture one photo, then run Diagnostics | "Storage kept by the phone" `persisted=` | `persisted=true` | The sync line warns that iOS may clear the phone's copy; the queue syncs on every open | **Fails** on iPhone 16 Pro, installed: `persisted=false` (quota 39 GB, 2026-09-29). The fallback stays in use |
| V12 | iPhone (an older one if you have it), both | Scan → point at a label on the A4 sheet from 20–30 cm | Roughly how long until the thing opened (at once, about 1 s, several s) | Opens within about a second (Diagnostics "Barcode scanner" timings) | 8 fps on a downscaled frame; "Type the code" is always there. A slower setting (4 fps, 640 px) exists but isn't wired until this says it's needed | iPhone 16 Pro, installed: wasm first read 3 ms, then 1 ms a frame (Diagnostics, 2026-09-29). Scan by hand, and an older iPhone, not tried yet |
| T0 | iPhone, Safari and installed | As V12 | Did anything decode? | The scanner decodes under Kept's CSP (`'wasm-unsafe-eval'`); Diagnostics "Barcode scanner" Works | Manual entry only, on a device where it doesn't | Passes on iPhone 16 Pro, installed: no native detector; the wasm scanner reads under the CSP (2026-09-29) |
| V30 | iPhone and Android, installed | Capture → the place chip → turn on "Suggest where I am"; answer the prompt | Whether the prompt appeared once and read sensibly | The prompt appears once and "Location permission" says granted. (No screen sets a location's position yet, so whether it suggests the right place can't be checked in step 3) | Opt-in; compared on the phone only; the chip keeps the last place otherwise | |
| Cam | iPhone, installed | Open Capture, close Kept completely (swipe it away), open it again, open Capture | Did it ask for the camera again? | The permission is kept across launches, and Diagnostics "Camera" `best` is at least 1920 wide | "Use the system camera" (full sensor, file input) is always offered for Receipt, Label and Reading | iPhone 16 Pro, installed: `best=4032x2160` (at least 1920 wide: passes). Keeping the permission across launches not tried yet |
| Print | iPhone | Labels → Recent batches → the A4 batch → Print → AirPrint, or Save as PDF | Did each label land in its cell? | A4, 100%, each label in its cell | The PNG path for thermal printers; A4 sheets from a desktop | |
| Share PNG | iPhone and Android | Print labels on "50 × 30 mm roll" → "Share as images" → a label-printer app (Niimbot, Brother iPrint) if you have one | Did the app receive the PNGs? | The printer app opens with the labels | Download the PNGs, save them to Photos, print from the app | |
| Update | iPhone and Android, installed | Open Capture and take a photo. On the dev machine, rebuild the web app (`pnpm --filter @kept/web build`). On the phone, stay in Capture a minute, then press Done | When "A new version is ready · Reload" appeared: during capture, or only after Done | Never during capture; offered after Done; Reload keeps the queue | Upload-idle gating (T23; e2e `step3-update.spec.ts` passes in desktop Chromium). If it misbehaves: show the prompt only at the next cold start | |
| Offline | iPhone and Android, installed | Open Kept online once. Airplane mode on **with Kept open**; capture three things into a room. Then quit Kept and open it again, still offline | What Capture's counter and the sync line said; what the cold start showed | Captures save offline with "ID pending" (as in e2e), and the cold start opens Kept from the phone, saying "as of last sync" (fixed in 440dd38; e2e "a cold reload while offline…" passes in desktop Chromium) | The queue survives and syncs when the connection is back | |
| Style | iPhone, installed | Only with a Mac at hand: iPhone Settings → Safari → Advanced → Web Inspector on; on the Mac, Safari → Develop → the iPhone → Kept → Console. Open a sheet (Capture → the place chip) | Any "Refused to apply a stylesheet" line | None. React Aria's `usePreventScroll` style is allowed by hash (`apps/server/src/http/csp-styles.ts`), unverified in real WebKit | Without it a nested list may scroll the page behind the sheet; nothing breaks | |
| Touch | iPhone | Open a box's Box check (Garage › Shelf B › Box 7) and tap a thing's checkbox | Did one tap tick it? | One tap ticks it (a tap failed under Chromium's touch emulation in T26) | Tap the row's name instead | |
| V18 | iPhone with VoiceOver (and NVDA on Windows if available) | Help → "Show me around"; and a first-use hint (open Scan for the first time) | Did VoiceOver read the hint as a dialog with its title? Could you reach "Got it"? Did focus go back to the control? | All three | T31's hint wrapper (RTL flip, focus return); react-joyride is the fallback library | |

## The step-3 walkthrough on a phone (Definition of done)

On a fresh `docker compose up`, seeded with `households`, over HTTPS, on the installed app. Tick
each, or write what happened instead:

- [ ] Install the app.
- [ ] Airplane mode on (with Kept open): capture three things with photos into a room; each shows
      "ID pending" in Capture's summary, and Search finds them on the phone ("On this phone ·
      as of last sync", 1d371ab).
- [ ] Airplane mode off: the IDs appear, AI names them (with the Groq key), the Inbox holds them.
- [ ] On a desktop, accept them with the keyboard (`x` selects, `j` moves, `Shift+A` accepts),
      then Undo from the toast.
- [ ] Print their labels on an A4 sheet from a start cell; "Yes, printed OK".
- [ ] Scan a label: the thing opens and its history says you saw it.
- [ ] Scan a blank label and claim it as a new box.
- [ ] Scan a random QR code, and a product barcode.
- [ ] A receipt with `$` asks USD or CAD.
- [ ] A reading that doesn't fit lands in the inbox.
- [ ] Import a spreadsheet with place paths (Settings → Import).
- [ ] Box-check a box, and move five things with the carrying tray.
- [ ] Without an AI key, the same captures wait in the inbox as unnamed photos.

## Credentials and real data (not a phone, but blocked on the maintainer)

| # | Check | Needs | In use now | If it fails | Result | Date |
|---|---|---|---|---|---|---|
| L50 | Structured output **together with an image** from each provider: `openai`, `anthropic`, `google`, and an Ollama `openai-compatible` URL with `supportsStructuredOutputs` true and false. Run `docs/spikes/code/step3/server/ai-providers.spike.ts` (its header has the commands); results go in `2026-09-26-step3-ai-sdk.md` | The maintainer's API keys and an Ollama host, set as environment variables, **never committed** | The mock provider in CI; "Test connection" records what each model supports (T9, D188) | Per-provider notes in AI settings; a provider without structured-plus-image falls back as T9 decides | **Groq: done.** `qwen/qwen3.8-27b` returns structured output with an image, using `json_schema` with `strictJsonSchema: false`; strict mode gives a 400, and JSON mode drops the schema. **OpenRouter: blocked.** The listing works, but the key's credit limit is $0 (paid models 403) and the `:free` vision models return 429 from a shared upstream pool. Rerun after raising the limit. OpenAI, Anthropic, Google and Ollama: pending (no keys). Details in `2026-09-26-step3-ai-sdk.md`, "Real providers" | 2026-09-26 (Groq, OpenRouter) |
| V1, V3, V37 | Vision models read seven-segment odometers, Arabic receipts and Egyptian registration cards; Groq's model is the cheapest reliable one | **30 or more of the maintainer's real photos**, labelled as `apps/server/eval/README.md` says, in a folder outside Git; then `KEPT_EVAL_DIR=<folder> KEPT_EVAL_API_KEY=<key> pnpm eval:extraction --provider groq --model qwen/qwen3.8-27b --gap-ms 65000` | The eval harness, the mock run in CI, versioned prompts; READING always waits for review (D19) | Per-provider notes in AI settings ("readings: confirm by hand") | **Synthetic set, 2026-09-29: V1 and V3 fail** (the odometer read as 0.97; the Arabic registration card came back empty); receipts 17/18 with `receipt-required` (`docs/evals/`). Real photos: pending | 2026-09-29 (synthetic) |
| V35 | OpenRouter's reported cost matches its bill | Raise the key's credit limit, use it for a month, compare the ledger with OpenRouter's activity page | A provider-reported cost wins over the price table | Price-table costs for OpenRouter | Blocked ($0 credit) | |

## Reports

Paste each Diagnostics report here, one block per phone and way.

```
<phone>, <OS>, browser|installed, <date>
(paste)
```

```
iPhone 16 Pro, iOS 18.7, installed, 2026-09-29 (over Tailscale HTTPS to the Mac)
Kept diagnostics · 2026-09-29T20:04:31.199Z
Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1

✓ Secure connection (HTTPS): protocol=https
✓ Opened as the installed app: display-mode=standalone ios-standalone
✓ Offline support (service worker): active=activated waiting=no controlled=yes
· Storage kept by the phone: persisted=false usage=8.4 MB quota=39321.6 MB
✓ Saving on this device: roundtrip=true
✓ Barcode scanner: native=no wasm=reads first=3ms frame=1ms
✓ Camera: best=4032x2160 facing=environment
✓ iPhone photos (HEIC): decoded=16x16
· Location permission: permission=prompt
· Print page sizes: page-rule=yes
```
