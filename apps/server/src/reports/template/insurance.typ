// Kept's insurance report (D158, D201; engineering spec §2.8), the second template on the D201
// engine. From the step-4 spike (docs/spikes/code/step4/insurance/insurance.typ), which rendered
// 500 things in Arabic at 138 MB. Everything comes from /data.json (incidents/report.ts builds
// it): strings, money and dates arrive formatted in the reader's language and digits, so no
// formatting happens here. Photos are /thumbs/<id>.jpg. Data strings are only ever inserted as
// text, never evaluated as markup; a link's target is Kept's own URL for the thing.
//
// The rules of report.typ hold: weights by family name ("IBM Plex Sans SmBld"), `dir: rtl` for
// Arabic with serials left-to-right in Plex Mono, page numbers in the reader's digits, a row is
// an unbreakable block, a place heading is sticky, and never `#let rtl = …`.
#let d = json("/data.json")
#let L = d.labels
#let isrtl = d.dir == "rtl"
// Design tokens (apps/web/src/styles/tokens.css, light theme: print is on paper).
#let c = (
  paper: rgb("#F2F1EC"), surface: rgb("#FBFAF7"), sunken: rgb("#ECEAE4"), line: rgb("#DEDBD3"),
  ink: rgb("#1C1B19"), ink2: rgb("#55524C"), ink3: rgb("#6B675F"), amber: rgb("#F0B03A"),
  amber-ink: rgb("#2E2100"), danger: rgb("#B42318"), danger-bg: rgb("#FDECEA"),
)
#let sans = if isrtl { ("IBM Plex Sans Arabic", "IBM Plex Sans") } else { ("IBM Plex Sans", "IBM Plex Sans Arabic") }
#let mono = "IBM Plex Mono"
#let sfx = (w) => if w == 600 { " SmBld" } else if w == 500 { " Medm" } else { "" }
#let W(w) = sans.map(f => f + sfx(w))
#let numpat = if d.digits == "arab" { "١" } else { "1" }

#set document(title: L.title + " — " + d.scopeName, author: d.generatedBy)
#set text(font: sans, size: 9pt, fill: c.ink, lang: d.lang, dir: if isrtl { rtl } else { ltr }, hyphenate: false)
#set par(leading: 0.6em)
#set page(paper: "a4", margin: (top: 16mm, x: 14mm, bottom: 18mm), fill: c.paper, numbering: numpat,
  footer: context {
    set text(size: 7.5pt)
    grid(columns: (1fr, auto),
      text(fill: c.ink3, d.footer),
      text(font: W(500), fill: c.ink2, L.page + " " + counter(page).display(numpat) + " " + L.of + " "
        + numbering(numpat, counter(page).final().first())))
  })

// ---- Header: title, scope, "as of", owner, who made it, and the incident when there is one.
#text(size: 20pt, font: W(600), L.title) \
#text(size: 12pt, font: W(500), fill: c.ink2, d.scopeName) \
#text(fill: c.ink3, d.asOfLine) \
#if d.ownerLine != "" [#text(fill: c.ink3, d.ownerLine) \ ]
#text(fill: c.ink3, d.generatedLine)
#if d.incident != none {
  v(3mm)
  block(width: 100%, fill: c.danger-bg, radius: 6pt, inset: 4mm, {
    text(size: 11pt, font: W(600), fill: c.danger, d.incident.title)
    for line in d.incident.lines [#linebreak() #text(fill: c.ink2, line)]
  })
}
#v(3mm)
#block(width: 100%, fill: c.surface, stroke: 1pt + c.line, radius: 6pt, inset: 4mm, {
  text(size: 10.5pt, font: W(600), L.totals)
  linebreak()
  for t in d.totals [#text(size: 12pt, font: W(600), t) #h(6mm)]
  if d.converted != "" {
    linebreak()
    text(size: 9pt, fill: c.ink2, d.convertedLabel + " ") + text(font: W(600), d.converted)
  }
  if d.moneyNote != "" { linebreak(); text(size: 8pt, fill: c.ink3, d.moneyNote) }
})
#v(2mm)

#show heading.where(level: 2): it => block(sticky: true, above: 5mm, below: 2mm, text(size: 11.5pt, font: W(600), it.body))
#let pathOf(steps) = steps.map(s => box(s)).join(text(fill: c.ink3, " " + d.pathSeparator + " "))
// Columns: photo, what it is, purchase, current value, receipts.
#let cols = (13mm, 1fr, 30mm, 28mm, 14mm)
#let head = (none, L.thing, L.purchase, L.value, L.receipts)

#if d.places.len() == 0 {
  v(8mm)
  align(center, text(fill: c.ink3, L.empty))
}

#for p in d.places [
  #heading(level: 2, if p.path.len() > 0 { pathOf(p.path) } else { d.scopeName })
  #block(sticky: true, below: 1mm, inset: (y: 1mm), stroke: (bottom: 1pt + c.line),
    grid(columns: cols, column-gutter: 3mm, ..head.map(h => if h == none { [] } else { text(size: 7.5pt, font: W(500), fill: c.ink3, h) })))
  #for t in p.things {
    block(breakable: false, width: 100%, inset: (y: 1.6mm), stroke: (bottom: 1pt + c.line),
      grid(columns: cols, column-gutter: 3mm, align: horizon,
        if t.photo != none { box(clip: true, radius: 3pt, image(t.photo, width: 13mm, height: 13mm, fit: "cover")) }
          else { box(width: 13mm, height: 13mm, radius: 3pt, fill: c.sunken) },
        {
          text(size: 9pt, font: W(600), t.name)
          if t.status != "" { h(2mm); text(size: 7.5pt, font: W(500), fill: c.danger, t.status) }
          let what = (t.brand, t.model).filter(x => x != "")
          if what.len() > 0 { linebreak(); text(size: 7.8pt, fill: c.ink2, what.join(" · ")) }
          if t.serial != "" { linebreak(); text(size: 7.5pt, fill: c.ink2, L.serial + ": ") + text(font: mono, size: 7.5pt, fill: c.ink3, dir: ltr, t.serial) }
        },
        { text(size: 8pt, t.purchasedOn); if t.price != "" { linebreak(); text(size: 8.5pt, font: W(500), t.price) } },
        align(end, { text(size: 8.5pt, font: W(600), t.value); if t.valuedOn != "" { linebreak(); text(size: 7pt, fill: c.ink3, t.valuedOn) } }),
        align(center, if t.receipts != "" { link(t.link, text(size: 8.5pt, fill: c.ink, underline(t.receipts))) }),
      ))
  }
  #if p.totals.len() > 0 {
    block(width: 100%, inset: (y: 2mm), breakable: false, align(end,
      text(font: W(500), fill: c.ink3, L.subtotal) + h(4mm) + p.totals.map(s => text(font: W(600), s)).join(h(5mm))))
  }
]
