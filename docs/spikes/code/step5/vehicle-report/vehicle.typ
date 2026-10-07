// SPIKE (step 5, T0, V39). A vehicle history report on the step-2 Typst path, to measure the photo
// load: rendered by apps/server/src/reports/render/child.mjs exactly as the inventory report is
// (data at /data.json, photos at /thumbs/<name>.jpg). Conventions are report.typ's: weights by
// family name, `dir: rtl` for Arabic, IDs and the VIN left-to-right in Plex Mono (D143), the
// numbering pattern follows the digits, data is only inserted as text.
#let d = json("/data.json")
#let L = d.labels
#let isrtl = d.dir == "rtl"
#let c = (
  paper: rgb("#F2F1EC"), surface: rgb("#FBFAF7"), sunken: rgb("#ECEAE4"), line: rgb("#DEDBD3"),
  ink: rgb("#1C1B19"), ink2: rgb("#55524C"), ink3: rgb("#6B675F"), amber: rgb("#F0B03A"),
  amber-ink: rgb("#2E2100"),
)
#let sans = if isrtl { ("IBM Plex Sans Arabic", "IBM Plex Sans") } else { ("IBM Plex Sans", "IBM Plex Sans Arabic") }
#let mono = "IBM Plex Mono"
#let sfx = (w) => if w == 600 { " SmBld" } else if w == 500 { " Medm" } else { "" }
#let W(w) = sans.map(f => f + sfx(w))
#let numpat = if d.digits == "arab" { "١" } else { "1" }

#set document(title: L.title + " — " + d.vehicle.name, author: "Kept")
#set text(font: sans, size: 9pt, fill: c.ink, lang: d.lang, dir: if isrtl { rtl } else { ltr }, hyphenate: false)
#set par(leading: 0.6em)

#let tape(width: 150pt) = box(width: width, height: width * 40 / 146, fill: c.amber, radius: 4pt,
  place(horizon + left, dx: width * 7 / 146, circle(radius: width * 3 / 146, fill: c.surface))
  + align(center + horizon, text(font: mono + " SmBld", size: width * 24 / 146, tracking: width * 5 / 146, fill: c.amber-ink, dir: ltr, "KEPT")))
// The plate: its own right-to-left island, whatever the report's language, so the letters keep
// the order they are printed in and the digits stay on their side.
#let plate(p) = box(stroke: 1.2pt + c.ink, radius: 3pt, inset: (x: 3mm, y: 1.5mm),
  text(font: ("IBM Plex Sans Arabic SmBld",), size: 14pt, dir: rtl, p))
// The VIN: left-to-right in Plex Mono, isolated in a box so bidi can't reorder it.
#let vin(v) = box(text(font: mono, size: 10pt, dir: ltr, v))

// ---- Cover.
#page(paper: "a4", margin: (x: 22mm, y: 28mm), fill: c.paper, footer: none)[
  #set align(if isrtl { right } else { left })
  #tape()
  #v(18mm)
  #text(size: 30pt, font: W(600), L.title)
  #v(2mm)
  #text(size: 15pt, font: W(500), fill: c.ink2, d.vehicle.name) \
  #text(fill: c.ink3, d.generatedLine)
  #v(10mm)
  #grid(columns: (auto, 1fr), column-gutter: 5mm, row-gutter: 3.5mm, align: horizon,
    text(fill: c.ink3, L.plate), plate(d.vehicle.plate),
    text(fill: c.ink3, L.vin), vin(d.vehicle.vin),
    text(fill: c.ink3, L.year), text(d.vehicle.year),
    text(fill: c.ink3, L.odometer), text(font: W(600), d.vehicle.odometer),
  )
  #v(10mm)
  #grid(columns: (1fr, 1fr), gutter: 4mm,
    ..d.counts.map(((n, l)) =>
      block(width: 100%, fill: c.surface, stroke: 1pt + c.line, radius: 6pt, inset: 5mm,
        text(size: 20pt, font: W(600), n) + linebreak() + text(size: 8.5pt, fill: c.ink3, l))))
  #v(1fr)
  #line(length: 100%, stroke: 1pt + c.line)
  #text(size: 8pt, fill: c.ink3, L.confidential)
]

#set page(paper: "a4", margin: (top: 16mm, x: 14mm, bottom: 18mm), numbering: numpat,
  footer: context {
    set text(size: 7.5pt)
    grid(columns: (1fr, auto),
      text(fill: c.ink3, d.footer),
      text(font: W(500), fill: c.ink2, L.page + " " + counter(page).display(numpat) + " " + L.of + " "
        + numbering(numpat, counter(page).final().first())))
  })
#show heading.where(level: 2): it => block(sticky: true, above: 5mm, below: 3mm, text(size: 13pt, font: W(600), it.body))
#let th(s) = text(font: W(600), size: 8pt, fill: c.ink2, s)
#let tbl(cols, head, rows) = table(columns: cols, stroke: (x: none, y: 0.6pt + c.line), inset: (x: 1.5mm, y: 1.6mm),
  align: (x, y) => if x == 0 { start + horizon } else { end + horizon },
  table.header(..head.map(th)), ..rows)

// ---- Odometer readings, then the proof photos.
== #L.readings
#tbl((1fr, 1fr, 1fr, 12mm), (L.date, L.reading, L.source, L.proof),
  d.readings.map(r => (r.date, r.value, r.source, r.proof)).flatten())

== #L.proofs
#grid(columns: (1fr,) * 5, gutter: 3mm,
  ..d.proofs.map(p => block(breakable: false, width: 100%, {
    box(clip: true, radius: 3pt, image(p.photo, width: 100%, height: 30mm, fit: "cover"))
    v(1mm)
    text(size: 7.5pt, font: W(600), p.value)
    linebreak()
    text(size: 7pt, fill: c.ink3, p.date)
  })))
#if d.proofsMore != "" [#v(2mm) #text(fill: c.ink3, d.proofsMore)]

// ---- Services, each with its lines and its invoice photos.
#pagebreak()
== #L.services
#for s in d.services {
  block(breakable: false, width: 100%, inset: (y: 2.5mm), stroke: (bottom: 1pt + c.line), {
    grid(columns: (1fr, auto), text(size: 10pt, font: W(600), s.date + " · " + s.odometer), text(font: W(600), s.total))
    text(size: 8pt, fill: c.ink2, s.vendor)
    v(1.5mm)
    grid(columns: (1fr, auto), column-gutter: 4mm,
      tbl((1fr, 10mm, 24mm), (L.item, L.qty, L.amount), s.lines.map(l => (l.name, l.qty, l.amount)).flatten()),
      s.photos.map(p => box(clip: true, radius: 3pt, image(p, width: 18mm, height: 18mm, fit: "cover"))).join(h(1.5mm)))
  })
}

// ---- Fuel: the years, then every fill.
#pagebreak()
== #L.fuel
#tbl((1fr, 1fr, 1fr, 1fr), (L.yearCol, L.litres, L.cost, L.per100),
  d.fuelYears.map(y => (y.year, y.litres, y.cost, y.per100)).flatten())
#v(4mm)
#tbl((1fr, 1fr, 16mm, 1fr, 14mm, 16mm), (L.date, L.odometer, L.litres, L.cost, "", L.per100),
  d.fills.map(f => (f.date, f.odometer, f.litres, f.cost, f.kind, f.per100)).flatten())

// ---- Documents.
== #L.documents
#tbl((1fr, 1fr, 1fr, 1fr), (L.documents, L.issued, L.expires, L.cost),
  d.documents.map(x => (x.name, x.issued, x.expires, x.cost)).flatten())
