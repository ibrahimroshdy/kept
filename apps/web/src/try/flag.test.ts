/** Try Kept (D246): the flag is off in every other build, and the docs links walk back right. */
import { describe, expect, it } from 'vitest';
import { docsUrl, TRY } from './flag';

describe('Try Kept flag and docs links', () => {
  it('is off outside the Try build', () => {
    expect(TRY).toBe(false);
  });

  it('links to the docs page from the app under the docs site base', () => {
    expect(docsUrl('/install/compose/', 'en', '/try/kept/app/')).toBe('/install/compose/');
    expect(docsUrl('/install/compose/', 'ar', '/try/kept/app/')).toBe('/ar/install/compose/');
    expect(docsUrl('install/compose/', 'fr', '/kept/try/kept/app/')).toBe('/kept/install/compose/');
    expect(docsUrl('/install/compose/', 'ar', '/kept/try/kept/app/')).toBe(
      '/kept/ar/install/compose/',
    );
  });
});
