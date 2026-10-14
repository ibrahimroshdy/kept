// A receipt that came as an email with no attachment (email-in, 1.4, D231): its body as a PDF,
// so the purchase keeps it as a page and the pdf-text job gives the receipt prompt its text.
// Everything comes from /data.json (mailin/read.ts): the subject, the sender, the date as the
// mail gave it, and the body as plain text. Data strings are only ever inserted as text, never
// evaluated as markup. Each paragraph carries its direction (read.ts: its first strong letter), so
// an Arabic receipt reads right to left.
#let d = json("/data.json")
#let c = (paper: rgb("#FBFAF7"), ink: rgb("#1C1B19"), ink2: rgb("#55524C"), line: rgb("#DEDBD3"))
#let sans = ("IBM Plex Sans", "IBM Plex Sans Arabic")

#set document(title: d.subject)
#set text(font: sans, size: 9.5pt, fill: c.ink, hyphenate: false)
#set par(leading: 0.62em)
#set page(paper: "a4", margin: (top: 16mm, x: 16mm, bottom: 16mm), fill: c.paper)

#text(size: 14pt, font: sans.map(f => f + " SmBld"), d.subject) \
#text(fill: c.ink2, d.from) \
#text(fill: c.ink2, d.date)
#line(length: 100%, stroke: 0.5pt + c.line)
#for p in d.paragraphs [
  #text(dir: if p.rtl { rtl } else { ltr }, p.text)
  #parbreak()
]
