/** Try Kept's banner (D246): what this is, Reset, and Install Kept in the interface's language. */
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '@/lib/prefs';
import { expectLogicalOnly, renderUI } from '@/test/render';
import { TryBanner } from './banner';

afterEach(() => setLocale('en'));

describe('TryBanner', () => {
  it('renders nothing outside the Try build', async () => {
    await renderUI(<TryBanner />);
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('says it is a sample, resets, and links to the install page', async () => {
    const onReset = vi.fn();
    const { user } = await renderUI(<TryBanner show onReset={onReset} />);
    expect(screen.getByRole('note')).toHaveTextContent(
      'A sample household in your browser. Nothing is saved.',
    );
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    expect(onReset).toHaveBeenCalledOnce();
    // Vite's base in a test is `/`; on the docs site it is /try/kept/app/ (flag.test.ts).
    expect(screen.getByRole('link', { name: 'Install Kept' })).toHaveAttribute(
      'href',
      '/install/compose/',
    );
    expectLogicalOnly();
  });

  it('links to the Arabic install page in Arabic', async () => {
    setLocale('ar');
    await renderUI(<TryBanner show onReset={() => {}} />, { locale: 'ar' });
    expect(screen.getByRole('button', { name: 'إعادة تعيين' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'ثبّت Kept' })).toHaveAttribute(
      'href',
      '/ar/install/compose/',
    );
  });
});
