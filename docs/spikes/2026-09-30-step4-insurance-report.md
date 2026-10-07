# Spike: the insurance report in Typst (step 4, T0; D158, D201, §2.8)

Date: 2026-09-30. Step-4 plan, Task 0. Result: **passes.** The insurance layout is a second
template on the D201 engine, rendered by its existing child process
(`apps/server/src/reports/render/child.mjs`) with no engine change. 500 things with photos render
in 0.4–0.7 s at a peak of 138–145 MB, well under the 512 MB child limit (`RENDER_MEMORY_MB`).
English and Arabic both lay out correctly.

Code: `docs/spikes/code/step4/insurance/`. `insurance.typ` is the template, copied from
`reports/template/report.typ` and cut to the insurance layout. `run.ts` builds synthetic data,
renders through `child.mjs` and samples memory. Nothing was merged into `apps/`. To reproduce:

```sh
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
cd apps/server && pnpm exec tsx ../../docs/spikes/code/step4/insurance/run.ts [dir to copy the 60-thing PDFs to]
```

## The layout (what T18's template carries over)

- **Header:**
  - the title and the scope (the location);
  - **"As of <date>"** (Q20: the date picks each thing's valuation and labels the report);
  - who made it.
- **Incident header**, when the report is for one: its kind, date, police and insurer references,
  on a danger-tinted block.
- **Totals block:**
  - **one total per currency**, always;
  - a **converted total** ("In EGP: …") only when every pair has a rate on or before the as-of
    date (Q21). `convert()` from `@kept/shared` is used, never estimated.
- **Per place:**
  - a sticky place heading (the path, isolated per step as in the inventory report) and a
    sticky column header;
  - then one unbreakable row per thing:
    - a 13 mm thumbnail;
    - the name, brand · model, and serial (Plex Mono, left to right);
    - the purchase date and price;
    - the **current value**, with its valuation date;
    - the **receipt count**;
  - a **subtotal per currency** under each place.
- **Footer:** the instance and "Page n of N" in the reader's digits.

All money and dates arrive formatted, from `formatMoney()`, `Intl` and `convert()`, as in the
inventory report. No formatting happens in Typst. Arabic sets `dir: rtl`: the columns mirror, the
serials stay LTR, and Eastern digits run throughout.

## Measurements

Each figure is the child process's wall time, the PDF size, and its peak resident memory sampled
every 20 ms with `ps`. That is how `render.ts` samples off Linux; the spike ran on macOS arm64.
Every thing has a 200 px JPEG thumbnail, as the report's gather step makes them.

| Things | Language | Incident | Time | Peak RSS | PDF |
|---|---|---|---|---|---|
| 60 | English | yes | 488 ms (first, cold) | 86 MB | 157 KB |
| 60 | Arabic | yes | 175 ms | 87 MB | 183 KB |
| 500 | English | no | 407 ms | 145 MB | 1,044 KB |
| 500 | Arabic | no | 640 ms | 138 MB | 1,202 KB |

- **Memory.** Under a third of the 512 MB limit. The V34 inventory report measured 248–278 MB for
  500 things on Linux, with QR codes as well.
- **Size.** 60 things fill 6 pages at 8 rows a page; 500 things need about 63.
- **Time.** Well inside the 60 s limit. T18 needs no new limits.

## For T18

- `src/reports/template/insurance.typ` beside `report.typ`. `render.ts`'s `renderPdf()` currently
  hard-codes `TEMPLATE`; it gains a template argument (`'inventory' | 'insurance'`, matching
  `REPORT_KINDS`), and `build-assets.ts` copies the new file into `dist/`.
- The view builder formats every string in the reader's language and digits, like
  `reports/view.ts`. The spike's `run.ts` shows the fields the template reads (`asOfLine`,
  `incident: {title, lines} | null`, `totals`, `converted`, `places[].totals`, and per thing
  `photo`, `name`, `brand`, `model`, `serial`, `purchasedOn`, `price`, `value`, `valuedOn`,
  `receipts`).
- Incidents and claim packs are owner and admin only (§7.1 `incidents.manage`). Money is gated
  as in the inventory report; since the insurance report is mostly money, refusing it outright
  to a reader who can't see money is simpler than a report of blanks (proposed, T18 decides).
- The CSV twin (§2.8) is written by the same view with the D172 CSV rules. The spike didn't render
  it, as it is plain text.
