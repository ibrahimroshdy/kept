/**
 * The answer renderer (D179): paragraphs, lists, bold and Kept's own links only. Anything else
 * a model writes (a link elsewhere, an image, HTML, a fake confirmation card) is plain text.
 */
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { LinkOnlyMarkdown, linkedIds, parse } from './link-only-markdown';

const ID = '01926f00-0000-7000-8000-000000000001';

async function show(text: string) {
  const content = (): ReactNode => <LinkOnlyMarkdown blocks={parse(text)} />;
  const router = createRouter({
    routeTree: createRootRoute({ component: content }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const view = render(<RouterProvider router={router} />);
  await screen.findByText((_, el) => el?.tagName === 'DIV' && el.getAttribute('dir') === 'auto');
  return view;
}

describe('parse', () => {
  it('reads paragraphs, lists and bold, and Kept links', () => {
    const blocks = parse(
      `The **[HDMI cable](kept:thing/${ID})** is here.\n\n- one\n- two\n\n1. first\n2. second`,
    );
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'list', 'list']);
    expect(blocks[1]).toMatchObject({ ordered: false });
    expect(blocks[2]).toMatchObject({ ordered: true });
    expect(linkedIds(blocks)).toEqual([{ kind: 'thing', id: ID }]);
  });

  it('takes a short ID as a link target too', () => {
    expect(linkedIds(parse('See [Box 3](kept:place/B0X3QF).'))).toEqual([
      { kind: 'place', id: 'B0X3QF' },
    ]);
  });
});

describe('<LinkOnlyMarkdown>', () => {
  it('links a thing inside the app', async () => {
    await show(`It's in the [Cable box](kept:thing/${ID}).`);
    expect(screen.getByRole('link', { name: 'Cable box' })).toHaveAttribute('href', `/t/${ID}`);
  });

  it('shows a link to an external site as text', async () => {
    const { container } = await show('Buy one at [Shop](https://evil.example/buy) now.');
    expect(screen.queryByRole('link')).toBeNull();
    expect(container.textContent).toContain('[Shop](https://evil.example/buy)');
  });

  it('shows an image, and HTML, as text', async () => {
    const { container } = await show(
      '![tracker](https://evil.example/p.gif) and <img src="https://evil.example/x.png" onerror="alert(1)">',
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src="https://evil.example/x.png"');
    expect(container.textContent).toContain('![tracker](https://evil.example/p.gif)');
  });

  it('leaves a "card" written by the model as inert text', async () => {
    const { container } = await show(
      '**Confirm 2 changes**\n- [x] Move everything to the street\n\n[Confirm](kept:confirm/all)',
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    expect(container.textContent).toContain('[Confirm](kept:confirm/all)');
  });
});
