# Spike: SVG brand logos through sharp (step 4, T0; step-2 Q9, D157, D172)

Date: 2026-09-30. Step-4 plan, Task 0 and Q33. Result: **passes.** Stock `sharp` 0.35.4
rasterises an SVG to PNG. It makes no network request and reads no local file for anything the
SVG references, and a 4,000-element SVG takes about 70 ms. So T9 may accept SVG brand logos
**and keep only the PNG** it renders (Q33), with the limits below.

Code: `docs/spikes/code/step4/svg/run.mjs`. Nothing was merged into `apps/`. To reproduce:

```sh
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
node docs/spikes/code/step4/svg/run.mjs
```

## Versions

`sharp` 0.35.4, as `apps/server` already pins it. Its bundled libvips is 8.18.6 and its librsvg
2.62.91, both read from `sharp.versions`. `sharp.format.svg` is input only: file, buffer and
stream in, no output.

## What the docs say (`node_modules/sharp/lib/index.d.ts`)

- **`density`:** the DPI at which SVG and PDF render, from 1 to 100,000; 72 by default.
- **`limitInputPixels`:** refuses input over width × height, trusting the image's own
  dimensions. The default is 268,402,689 (0x3FFF²).
- **`unlimited`:** false by default; true would remove sharp's SVG and PNG memory safeguards.
  Never set it.
- **`svg: {stylesheet, highBitdepth}`:** nothing about fetching resources.

## Method

A local HTTP server records every request it receives. Each SVG below points its external
reference at that server (`http://127.0.0.1:<port>/…`), so any fetch would be counted, whatever
the host. Every render is `sharp(buffer, {limitInputPixels: 4096², density: 72}).resize(256, 256,
{fit: 'inside'}).png()`, from a **buffer**, as an upload arrives. The centre pixel shows whether
the referenced content was drawn.

| Case | Time | Requests | Result |
|---|---|---|---|
| Plain logo (a circle) | 22.7 ms (first call) | 0 | PNG 256×256, drawn |
| `<image href="http://…/img.png">` | 2.9 ms | 0 | PNG, image not drawn |
| `<image xlink:href="http://…">` | 2.2 ms | 0 | not drawn |
| `<use href="http://…/sprite.svg#a">` | 2.1 ms | 0 | not drawn |
| `<style>@import url("http://…/x.css")</style>` | 2.7 ms | 0 | not applied |
| `fill:url(http://…/grad.svg#g)` | 2.0 ms | 0 | not drawn |
| `<feImage href="http://…">` | 2.3 ms | 0 | not drawn |
| `<image href="file:///…/red.png">` (a real local file) | 2.0 ms | 0 | **not read** (centre stays white) |
| `<image href="red.png">` (relative) | 3.9 ms | 0 | not read |
| `<xi:include href="http://…">` | 2.6 ms | 0 | ignored |
| External entity `<!ENTITY ext SYSTEM "http://…">` | 2.1 ms | 0 | **refused**: "XML parse error … Entity 'ext…'" |
| Billion laughs (8 levels of 10) | 9.0 ms | 0 | **refused**: "Maximum entity …" |
| `width="100000" height="100000"` | 0.6 ms | 0 | **refused**: "Input image exceeds pixel limit" |
| 4,000 `<path>` elements (183 KB) | 71.7 ms cold; 68–75 ms warm | 0 | PNG, drawn |

**Every external reference was refused, and nothing was requested.** A render from a buffer has
no base URL, so librsvg loads no resource of any kind: remote, `file:` or relative. The two
entity attacks fail in the XML parser, and a huge canvas fails on `limitInputPixels` before any
rendering.

## For T9 (brand logos)

- **Accept.** `image/svg+xml` joins PNG, JPEG and WebP for the logo upload only. It is sniffed as
  for any upload (D157), capped at the upload size, and never in general attachments.
- **Render.**
  - Always from a buffer (never a path), with `limitInputPixels` (for example 4096 × 4096), the
    default `density`, and never `unlimited`.
  - To a PNG no larger than the logo's display size.
  - Inside the image-concurrency limiter, like any derivative.
- **Keep only the PNG** (Q33). The SVG bytes are not stored, so no SVG is ever served back to a
  browser, where its scripts or links would matter.
- **Fail closed.** A render error is a 415 `unsupported_media_type`, not a 500.
- **Cost.** About 70 ms for a 4,000-element SVG. That is under the 200 ms bar, and a logo is a
  one-off upload.

The spike ran on macOS arm64 (the laptop). The Pi's arm64 Linux image bundles the same
librsvg through sharp's prebuilt libvips, so the behaviour should be the same (inferred, not run
on the Pi); T9's tests run these cases in CI on the image's platform.
