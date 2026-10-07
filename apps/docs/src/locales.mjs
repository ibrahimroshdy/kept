// The site's five locales (plan Q19), in one place: astro.config.mjs hands them to Starlight, and
// the language menu (components/language/LanguageSelect.astro) lists them. `root` is English, at
// the site's root.
export const locales = {
  root: { label: 'English', lang: 'en' },
  ar: { label: 'العربية', lang: 'ar', dir: 'rtl' },
  fr: { label: 'Français', lang: 'fr' },
  de: { label: 'Deutsch', lang: 'de' },
  it: { label: 'Italiano', lang: 'it' },
};
