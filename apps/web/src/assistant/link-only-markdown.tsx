/**
 * The assistant's answers, rendered (D179, screens §5 "Replies"): a deliberately tiny renderer for
 * paragraphs, bulleted and numbered lists, bold, and Kept's own links (`kept:thing/<id>` and
 * `kept:place/<id>`, which the server's prompt asks for and checks). Nothing else is markup: any
 * other link, any image, any HTML and anything that looks like a confirmation card is shown as the
 * plain text it is. React escapes every string, so nothing in model text can become an element,
 * a URL to elsewhere or a remote image (no remote images and internal links only, D179).
 *
 * `parse()` is pure and returns blocks; `<LinkOnlyMarkdown>` draws them.
 */
import { Link } from '@tanstack/react-router';
import { Fragment, type ReactNode } from 'react';

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'bold'; children: Inline[] }
  | { type: 'link'; kind: 'thing' | 'place'; id: string; text: string }
  | { type: 'break' };

export type Block =
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'list'; ordered: boolean; items: Inline[][] };

/** A Kept id: a UUID or a 6-character short ID (D208). */
const ID =
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9A-Za-z]{6}';
const LINK = new RegExp(`\\[([^\\]\\n]{1,200})\\]\\(kept:(thing|place)\\/(${ID})\\)`, 'g');
const BOLD = /\*\*([^*\n](?:[^*\n]|\*(?!\*))*?)\*\*/g;
const BULLET = /^\s*[-*•]\s+/;
const NUMBERED = /^\s*\d{1,3}[.)]\s+/;

function links(text: string): Inline[] {
  const out: Inline[] = [];
  let at = 0;
  for (const m of text.matchAll(LINK)) {
    const [whole, label = '', kind, id = ''] = m;
    if (m.index > at) out.push({ type: 'text', text: text.slice(at, m.index) });
    out.push({ type: 'link', kind: kind as 'thing' | 'place', id, text: label });
    at = m.index + whole.length;
  }
  if (at < text.length) out.push({ type: 'text', text: text.slice(at) });
  return out;
}

/** One line's inline content: bold spans, Kept links inside or outside them, the rest text. */
export function inline(text: string): Inline[] {
  const out: Inline[] = [];
  let at = 0;
  for (const m of text.matchAll(BOLD)) {
    if (m.index > at) out.push(...links(text.slice(at, m.index)));
    out.push({ type: 'bold', children: links(m[1] ?? '') });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push(...links(text.slice(at)));
  return out;
}

function lines(text: string): Inline[] {
  const out: Inline[] = [];
  text.split('\n').forEach((line, i) => {
    if (i > 0) out.push({ type: 'break' });
    out.push(...inline(line));
  });
  return out;
}

/** Blocks from the answer's text: blank lines separate them; a run of list lines is a list. */
export function parse(text: string): Block[] {
  const blocks: Block[] = [];
  const chunks = text.replace(/\r\n?/g, '\n').split(/\n\s*\n/);
  for (const chunk of chunks) {
    const rows = chunk.split('\n').filter((l) => l.trim() !== '');
    if (rows.length === 0) continue;
    let para: string[] = [];
    let list: { ordered: boolean; items: string[] } | null = null;
    const flushPara = () => {
      if (para.length) blocks.push({ type: 'paragraph', children: lines(para.join('\n')) });
      para = [];
    };
    const flushList = () => {
      if (list) blocks.push({ type: 'list', ordered: list.ordered, items: list.items.map(inline) });
      list = null;
    };
    for (const row of rows) {
      const bullet = BULLET.test(row);
      const numbered = !bullet && NUMBERED.test(row);
      if (bullet || numbered) {
        flushPara();
        if (list && list.ordered !== numbered) flushList();
        list ??= { ordered: numbered, items: [] };
        list.items.push(row.replace(bullet ? BULLET : NUMBERED, ''));
      } else if (list && /^\s{2,}/.test(row)) {
        // A wrapped list item.
        const last = list.items.length - 1;
        list.items[last] = `${list.items[last]} ${row.trim()}`;
      } else {
        flushList();
        para.push(row);
      }
    }
    flushPara();
    flushList();
  }
  return blocks;
}

/** Every Kept link in the answer, in order, each once. */
export function linkedIds(blocks: Block[]): { kind: 'thing' | 'place'; id: string }[] {
  const seen = new Set<string>();
  const out: { kind: 'thing' | 'place'; id: string }[] = [];
  const walk = (xs: Inline[]) => {
    for (const x of xs) {
      if (x.type === 'bold') walk(x.children);
      else if (x.type === 'link' && !seen.has(`${x.kind}:${x.id}`)) {
        seen.add(`${x.kind}:${x.id}`);
        out.push({ kind: x.kind, id: x.id });
      }
    }
  };
  for (const b of blocks) {
    if (b.type === 'paragraph') walk(b.children);
    else for (const item of b.items) walk(item);
  }
  return out;
}

const linkClass =
  'font-semibold text-ink underline decoration-ink-3 decoration-1 underline-offset-[3px] outline-none hover:decoration-ink focus-visible:outline-2 focus-visible:outline-info';

function InlineView({ nodes, onNavigate }: { nodes: Inline[]; onNavigate?: () => void }) {
  return nodes.map((n, i) => {
    const key = `${n.type}${i}`;
    switch (n.type) {
      case 'text':
        return <Fragment key={key}>{n.text}</Fragment>;
      case 'break':
        return <br key={key} />;
      case 'bold':
        return (
          <strong key={key} className="font-semibold">
            <InlineView nodes={n.children} {...(onNavigate ? { onNavigate } : {})} />
          </strong>
        );
      case 'link':
        return n.kind === 'thing' ? (
          <Link
            key={key}
            to="/t/$id"
            params={{ id: n.id }}
            className={linkClass}
            onClick={onNavigate}
          >
            <bdi>{n.text}</bdi>
          </Link>
        ) : (
          <Link
            key={key}
            to="/p/$id"
            params={{ id: n.id }}
            className={linkClass}
            onClick={onNavigate}
          >
            <bdi>{n.text}</bdi>
          </Link>
        );
    }
    return null;
  });
}

export function LinkOnlyMarkdown({
  blocks,
  onNavigate,
}: {
  blocks: Block[];
  /** A link was followed (the phone's sheet closes so the page shows). */
  onNavigate?: () => void;
}): ReactNode {
  const nav = onNavigate ? { onNavigate } : {};
  return (
    <div dir="auto" className="grid gap-2 [overflow-wrap:anywhere]">
      {blocks.map((b, i) =>
        b.type === 'paragraph' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks have no identity beyond order
          <p key={i} className="m-0">
            <InlineView nodes={b.children} {...nav} />
          </p>
        ) : b.ordered ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: as above
          <ol key={i} className="m-0 grid list-decimal gap-1 ps-5">
            {b.items.map((item, j) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: as above
              <li key={j}>
                <InlineView nodes={item} {...nav} />
              </li>
            ))}
          </ol>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: as above
          <ul key={i} className="m-0 grid list-disc gap-1 ps-5">
            {b.items.map((item, j) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: as above
              <li key={j}>
                <InlineView nodes={item} {...nav} />
              </li>
            ))}
          </ul>
        ),
      )}
    </div>
  );
}
