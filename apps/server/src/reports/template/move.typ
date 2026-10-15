// Kept's contents sheets for a move (1.x, D251), a fifth template on the D201 engine: one A4 page
// per box, to tape to the box or keep in a folder. Everything comes from /data.json
// (reports/move/view.ts builds it): strings arrive formatted in the reader's language and digits,
// so no formatting happens here. A box's QR code is /qr/<container id>.svg, its label's code.
// Data strings are only ever inserted as text, never evaluated as markup.
//
// report.typ's rules hold: weights by family name ("IBM Plex Sans SmBld"), `dir: rtl` for Arabic,
// and never `#let rtl = …`.
#let d = json("/data.json")
#let L = d.labels
#let isrtl = d.dir == "rtl"
// Design tokens (apps/web/src/styles/tokens.css, light theme: print is on paper).
#let c = (
  paper: rgb("#FFFFFF"), surface: rgb("#FBFAF7"), sunken: rgb("#ECEAE4"), line: rgb("#DEDBD3"),
  ink: rgb("#1C1B19"), ink2: rgb("#55524C"), ink3: rgb("#6B675F"), amber: rgb("#F0B03A"),
)
#let sans = if isrtl { ("IBM Plex Sans Arabic", "IBM Plex Sans") } else { ("IBM Plex Sans", "IBM Plex Sans Arabic") }
#let sfx = (w) => if w == 600 { " SmBld" } else if w == 500 { " Medm" } else { "" }
#let W(w) = sans.map(f => f + sfx(w))

#set document(title: d.title + " — " + d.move, author: "Kept")
#set text(font: sans, size: 10pt, fill: c.ink, lang: d.lang, dir: if isrtl { rtl } else { ltr }, hyphenate: false)
#set par(leading: 0.6em)
#set page(paper: "a4", margin: (top: 16mm, x: 16mm, bottom: 16mm), fill: c.paper,
  footer: context {
    set text(size: 7.5pt, fill: c.ink3)
    grid(columns: (1fr, auto), d.footer, d.generatedLine)
  })

#if d.boxes.len() == 0 [
  #text(size: 16pt, font: W(600), d.move)
  #v(4mm)
  #text(fill: c.ink3, d.none)
]

#for (i, b) in d.boxes.enumerate() [
  #if i > 0 { pagebreak() }
  #grid(columns: (1fr, auto), column-gutter: 8mm, align: (start + top, end + top),
    {
      text(size: 9pt, fill: c.ink3, d.move + "  ·  " + d.route)
      v(1mm)
      text(size: 54pt, font: W(600), b.heading)
      linebreak()
      if b.name != "" and b.name != b.heading { text(size: 13pt, fill: c.ink2, b.name); linebreak() }
      v(2mm)
      box(fill: c.sunken, radius: 10pt, inset: (x: 2.5mm, y: 1pt), outset: (y: 1pt),
        text(size: 9pt, font: W(500), fill: c.ink2, b.state))
    },
    if b.qr != "" {
      align(center, {
        image(b.qr, width: 38mm)
        text(size: 12pt, font: W(600), b.code)
      })
    },
  )
  #v(6mm)
  #block(width: 100%, fill: c.surface, stroke: 1.5pt + c.amber, radius: 6pt, inset: 5mm, {
    text(size: 10pt, font: W(500), fill: c.ink3, L.goesTo)
    linebreak()
    text(size: 28pt, font: W(600), fill: if b.hasRoom { c.ink } else { c.ink3 }, b.room)
  })
  #v(6mm)
  #text(size: 13pt, font: W(600), b.contentsTitle)
  #v(2mm)
  #if b.lines.len() == 0 [
    #text(fill: c.ink3, b.empty)
  ] else [
    #table(columns: (1fr, auto, auto), stroke: (x, y) => (bottom: 0.75pt + c.line),
      inset: (x: 1.5mm, y: 2mm), align: (start, end, end),
      table.header(text(size: 8.5pt, font: W(500), fill: c.ink3, ""),
        text(size: 8.5pt, font: W(500), fill: c.ink3, L.quantity),
        text(size: 8.5pt, font: W(500), fill: c.ink3, L.id)),
      ..b.lines.map(l => (
        { text(l.name); if l.note != "" { h(2mm); text(size: 8.5pt, fill: c.ink3, l.note) } },
        text(l.quantity),
        text(size: 9pt, fill: c.ink2, l.id),
      )).flatten())
  ]
  #if b.more != "" { v(2mm); text(size: 9pt, fill: c.ink3, b.more) }
  #v(1fr)
  #text(size: 8.5pt, fill: c.ink3, L.scan)
]
