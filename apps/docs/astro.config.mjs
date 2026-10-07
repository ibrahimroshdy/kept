// Kept's documentation site (D102, D199): Starlight, built to static files in dist/.
//
// Five locales (plan Q19): English at the root and complete; Arabic right to left, with the key
// pages written in Arabic; French, German and Italian fall back to English under Starlight's own
// "not translated yet" notice until the translation platform (D106) fills them in.
//
// The API reference is generated at build time from Kept's own OpenAPI document
// (scripts/openapi.ts, no database needed), into the git-ignored openapi/kept.json. The
// configuration reference is generated from the server's env schema into a committed page
// (scripts/env-reference.ts) so a drift check can compare them.
//
// The look is Kept's own kit (D131, D132, D135): the app's design tokens are loaded from
// apps/web/src/styles/tokens.css itself, so the docs and the app share one set of colours in both
// themes; src/styles/kept.css maps Starlight onto them, and the site title and the landing hero
// are component overrides (src/components/), as is the language menu (a flag beside each
// language, and a disclosure of links instead of Starlight's native <select>). Screenshots on
// the landing page are the app's demo build (fixture data, the Arabic household on Arabic pages),
// committed as small WebP files in src/assets/screens/.
//
// A link to the site shares as a card (src/route-data.ts): the image is public/social-card.png
// (public/social-card-ar.png on Arabic pages), drawn by scripts/render-social-preview.mjs.
//
// Nothing here loads a remote font, script or stylesheet. Astro's telemetry is turned off by the
// package scripts (ASTRO_TELEMETRY_DISABLED=1), so a build makes no network call at all.
//
// Publishing (D199, .github/workflows/docs.yml): the site lives at https://ibrahimroshdy.com/kept/,
// a GitHub Pages project site under the maintainer's user site and its custom domain. The workflow
// passes that origin and base path as KEPT_DOCS_SITE and KEPT_DOCS_BASE; a local build has neither
// and is served from `/`.
import { satteri } from '@astrojs/markdown-satteri';
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import { defineMdastPlugin } from 'satteri';
import starlightLinksValidator from 'starlight-links-validator';
import starlightOpenAPI, { openAPISidebarGroups } from 'starlight-openapi';
import { locales } from './src/locales.mjs';

const site = process.env.KEPT_DOCS_SITE || undefined;
const base = process.env.KEPT_DOCS_BASE || '/';
const prefix = base.replace(/\/+$/, '');

// Pages link to each other as `/install/compose/`. Astro doesn't add the base path to Markdown
// links, so under a base this adds it, before the link check reads them (the check expects
// links that include the base).
const baseLinks = defineMdastPlugin({
  name: 'kept-base-links',
  link(node, ctx) {
    const url = node.url;
    if (url.startsWith('/') && !url.startsWith('//') && !url.startsWith(`${prefix}/`)) {
      ctx.setProperty(node, 'url', `${prefix}${url}`);
    }
  },
});

/** A sidebar group with its Arabic label; the other locales show the English one. */
const group = (label, ar, items, extra = {}) => ({ label, translations: { ar }, items, ...extra });
/** A page in the sidebar, under its own title. */
const page = (slug) => slug;
/** A group filled from a directory, in each page's `sidebar.order`. */
const dir = (directory) => [{ autogenerate: { directory } }];

// Four audiences (go-public plan §2): people who use Kept, people who run it, people who build
// on it, and people who maintain it. Pages keep their URLs (install/, admin/, reference/); the
// sidebar groups them by who reads them.
const sidebar = [
  group('Use Kept', 'استخدام Kept', [
    group('Install', 'التثبيت', dir('install')),
    page('users/first-run'),
    page('users/everyday-use'),
    page('users/phone-app'),
    page('users/ai-providers'),
    page('admin/ollama'),
    page('users/mcp-clients'),
    page('users/import-export'),
    group('Backups and restore', 'النسخ الاحتياطي والاستعادة', [
      page('admin/backups'),
      page('admin/restore'),
      page('admin/read-with-restic'),
      page('admin/move-server'),
    ]),
    page('users/faq'),
  ]),
  group('Run Kept', 'تشغيل Kept', [
    page('reference/configuration'),
    page('admin/upgrades'),
    page('admin/verify-release'),
    page('admin/observability'),
    page('admin/recovery-kit'),
    page('admin/security-model'),
    page('admin/storage'),
    page('admin/notifications'),
    page('admin/cli'),
    page('admin/troubleshooting'),
    page('admin/uninstall'),
  ]),
  group('Build on Kept', 'التطوير', [
    page('developers/architecture'),
    page('developers/monorepo'),
    page('developers/local-setup'),
    page('developers/data-model'),
    page('developers/rls'),
    page('developers/migrations'),
    page('developers/auth'),
    page('developers/api'),
    page('developers/offline-sync'),
    page('developers/ai-providers'),
    page('developers/mcp'),
    page('developers/i18n-rtl'),
    page('developers/ui-kit'),
    page('developers/testing'),
    page('developers/feature-walkthrough'),
  ]),
  group('Maintain Kept', 'صيانة المشروع', [
    page('maintainers/releasing'),
    page('maintainers/signing'),
    page('maintainers/changelog'),
    page('maintainers/triage'),
    page('maintainers/security'),
    page('maintainers/dco'),
    page('maintainers/decisions'),
    page('maintainers/runbooks'),
  ]),
];

export default defineConfig({
  site,
  base,
  markdown: { processor: satteri({ mdastPlugins: prefix ? [baseLinks] : [] }) },
  integrations: [
    starlight({
      title: 'Kept',
      description:
        'A self-hosted, open-source inventory of everything you own and where it is. Built-in AI assistant and MCP server.',
      logo: { src: './src/assets/logo.svg', alt: 'Kept' },
      favicon: '/favicon.svg',
      defaultLocale: 'root',
      locales,
      components: {
        SiteTitle: './src/components/SiteTitle.astro',
        Hero: './src/components/Hero.astro',
        LanguageSelect: './src/components/language/LanguageSelect.astro',
      },
      // The share card: og:image and twitter:image (absolute, from `site` and `base`), og:locale
      // per language, og:type website on the landing pages.
      routeMiddleware: './src/route-data.ts',
      customCss: [
        '@fontsource/ibm-plex-sans/400.css',
        '@fontsource/ibm-plex-sans/500.css',
        '@fontsource/ibm-plex-sans/600.css',
        '@fontsource/ibm-plex-sans-arabic/400.css',
        '@fontsource/ibm-plex-sans-arabic/600.css',
        '@fontsource/ibm-plex-mono/400.css',
        '@fontsource/ibm-plex-mono/600.css',
        '../web/src/styles/tokens.css',
        './src/styles/kept.css',
      ],
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/ibrahimroshdy/kept' }],
      plugins: [
        // fr/de/it are fallback pages by design (Q19), so links into them must not fail. The API
        // reference is injected routes the validator can't see, so links to it aren't checked
        // (spike D1, findings 2 and 3). Under a base path, a root-relative link without the base
        // can only be a landing page's hero action (frontmatter, which baseLinks can't reach;
        // Hero.astro adds the base when it renders them): those are checked by a build without a
        // base (`pnpm docs:build` locally), not by this one.
        starlightLinksValidator({
          errorOnFallbackPages: false,
          exclude: ({ link }) =>
            link === `${prefix}/api/` ||
            link.startsWith(`${prefix}/api/`) ||
            (prefix !== '' && link.startsWith('/') && !link.startsWith(`${prefix}/`)),
        }),
        starlightOpenAPI([
          {
            base: 'api',
            schema: './openapi/kept.json',
            sidebar: { label: 'API reference' },
          },
        ]),
      ],
      sidebar: [...sidebar, ...openAPISidebarGroups],
    }),
  ],
});
