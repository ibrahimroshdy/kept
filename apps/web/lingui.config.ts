import { defineConfig } from '@lingui/cli';
import { formatter } from '@lingui/format-po';

export default defineConfig({
  sourceLocale: 'en',
  locales: ['en', 'ar', 'fr', 'de', 'it'],
  // PO for translators (D96, Weblate). No line numbers, so catalogues don't churn on every edit.
  format: formatter({ lineNumbers: false }),
  catalogs: [
    {
      path: '<rootDir>/src/locales/{locale}/messages',
      include: ['src'],
      exclude: ['**/*.test.tsx', '**/routeTree.gen.ts'],
    },
  ],
});
