# Spike V39: the vehicle history report's photo load on Typst

Date: 2026-09-30. Step-5 plan, Task 0. Result: **passes without a cap.** Five years of one car (60
services with 3 invoice thumbnails each, 600 fills, 860 readings of which 200 have a proof photo)
renders in English and in Arabic in 1–4 s. Its peak is about 300 MB of Linux RSS inside Kept's
image under a hard 512 MB limit, and 196–309 MB (macOS RSS) on the laptop. The Arabic plate keeps
its printed order and the VIN stays left to right.

The fail path, capping proof photos at 60, was measured anyway, and **it barely helps**. It saved
18–23 MB, because the photos are not what drives memory: the rows are. Ten years of the same car
(every count doubled, 104 pages) peaked at **507 MB** in the image, a hair under the 512 MB limit.
T15's report therefore needs a bound on rows, not on photos (see "Change to the plan").

Code: `docs/spikes/code/step5/vehicle-report/`:
- `make-data.mjs` writes a job directory as `reports/service.ts` does: `data.json` and
  `thumbs/*.jpg`, 200 px JPEG q72 mozjpeg from the server's own sharp, with Intl-formatted strings;
- `vehicle.typ` is the template;
- `run.mjs` runs the render on the laptop;
- `container-run.mjs` runs it in the image.

Measurements are in `results/runs-2026-09-30.jsonl`, and the cover renders in `results/`. The job
directories were deleted after the run (the laptop's disk was full). Nothing was merged into
`apps/`. To reproduce:

```sh
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
cd docs/spikes/code/step5/vehicle-report          # needs `magick` and poppler (pdfinfo, pdftotext)
node make-data.mjs ar 200 .tmp/ar-200             # [proofCap]; SCALE=2 doubles every count
node run.mjs .tmp/ar-200
DOCKER_CONFIG=/tmp/kept-docker-config docker run --rm --memory 512m --memory-swap 512m --cpus 2 \
  -v "$PWD:/spike:ro" --entrypoint node kept:ci-arm64 /spike/container-run.mjs /spike/.tmp/ar-200
```

## The path it ran on

This is the step-2 report engine unchanged: `apps/server/src/reports/render/child.mjs` (in the
image, `dist/reports/render/child.mjs`), started as `render.ts` starts it:
- `--max-old-space-size=64`;
- no inherited environment;
- the fonts from `apps/server/assets/fonts`;
- data at `/data.json` and photos at `/thumbs/<name>.jpg` in the compiler's virtual file system.

Typst 0.14 runs through `@myriaddreamin/typst-ts-node-compiler` 0.7.0, and the thumbnails are
made with sharp 0.35.4. Only the template is new (`vehicle.typ`, on `report.typ`'s conventions):
- a cover with the plate, VIN, year and odometer;
- every reading in a table, then the 200 proof photos in a five-column grid;
- each service with its lines and its three invoice thumbnails;
- the fuel years, then every fill;
- the documents.

**The limit it must stay under** is read from `render.ts`: `RENDER_MEMORY_MB = 512` (sampled every
`POLL_MS = 100`) and `RENDER_TIMEOUT_MS = 60_000`.

The thumbnails are unique photo-like images (ImageMagick plasma with gaussian noise, and a
caption), about 7.4 KB each at 200 px: 380 of them, 2.8 MB in all.

## Results

| | Peak memory | Time | PDF |
|---|---|---|---|
| **English, 5 years**, in `kept:ci-arm64` (512 MB hard limit, 2 CPUs) | 300 / 297 MB child RSS (cgroup peak 269 / 266) | 10.3 s (cold), 1.9 s | 5.7 MB, 55 pages |
| **Arabic, 5 years**, same container | 302 / 307 MB (cgroup 272 / 278) | 2.9 s, 4.1 s | 6.0 MB, 55 pages |
| English, 5 years, laptop (macOS) | max RSS 196 / 285 / 212 MB; footprint 243–249 MB | 1.3–7.0 s | 5.7 MB |
| Arabic, 5 years, laptop | max RSS 309 / 202 / 208 MB; footprint 260–261 MB | 1.1–3.4 s | 6.0 MB |
| Proof photos capped at 60 (the fail path), Arabic, container | 284 MB (cgroup 248) | 3.3 s | 4.8 MB, 50 pages |
| **Ten years** (`SCALE=2`: 120 services, 1,200 fills, 1,720 readings, 400 proofs), Arabic, container | **507 MB** (cgroup 494) | 11.4 s | 11.9 MB, 104 pages |
| Ten years, laptop | max RSS 313 / 281 MB; footprint 464 / 453 MB | 5.4–7.7 s | 11.9 MB |
| 400 px thumbnails instead of 200, 5 years, laptop | max RSS 397–476 MB; footprint 412–422 MB | 0.7–2.1 s | 11.8–12.0 MB |

Times are wall-clock on a laptop shared with several other build agents, so they are noisy. The
slowest run was 11.4 s. Every run is far under the 60 s timeout.

**The pass conditions:**
- **Peak memory under the report job's limit (512 MB):** ✅ at five years. It is about 300 MB in
  the image, roughly the V34 figure for 500 things (280 MB).
- **The plate's Arabic letters shape and stay in printed order:** ✅ in both reports. The plate is
  typed as `س ع ط ٧٤٥١` (letters, then digits, in reading order). In the PDF, `pdftotext -bbox` puts
  س rightmost (x 452–468), then ع (440–448), then ط (425–436), with the digits leftmost (396–422)
  reading "٧٤٥١" left to right. That is the order on the physical plate. The English report gives
  the same order (س at 194–210 … digits at 138–165), because the plate is its own `dir: rtl` box
  there too (`results/*-plate-zoom-01.png`). Joined Arabic text ("سجل المركبة", "تويوتا كورولا")
  shapes correctly (`results/ar-cover-01.png`).
- **The VIN stays LTR:** ✅ It extracts as the single word `JTDBR32E720123456`, in order, in both
  languages. It is set in Plex Mono in a `dir: ltr` box (D143's rule for IDs).
- **Under 60 s on the laptop:** ✅ The laptop runs took 0.7–7.7 s. The slowest run anywhere was
  11.4 s (ten years, in the container).

## What drives memory

- **Photos are cheap at 200 px.** Dropping 140 of the 380 photos (the cap at 60) saved 18–23 MB
  of RSS in the image (Arabic: 302 / 307 → 284). That is roughly 0.15 MB a photo.
- **Photo size matters.** At 400 px (the stored thumbnail derivative) the laptop's peak footprint
  rose by about 160 MB and the PDF doubled. Keep `THUMB_PX = 200`.
- **Pages drive memory.** Doubling the rows took the image from about 300 MB to 507 MB: 55 → 104
  pages, of which the reading and fill tables are most. Typst holds the whole layout until the PDF
  is written.
- **Sampling misses peaks.** `render.ts` samples RSS every 100 ms. On the laptop, one Arabic run's
  samples topped out at 243 MB against a true maximum of 293 MB (`/usr/bin/time -l`). In
  production, the container's own memory limit is what actually stops a runaway. The 512 MB watch
  is a friendlier early stop, not a guarantee.
- **macOS is not the measure.** Its RSS moves around under load because it compresses pages. The
  laptop's max RSS varied 196–309 MB for the same job, while `peak memory footprint` stayed at
  243–261 MB. The Linux container figures are the ones to budget with, as in V34.

## Change to the plan (proposed)

The spike was harsher than T15's layout on purpose. It printed every fill as a row (600), where
T15's fuel section is a summary. T15's odometer history, though, prints "every accepted reading",
and at five years that is 860 rows. Of those, 660 are the readings that fills and services own.
That list grows with every fill, so it is what grows without bound.

- **T0's fail path is replaced.** "Cap proof photos at the latest 60" isn't needed at five years,
  and it wouldn't save a long history either. Instead, **T15 bounds the rows** (Q16):
  - The odometer history prints every reading that has a proof photo or was typed by hand.
    Otherwise it prints one reading a month, the latest. A fill's or a service's reading still
    shows in its own section (readings stay one series, D52; this is only the report's layout).
  - The fuel section stays a summary, as T15 has it: no fill-by-fill table.

  With those rules a ten-year car prints fewer rows than this spike's five-year car did (about 400
  proof readings plus 120 monthly ones, against 1,460 rows here). That it stays under the limit is
  **inferred** from the page counts, not measured.
- **Keep the 200 px thumbnails** that `reports/service.ts` already makes. Don't use the 400 px
  derivative, even for proof photos where the digits matter. At 30 mm printed, 200 px is about
  170 dpi, and the stored photo is one tap away in Kept.
- **Proof photos stay uncapped.** Q16's "capped by the T0 result" becomes a guard only: the latest
  200 (the measured load), with "N more in Kept".
