/**
 * Starlight route middleware (astro.config.mjs, `routeMiddleware`): the share card. Starlight
 * already writes og:title, og:description, og:site_name ("Kept") and twitter:card
 * (summary_large_image) for every page; this adds what a pasted link needs to show a picture, and
 * corrects what Starlight can't know:
 *
 * - og:image, its size, type and alt, and twitter:image: the card from
 *   scripts/render-social-preview.mjs in public/, the Arabic one on Arabic pages. The URL must be
 *   absolute, so it is built from the configured `site` and base path (KEPT_DOCS_SITE and
 *   KEPT_DOCS_BASE); a build without a site (a local one) has no og:image.
 * - og:locale as language_TERRITORY (Starlight writes the bare language tag);
 * - og:type `website` on the landing pages (Starlight writes `article` everywhere);
 * - on the landing pages, a schema.org `SoftwareApplication` as JSON-LD: free (price 0), AGPL-3.0,
 *   category `HomeApplication` (one of the values Google's software-app structured data accepts,
 *   read 2026-10-15), and the share card as its screenshot when the build knows its site. No
 *   rating or review: Kept has none to state, and Google shows a rich result only with one, so
 *   this describes the app without asking for one.
 * - on Arabic pages, a preload of IBM Plex Sans Arabic 400 (43 KB, the body text): without it
 *   the font is found only once the stylesheet is parsed, and Lighthouse's mobile run measured the
 *   Arabic landing page at 94 instead of 95–97 (2026-10-15), with a layout shift as it swaps in.
 * - on the integrations page, the table of contents: the page's headings are drawn by a component
 *   from src/data/integrations.ts, which Starlight can't see, so its groups are added here from the
 *   same data.
 *
 * Search engines (2026-10-16 audit, measured over dist/ before and after):
 *
 * - hreflang names only pages that exist in that language. Starlight writes an alternate for every
 *   locale on every page, but French, German and Italian have no pages of their own (Q19: they
 *   are the English text under the "not translated yet" notice) and Arabic has a few; the API
 *   reference has no other locale at all, so its alternates were 404s. Now: `en` and x-default
 *   always, `ar` when src/content/docs/ar/ has the page.
 * - A fallback page (English text at /fr/…, /de/…, /it/…, or an untranslated /ar/… page) is a
 *   duplicate of the English one, so its canonical and og:url point there. astro.config.mjs keeps
 *   the same pages out of the sitemap.
 * - The API reference's pages had no description of their own (all 424 shared the site's), and
 *   its overview was titled "Overview": each gets one from its method and path.
 * - The 404 page is noindex.
 * - The landing pages also describe the project (Organization, the GitHub organisation) and the
 *   site (WebSite) as JSON-LD, in one @graph with the SoftwareApplication.
 *
 * Starlight writes the sitemap link from `site`.
 */
import { defineRouteMiddleware } from '@astrojs/starlight/route-data';
import arabic400 from '@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-arabic-400-normal.woff2?url';
import { integrationGroups } from './data/integrations';

const CARD = { width: 1200, height: 630 };

const CARDS: Record<string, { file: string; alt: string }> = {
  en: {
    file: 'social-card.png',
    alt: "Kept, an inventory of everything you own and where it is: the app's home screen on a desktop and a phone",
  },
  ar: {
    file: 'social-card-ar.png',
    alt: 'Kept، جرد لكل ما تملكه وأين هو: موقع «بيت العائلة» في التطبيق على حاسوب وهاتف',
  },
};

const LICENSE = 'https://www.gnu.org/licenses/agpl-3.0.html';
const REPOSITORY = 'https://github.com/keptinventory/kept';
const ORGANIZATION = 'https://github.com/keptinventory';

/** The pages Arabic has of its own, as paths under /ar/ ('' is the landing page). */
const ARABIC = new Set(
  Object.keys(import.meta.glob('./content/docs/ar/**/*.{md,mdx}')).map((file) =>
    file.replace(/^\.\/content\/docs\/ar\//, '').replace(/(^|\/)index\.mdx?$|\.mdx?$/, ''),
  ),
);

const OG_LOCALES: Record<string, string> = {
  en: 'en_US',
  ar: 'ar_AR',
  fr: 'fr_FR',
  de: 'de_DE',
  it: 'it_IT',
};

export const onRequest = defineRouteMiddleware((context) => {
  const route = context.locals.starlightRoute;
  const { head } = route;
  const base = import.meta.env.BASE_URL.replace(/\/+$/, '');

  /** Sets a <meta>'s content, replacing Starlight's own tag when there is one. */
  const meta = (key: 'name' | 'property', value: string, content: string) => {
    const tag = head.find((t) => t.tag === 'meta' && t.attrs?.[key] === value);
    if (tag) tag.attrs = { ...tag.attrs, content };
    else head.push({ tag: 'meta', attrs: { [key]: value, content }, content: '' });
  };

  meta('property', 'og:locale', OG_LOCALES[route.lang] ?? route.lang);

  // The page's path with no base and no locale ('install/compose', '' for a landing page).
  let path = context.url.pathname;
  if (base && path.startsWith(`${base}/`)) path = path.slice(base.length);
  path = path.replace(/^\/+|\/+$/g, '');
  if (route.locale) path = path.replace(new RegExp(`^${route.locale}(/|$)`), '');
  const url = (prefix: string) =>
    context.site ? new URL(`${base}/${prefix}${path}${path ? '/' : ''}`, context.site).href : null;
  const english = url('');

  if (english) {
    const alternates = [{ lang: 'en', href: english }];
    if (ARABIC.has(path)) alternates.push({ lang: 'ar', href: url('ar/') as string });
    alternates.push({ lang: 'x-default', href: english });
    for (let i = head.length - 1; i >= 0; i--) {
      if (head[i].tag === 'link' && head[i].attrs?.rel === 'alternate' && head[i].attrs?.hreflang) {
        head.splice(i, 1);
      }
    }
    head.push(
      ...alternates.map(({ lang, href }) => ({
        tag: 'link' as const,
        attrs: { rel: 'alternate', hreflang: lang, href },
        content: '',
      })),
    );
    if (route.isFallback) {
      const canonical = head.find((t) => t.tag === 'link' && t.attrs?.rel === 'canonical');
      if (canonical) canonical.attrs = { ...canonical.attrs, href: english };
      meta('property', 'og:url', english);
    }
  }

  if (route.id === '404') meta('name', 'robots', 'noindex');

  if (path === 'api' || path.startsWith('api/')) {
    const title = route.entry.data.title;
    // Operation pages are titled "<path> (<METHOD>)", or "<path>" alone when it has one method.
    const op = /^(\/\S+?)(?: \((\w+)\))?$/.exec(title);
    const text =
      path === 'api'
        ? "Kept's HTTP API reference, generated from its OpenAPI document: every endpoint, by method and path."
        : op
          ? `Kept HTTP API: ${op[2] ? `${op[2]} ` : ''}${op[1]}. Its parameters, request body and responses.`
          : null;
    if (text) {
      meta('name', 'description', text);
      meta('property', 'og:description', text);
    }
    if (path === 'api') {
      const tag = head.find((t) => t.tag === 'title');
      if (tag) tag.content = 'HTTP API reference | Kept';
      meta('property', 'og:title', 'HTTP API reference');
    }
  }
  if (route.lang === 'ar') {
    head.push({
      tag: 'link',
      attrs: { rel: 'preload', href: arabic400, as: 'font', type: 'font/woff2', crossorigin: '' },
      content: '',
    });
  }
  const card = CARDS[route.lang] ?? CARDS.en;
  const cardUrl = context.site && card ? new URL(`${base}/${card.file}`, context.site).href : null;

  if (route.toc && (route.id === 'integrations' || route.id === 'ar/integrations')) {
    const ar = route.lang === 'ar';
    route.toc.items.push(
      ...integrationGroups.map((group) => ({
        depth: 2,
        slug: group.id,
        text: ar ? group.ar : group.en,
        children: [],
      })),
    );
  }

  if (route.entry.data.hero) {
    meta('property', 'og:type', 'website');
    const home = context.site ? new URL(`${base}/`, context.site).href : null;
    const org = {
      '@type': 'Organization',
      '@id': `${home ?? ORGANIZATION}#organization`,
      name: 'Kept',
      url: home ?? ORGANIZATION,
      ...(context.site ? { logo: new URL(`${base}/favicon.svg`, context.site).href } : {}),
      sameAs: [ORGANIZATION, REPOSITORY],
    };
    const app = {
      '@type': 'SoftwareApplication',
      name: 'Kept',
      description: route.entry.data.description,
      applicationCategory: 'HomeApplication',
      operatingSystem:
        'Linux (Docker Compose or Kubernetes, amd64 or arm64); the app runs in a web browser',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      isAccessibleForFree: true,
      license: LICENSE,
      sameAs: [REPOSITORY, ORGANIZATION],
      publisher: { '@id': org['@id'] },
      ...(cardUrl ? { image: cardUrl, screenshot: cardUrl } : {}),
      inLanguage: route.entryMeta.lang,
      ...(home ? { url: home } : {}),
    };
    const site = {
      '@type': 'WebSite',
      ...(home ? { '@id': `${home}#website` } : {}),
      name: 'Kept',
      ...(home ? { url: home } : {}),
      inLanguage: route.entryMeta.lang,
      publisher: { '@id': org['@id'] },
    };
    head.push({
      tag: 'script',
      attrs: { type: 'application/ld+json' },
      // `<` escaped, so no text in it can close the script element.
      content: JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [app, org, site],
      }).replaceAll('<', '\\u003c'),
    });
  }

  if (!cardUrl || !card) return;
  const image = cardUrl;
  meta('property', 'og:image', image);
  meta('property', 'og:image:type', 'image/png');
  meta('property', 'og:image:width', String(CARD.width));
  meta('property', 'og:image:height', String(CARD.height));
  meta('property', 'og:image:alt', card.alt);
  meta('name', 'twitter:image', image);
  meta('name', 'twitter:image:alt', card.alt);
});
