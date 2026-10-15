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
 * Starlight already writes the canonical link, an hreflang alternate per locale and x-default,
 * and the sitemap link, all from `site`.
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
    const app = {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'Kept',
      description: route.entry.data.description,
      applicationCategory: 'HomeApplication',
      operatingSystem:
        'Linux (Docker Compose or Kubernetes, amd64 or arm64); the app runs in a web browser',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      isAccessibleForFree: true,
      license: LICENSE,
      sameAs: [REPOSITORY],
      ...(cardUrl ? { screenshot: cardUrl } : {}),
      inLanguage: route.entryMeta.lang,
      ...(context.site ? { url: new URL(`${base}/`, context.site).href } : {}),
    };
    head.push({
      tag: 'script',
      attrs: { type: 'application/ld+json' },
      // `<` escaped, so no text in it can close the script element.
      content: JSON.stringify(app).replaceAll('<', '\\u003c'),
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
