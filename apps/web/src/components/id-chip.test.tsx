import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '@/app-providers';
import { expectLogicalOnly, renderUI } from '@/test/render';
import { IdChip } from './id-chip';
import { StatusPill } from './status-pill';

function reducedMotion(reduce: boolean) {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: reduce && query.includes('reduce'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
}
afterEach(() => vi.unstubAllGlobals());

describe('IdChip (D134)', () => {
  it('shows the code as printed, 3 + 3, with the full code as its name', async () => {
    reducedMotion(false);
    await renderUI(<IdChip code="7KQ4MZ" />);
    const chip = screen.getByRole('img', { name: '7KQ4MZ' });
    expect(chip).toHaveTextContent('7KQ‑4MZ');
    expect(chip).toHaveAttribute('dir', 'ltr');
    expect(chip.tagName).toBe('BDI');
    expect(chip).toHaveClass('font-mono');
  });

  it('stays left to right inside Arabic', async () => {
    reducedMotion(false);
    await renderUI(<IdChip code="K7Q3FM" />, { locale: 'ar' });
    expect(document.documentElement).toHaveAttribute('dir', 'rtl');
    expect(screen.getByRole('img', { name: 'K7Q3FM' })).toHaveAttribute('dir', 'ltr');
    expectLogicalOnly();
  });

  it('renders nothing until a code is allocated, unless asked to show it pending', async () => {
    reducedMotion(false);
    const { container } = await renderUI(<IdChip code={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('"ID pending" (D112): a dashed chip, announced as "ID pending"', async () => {
    reducedMotion(false);
    await renderUI(<IdChip code={null} pending />);
    const chip = screen.getByRole('img', { name: 'ID pending' });
    expect(chip).toHaveTextContent('ID pending');
    expect(chip).toHaveAttribute('data-pending', 'true');
    expect(chip).toHaveClass('border-dashed');
    expect(chip).not.toHaveClass('font-mono');
  });

  it('"ID pending" in Arabic keeps logical CSS, and the code prints when it arrives', async () => {
    reducedMotion(false);
    const { rerender } = await renderUI(<IdChip code={null} pending />, { locale: 'ar' });
    expectLogicalOnly();
    rerender(
      <AppProviders locale="ar">
        <IdChip code="7KQ4MZ" pending />
      </AppProviders>,
    );
    const chip = screen.getByRole('img', { name: '7KQ4MZ' });
    expect(chip).toHaveAttribute('data-printing', 'true');
  });

  it('animates like printed tape once, when the code arrives (D195)', async () => {
    reducedMotion(false);
    const { rerender } = await renderUI(<IdChip code={null} />);
    rerender(
      <AppProviders locale="en">
        <IdChip code="7KQ4MZ" />
      </AppProviders>,
    );
    expect(screen.getByRole('img')).toHaveAttribute('data-printing', 'true');
  });

  it('does not animate a code that was already there, or under reduced motion', async () => {
    reducedMotion(false);
    const { unmount } = await renderUI(<IdChip code="7KQ4MZ" />);
    expect(screen.getByRole('img')).not.toHaveAttribute('data-printing');
    unmount();
    reducedMotion(true);
    await renderUI(<IdChip code="7KQ4MZ" fresh />);
    expect(screen.getByRole('img')).not.toHaveAttribute('data-printing');
  });

  it('animates a fresh code on mount (a thing just created)', async () => {
    reducedMotion(false);
    await renderUI(<IdChip code="7KQ4MZ" fresh />);
    expect(screen.getByRole('img')).toHaveAttribute('data-printing', 'true');
  });
});

describe('StatusPill (screens §4: never colour alone)', () => {
  it.each([
    ['uncertain', 'Not sure where'],
    ['draft', 'Draft'],
    ['ended', 'Ended'],
    ['needs_review', 'Needs review'],
  ] as const)('%s has an icon and a word', async (state, word) => {
    await renderUI(<StatusPill state={state} />);
    const pill = screen.getByText(word).closest('[data-status]') as HTMLElement;
    expect(pill).toHaveAttribute('data-status', state);
    expect(pill.querySelector('svg')).not.toBeNull();
  });

  it('an ended pill can name the lifecycle', async () => {
    await renderUI(<StatusPill state="ended" label="Given away" />);
    expect(screen.getByText('Given away')).toBeInTheDocument();
  });

  it('in Arabic', async () => {
    await renderUI(<StatusPill state="draft" />, { locale: 'ar' });
    expectLogicalOnly();
  });
});
