# Spike V38: visx charts in RTL

Date: 2026-09-30. Step-5 plan, Task 0. Result: **passes on visx.** The fail path (hand-drawn SVG
with `@visx/scale` only) is not needed; T18 and T21 use `@visx/*` 4.0.0. One rule comes with it:
**a chart's `<svg>` is `direction: ltr`, and RTL is drawn by geometry** (reversed ranges, the value
axis on the right). Left to inherit `direction: rtl`, visx's tick labels land on the plot.

Code: `docs/spikes/code/step5/charts/` (a standalone Vite app: `src/charts.tsx`,
`src/scale-only.tsx`, `src/pull.ts`, `measure.mjs`, `check.mjs`). Results and screenshots:
`docs/spikes/code/step5/charts/results/` (`check.json`, `ar-375.png`, `ar-desktop.png`,
`ar-naive.png`, `en-*.png`). Nothing was merged into `apps/`. To reproduce:

```sh
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
cd docs/spikes/code/step5/charts
npm ci && npx vite build && node measure.mjs && node check.mjs   # check.mjs serves on 4795
```

## Versions (checked with `npm view` on 2026-09-30)

| Package | Version | Licence | Peers and dependencies |
|---|---|---|---|
| `@visx/shape` | 4.0.0 | MIT | peer `react` and `@types/react` `^18.0.0 \|\| ^19.0.0`; deps `@visx/curve`, `@visx/group`, `@visx/scale`, `@visx/vendor` (all 4.0.0), `classnames` |
| `@visx/scale` | 4.0.0 | MIT | `@visx/vendor` 4.0.0 |
| `@visx/axis` | 4.0.0 | MIT | peer react; deps `@visx/group`, `point`, `scale`, `shape`, `text` (4.0.0), `classnames` |
| `@visx/group` | 4.0.0 | MIT | peer react; `classnames` |
| `@visx/tooltip` | 4.0.0 | MIT | peer `react`, `react-dom` and their types; deps `@visx/bounds` 4.0.0, `classnames`, `react-use-measure` |
| `@visx/responsive` | 4.0.0 | MIT | peer react |
| `@visx/vendor` (transitive) | 4.0.0 | "MIT and ISC" | pins `d3-array` 3.2.1, `d3-color` 3.1.0, `d3-delaunay` 6.0.2, `d3-format` 3.1.0, `d3-geo` 3.1.0, `d3-interpolate` 3.0.1, `d3-path` 3.1.0, `d3-scale` 4.0.2, `d3-shape` 3.2.0, `d3-time` 3.1.0, `d3-time-format` 4.1.0, `internmap` 2.0.3 (the d3 packages are ISC: `licences` must allow ISC) |

4.0.0 was published on 2026-06-11. The plan's table matches: every package is 4.0.0, MIT, with
the peers it lists. D133 chose visx 4.0.0 for this reason: Kept writes the SVG, so CSS-variable
colours (`var(--s1)`…), ARIA labels and RTL mirroring are in Kept's hands. The spike keeps D133's
three series slots (`--s1`, `--s2`, `--s3`), a legend for two or more series, hover and focus
tooltips, and a table view.

Built with the web app's own toolchain versions: React 19.3.0, Vite 8.3.1 (rolldown),
`@vitejs/plugin-react` 6.1.1, Vite's default build settings. Checked in Playwright 1.63.0's
Chromium.

## What was built

A page shaped like a vehicle's Costs tab: a scrolling `main` with the app's pull-to-refresh gesture
attached (`attachPull()` copied verbatim from `apps/web/src/components/pull-to-refresh.tsx` at
a010a9a). It loads the charts with `React.lazy`:

- **Costs by month:** `BarStack`, three series over six months (fuel, service and parts, fees and
  insurance), `scaleBand` for the months and `scaleLinear` for money, `AxisBottom` and
  `AxisLeft`/`AxisRight`, `TooltipWithBounds` with `useTooltip`, and `ParentSize` for the width.
- **Odometer:** `LinePath` for the readings and a second `LinePath` with `strokeDasharray="5 4"`
  from the last reading to the estimate, on `scaleUtc`.
- **"Show as table"** under each: a button with `aria-expanded`, and a table formatted by the same
  functions as the tooltips.
- **Formatting:** `Intl` in the reader's locale (`ar-EG` or `en-GB`). Ticks use the compact
  notation ("٢ ألف" / "2k") for money and grouped numbers for kilometres.

## Results (`results/check.json`, all passed)

| Pass condition | Result |
|---|---|
| **Arabic RTL: the time axis runs right to left** | ✅ Month label centres at 1280 px: April 1047 → September 127 (English: 172 → 1091). `scaleBand`, `scaleUtc` and `LinePath` take a reversed range (`[innerW, 0]`), and nothing else changes. The estimate point sits left of the last reading in Arabic and right of it in English |
| **Eastern digits from `Intl.NumberFormat('ar-EG')` in the ticks** | ✅ Every value tick has only Eastern digits: "٠", "٢ ألف" … "٨ آلاف"; "٨٤٬٠٠٠" … "٩٢٬٠٠٠". Month ticks are Arabic month names |
| **Every bar and point reachable by keyboard, with a tooltip on focus** | ✅ In both languages, all 12 visible cost segments and all 7 odometer points (6 readings and the estimate) were reached from the keyboard, each with its tooltip. Each chart is **one tab stop** (a roving `tabIndex`), and the next Tab goes to "Show as table". The arrow keys move the way they point on screen, so in Arabic ← is later in time. ↑ and ↓ move within a month's stack; Home and End go to the first and last mark. Zero amounts draw no bar, so they aren't stops; the table shows them |
| **"Show as table" gives the same numbers** | ✅ All 12 cost tooltips (the series amount and the month's total) and all 7 odometer tooltips match their table cells string for string. Example: "أبريل ٢٠٢٦. الوقود: ‏٢٬١٤٠ ج.م.‏. الإجمالي: ‏٢٬٥٢٠ ج.م.‏" |
| **Reduced motion: no transitions** | ✅ With `prefers-reduced-motion: reduce`, nothing in the charts has a transition or animation, and `document.getAnimations()` is empty. visx draws static SVG and animates nothing by itself. The only motion in the spike is the tooltip's 120 ms fade, and it exists only under `no-preference` (the control run shows it) |
| **The lazy chunk's gzip size (budget 60 KB)** | ✅ **30.4 KB** gzip level 9, measured as `check-bundle.mjs` measures (89 KB raw). That is the charts chunk (15.2 KB) plus the shared chunk it imports (15.9 KB, which is `@visx/scale`'s d3 plus the sample data). The fail path would have cost 16.4 KB. The entry chunk is unaffected: React stays in it, the charts don't |
| **A horizontal drag across the chart at 375 px doesn't arm pull to refresh** | ✅ Chromium at 375 × 812 with touch, driven by CDP touch events through the app's `attachPull()`. A right-to-left drag across the chart (3 px of vertical drift), a left-to-right drag, and a slanted drag (−240 px sideways, +40 px down) each gave **0** pull events, in both languages. The control, a vertical pull down on the chart, did arm (11 pull events, then a refresh), so the harness works. A tap on a bar focuses it and opens its tooltip. No sideways scroll at 375 px (the chart is 313 px wide inside the card) |

## The RTL trap: SVG text inherits `direction`

`text-anchor: start | end` is relative to the text's `direction`. That is a CSS property, and the
SVG inherits it from `<html dir="rtl">`. visx's axes set LTR anchors: `AxisLeft` uses `end`,
`AxisRight` uses `start`. With the page in Arabic and the value axis on the right, `start` puts
each label's right edge at the tick, so the label runs leftwards over the plot.
`?naive=1` measured this: 4 of the 5 labels overlapped the plot (plot edge 1166 px, labels from
1151 px; `results/ar-naive.png`). With `style={{ direction: 'ltr' }}` on the `<svg>`, anchors
mean left and right again, and the labels sit clear of the plot (from 1177 px). Arabic text inside
the SVG still shapes and orders correctly, because bidi works within each text run.

**Rule for T18 and T21:** every chart `<svg>` is `direction: ltr`. RTL is drawn by geometry: the
time scale's range is reversed and the value axis moves to the right. The HTML around the chart
(legend, tooltip, table) keeps the page's direction.

*Inferred, not observed in the app:* the existing AI usage day chart
(`apps/web/src/components/ai/usage-charts.tsx`) draws its tick labels with
`textAnchor={rtl ? 'start' : 'end'}` in an SVG that inherits `direction: rtl`. By the mechanism
measured here, its Arabic value labels would run into the bars. Worth checking on the usage page in
Arabic.

## Notes for T18 and T21

- **These are not the app's first charts** (the plan says they are). The AI usage page already has
  hand-drawn SVG charts (`components/ai/usage-charts.tsx`, D206). visx is the new dependency, but
  the design tokens `--s1`…`--s-other` and a "Show as a table" pattern (`AiDisclosure`) are already
  in the app, so reuse them.
- `TooltipWithBounds` positions itself with inline `left`/`top`, which are physical properties. It
  is library output, not Kept's CSS, so `check-logical-css` doesn't see it. Pass `unstyled` and
  `applyPositionStyle`, and style it with a class.
- `TooltipWithBounds` is a class component (a `withBoundingRects` HOC). It works on React 19.3.0
  with no warnings.
- Give each mark `role="img"` and an `aria-label` that says what the tooltip says. The tooltip
  itself is `aria-hidden`, and the `<svg>` is `role="group"` with a label that mentions the arrow
  keys.
- The odometer's first point sits on the value axis line in RTL. Pad the time domain a little in
  T18.
- The lazy chunk is precached by the service worker like every other JS file. 30 KB fits inside
  the precache budget's headroom (T0 of step 3 measured about 2.4 MB of the 3 MB budget).
- On real phones, "tooltips by tap, horizontal drags don't arm pull to refresh, VoiceOver reads
  the table" stays on the device checklist (`2026-09-30-step5-devices.md`). This spike ran in
  Chromium's touch emulation, not on a device.
