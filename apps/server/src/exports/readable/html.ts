import type { ReadableLocale, ReadableWords } from './labels.js';

// The readable copy's pages (D159; plan T13): plain HTML with one inline stylesheet, no script, no
// remote resource (no font file, no image from anywhere but the copy itself), so it opens from
// disk in any browser, years from now, with no network. Every piece of user text is escaped and
// isolated (`<bdi>`), so a name in another script keeps its order and markup in a name stays
// text. The Label-tape brand's fonts are named with system fallbacks only.

export type ReadableFileLink = { label: string; href: string };

export type ReadableThing = {
  id: string;
  name: string;
  shortId: string;
  type: string;
  brandModel: string;
  serial: string;
  quantity: string;
  condition: string;
  /** "Sold", "In the trash", … ('' while in use). */
  status: string;
  tags: string[];
  lastSeen: string;
  bought: string;
  /** The containers it sits in, outermost first (the place is the section). */
  inside: string[];
  /** `thumbs/<fileId>.jpg`, relative to the copy's root. */
  thumb: string | null;
  /** The original the thumbnail opens. */
  photoHref: string | null;
  files: ReadableFileLink[];
};

export type ReadablePlace = {
  /** '' for the things with no place. */
  id: string;
  name: string;
  depth: number;
  /** Things directly here (and inside containers here). */
  things: ReadableThing[];
  /** Things here and in every place below, and that number formatted. */
  total: number;
  totalText: string;
  /** Things directly here, formatted ("3 things"). */
  countText: string;
  /** Over the page limit: its things are on `places/<id>.html`. */
  ownPage: boolean;
};

export type ReadableView = {
  lang: ReadableLocale;
  dir: 'ltr' | 'rtl';
  words: ReadableWords;
  location: string;
  exported: string;
  thingCount: string;
  placeCount: string;
  showMoney: boolean;
  pdf: { href: string } | { note: string } | null;
  csvs: string[];
  /** Depth-first, the tree's order; the unplaced group last. */
  places: ReadablePlace[];
};

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Text for HTML: every markup character escaped. */
export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

/** User text: escaped and isolated. */
const bdi = (s: string): string => (s ? `<bdi>${esc(s)}</bdi>` : '');

/** A relative URL made of our own path segments (ids, fixed names): each segment escaped. */
const href = (url: string): string =>
  esc(
    url
      .split('/')
      .map((seg) => (seg === '..' || seg === '.' ? seg : encodeURIComponent(seg)))
      .join('/'),
  );

const STYLE = `
:root { color-scheme: light dark; --ink: #1d1b16; --muted: #6b665c; --line: #d9d4c7;
  --paper: #fbf8f1; --tape: #f2d64b; }
@media (prefers-color-scheme: dark) { :root { --ink: #f1ede4; --muted: #aaa496; --line: #3b382f;
  --paper: #191813; --tape: #b89b12; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink);
  font: 15px/1.45 "IBM Plex Sans", "IBM Plex Sans Arabic", system-ui, -apple-system,
    "Segoe UI", Roboto, "Noto Sans", "Noto Sans Arabic", sans-serif; }
main { max-inline-size: 72rem; margin-inline: auto; padding: 1.5rem 1rem 3rem; }
h1 { margin: 0 0 .25rem; font-size: 1.6rem; }
h1 .tape { background: var(--tape); color: #1d1b16; padding: .05em .4em; border-radius: 2px; }
h2 { margin: 2rem 0 .5rem; font-size: 1.2rem; border-block-end: 1px solid var(--line);
  padding-block-end: .25rem; }
p, li { overflow-wrap: anywhere; }
.muted { color: var(--muted); }
nav ul { list-style: none; padding-inline-start: 0; margin: .25rem 0; }
nav ul ul { padding-inline-start: 1.25rem; }
a { color: inherit; }
table { border-collapse: collapse; inline-size: 100%; margin-block: .5rem; }
th, td { text-align: start; vertical-align: top; padding: .35rem .5rem;
  border-block-end: 1px solid var(--line); overflow-wrap: anywhere; }
th { font-weight: 600; font-size: .85rem; color: var(--muted); }
img.thumb { inline-size: 64px; block-size: 64px; object-fit: cover; border-radius: 4px; }
.code { font-family: "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace;
  white-space: nowrap; direction: ltr; unicode-bidi: isolate; }
.files a { display: inline-block; margin-inline-end: .5rem; }
@media (max-width: 40rem) {
  table, thead, tbody, tr, th, td { display: block; }
  thead { display: none; }
  tr { border-block-end: 1px solid var(--line); padding-block: .5rem; }
  td { border: 0; padding: .1rem 0; }
  td[data-label]::before { content: attr(data-label) ": "; color: var(--muted); }
}
`;

/** One page. `body` is markup already built from escaped parts. */
export function page(
  view: Pick<ReadableView, 'lang' | 'dir'>,
  title: string,
  body: string,
): string {
  return `<!doctype html>
<html lang="${view.lang}" dir="${view.dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

function thingRow(w: ReadableWords, t: ReadableThing, root: string, showMoney: boolean): string {
  const photo =
    t.thumb && t.photoHref
      ? `<a href="${href(root + t.photoHref)}"><img class="thumb" src="${href(root + t.thumb)}" alt=""></a>`
      : t.thumb
        ? `<img class="thumb" src="${href(root + t.thumb)}" alt="">`
        : '';
  const files = t.files
    .map((f) => `<a href="${href(root + f.href)}">${esc(f.label)}</a>`)
    .join(' ');
  const name = [
    bdi(t.name),
    t.inside.length > 0
      ? `<div class="muted">${esc(w.inside)} ${t.inside.map(bdi).join(' › ')}</div>`
      : '',
    t.status ? `<div class="muted">${esc(t.status)}</div>` : '',
  ].join('');
  const cells: [string, string][] = [
    [w.photo, photo],
    [w.name, name],
    [w.shortId, t.shortId ? `<span class="code">${esc(t.shortId)}</span>` : ''],
    [w.type, bdi(t.type)],
    [w.brandModel, bdi(t.brandModel)],
    [w.serial, t.serial ? `<span class="code">${esc(t.serial)}</span>` : ''],
    [w.quantity, esc(t.quantity)],
    [w.condition, esc(t.condition)],
    [w.tags, t.tags.map(bdi).join(', ')],
    [w.lastSeen, esc(t.lastSeen)],
    ...(showMoney ? ([[w.bought, bdi(t.bought)]] as [string, string][]) : []),
    [w.files, `<span class="files">${files}</span>`],
  ];
  return `<tr id="thing-${esc(t.id)}">${cells
    .map(([label, html]) => `<td data-label="${esc(label)}">${html}</td>`)
    .join('')}</tr>`;
}

function thingTable(view: ReadableView, things: ReadableThing[], root: string): string {
  const w = view.words;
  if (things.length === 0) return `<p class="muted">${esc(w.empty)}</p>`;
  const heads = [
    w.photo,
    w.name,
    w.shortId,
    w.type,
    w.brandModel,
    w.serial,
    w.quantity,
    w.condition,
    w.tags,
    w.lastSeen,
    ...(view.showMoney ? [w.bought] : []),
    w.files,
  ];
  return `<table><thead><tr>${heads.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>
${things.map((t) => thingRow(w, t, root, view.showMoney)).join('\n')}
</tbody></table>`;
}

const anchorOf = (p: ReadablePlace) => (p.id ? `place-${p.id}` : 'unplaced');
const pageOf = (p: ReadablePlace) => `places/${p.id || 'unplaced'}.html`;

/** The place tree, nested by depth (the places come depth-first). */
function tree(view: ReadableView): string {
  const out: string[] = [];
  let depth = -1;
  for (const p of view.places) {
    if (p.depth > depth) {
      for (; depth < p.depth; depth++) out.push('<ul>');
    } else {
      out.push('</li>');
      for (; depth > p.depth; depth--) out.push('</ul></li>');
    }
    const link = p.ownPage ? href(pageOf(p)) : `#${esc(anchorOf(p))}`;
    out.push(
      `<li><a href="${link}">${bdi(p.name)}</a> <span class="muted">(${esc(
        view.words.thingCount(p.total, p.totalText),
      )})</span>`,
    );
  }
  if (depth >= 0) {
    out.push('</li>');
    for (; depth > 0; depth--) out.push('</ul></li>');
    out.push('</ul>');
  }
  return `<nav aria-label="${esc(view.words.places)}">${out.join('')}</nav>`;
}

/** `index.html`: the location, its tree, and each place's things (or a link to its own page). */
export function indexHtml(view: ReadableView): string {
  const w = view.words;
  const pdf = view.pdf
    ? 'href' in view.pdf
      ? `<li><a href="${href(view.pdf.href)}">${esc(w.pdf)}</a></li>`
      : `<li class="muted">${esc(view.pdf.note)}</li>`
    : '';
  const csvs = view.csvs.map((c) => `<a href="${href(c)}">${esc(c)}</a>`).join(', ');
  const sections = view.places
    .map((p) => {
      const heading = `<h2 id="${esc(anchorOf(p))}">${bdi(p.name)} <span class="muted">(${esc(
        p.countText,
      )})</span></h2>`;
      if (p.ownPage) {
        return `${heading}<p><a href="${href(pageOf(p))}">${esc(w.ownPage)}</a></p>`;
      }
      return `${heading}\n${thingTable(view, p.things, '')}`;
    })
    .join('\n');
  return page(
    view,
    `${view.location}: ${w.title}`,
    `<h1><span class="tape">${bdi(view.location)}</span></h1>
<p class="muted">${esc(w.title)}. ${esc(view.exported)}. ${esc(view.thingCount)}, ${esc(
      view.placeCount,
    )}.</p>
<p>${esc(w.intro)}</p>
${view.showMoney ? '' : `<p class="muted">${esc(w.moneyHidden)}</p>`}
<ul>${pdf}<li>${esc(w.spreadsheets)}: ${csvs}</li></ul>
<h2>${esc(w.places)}</h2>
${tree(view)}
${sections}`,
  );
}

/** `places/<id>.html`: one big place's things. Its links climb one level to the copy's root. */
export function placeHtml(view: ReadableView, place: ReadablePlace): string {
  return page(
    view,
    `${place.name}: ${view.location}`,
    `<p><a href="../index.html">${bdi(view.location)}</a></p>
<h1>${bdi(place.name)}</h1>
${thingTable(view, place.things, '../')}`,
  );
}
