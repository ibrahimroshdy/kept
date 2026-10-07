// Kept's vehicle history report (D51, D201; step-5 plan T15), the third template on the D201
// engine, from the V39 spike (docs/spikes/code/step5/vehicle-report/vehicle.typ). Everything comes
// from /data.json (reports/vehicle/view.ts builds it): strings, money and dates arrive formatted
// in the reader's language and digits, so no formatting happens here. Photos are
// /thumbs/<id>.jpg (200 px JPEG, GPS-stripped derivatives), the short ID's QR /qr/<id>.svg. Data
// strings are only ever inserted as text, never evaluated as markup.
//
// report.typ's rules hold: weights by family name ("IBM Plex Sans SmBld"), `dir: rtl` for Arabic,
// the VIN and short ID left to right in Plex Mono (D143), the plate in its own box in the
// direction it is written in (the spike measured Arabic plates keeping their printed order), page
// numbers in the reader's digits, rows unbreakable, headings sticky, a contents page over the
// level-2 headings, and never `#let rtl = …`.
#let d = json("/data.json")
#let L = d.labels
#let isrtl = d.dir == "rtl"
// Design tokens (apps/web/src/styles/tokens.css, light theme: print is on paper).
#let c = (
  paper: rgb("#F2F1EC"), surface: rgb("#FBFAF7"), sunken: rgb("#ECEAE4"), line: rgb("#DEDBD3"),
  ink: rgb("#1C1B19"), ink2: rgb("#55524C"), ink3: rgb("#6B675F"), amber: rgb("#F0B03A"),
  amber-ink: rgb("#2E2100"), danger: rgb("#B42318"), dots: rgb("#A8A399"),
)
#let sans = if isrtl { ("IBM Plex Sans Arabic", "IBM Plex Sans") } else { ("IBM Plex Sans", "IBM Plex Sans Arabic") }
#let mono = "IBM Plex Mono"
#let sfx = (w) => if w == 600 { " SmBld" } else if w == 500 { " Medm" } else { "" }
#let W(w) = sans.map(f => f + sfx(w))
#let numpat = if d.digits == "arab" { "١" } else { "1" }

#set document(title: L.title + " — " + d.vehicle.name, author: "Kept")
#set text(font: sans, size: 9pt, fill: c.ink, lang: d.lang, dir: if isrtl { rtl } else { ltr }, hyphenate: false)
#set par(leading: 0.6em)

// Kept's lockup (D135): the label-tape mark with its punched hole (cut out, so the page shows
// through) and KEPT in Plex Mono SemiBold, as the outlines scripts/render-icons.mjs draws. A brand
// mark, so always laid out left-to-right.
#let lockup(height: 40pt) = box(image(bytes("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 191 64'><path d='M9 2H55A7 7 0 0 1 62 9V55A7 7 0 0 1 55 62H9A7 7 0 0 1 2 55V9A7 7 0 0 1 9 2ZM12 8.5A3.5 3.5 0 1 0 12 15.5A3.5 3.5 0 1 0 12 8.5Z' fill='#F0B03A' fill-rule='evenodd'/><path d='M277 306 204 210V0H73V698H204V384H210L291 500L438 698H586L367 404L596 0H448Z' fill='#2E2100' transform='translate(21.4 48) scale(0.042 -0.042)'/><g fill='#1C1B19'><path d='M277 306 204 210V0H73V698H204V384H210L291 500L438 698H586L367 404L596 0H448Z' transform='translate(74 48) scale(0.042 -0.042)'/><path d='M83 0V698H524V590H214V408H513V300H214V108H524V0Z' transform='translate(104.2 48) scale(0.042 -0.042)'/><path d='M80 0V698H345Q447 698 501 640Q555 582 555 482Q555 382 501 324Q447 266 345 266H211V0ZM211 373H318Q371 373 394 394.5Q417 416 417 463V501Q417 548 394 569.5Q371 591 318 591H211Z' transform='translate(134.4 48) scale(0.042 -0.042)'/><path d='M365 590V0H235V590H25V698H575V590Z' transform='translate(164.6 48) scale(0.042 -0.042)'/></g></svg>"), format: "svg", height: height))
#let chip(id) = box(fill: c.amber, radius: 3pt, inset: (x: 4pt, y: 3pt),
  text(font: mono + " SmBld", size: 9pt, tracking: 0.6pt, fill: c.amber-ink, dir: ltr, id))
// The plate: its own island, in the direction it is written in, so its letters keep their order.
#let plate(p, dir) = box(stroke: 1.2pt + c.ink, radius: 3pt, inset: (x: 3mm, y: 1.5mm),
  text(font: ("IBM Plex Sans Arabic SmBld", "IBM Plex Sans SmBld"), size: 13pt, dir: if dir == "rtl" { rtl } else { ltr }, p))
#let vin(v) = box(text(font: mono, size: 10pt, dir: ltr, v))

// ---- Cover.
#page(paper: "a4", margin: (x: 22mm, y: 28mm), fill: c.paper, footer: none)[
  #set align(if isrtl { right } else { left })
  #lockup()
  #v(16mm)
  #text(size: 30pt, font: W(600), L.title)
  #v(2mm)
  #text(size: 15pt, font: W(500), fill: c.ink2, d.vehicle.name)
  #if d.vehicle.status != "" [#h(2mm) #text(size: 10pt, fill: c.danger, d.vehicle.status)]
  \
  #text(fill: c.ink3, d.asOfLine) \
  #if d.rangeLine != "" [#text(fill: c.ink3, d.rangeLine) \ ]
  #text(fill: c.ink3, d.generatedLine)
  #v(8mm)
  #grid(columns: (1fr, auto), column-gutter: 6mm, align: top,
    grid(columns: (auto, 1fr), column-gutter: 5mm, row-gutter: 3.5mm, align: horizon,
      ..(
        if d.vehicle.type != "" { (text(fill: c.ink3, L.cover.type), text(d.vehicle.type)) } else { () }
        + if d.vehicle.shortId != "" { (text(fill: c.ink3, L.cover.shortId), chip(d.vehicle.shortId)) } else { () }
        + if d.vehicle.plate != "" { (text(fill: c.ink3, L.cover.plate), plate(d.vehicle.plate, d.vehicle.plateDir)) } else { () }
        + if d.vehicle.vin != "" { (text(fill: c.ink3, L.cover.vin), vin(d.vehicle.vin)) } else { () }
        + (text(fill: c.ink3, L.cover.location), text(d.vehicle.location))
        + if d.vehicle.odometer != "" { (text(fill: c.ink3, L.cover.odometer), text(font: W(600), d.vehicle.odometer)) } else { () }
      )),
    {
      if d.photo != none { box(clip: true, radius: 6pt, image(d.photo, width: 34mm, height: 34mm, fit: "cover")) }
      if d.qr != none { v(3mm); image(d.qr, width: 22mm) }
    })
  #v(10mm)
  #grid(columns: (1fr, 1fr), gutter: 4mm,
    ..d.counts.map(((n, l)) =>
      block(width: 100%, fill: c.surface, stroke: 1pt + c.line, radius: 6pt, inset: 5mm,
        text(size: 20pt, font: W(600), n) + linebreak() + text(size: 8.5pt, fill: c.ink3, l))))
  #if d.moneyNote != "" [#v(4mm) #text(size: 8pt, fill: c.ink3, d.moneyNote)]
  #v(1fr)
  #line(length: 100%, stroke: 1pt + c.line)
  #text(size: 8pt, fill: c.ink3, L.confidential)
]

#set page(paper: "a4", margin: (top: 16mm, x: 14mm, bottom: 18mm), fill: c.paper, numbering: numpat,
  footer: context {
    set text(size: 7.5pt)
    grid(columns: (1fr, auto),
      text(fill: c.ink3, d.footer),
      text(font: W(500), fill: c.ink2, L.page + " " + counter(page).display(numpat) + " " + L.of + " "
        + numbering(numpat, counter(page).final().first())))
  })

#show outline.entry: it => block(width: 100%, inset: (y: 2.2mm), stroke: (bottom: 1pt + c.line),
  text(size: 10.5pt, link(it.element.location(), box(it.body()) + h(2mm)
    + box(width: 1fr, repeat(text(fill: c.dots, "."), gap: 1.5pt)) + h(2mm)
    + box(text(font: W(600), it.page())))))
#text(size: 16pt, font: W(600), L.contents)
#v(4mm)
#outline(title: none, target: heading.where(level: 2))
#pagebreak()

#show heading.where(level: 2): it => block(sticky: true, above: 5mm, below: 3mm, text(size: 13pt, font: W(600), it.body))
#let th(s) = text(font: W(600), size: 8pt, fill: c.ink2, s)
#let tbl(cols, head, rows) = table(columns: cols, stroke: (x: none, y: 0.6pt + c.line), inset: (x: 1.5mm, y: 1.6mm),
  align: (x, y) => if x == 0 { start + horizon } else { end + horizon },
  table.header(..head.map(th)), ..rows)
#let none-line() = text(fill: c.ink3, L.none)

// ---- Odometer history: readings with a photo or typed by hand, and the latest of each month.
== #L.readings
#text(size: 8pt, fill: c.ink3, L.readingsNote)
#v(2mm)
#if d.readings.len() == 0 { none-line() } else {
  tbl((1fr, 1fr, 1fr, 1fr, 12mm), (L.date, L.reading, L.source, L.by, L.proof),
    d.readings.map(r => (r.date, text(font: W(500), r.value), r.source, r.by, if r.proof { "●" } else { "" })).flatten())
}

#if d.proofs.len() > 0 [
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
]

// ---- Services, each with its lines and its invoice photos.
== #L.services
#if d.services.len() == 0 { none-line() }
#for s in d.services {
  block(breakable: false, width: 100%, inset: (y: 2.5mm), stroke: (bottom: 1pt + c.line), {
    grid(columns: (1fr, auto),
      text(size: 10pt, font: W(600), (s.date, s.odometer).filter(x => x != "").join(d.sep)),
      text(font: W(600), s.total))
    if s.vendor != "" { text(size: 8pt, fill: c.ink2, s.vendor) }
    if s.lines.len() > 0 or s.photos.len() > 0 {
      v(1.5mm)
      grid(columns: (1fr, auto), column-gutter: 4mm,
        if s.lines.len() > 0 {
          tbl((1fr, 12mm) + (if d.showMoney { (26mm,) } else { () }),
            (L.item, L.qty) + (if d.showMoney { (L.amount,) } else { () }),
            s.lines.map(l => (l.name, l.qty) + (if d.showMoney { (l.amount,) } else { () })).flatten())
        } else { [] },
        (s.photos.map(p => box(clip: true, radius: 3pt, image(p, width: 18mm, height: 18mm, fit: "cover")))
          + (if s.more != "" { (text(fill: c.ink3, s.more),) } else { () })).join(h(1.5mm)))
    }
  })
}

// ---- Fuel: the summary and the fills per year (no fill-by-fill table: V39's row bound).
#if d.fuel != none [
  == #L.fuel
  #for (k, v) in d.fuel.summary [#text(fill: c.ink3, k + ": ") #text(font: W(600), v) \ ]
  #v(3mm)
  #if d.fuel.years.len() > 0 {
    tbl((1fr, 1fr, 2fr), (L.year, L.fills, L.fuelAmount),
      d.fuel.years.map(y => (y.year, y.fills, y.amount)).flatten())
  }
]

// ---- Documents.
#if d.documents != none [
  == #L.documents
  #if d.documents.len() == 0 { none-line() } else {
    tbl((2fr, 1fr, 1fr, 1fr) + (if d.showMoney { (1fr,) } else { () }),
      (L.name, L.issued, L.expires, L.state) + (if d.showMoney { (L.cost,) } else { () }),
      d.documents.map(x => (x.name, x.issued, x.expires, x.state) + (if d.showMoney { (x.cost,) } else { () })).flatten())
  }
]
