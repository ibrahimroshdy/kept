// Kept's inventory report (D201), ported from the V34 spike (docs/spikes/code/pdf/report.typ).
// Typst 0.14 through @myriaddreamin/typst-ts-node-compiler 0.7.0, rendered by
// src/reports/render/child.mjs. Everything comes from /data.json (reports/view.ts builds it):
// strings, numbers, money and dates arrive formatted (Intl, in the reader's language and digits),
// so no formatting happens here. Photos are /thumbs/<id>.jpg (always JPEG, 200 px) and QR codes
// /qr/<id>.svg. Data strings are only ever inserted as text, never evaluated as markup.
//
// Rules from the spike (docs/spikes/2026-09-26-pdf-engine.md):
// - weights are picked by family name ("IBM Plex Sans SmBld"), never with `weight:`: Typst files
//   the Medium and SemiBold faces under their legacy family names;
// - Arabic sets `dir: rtl`; short IDs and serials stay left-to-right in Plex Mono (D143);
// - page numbers follow the digits setting through the numbering pattern ("١" or "1");
// - the contents are Typst's own outline over the level-2 headings (one per place);
// - a row is an unbreakable block, a place heading is sticky;
// - never `#let rtl = …`: it shadows the direction value.
#let d = json("/data.json")
#let L = d.labels
#let isrtl = d.dir == "rtl"
// Design tokens (apps/web/src/styles/tokens.css, light theme: print is on paper).
#let c = (
  paper: rgb("#F2F1EC"), surface: rgb("#FBFAF7"), sunken: rgb("#ECEAE4"), line: rgb("#DEDBD3"),
  ink: rgb("#1C1B19"), ink2: rgb("#55524C"), ink3: rgb("#6B675F"), amber: rgb("#F0B03A"),
  amber-ink: rgb("#2E2100"), amber-text: rgb("#8A5700"), danger: rgb("#B42318"),
  dots: rgb("#A8A399"),
)
#let sans = if isrtl { ("IBM Plex Sans Arabic", "IBM Plex Sans") } else { ("IBM Plex Sans", "IBM Plex Sans Arabic") }
#let mono = "IBM Plex Mono"
#let sfx = (w) => if w == 600 { " SmBld" } else if w == 500 { " Medm" } else { "" }
#let W(w) = sans.map(f => f + sfx(w))
#let numpat = if d.digits == "arab" { "١" } else { "1" }

#set document(title: L.title + " — " + d.scopeName, author: d.generatedBy)
#set text(font: sans, size: 9pt, fill: c.ink, lang: d.lang, dir: if isrtl { rtl } else { ltr }, hyphenate: false)
#set par(leading: 0.6em)

// Kept's lockup (D135): the label-tape mark with its punched hole (cut out, so the page shows
// through) and KEPT in Plex Mono SemiBold, as the outlines scripts/render-icons.mjs draws. A brand
// mark, so always laid out left-to-right.
#let lockup(height: 40pt) = box(image(bytes("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 191 64'><path d='M9 2H55A7 7 0 0 1 62 9V55A7 7 0 0 1 55 62H9A7 7 0 0 1 2 55V9A7 7 0 0 1 9 2ZM12 8.5A3.5 3.5 0 1 0 12 15.5A3.5 3.5 0 1 0 12 8.5Z' fill='#F0B03A' fill-rule='evenodd'/><path d='M277 306 204 210V0H73V698H204V384H210L291 500L438 698H586L367 404L596 0H448Z' fill='#2E2100' transform='translate(21.4 48) scale(0.042 -0.042)'/><g fill='#1C1B19'><path d='M277 306 204 210V0H73V698H204V384H210L291 500L438 698H586L367 404L596 0H448Z' transform='translate(74 48) scale(0.042 -0.042)'/><path d='M83 0V698H524V590H214V408H513V300H214V108H524V0Z' transform='translate(104.2 48) scale(0.042 -0.042)'/><path d='M80 0V698H345Q447 698 501 640Q555 582 555 482Q555 382 501 324Q447 266 345 266H211V0ZM211 373H318Q371 373 394 394.5Q417 416 417 463V501Q417 548 394 569.5Q371 591 318 591H211Z' transform='translate(134.4 48) scale(0.042 -0.042)'/><path d='M365 590V0H235V590H25V698H575V590Z' transform='translate(164.6 48) scale(0.042 -0.042)'/></g></svg>"), format: "svg", height: height))
#let chip(id) = box(fill: c.amber, radius: 3pt, inset: (x: 4pt, y: 3pt),
  text(font: mono + " SmBld", size: 8pt, tracking: 0.6pt, fill: c.amber-ink, dir: ltr, id))
#let pill(label, fill: c.sunken, ink: c.ink2) = box(fill: fill, radius: 10pt, inset: (x: 2mm, y: 1pt), outset: (y: 1pt),
  text(size: 7.5pt, fill: ink, label))

// ---- Cover: a page of its own, no footer.
#page(paper: "a4", margin: (x: 22mm, y: 28mm), fill: c.paper, footer: none)[
  #set align(if isrtl { right } else { left })
  #lockup()
  #v(18mm)
  #text(size: 30pt, font: W(600), L.title)
  #v(2mm)
  #text(size: 15pt, font: W(500), fill: c.ink2, d.scopeName) \
  #if d.scopeDetail != "" [#text(fill: c.ink3, d.scopeDetail) \ ]
  #text(fill: c.ink3, d.generatedLine)
  #v(14mm)
  #grid(columns: (1fr, 1fr, 1fr), gutter: 4mm,
    ..((d.counts.things, L.things), (d.counts.places, L.places), (d.counts.photos, L.photos)).map(((n, l)) =>
      block(width: 100%, fill: c.surface, stroke: 1pt + c.line, radius: 6pt, inset: 5mm,
        text(size: 20pt, font: W(600), n) + linebreak() + text(size: 8.5pt, fill: c.ink3, l))))
  #if d.showMoney and d.totals.len() > 0 [
    #v(10mm)
    #block(width: 100%, fill: c.surface, stroke: 1pt + c.line, radius: 6pt, inset: 5mm)[
      #text(size: 11pt, font: W(600), L.totals)
      #v(2mm)
      #for t in d.totals [#text(size: 13pt, font: W(600), t) \ ]
      #if d.moneyNote != "" [#v(1mm) #text(size: 8pt, fill: c.ink3, d.moneyNote)]
    ]
  ]
  #if d.filters.len() > 0 [
    #v(6mm)
    #for f in d.filters [#text(size: 8.5pt, fill: c.ink3, f) \ ]
  ]
  #v(1fr)
  #line(length: 100%, stroke: 1pt + c.line)
  #text(size: 8pt, fill: c.ink3, L.confidential)
]

// ---- Everything else: A4 with the footer. The cover is page 1; the counter keeps counting.
#set page(paper: "a4", margin: (top: 16mm, x: 14mm, bottom: 18mm), numbering: numpat,
  footer: context {
    set text(size: 7.5pt)
    grid(columns: (1fr, auto),
      text(fill: c.ink3, d.footer),
      text(font: W(500), fill: c.ink2, L.page + " " + counter(page).display(numpat) + " " + L.of + " "
        + numbering(numpat, counter(page).final().first())))
  })

// The entry's title and page number are boxed, so bidi sees them as neutral objects laid out in
// the document's direction: an Arabic place name in an English report (or the reverse) can't
// turn its whole line around.
#show outline.entry: it => block(width: 100%, inset: (y: 2.2mm), stroke: (bottom: 1pt + c.line),
  text(size: 10.5pt, link(it.element.location(), box(it.body()) + h(2mm)
    + box(width: 1fr, repeat(text(fill: c.dots, "."), gap: 1.5pt)) + h(2mm)
    + box(text(font: W(600), it.page())))))
#text(size: 16pt, font: W(600), L.contents)
#v(4mm)
#if d.places.len() == 0 [
  #text(fill: c.ink3, L.empty)
] else [
  #outline(title: none, target: heading.where(level: 2))
]
#pagebreak()

#show heading.where(level: 2): it => block(sticky: true, above: 4mm, below: 2.5mm, text(size: 12.5pt, font: W(600), it.body))

// A place path: each step isolated in a box, joined in the document's direction, so the
// outermost step always comes first in reading order. The separator comes from the data ("›", or
// "‹" right to left): Typst doesn't mirror it.
#let pathOf(steps) = steps.map(s => box(s)).join(text(fill: c.ink3, " " + d.pathSeparator + " "))

// The row's columns: photo, what it is, short ID, QR, quantity, value. Photo, QR and value are
// there only when the report includes them (value: only where the reader may see money).
#let cols = (if d.photos { (15mm,) } else { () }) + (1fr, 20mm) + (if d.qr { (13mm,) } else { () }) + (10mm,) + (if d.showMoney { (30mm,) } else { () })

#for p in d.places [
  #heading(level: 2, pathOf(p.path))
  #block(sticky: true, below: 2mm, text(size: 8pt, fill: c.ink3, p.count))
  #for t in p.things {
    let cells = ()
    if d.photos {
      cells.push(if t.photo != none { box(clip: true, radius: 4pt, image(t.photo, width: 15mm, height: 15mm, fit: "cover")) }
        else { box(width: 15mm, height: 15mm, radius: 4pt, fill: c.sunken) })
    }
    cells.push({
      text(size: 9.5pt, font: W(600), t.name)
      let what = (t.type, t.brandModel).filter(x => x != "").join(" · ")
      if what != none and what != "" {
        linebreak()
        text(size: 7.8pt, fill: c.ink2, what)
      }
      if t.serial != "" {
        linebreak()
        text(size: 7.5pt, fill: c.ink2, L.serial + ": ") + text(font: mono, size: 7.5pt, fill: c.ink3, dir: ltr, t.serial)
      }
      if t.purchased != "" {
        linebreak()
        text(size: 7.5pt, fill: c.ink2, L.bought + ": " + t.purchased)
      }
      let pills = ()
      if t.condition != "" { pills.push(pill(t.condition)) }
      if t.status != "" { pills.push(pill(t.status, fill: rgb("#FDECEA"), ink: c.danger)) }
      if pills.len() > 0 {
        linebreak()
        pills.join(h(1.5mm))
      }
    })
    cells.push(if t.shortId != "" { chip(t.shortId) } else { [] })
    if d.qr { cells.push(if t.qr != none { image(t.qr, width: 12mm) } else { [] }) }
    cells.push(align(center, t.qty))
    if d.showMoney { cells.push(align(end, text(font: W(500), t.value))) }
    block(breakable: false, width: 100%, inset: (y: 2mm), stroke: (bottom: 1pt + c.line),
      grid(columns: cols, column-gutter: 3mm, align: horizon, ..cells))
  }
  #if d.showMoney and p.subtotals.len() > 0 {
    block(width: 100%, inset: (y: 2mm), breakable: false, align(end,
      text(font: W(500), fill: c.ink3, L.subtotal) + h(5mm) + p.subtotals.map(s => text(font: W(600), s)).join(h(5mm))))
  }
  #v(4mm)
]
