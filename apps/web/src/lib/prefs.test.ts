/**
 * Device preferences (D143, D203, D204): the five languages, their Intl tags, content width, and
 * the pre-paint script in index.html, which must make the same choices before React loads.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import indexHtml from '../../index.html?raw';
import {
  formatLocale,
  initialLocale,
  isLocale,
  LOCALES,
  localeOfTag,
  setThemePref,
  setWidthPref,
  storedWidthPref,
  THEME_KEY,
  WIDTH_KEY,
  watchSystemTheme,
} from './prefs';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  setWidthPref('centered');
  setThemePref('system');
});

describe('languages (D204)', () => {
  it('has the five launch languages, and knows a tag by its language', () => {
    expect(LOCALES).toEqual(['en', 'ar', 'fr', 'de', 'it']);
    expect(isLocale('it')).toBe(true);
    expect(isLocale('es')).toBe(false);
    expect(localeOfTag('ar-EG')).toBe('ar');
    expect(localeOfTag('fr_CA')).toBe('fr');
    expect(localeOfTag('DE-at')).toBe('de');
    expect(localeOfTag('es-ES')).toBeNull();
  });

  it('formats in the language itself; only Arabic carries a numbering system', () => {
    expect(formatLocale('fr', 'eastern')).toBe('fr');
    expect(formatLocale('de', 'western')).toBe('de');
    expect(formatLocale('it', 'eastern')).toBe('it');
    expect(formatLocale('en', 'eastern')).toBe('en');
    expect(formatLocale('ar', 'eastern')).toBe('ar-u-nu-arab');
    expect(formatLocale('ar', 'western')).toBe('ar-u-nu-latn');
    // Plurals and dates follow the locale through Intl.
    expect(new Intl.NumberFormat(formatLocale('de', 'western')).format(1234.5)).toBe('1.234,5');
  });

  it('starts in the stored language, else the browser’s when it is one of the five', () => {
    vi.stubGlobal('navigator', { language: 'it-IT' });
    expect(initialLocale()).toBe('it');
    vi.stubGlobal('navigator', { language: 'es-ES' });
    expect(initialLocale()).toBe('en');
    localStorage.setItem('kept.locale', 'de');
    expect(initialLocale()).toBe('de');
    localStorage.setItem('kept.locale', 'xx');
    vi.stubGlobal('navigator', { language: 'fr' });
    expect(initialLocale()).toBe('fr');
  });
});

describe('content width (D203)', () => {
  it('stores Full width, forgets Centered, and marks the document', () => {
    expect(storedWidthPref()).toBe('centered');
    setWidthPref('full');
    expect(localStorage.getItem(WIDTH_KEY)).toBe('full');
    expect(document.documentElement.dataset.width).toBe('full');
    expect(storedWidthPref()).toBe('full');
    setWidthPref('centered');
    expect(localStorage.getItem(WIDTH_KEY)).toBeNull();
    expect(document.documentElement.dataset.width).toBe('centered');
  });
});

describe('theme (D204)', () => {
  it('follows the device live while the choice is System', () => {
    let dark = false;
    const listeners = new Set<() => void>();
    vi.stubGlobal('matchMedia', (q: string) => ({
      get matches() {
        return q === '(prefers-color-scheme: dark)' && dark;
      },
      media: q,
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
    }));
    setThemePref('system');
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
    const stop = watchSystemTheme();
    expect(document.documentElement.dataset.theme).toBe('light');
    dark = true;
    for (const l of listeners) l();
    expect(document.documentElement.dataset.theme).toBe('dark');
    // A fixed choice ignores the device.
    setThemePref('light');
    for (const l of listeners) l();
    expect(document.documentElement.dataset.theme).toBe('light');
    stop();
    expect(listeners.size).toBe(0);
  });
});

describe('the pre-paint script (index.html)', () => {
  // The inline script that reads the stored preferences (index.html also has zod's config).
  const script =
    [...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)]
      .map((m) => m[1] ?? '')
      .find((body) => body.includes('kept.theme')) ?? '';

  function prePaint(stored: Record<string, string>, language = 'en-GB') {
    localStorage.clear();
    for (const [k, v] of Object.entries(stored)) localStorage.setItem(k, v);
    vi.stubGlobal('navigator', { language });
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(min-width: 1024px)' }));
    const d = document.documentElement;
    for (const a of ['data-theme', 'data-width', 'lang', 'dir']) d.removeAttribute(a);
    new Function(script)();
    return {
      width: d.getAttribute('data-width'),
      lang: d.getAttribute('lang'),
      dir: d.getAttribute('dir'),
    };
  }

  it('applies the stored width and language before React loads', () => {
    expect(script).toContain('kept.width');
    expect(prePaint({ 'kept.width': 'full', 'kept.locale': 'de' })).toEqual({
      width: 'full',
      lang: 'de',
      dir: 'ltr',
    });
    expect(prePaint({ 'kept.locale': 'ar' })).toEqual({
      width: 'centered',
      lang: 'ar',
      dir: 'rtl',
    });
  });

  it('falls back to the browser language when it is one of the five, else English', () => {
    expect(prePaint({}, 'fr-CA').lang).toBe('fr');
    expect(prePaint({}, 'it').lang).toBe('it');
    expect(prePaint({}, 'es-ES').lang).toBe('en');
    expect(prePaint({ 'kept.width': 'wide' }).width).toBe('centered');
  });
});
