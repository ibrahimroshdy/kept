/** The separator between a line's parts (UI step-4 review L1): "·" reads as the zero "٠" beside
 * an Eastern digit, so Arabic uses its comma, in the catalogue and in lines built in code. */
import { i18n, type Messages } from '@lingui/core';
import { afterEach, describe, expect, it } from 'vitest';
import { activateLocale } from '@/i18n/i18n';
import { localiseSeparators, makeFormatter, sep, separatorFor } from './format';
import { formatLocale } from './prefs';

afterEach(async () => {
  await activateLocale('en');
});

describe('the separator', () => {
  it('is " · " in the other languages and the Arabic comma in Arabic, whatever the digits', () => {
    expect(separatorFor('en')).toBe(' · ');
    expect(separatorFor('fr', { keep: true })).toBe(' · ');
    expect(separatorFor('ar')).toBe('، ');
    expect(makeFormatter(formatLocale('ar', 'eastern')).sep).toBe('، ');
    expect(makeFormatter(formatLocale('ar', 'western')).sep).toBe('، ');
    expect(makeFormatter('de').sep).toBe(' · ');
  });

  it('follows the language being read, for lines built in code', async () => {
    expect(sep()).toBe(' · ');
    await activateLocale('ar');
    expect(sep()).toBe('، ');
    expect(sep({ keep: true })).toBe('، ');
  });

  it('replaces the catalogue\'s " · " in Arabic, inside plural choices too', () => {
    // Compiled as @lingui/vite-plugin compiles the .po: text and tokens, choices as messages.
    const messages = {
      a: ['الضمانات · ', ['0']],
      b: [['n', 'plural', { one: ['صندوق · واحد'], other: ['صندوق · كثير'], offset: undefined }]],
      c: ['· موروث'],
    } as unknown as Messages;
    const ar = localiseSeparators(messages, 'ar');
    i18n.load('ar-test', ar);
    i18n.activate('ar-test');
    // By a variable, so Lingui's extractor doesn't take these test ids for the app's messages.
    const say = (id: keyof typeof messages, values?: Record<string, unknown>) => i18n._(id, values);
    expect(say('a', { 0: '٢' })).toBe('الضمانات، ٢');
    expect(say('b', { n: 3 })).toBe('صندوق، كثير');
    expect(say('c')).toBe('، موروث');
    expect(localiseSeparators(messages, 'en')).toBe(messages);
  });

  it('reaches every Arabic message: none keeps the dot', async () => {
    await activateLocale('ar');
    const all = JSON.stringify(Object.values(i18n.messages));
    expect(all).not.toContain('·');
  });
});
