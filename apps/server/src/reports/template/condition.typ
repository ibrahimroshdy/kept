// Kept's condition report (1.x, D171, D235), a fourth template on the D201 engine: one move-in or
// move-out walk-through, or two side by side, room by room. Everything comes from /data.json
// (reports/condition/view.ts builds it): strings and dates arrive formatted in the reader's
// language and digits, so no formatting happens here. Photos are /thumbs/<id>.jpg (at most 640 px,
// JPEG, from the GPS-stripped derivatives). Data strings are only ever inserted as text, never
// evaluated as markup.
//
// report.typ's rules hold: weights by family name ("IBM Plex Sans SmBld"), `dir: rtl` for Arabic,
// page numbers in the reader's digits, a room's side unbreakable, headings sticky, a contents page
// over the level-2 headings (one per room), and never `#let rtl = …`.
#let d = json("/data.json")
#let L = d.labels
#let isrtl = d.dir == "rtl"
// Design tokens (apps/web/src/styles/tokens.css, light theme: print is on paper).
#let c = (
  paper: rgb("#F2F1EC"), surface: rgb("#FBFAF7"), sunken: rgb("#ECEAE4"), line: rgb("#DEDBD3"),
  ink: rgb("#1C1B19"), ink2: rgb("#55524C"), ink3: rgb("#6B675F"), amber: rgb("#F0B03A"),
  amber-ink: rgb("#2E2100"), danger: rgb("#B42318"), dots: rgb("#A8A399"),
)
// A room's condition as a pill: good is plain, fair and poor amber, damaged red.
#let tones = (
  good: (fill: c.sunken, ink: c.ink2),
  fair: (fill: rgb("#FDF3DC"), ink: rgb("#8A5700")),
  poor: (fill: rgb("#FDF3DC"), ink: rgb("#8A5700")),
  damaged: (fill: rgb("#FDECEA"), ink: c.danger),
)
#let sans = if isrtl { ("IBM Plex Sans Arabic", "IBM Plex Sans") } else { ("IBM Plex Sans", "IBM Plex Sans Arabic") }
#let sfx = (w) => if w == 600 { " SmBld" } else if w == 500 { " Medm" } else { "" }
#let W(w) = sans.map(f => f + sfx(w))
#let numpat = if d.digits == "arab" { "١" } else { "1" }

#set document(title: L.title + " — " + d.location, author: "Kept")
#set text(font: sans, size: 9pt, fill: c.ink, lang: d.lang, dir: if isrtl { rtl } else { ltr }, hyphenate: false)
#set par(leading: 0.6em)

// Kept's lockup (D135), as report.typ draws it: a brand mark, so always left-to-right.
#let lockup(height: 40pt) = box(image(bytes("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 191 64'><path d='M9 2H55A7 7 0 0 1 62 9V55A7 7 0 0 1 55 62H9A7 7 0 0 1 2 55V9A7 7 0 0 1 9 2ZM12 8.5A3.5 3.5 0 1 0 12 15.5A3.5 3.5 0 1 0 12 8.5Z' fill='#F0B03A' fill-rule='evenodd'/><path d='M277 306 204 210V0H73V698H204V384H210L291 500L438 698H586L367 404L596 0H448Z' fill='#2E2100' transform='translate(21.4 48) scale(0.042 -0.042)'/><g fill='#1C1B19'><path d='M277 306 204 210V0H73V698H204V384H210L291 500L438 698H586L367 404L596 0H448Z' transform='translate(74 48) scale(0.042 -0.042)'/><path d='M83 0V698H524V590H214V408H513V300H214V108H524V0Z' transform='translate(104.2 48) scale(0.042 -0.042)'/><path d='M80 0V698H345Q447 698 501 640Q555 582 555 482Q555 382 501 324Q447 266 345 266H211V0ZM211 373H318Q371 373 394 394.5Q417 416 417 463V501Q417 548 394 569.5Q371 591 318 591H211Z' transform='translate(134.4 48) scale(0.042 -0.042)'/><path d='M365 590V0H235V590H25V698H575V590Z' transform='translate(164.6 48) scale(0.042 -0.042)'/></g></svg>"), format: "svg", height: height))
#let pill(label, tone) = {
  let t = tones.at(tone, default: (fill: c.sunken, ink: c.ink3))
  box(fill: t.fill, radius: 10pt, inset: (x: 2mm, y: 1pt), outset: (y: 1pt),
    text(size: 8pt, font: W(500), fill: t.ink, label))
}

// ---- Cover.
#page(paper: "a4", margin: (x: 22mm, y: 28mm), fill: c.paper, footer: none)[
  #set align(if isrtl { right } else { left })
  #lockup()
  #v(16mm)
  #text(size: 30pt, font: W(600), L.title)
  #v(2mm)
  #text(size: 15pt, font: W(500), fill: c.ink2, d.location) \
  #text(fill: c.ink3, d.generatedLine)
  #v(8mm)
  #for s in d.sides {
    block(width: 100%, fill: c.surface, stroke: 1pt + c.line, radius: 6pt, inset: 5mm, below: 4mm, {
      text(size: 13pt, font: W(600), s.title)
      linebreak()
      if s.started != "" { text(size: 8.5pt, fill: c.ink3, s.started); linebreak() }
      text(size: 8.5pt, fill: if s.draft { c.danger } else { c.ink2 }, s.status)
      v(3mm)
      grid(columns: (auto, auto), column-gutter: 10mm,
        ..s.counts.map(((n, l)) => text(size: 16pt, font: W(600), n) + linebreak() + text(size: 8pt, fill: c.ink3, l)))
      if s.notes != "" {
        v(3mm)
        text(size: 8pt, font: W(600), fill: c.ink2, L.notes)
        linebreak()
        text(size: 9pt, s.notes)
      }
    })
  }
  #v(1fr)
  #text(size: 8pt, fill: c.ink3, L.photoNote)
  #v(2mm)
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
#if d.rooms.len() == 0 [
  #text(fill: c.ink3, L.empty)
] else [
  #outline(title: none, target: heading.where(level: 2))
]
#pagebreak()

#show heading.where(level: 2): it => block(sticky: true, above: 5mm, below: 3mm, text(size: 13pt, font: W(600), it.body))

// ---- Rooms: each side's condition, note and photos, the earlier walk-through first.
#for r in d.rooms [
  #heading(level: 2, box(r.name))
  #for s in r.sides {
    block(width: 100%, inset: (y: 2.5mm), stroke: (bottom: 1pt + c.line), {
      block(breakable: false, sticky: true, below: 2mm, {
        if s.heading != "" { text(size: 9.5pt, font: W(600), fill: c.ink2, s.heading); h(3mm) }
        if s.missing { text(fill: c.ink3, L.notInReport) } else { pill(s.condition, s.tone) }
      })
      if s.note != "" { block(below: 2mm, text(size: 9pt, s.note)) }
      if s.photos.len() > 0 {
        grid(columns: (1fr,) * 3, gutter: 3mm,
          ..s.photos.map(p => block(breakable: false, width: 100%, {
            box(clip: true, radius: 3pt, image(p.path, width: 100%, height: 42mm, fit: "contain"))
            v(1mm)
            text(size: 7pt, fill: c.ink3, p.caption)
          })))
      }
      if s.more != "" { v(1.5mm); text(size: 8pt, fill: c.ink3, s.more) }
    })
  }
]
