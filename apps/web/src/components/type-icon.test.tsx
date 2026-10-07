import { render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { resolveIcon, STATIC_ICONS, TypeIcon } from './type-icon';

const svgOf = (el: HTMLElement) => el.querySelector('svg') as SVGElement;

describe('TypeIcon (D98)', () => {
  it('resolves a static Lucide icon', () => {
    const { container } = render(<TypeIcon icon="lucide:cable" />);
    const svg = svgOf(container);
    expect(svg).toHaveClass('lucide-cable');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('data-icon', 'lucide:cable');
  });

  it('resolves a Tabler icon', () => {
    const { container } = render(<TypeIcon icon="tabler:hanger" />);
    expect(svgOf(container)).toHaveClass('tabler-icon-hanger');
  });

  it("resolves Kept's own safe", () => {
    const { container } = render(<TypeIcon icon="kept:safe" className="size-8" />);
    expect(svgOf(container)).toHaveAttribute('data-icon', 'kept:safe');
    expect(svgOf(container)).toHaveClass('size-8');
  });

  it.each([null, undefined, '', 'tabler:not-a-real-icon', 'kept:nope', 'lucide:Bad Name', 'x'])(
    'falls back to the box for %j',
    (icon) => {
      const { container } = render(<TypeIcon icon={icon} />);
      expect(svgOf(container)).toHaveClass('lucide-box');
    },
  );

  it('loads any other Lucide icon lazily, showing the box meanwhile', async () => {
    expect(resolveIcon('lucide:guitar')).toEqual({ source: 'dynamic', name: 'guitar' });
    const { container } = render(<TypeIcon icon="lucide:guitar" />);
    await waitFor(() => expect(svgOf(container)).toHaveClass('lucide-guitar'), { timeout: 3000 });
  });

  it('an unknown Lucide name settles on the box', async () => {
    const { container } = render(<TypeIcon icon="lucide:no-such-icon-anywhere" />);
    await waitFor(() => expect(svgOf(container)).not.toHaveAttribute('data-icon-loading'));
    expect(svgOf(container)).toHaveClass('lucide-box');
  });

  it('every static reference is well formed', () => {
    for (const ref of Object.keys(STATIC_ICONS))
      expect(ref).toMatch(/^(lucide|tabler|kept):[a-z0-9]+(-[a-z0-9]+)*$/);
  });
});
