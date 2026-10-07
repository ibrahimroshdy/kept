// Reads page numbers back out of a Chromium PDF's outline (page.pdf({outline: true, tagged: true})
// writes one entry per heading, in document order). Chromium (Skia) writes plain object
// dictionaries, so a regex walk is enough: no PDF library needed.
// Returns the 1-based page of the last `titles.length` outline entries (the place headings).
export function outlinePages(pdf, titles) {
  const s = pdf.toString('latin1');
  const pagesNodes = new Map();
  for (const m of s.matchAll(/(\d+) 0 obj\s*<<\/Type \/Pages[^]*?\/Kids \[([^\]]*)\]/g)) {
    pagesNodes.set(m[1], [...m[2].matchAll(/(\d+) 0 R/g)].map((k) => k[1]));
  }
  const root = s.match(/\/Type \/Catalog\s*\/Pages (\d+) 0 R/)[1];
  const order = [];
  const walk = (id) => (pagesNodes.has(id) ? pagesNodes.get(id).forEach(walk) : order.push(id));
  walk(root);
  const entries = [];
  const byId = new Map();
  for (const m of s.matchAll(/(\d+) 0 obj\s*<<\/Title (?:(?!endobj)[^])*?\/Dest \[(\d+) 0 R(?:(?!endobj)[^])*?endobj/g)) {
    const first = m[0].match(/\/First (\d+) 0 R/)?.[1];
    const next = m[0].match(/\/Next (\d+) 0 R/)?.[1];
    byId.set(m[1], { page: order.indexOf(m[2]) + 1, first, next });
  }
  const top = s.match(/\/Type \/Outlines\s*\/First (\d+) 0 R/)[1];
  const visit = (id) => {
    for (let cur = id; cur; cur = byId.get(cur)?.next) {
      const e = byId.get(cur);
      if (!e) break;
      entries.push(e.page);
      if (e.first) visit(e.first);
    }
  };
  visit(top);
  // Only the place headings are h2 after the table of contents, so they are the last entries.
  return entries.slice(-titles.length);
}
