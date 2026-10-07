// Spike D1: Starlight with five locales (en at the root, ar RTL, fr/de/it falling back to English),
// Pagefind (Starlight's default), the API reference from Kept's own OpenAPI JSON, and the link check.
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import starlightLinksValidator from 'starlight-links-validator';
import starlightOpenAPI, { openAPISidebarGroups } from 'starlight-openapi';

// SPIKE_NO_API=1 builds without the API reference (to time the prose site alone).
const withApi = process.env.SPIKE_NO_API !== '1';

export default defineConfig({
  site: 'https://docs.kept.example',
  integrations: [
    starlight({
      title: 'Kept',
      defaultLocale: 'root',
      locales: {
        root: { label: 'English', lang: 'en' },
        ar: { label: 'العربية', lang: 'ar', dir: 'rtl' },
        fr: { label: 'Français', lang: 'fr' },
        de: { label: 'Deutsch', lang: 'de' },
        it: { label: 'Italiano', lang: 'it' },
      },
      plugins: [
        // fr/de/it are fallback pages by design (Q19), so links to them must not error. The API
        // reference is injected routes (starlight-openapi), which the validator can't see: excluded.
        starlightLinksValidator({ errorOnFallbackPages: false, exclude: ['/api/', '/api/**'] }),
        ...(withApi
          ? [
              starlightOpenAPI([
                { base: 'api', schema: './openapi/kept.json', sidebar: { label: 'API reference' } },
              ]),
            ]
          : []),
      ],
      sidebar: [
        { label: 'Guides', items: [{ autogenerate: { directory: 'guides' } }] },
        ...(withApi ? openAPISidebarGroups : []),
      ],
    }),
  ],
});
