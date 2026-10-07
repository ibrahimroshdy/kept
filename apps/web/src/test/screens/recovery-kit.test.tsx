/**
 * Step 8 T22 (D182, D176): the recovery kit's download from Admin → Status, after
 * re-authentication, on the mock (api/ops/mock/kit.ts).
 */
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ownerScenario } from '@/api/mock/fixtures';
import { opsPaths } from '@/api/ops/paths';
import { renderApp } from '@/test/app';
import { expectLogicalOnly } from '@/test/render';

const created: Blob[] = [];
const createObjectURL = vi.fn((blob: Blob) => {
  created.push(blob);
  return `blob:kit-${created.length}`;
});
const revokeObjectURL = vi.fn();

beforeEach(() => {
  created.length = 0;
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));
  // jsdom doesn't download; the click is what a browser would act on.
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const openSheet = async (locale: 'en' | 'ar' = 'en') => {
  const r = await renderApp('/admin/status', { state: ownerScenario(), locale });
  return r;
};

describe('Admin → Status → the recovery kit (T22)', () => {
  it('a stale kit asks again; a wrong password keeps the sheet open; the kit saves and its URL goes', async () => {
    const { user, mock } = await openSheet();
    expect(await screen.findByText('Changed since you downloaded it')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Download again' }));
    const dialog = screen.getByRole('dialog', { name: 'Download the recovery kit' });
    expect(dialog).toHaveTextContent('Keep it off this server');

    await user.type(within(dialog).getByLabelText('Your password'), 'not it');
    await user.click(within(dialog).getByRole('button', { name: 'Download' }));
    expect(await within(dialog).findByText("That password isn't right.")).toBeInTheDocument();
    expect(createObjectURL).not.toHaveBeenCalled();
    // The field is cleared after each try.
    expect(within(dialog).getByLabelText('Your password')).toHaveValue('');

    await user.type(within(dialog).getByLabelText('Your password'), 'correct horse battery');
    await user.click(within(dialog).getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    expect(mock.lastCall('POST', opsPaths.recoveryKitDownload)?.body).toEqual({
      format: 'text',
      password: 'correct horse battery',
    });
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:kit-1'), {
      timeout: 3000,
    });
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Download the recovery kit' }),
      ).not.toBeInTheDocument(),
    );
    expect(await screen.findByText(/^Downloaded /)).toBeInTheDocument();
    expect(screen.queryByText('Changed since you downloaded it')).not.toBeInTheDocument();
  });

  it('asks for the password when the field is empty', async () => {
    const { user } = await openSheet();
    await user.click(await screen.findByRole('button', { name: 'Download again' }));
    const dialog = screen.getByRole('dialog', { name: 'Download the recovery kit' });
    await user.click(within(dialog).getByRole('button', { name: 'Download' }));
    expect(await within(dialog).findByText('Enter your password.')).toBeInTheDocument();
  });

  it('downloads the printable page', async () => {
    const { user, mock } = await openSheet();
    await user.click(await screen.findByRole('button', { name: 'Download again' }));
    const dialog = screen.getByRole('dialog', { name: 'Download the recovery kit' });
    await user.click(within(dialog).getByRole('radio', { name: 'Printable page' }));
    await user.type(within(dialog).getByLabelText('Your password'), 'correct horse battery');
    await user.click(within(dialog).getByRole('button', { name: 'Download' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', opsPaths.recoveryKitDownload)?.body).toMatchObject({
        format: 'html',
      }),
    );
    await waitFor(() => expect(created[0]?.type).toMatch(/^text\/html/));
  });

  it('lays out right to left with logical properties only', async () => {
    const { user } = await openSheet('ar');
    await waitFor(() => expect(document.documentElement).toHaveAttribute('dir', 'rtl'));
    // English until the Arabic catalogue entry lands, then Arabic.
    await waitFor(() =>
      expect(
        screen
          .getAllByRole('button')
          .some((b) => /Download again|نزّلها مجددًا/.test(b.textContent ?? '')),
      ).toBe(true),
    );
    const tileButton = screen
      .getAllByRole('button')
      .find((b) => /Download again|نزّلها مجددًا/.test(b.textContent ?? ''));
    await user.click(tileButton as HTMLElement);
    const dialog = await screen.findByRole('dialog');
    expectLogicalOnly(dialog);
  });
});
