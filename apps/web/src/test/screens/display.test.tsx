/**
 * Settings → Me → Display (D203, D204) and a location's languages (D41, D204): the language
 * dropdown with flags and each language's own name, the theme with System first, digits only in
 * Arabic, the content width, the sign-in pages' picker, and French, German and Italian screens.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IDS, signedOutScenario } from '@/api/mock/fixtures';
import { paths } from '@/api/paths';
import { findHeading, renderApp } from '@/test/app';
import { expectLogicalOnly } from '@/test/render';

vi.setConfig({ testTimeout: 20_000 });

/** No native picker is ever shown: React Aria's hidden <select> only serves autofill. */
function expectNoVisibleNativeSelect() {
  for (const select of document.querySelectorAll('select'))
    expect(select.closest('[aria-hidden="true"]'), 'a native <select> is visible').not.toBeNull();
}

describe('Settings → Me → Display', () => {
  it('picks the interface language from a dropdown of flags and own names', async () => {
    const { user } = await renderApp('/settings');
    await findHeading('Settings');
    expect(screen.getByRole('heading', { name: 'Display' })).toBeInTheDocument();
    const trigger = screen.getByRole('button', { name: /Language/ });
    expect(within(trigger).getByText('English')).toHaveAttribute('lang', 'en');
    await user.click(trigger);
    const list = await screen.findByRole('listbox');
    const options = within(list).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      'English',
      'العربية',
      'Français',
      'Deutsch',
      'Italiano',
    ]);
    // A flag (SVG, never an emoji) beside every name, marked decorative.
    for (const o of options) {
      const flag = o.querySelector('svg[data-flag]');
      expect(flag).not.toBeNull();
      expect(flag).toHaveAttribute('aria-hidden', 'true');
    }
    expect(options[1]?.querySelector('[lang="ar"]')).toHaveAttribute('dir', 'rtl');
    await user.click(within(list).getByRole('option', { name: 'Français' }));
    await findHeading('Paramètres');
    expect(localStorage.getItem('kept.locale')).toBe('fr');
    expect(document.documentElement.lang).toBe('fr');
    expect(document.documentElement.dir).toBe('ltr');
    expectNoVisibleNativeSelect();
    expectLogicalOnly();
  });

  it('switches to German and Italian, and back to Arabic right to left', async () => {
    const { user } = await renderApp('/settings');
    await findHeading('Settings');
    await user.click(screen.getByRole('button', { name: /Language/ }));
    await user.click(await screen.findByRole('option', { name: 'Deutsch' }));
    await findHeading('Einstellungen');
    await user.click(screen.getByRole('button', { name: /Sprache/ }));
    await user.click(await screen.findByRole('option', { name: 'Italiano' }));
    await findHeading('Impostazioni');
    await user.click(screen.getByRole('button', { name: /Lingua/ }));
    await user.click(await screen.findByRole('option', { name: 'العربية' }));
    await findHeading('الإعدادات');
    expect(document.documentElement.dir).toBe('rtl');
  });

  it('shows the digits choice only when the interface is Arabic', async () => {
    await renderApp('/settings', { locale: 'fr' });
    await findHeading('Paramètres');
    expect(screen.queryByRole('radio', { name: '0123' })).toBeNull();
    cleanup();
    await renderApp('/settings', { locale: 'ar' });
    await findHeading('الإعدادات');
    expect(screen.getByRole('radio', { name: '0123' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '٠١٢٣' })).toBeInTheDocument();
  });

  it('offers System, Light and Dark, with System the default', async () => {
    const { user } = await renderApp('/settings');
    await findHeading('Settings');
    const theme = screen.getByRole('radiogroup', { name: 'Theme' });
    expect(
      within(theme)
        .getAllByRole('radio')
        .map((r) => r.closest('label')?.textContent),
    ).toEqual(['System', 'Light', 'Dark']);
    expect(within(theme).getByRole('radio', { name: 'System' })).toBeChecked();
    expect(screen.getByText('Follows this device’s light or dark setting.')).toBeInTheDocument();
    await user.click(within(theme).getByRole('radio', { name: 'Dark' }));
    expect(localStorage.getItem('kept.theme')).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    await user.click(within(theme).getByRole('radio', { name: 'System' }));
    expect(localStorage.getItem('kept.theme')).toBeNull();
  });

  it('sets the content width for this device, Centered by default', async () => {
    const { user } = await renderApp('/settings');
    await findHeading('Settings');
    const width = screen.getByRole('radiogroup', { name: 'Content width' });
    expect(within(width).getByRole('radio', { name: 'Centered' })).toBeChecked();
    await user.click(within(width).getByRole('radio', { name: 'Full width' }));
    expect(localStorage.getItem('kept.width')).toBe('full');
    expect(document.documentElement.dataset.width).toBe('full');
    // Me is one tab of Settings: it fills like Account and Admin, so the tabs keep one width.
    expect(document.querySelector('[data-slot="page-body"]')).toHaveClass('page-fill');
    await user.click(within(width).getByRole('radio', { name: 'Centered' }));
    expect(localStorage.getItem('kept.width')).toBeNull();
    expect(document.documentElement.dataset.width).toBe('centered');
  });

  it('lets lists, search, activity and trash use the width; forms keep theirs', async () => {
    for (const path of ['/activity', '/search', '/trash', `/loc/${IDS.home}`]) {
      await renderApp(path);
      await waitFor(() =>
        expect(document.querySelector('[data-slot="page-body"]')).toHaveClass('page-fill'),
      );
      cleanup();
    }
    await renderApp('/settings/two-factor');
    await waitFor(() =>
      expect(document.querySelector('[data-slot="page-body"]')).not.toHaveClass('page-fill'),
    );
  });

  // Before, Me, Locations, AI, Connections, Import, Export and a location's settings kept the
  // centered column while Account and Admin filled, so under Full width the tab strip jumped
  // between a centered 720 px row and the whole width on every switch.
  it.each([
    ['/settings', 'Settings'],
    ['/settings/locations', 'Settings'],
    ['/settings/ai', 'Settings'],
    ['/settings/connections', 'Settings'],
    ['/settings/import', 'Settings'],
    ['/settings/export', 'Settings'],
    ['/settings/account/types', 'Account'],
    ['/admin/users', 'Instance admin'],
    [`/settings/location/${IDS.home}/general`, 'Location settings'],
    [`/settings/location/${IDS.home}/track`, 'Location settings'],
    [`/settings/location/${IDS.home}/webhooks`, 'Location settings'],
  ])('fills every tab of a tabbed section, so its tabs keep one width: %s', async (path, strip) => {
    await renderApp(path);
    const tabs = await screen.findByRole('navigation', { name: strip }, { timeout: 10_000 });
    const body = document.querySelector('[data-slot="page-body"]');
    expect(body).toContainElement(tabs);
    expect(body).toHaveClass('page-fill');
  });
});

describe('the sign-in pages', () => {
  it('pick the language from the same dropdown, in a small trigger', async () => {
    const { user } = await renderApp('/signin', { state: signedOutScenario() });
    await findHeading('Sign in to Kept');
    const trigger = await screen.findByRole('button', { name: /Language/ });
    await user.click(trigger);
    await user.click(await screen.findByRole('option', { name: 'Deutsch' }));
    await waitFor(() => expect(document.documentElement.lang).toBe('de'));
    expect(localStorage.getItem('kept.locale')).toBe('de');
    expectNoVisibleNativeSelect();
  });
});

describe('Location settings → General: the name', () => {
  it('renames the location with If-Match, and the sidebar follows', async () => {
    const { user, mock } = await renderApp(`/settings/location/${IDS.home}/general`, {
      setup: (m) => {
        const loc = m.state.locations.find((l) => l.id === IDS.home);
        if (loc) loc.rowVersion = 3;
      },
    });
    await findHeading('General');
    const field = screen.getByRole('textbox', { name: 'Location name' });
    const rename = screen.getByRole('button', { name: 'Rename' });
    expect(rename).toBeDisabled();
    await user.clear(field);
    expect(rename).toBeDisabled();
    expect(screen.getByText('Give it a name.')).toBeInTheDocument();
    await user.type(field, '  Our flat ');
    await user.click(rename);
    await waitFor(() => expect(mock.lastCall('PATCH', paths.location(IDS.home))).toBeDefined());
    const call = mock.lastCall('PATCH', paths.location(IDS.home));
    expect(call?.body).toEqual({ name: 'Our flat' });
    expect(call?.headers['if-match']).toBe('3');
    expect(await screen.findByText('Renamed to Our flat')).toBeInTheDocument();
    expectLogicalOnly();
  });
});

describe('Location settings → General: languages (D41)', () => {
  it('chooses several languages with flags and saves them with If-Match', async () => {
    const { user, mock } = await renderApp(`/settings/location/${IDS.home}/general`, {
      setup: (m) => {
        const loc = m.state.locations.find((l) => l.id === IDS.home);
        if (loc) loc.rowVersion = 7;
      },
    });
    await findHeading('General');
    const trigger = screen.getByRole('button', { name: /Languages spoken here/ });
    await user.click(trigger);
    const list = await screen.findByRole('listbox');
    expect(list).toHaveAttribute('aria-multiselectable', 'true');
    await user.click(within(list).getByRole('option', { name: 'Français' }));
    await user.click(within(list).getByRole('option', { name: 'العربية' }));
    await user.keyboard('{Escape}');
    expect(within(trigger).getByText('Français')).toBeInTheDocument();
    expect(trigger.querySelectorAll('svg[data-flag]')).toHaveLength(2);
    // The languages' Save, the first on the page (own codes have their own below, D208).
    await user.click(screen.getAllByRole('button', { name: 'Save' })[0] as HTMLElement);
    await waitFor(() => expect(mock.lastCall('PATCH', paths.location(IDS.home))).toBeDefined());
    const call = mock.lastCall('PATCH', paths.location(IDS.home));
    expect(call?.body).toEqual({ languages: ['fr', 'ar'] });
    expect(call?.headers['if-match']).toBe('7');
    expectNoVisibleNativeSelect();
    expectLogicalOnly();
  });

  it('keeps a stored regional tag and tags outside the five', async () => {
    const { user, mock } = await renderApp(`/settings/location/${IDS.home}/general`, {
      setup: (m) => {
        const loc = m.state.locations.find((l) => l.id === IDS.home);
        if (loc) loc.languages = ['ar-EG', 'es'];
      },
    });
    await findHeading('General');
    const trigger = screen.getByRole('button', { name: /Languages spoken here/ });
    expect(within(trigger).getByText('العربية')).toBeInTheDocument();
    await user.click(trigger);
    await user.click(await screen.findByRole('option', { name: 'Italiano' }));
    await user.keyboard('{Escape}');
    // The languages' Save, the first on the page (own codes have their own below, D208).
    await user.click(screen.getAllByRole('button', { name: 'Save' })[0] as HTMLElement);
    await waitFor(() =>
      expect(mock.lastCall('PATCH', paths.location(IDS.home))?.body).toEqual({
        languages: ['ar-EG', 'es', 'it'],
      }),
    );
  });
});

describe('French, German and Italian screens', () => {
  it('read in the chosen language, with built-in names translated', async () => {
    await renderApp('/', { locale: 'fr' });
    await findHeading('Accueil');
    cleanup();
    await renderApp('/', { locale: 'de' });
    await findHeading('Start');
    cleanup();
    await renderApp('/settings/account/types', { locale: 'it' });
    // A built-in type's name comes from @kept/shared's table (D204), not the English.
    expect(await screen.findByText('Elettrodomestico', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('it');
  });
});
