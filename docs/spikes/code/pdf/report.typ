// Engine 3: Typst (0.14.2, embedded in @myriaddreamin/typst-ts-node-compiler 0.7.0).
// The data comes from /data.json, photos from /thumbs/*.jpg and QR codes from /qr/*.svg, all
// mapped into the compiler's virtual file system by render-typst.mjs. Nothing is read from disk.
#let d = json("/data.json")
#let L = d.labels
#let isrtl = d.dir == "rtl"
#let c = (
  paper: rgb("#F2F1EC"), surface: rgb("#FBFAF7"), sunken: rgb("#ECEAE4"), line: rgb("#DEDBD3"),
  ink: rgb("#1C1B19"), ink2: rgb("#55524C"), ink3: rgb("#6B675F"), amber: rgb("#F0B03A"),
  amber-ink: rgb("#2E2100"), dots: rgb("#A8A399"),
)
#let sans = if isrtl { ("IBM Plex Sans Arabic", "IBM Plex Sans") } else { ("IBM Plex Sans", "IBM Plex Sans Arabic") }
#let mono = "IBM Plex Mono"
// Typst files the Medium and SemiBold TTFs under their legacy family names ("IBM Plex Sans SmBld"),
// so `font: W(600)` on "IBM Plex Sans" silently falls back to Regular (checked with pdffonts).
// Weights are therefore picked by family name.
#let sfx = (w) => if w == 600 { " SmBld" } else if w == 500 { " Medm" } else { "" }
#let W(w) = sans.map(f => f + sfx(w))
// Page numbers: Typst's numbering patterns include "١" (Eastern Arabic digits).
#let numpat = if d.digits == "arab" { "١" } else { "1" }

#set document(title: L.title + " — " + L.location)
#set text(font: sans, size: 9pt, fill: c.ink, lang: d.lang, dir: if isrtl { rtl } else { ltr }, hyphenate: false)
#set par(leading: 0.6em)

#let tape(width: 170pt) = box(width: width, height: width * 40 / 146, fill: c.amber, radius: 4pt,
  place(horizon + left, dx: width * 7 / 146, circle(radius: width * 3 / 146, fill: c.surface))
  + align(center + horizon, text(font: mono + " SmBld", size: width * 24 / 146, tracking: width * 5 / 146, fill: c.amber-ink, "KEPT")))
#let chip(id) = box(fill: c.amber, radius: 3pt, inset: (x: 4pt, y: 3pt),
  text(font: mono + " SmBld", size: 8pt, tracking: 0.6pt, fill: c.amber-ink, dir: ltr, id))

// ---- Cover: its own page, no footer.
#page(paper: "a4", margin: (x: 22mm, y: 28mm), fill: c.paper, footer: none)[
  #set align(if isrtl { right } else { left })
  // The tape is a brand mark: always laid out left-to-right.
  #tape()
  #v(18mm)
  #text(size: 30pt, font: W(600), L.title)
  #v(2mm)
  #text(size: 15pt, font: W(500), fill: c.ink2, L.location) \
  #text(fill: c.ink3, L.account + " · " + L.generated + " " + d.date)
  #v(14mm)
  #grid(columns: (1fr, 1fr, 1fr), gutter: 4mm,
    ..((d.counts.things, L.things), (d.counts.places, L.places), (d.counts.photos, L.photos)).map(((n, l)) =>
      block(width: 100%, fill: c.surface, stroke: 1pt + c.line, radius: 6pt, inset: 5mm,
        text(size: 20pt, font: W(600), n) + linebreak() + text(size: 8.5pt, fill: c.ink3, l))))
  #v(10mm)
  #block(width: 100%, fill: c.surface, stroke: 1pt + c.line, radius: 6pt, inset: 5mm)[
    #text(size: 11pt, font: W(600), L.totals)
    #v(2mm)
    #for t in d.totals [#text(size: 13pt, font: W(600), t) \ ]
  ]
  #v(1fr)
  #line(length: 100%, stroke: 1pt + c.line)
  #text(size: 8pt, fill: c.ink3, L.confidential)
]

// ---- Everything else: A4 with the footer. The cover is page 1, so the counter keeps counting.
#set page(paper: "a4", margin: (top: 16mm, x: 14mm, bottom: 18mm), numbering: numpat,
  footer: context {
    set text(size: 7.5pt)
    grid(columns: (1fr, auto),
      text(fill: c.ink3, L.footer),
      text(font: W(500), fill: c.ink2, L.page + " " + counter(page).display(numpat) + " " + L.of + " "
        + numbering(numpat, counter(page).final().first())))
  })

// Table of contents: Typst's own outline, with page numbers resolved by the compiler.
#show outline.entry: it => block(width: 100%, inset: (y: 2.2mm), stroke: (bottom: 1pt + c.line),
  text(size: 10.5pt, link(it.element.location(), it.body() + h(2mm)
    + box(width: 1fr, repeat(text(fill: c.dots, "."), gap: 1.5pt)) + h(2mm)
    + text(font: W(600), it.page()))))
#text(size: 16pt, font: W(600), L.contents)
#v(4mm)
#outline(title: none, target: heading.where(level: 2))
#pagebreak()

#show heading.where(level: 2): it => block(sticky: true, above: 4mm, below: 2.5mm, text(size: 12.5pt, font: W(600), it.body))

#for p in d.places [
  #heading(level: 2, p.pathText)
  #block(sticky: true, below: 2mm, text(size: 8pt, fill: c.ink3, p.count + " " + L.things))
  #for t in p.things {
    block(breakable: false, width: 100%, inset: (y: 2mm), stroke: (bottom: 1pt + c.line),
      grid(columns: (15mm, 1fr, 20mm, 13mm, 10mm, 30mm), column-gutter: 3mm, align: horizon,
        if t.photo != none { box(clip: true, radius: 4pt, image(t.photo, width: 15mm, height: 15mm, fit: "cover")) }
          else { box(width: 15mm, height: 15mm, radius: 4pt, fill: c.sunken) },
        {
          text(size: 9.5pt, font: W(600), t.name)
          linebreak()
          text(size: 7.8pt, fill: c.ink2, (t.type, (t.brand, t.model).filter(x => x != "").join(" ")).filter(x => x != "").join(" · "))
          if t.serial != "" {
            linebreak()
            text(size: 7.5pt, fill: c.ink2, L.serial + ": ") + text(font: mono, size: 7.5pt, fill: c.ink3, t.serial)
          }
          linebreak()
          box(fill: c.sunken, radius: 10pt, inset: (x: 2mm, y: 1pt), outset: (y: 1pt), text(size: 7.5pt, fill: c.ink2, t.condition))
        },
        chip(t.shortId),
        if t.qr != none { image(t.qr, width: 12mm) },
        align(center, t.qty),
        align(end, text(font: W(500), t.value)),
      ))
  }
  #block(width: 100%, inset: (y: 2mm), breakable: false, align(end,
    text(font: W(500), fill: c.ink3, L.subtotal) + h(5mm) + p.subtotals.map(s => text(font: W(600), s)).join(h(5mm))))
  #v(4mm)
]

#pagebreak()
#text(size: 12.5pt, font: W(600), L.stress)
#for s in d.stress {
  // Paragraph direction from the first strong character, like dir="auto".
  let ar = s.match(regex("^[^A-Za-z\u{0600}-\u{06FF}]*[\u{0600}-\u{06FF}]")) != none
  block(width: 100%, inset: (y: 2mm), stroke: (bottom: 1pt + c.line),
    align(if ar { right } else { left }, text(size: 11pt, dir: if ar { rtl } else { ltr }, s)))
}
