# Spike V34: the PDF engine for the inventory report (D201)

Date: 2026-09-26. Step-2 plan, Task 31. Result: **Typst passes and is chosen**, run in-process
through `@myriaddreamin/typst-ts-node-compiler` 0.7.0 (Typst 0.14.2), inside the main image, in a
child process started by the report job. All three candidates shape Arabic correctly. Contrary to
what D97 assumed, react-pdf 4.9.0 joins letters and orders bidi text correctly. It still loses on
diacritic placement, WebP, page-break control and speed at 500 things. Headless Chromium produces
the best output, but it costs about 325 MB of image and was OOM-killed at 500 things under a
512 MB limit.

Code: `docs/spikes/code/pdf/`. It is a throwaway npm project, outside the pnpm workspace, and
nothing was added to `apps/`. `node prepare.mjs` builds the untracked inputs (TTF fonts and
thumbnails), and `node render-{reactpdf,chromium,typst}.mjs [en|ar|all]` renders. Environment
switches: `SCALE=500`, `DIGITS=latn|arab`, `JPEG_ONLY=1`, `TAG=`. `container-bench.sh` and
`container-scale.sh` run the measurements in the arm64 image. Rendered samples are in
`docs/spikes/code/pdf/results/`: six PDFs (EN and AR per engine), a page strip per PDF, and
`arabic-shaping-zoom.png`, which shows the diacritics difference.

## Versions (checked with `npm view` and the GitHub API on 2026-09-26)

| Package | Version | Licence | Notes |
|---|---|---|---|
| `@react-pdf/renderer` | 4.9.0 | MIT | pdfkit 0.20.1, fontkit, textkit with `bidi-js`; React 19.3.0 |
| `playwright-core` | 1.63.0 | Apache-2.0 | Chrome Headless Shell 153.0.8010.12 (revision 1243) |
| `@myriaddreamin/typst-ts-node-compiler` | 0.7.0 | Apache-2.0 | napi-rs addon. `sys.version` reports **Typst 0.14.2**; the latest Typst is 0.15.1 (2026-07-17) |
| `qrcode` | 1.5.4 | MIT | SVG for Typst and Chromium, a PNG data URL for react-pdf |
| `@ibm/plex-sans` / `-sans-arabic` / `@ibm/plex-mono` | 1.1.0 / 1.1.0 / 2.5.0 | OFL-1.1 | complete (unsubset) WOFF/WOFF2, no TTF |
| `@fontsource/ibm-plex-*` (already in `apps/web`) | 5.3.0 | OFL-1.1 | WOFF/WOFF2 only, split into per-script subsets |

The npm package `typst` (0.10.0-8, typst-community) is a CLI wrapper on an old Typst and was not
used.

## Sample

The same data goes to every engine (`lib/data.mjs`). Strings, numbers and money are formatted
with `Intl` once, so the engines differ only in layout and shaping. The sample is one location,
6 places (paths up to 4 levels deep), 60 things, 30 JPEG thumbnails, a QR code per thing, Crockford
short IDs in Plex Mono, type, brand and model, serial and condition, and money in EGP, USD and EUR
with subtotals per place and totals per currency. Each PDF also has a cover with the Label-tape
wordmark, a table of contents with page numbers, and a footer showing "Page N of M".

- **Arabic names embed Latin text**, for example `تلفزيون Samsung TV 55 بوصة`.
- **Arabic uses Eastern digits by default** (`ar-EG-u-nu-arab`); a second run used Western digits
  (D143).
- **The last page is a shaping check:** lam-alef ligatures, harakat, tatweel, parentheses, a URL-like
  model number, a long mixed paragraph that wraps, and Arabic inside an English sentence.
- **The budget run:** `SCALE=500` gives 25 places × 20 things with 250 thumbnails, a third of
  them WebP.

Every page was rasterised with `pdftoppm` and inspected. Fonts were checked with `pdffonts` and
images with `pdfimages -list`.

## Results

### Correctness

| Criterion | react-pdf 4.9.0 | Chromium 153 (Playwright) | Typst 0.14.2 |
|---|---|---|---|
| Arabic joining, lam-alef ligatures | ✅ | ✅ | ✅ |
| Harakat (mark positioning) | ❌ In `عَلِيّ`, the fatha drifts onto the lam and the kasra is lost (`results/arabic-shaping-zoom.png`) | ✅ | ✅ |
| Mixed bidi (brand inside Arabic, wrapped paragraph, Arabic inside English) | ✅ | ✅ | ✅ |
| RTL layout | Manual: `flexDirection: 'row-reverse'` on every row | Automatic from `dir="rtl"` | Automatic: `grid` follows `text(dir: rtl)` |
| Eastern digits in page numbers and the TOC | ✅ (formatted with `Intl` in a `render` callback) | ✅ `counter(page, arabic-indic)` | ✅ numbering pattern `"١"` |
| Western digits option | ✅ | ✅ | ✅ |
| Fonts embedded and subset | ✅ only after stripping U+200F (see below) | ✅ | ✅ only when weights are chosen by family name (see below) |
| Photos | JPEG and PNG only; **WebP is silently dropped** (`Not valid image extension`) | JPEG kept as is; WebP decoded to lossless | JPEG kept as is; WebP decoded to lossless |
| TOC with page numbers | Two passes, reading `pageNumber` from a `render` callback | Two passes, reading the tagged PDF's outline back (`lib/pdf-outline.mjs`) | **Native**: `outline(target: heading.where(level: 2))` |
| Page breaks | `minPresenceAhead` left a heading orphaned; the heading has to be grouped with the first row in a `wrap: false` view | `break-after: avoid` works | Headings are `sticky` and rows `breakable: false`; works |
| Looks like Kept (tokens, Plex, tape wordmark, amber ID chips) | ✅ | ✅ | ✅ |
| Rendered the same on linux-arm64 as on macOS | ✅ | ✅ (identical, because the fonts are inlined) | ✅ |

Traps found:

- **react-pdf falls back to an unembedded Helvetica for U+200F.** `Intl` puts an RLM in front of
  Arabic money, and neither Plex font has a glyph for it. react-pdf runs its own bidi, so
  `render-reactpdf.mjs` strips U+200E, U+200F and U+061C first.
- **react-pdf SVG text takes font props, not `style`.** The props are `fontFamily`, `fontWeight`
  and so on. With `style`, the tape wordmark came out in Helvetica-Bold.
- **react-pdf `render` text needs a fixed width.** A `render` text has no content at layout time,
  so without one it overlaps its sibling.
- **Typst files the Medium and SemiBold TTFs under their legacy family names.** `text(font: "IBM
  Plex Sans", weight: 600)` silently rendered Regular, and `pdffonts` showed only Regular embedded.
  The fix is to ask for the family `"IBM Plex Sans SmBld"` (or `"… Medm"`). `report.typ` wraps this
  as `W(600)`. Both the typographic family (name ID 16) and the weight class are correct in the
  files, so this looks like Typst's family matching (inferred, not traced in its source).
- **Typst reads TTF/OTF only**, and the IBM and Fontsource packages ship only WOFF/WOFF2. WOFF 1.0
  is a lossless zlib container, so `lib/woff-to-ttf.mjs` (40 lines, `node:zlib`) restores the
  original sfnt bytes.
- **WebP cannot go into a PDF as it is.** Typst and Chromium both decode it to Flate-compressed raw
  pixels: about 78 KB per 200 px thumbnail, against about 3 KB for the JPEG. In the 500-thing run,
  84 WebP thumbnails made up 6.8 MB of Typst's 9.2 MB PDF. With the same thumbnails as JPEG, the
  PDF is 2.5 MB.
- **Chromium only writes an outline when the PDF is tagged:** `page.pdf({ outline: true, tagged:
  true })`. With `outline` alone, there is no outline.

### Cost (linux-arm64 container from `kept:dev`, node 24.21.0 on bookworm-slim, `--cpus 4`)

The container ran in Docker Desktop's VM on an Apple-silicon Mac under heavy load from other jobs.
Peak memory is the summed VmRSS of the process tree, sampled every 20 ms from `/proc`
(`measure.mjs`). For Chromium this overcounts pages its processes share. Each cell shows two runs.
No Pi was reachable, so Pi times are **not measured**.

| | react-pdf | Chromium | Typst |
|---|---|---|---|
| 60 things, EN then AR in one process: render ms | EN 1880 / 1521, AR 1299 / 1320 | EN 811 / 509, AR 549 / 495 (two passes each; launch 192 / 46) | EN 350 / 191, AR 144 / 141 |
| 60 things: peak RSS | 236 / 258 MB | 636 / 637 MB (7 processes) | **131 / 127 MB** |
| 500 things, AR: render ms | 37,806 / 34,293 | 5342 / 4368 | **1870 / 1476** |
| 500 things: peak RSS | 430 / 427 MB | 967 / 948 MB | **278 / 278 MB** |
| 500 things: PDF size | 1.7 MB (WebP dropped) | 10.2 MB | 9.2 MB (2.5 MB with JPEG only) |
| Under a hard 512 MB limit (`--memory 512m --memory-swap 512m`) | 500 things ✅ (331 MB, 42.5 s) | 60 things ✅; **500 things OOM-killed** (`oom_kill 4`) | 500 things ✅ (248 MB, 1.8 s) |
| Size added on linux-arm64 | 31 MB of JS (`node_modules` closure) | 269 MB headless shell + 42 MB of Debian libraries (Playwright's Debian 12 Chromium list, without xvfb or its font packages) + 14 MB `playwright-core` ≈ **325 MB** | 47 MB (the `linux-arm64-gnu` addon) + 1.9 MB of TTFs |
| arm64 | ✅ pure JS | ✅ Chrome for Testing arm64 build | ✅ prebuilt `linux-arm64-gnu` (and `-musl`) addon, ran in the container |
| Licence policy (D151) | ⚠️ `png-js` 2.0.0 has no `license` field in `package.json` (its LICENSE file is MIT), so pnpm would report it as unknown and `check-licences.mjs` would need an exception (inferred; not run through pnpm). Everything else is MIT, ISC, 0BSD or Apache-2.0 | ✅ `playwright-core` is Apache-2.0. The browser is a downloaded binary, outside the npm check | ✅ Apache-2.0 (Typst and typst.ts); fonts OFL-1.1 |

## Recommendation: Typst

These rule out the other two:

- **Chromium is too heavy for the Pi target.** It is the most faithful renderer, but it adds about
  325 MB of image, needs about 640 MB for 60 things, and was OOM-killed at 500 things under 512 MB.
  As a sidecar it is the D97 design that D201 replaces. It stays the fallback if Typst ever fails a
  script we need.
- **react-pdf is out on both correctness and cost.** It misplaces harakat, drops WebP silently,
  needs manual RTL mirroring and page-break grouping, and takes 34–42 s for 500 things.

Typst is correct on every Arabic check, has a native TOC and sticky headings, and needs about
130 MB for 60 things and about 280 MB for 500. It adds about 49 MB to the one image, and its
arm64 build is prebuilt.

### Exact setup for Task 32

- **Dependency:** `@myriaddreamin/typst-ts-node-compiler` **0.7.0**, pinned exactly. pnpm installs
  only the platform addon each image needs (`-linux-arm64-gnu` in the arm64 image,
  `-linux-x64-gnu` in the amd64 one; both are Apache-2.0, 49 MB and 52 MB unpacked). It has no install script.
- **Fonts, at build time.** Take the complete WOFF files from `@ibm/plex-sans@1.1.0`,
  `@ibm/plex-sans-arabic@1.1.0` and `@ibm/plex-mono@2.5.0`, as devDependencies. They have an
  `ibmtelemetry` postinstall, which pnpm leaves blocked because `allowBuilds` names esbuild only;
  keep it that way. Convert them with `woff-to-ttf.mjs` and ship eight TTFs in the image, about
  1.9 MB: Sans Regular, Medium and SemiBold; Sans Arabic Regular, Medium and SemiBold; Mono
  Regular and SemiBold.
- **API**, from `index-napi.d.ts`:

  ```js
  const compiler = NodeCompiler.create({ workspace: '/', fontArgs: [{ fontPaths: [FONT_DIR] }] });
  compiler.resetShadow();
  compiler.mapShadow('/data.json', Buffer.from(JSON.stringify(view)));   // strings pre-formatted
  compiler.mapShadow(`/thumbs/${id}.jpg`, jpegBuffer);                   // per thumbnail
  compiler.mapShadow(`/qr/${id}.svg`, Buffer.from(qrSvg));               // when QR is on
  const res = compiler.compile({ mainFileContent: TEMPLATE });           // report.typ
  if (res.hasError()) throw new Error(JSON.stringify(compiler.fetchDiagnostics(res.takeDiagnostics())));
  const pdf = compiler.pdf(res.result, { creationTimestamp: Math.floor(Date.now() / 1000) });
  compiler.evictCache(10);
  ```

  `fontBlobs` also exists in the type definitions, but only `fontPaths` was tested. Typst writes a
  tagged PDF by default (`pdfTags`), which suits T32's extracted-text tests; text extraction itself
  was not tried here.
- **Template rules**, all proven in `docs/spikes/code/pdf/report.typ`:
  - Choose weights by family name (`"IBM Plex Sans Arabic SmBld"`, `"… Medm"`), never with
    `weight:`.
  - Set `text(lang: "ar", dir: rtl)` for Arabic, with the font list
    `("IBM Plex Sans Arabic", "IBM Plex Sans")`. Keep short IDs and serials in
    `text(dir: ltr, font: "IBM Plex Mono…")`, as D143 requires.
  - Set `page(numbering: "١")` for Eastern digits and `"1"` for Western. This drives both the
    footer and the TOC.
  - Build the TOC with `outline(target: heading.where(level: 2))` and a `show outline.entry` rule.
    Make every place a level-2 heading.
  - Render rows as `block(breakable: false, grid(...))`. The grid mirrors itself in RTL.
  - Pass strings, money and dates in already formatted (`Intl`), so Kept's formatting stays in
    TypeScript.
  - Never write `#let rtl = …`: it shadows the `rtl` direction value.
- **Thumbnails: always JPEG.** The report job reads the display derivative and transcodes anything
  that isn't JPEG with sharp (200 px, q≈72) before `mapShadow`. WebP would otherwise cost about
  25× the space.
- **Run the render in a child process** (`child_process.fork` of a small render entry) started by
  the pg-boss `report` job, like the PDF-parse child in engineering spec §3.1b. The addon's memory
  sits outside V8, so a child is the only way to hand it back and bound it. Give the child a
  wall-clock timeout (60 s is ample: 500 things took under 2 s). On a Pi, allow for about 280 MB
  on top of the app's 400 MB idle target while a report renders.
- **Watch item:** typst.ts is on Typst 0.14.2 while Typst itself is on 0.15.1. If the addon ever
  lags badly or crashes, the drop-in alternative is the official static CLI
  (`typst-aarch64-unknown-linux-musl.tar.xz`, 16 MB compressed, Apache-2.0), fed the same
  template through `typst compile` with `--font-path` and the files in a temporary directory. The
  CLI and its exact flags were not tested in this spike.
