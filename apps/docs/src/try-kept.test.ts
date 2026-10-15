import { describe, expect, it } from 'vitest';
import { TRY_APP_PATH, tryAppBase, tryAppHref } from './try-kept';

describe('Try Kept paths (D246)', () => {
  it('puts the app under the docs site base', () => {
    expect(tryAppBase('/')).toBe('/try/kept/app/');
    expect(tryAppBase('')).toBe('/try/kept/app/');
    expect(tryAppBase('/kept')).toBe('/kept/try/kept/app/');
    expect(tryAppBase('/kept/')).toBe('/kept/try/kept/app/');
    expect(tryAppBase('kept')).toBe('/kept/try/kept/app/');
  });

  it('opens the app in the page language', () => {
    expect(tryAppHref('/', 'en')).toBe('/try/kept/app/?lang=en');
    expect(tryAppHref('/kept/', 'ar')).toBe('/kept/try/kept/app/?lang=ar');
  });

  it('matches the path the web app walks back from', () => {
    // apps/web/src/try/flag.ts docsUrl() strips exactly this from its base.
    expect(TRY_APP_PATH).toBe('try/kept/app/');
  });
});
