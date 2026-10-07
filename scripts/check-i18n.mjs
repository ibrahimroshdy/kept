#!/usr/bin/env node
// The web app's catalogues must hold every message in the source. A production build compiles
// only what apps/web/src/locales/<locale>/messages.po hold, and the Lingui macro strips the source
// text, so a message missing from them renders as its hashed id (a string like "x3Fk9a"), not as
// English (this happened to every step-2 screen once; docs/plans/step-1-carryover.md).
//
// This runs Lingui's own extractor over apps/web/src (the same config `pnpm --filter @kept/web
// i18n:extract` uses) in memory, writes nothing, and fails (exit 1) when an extracted message is
// absent from any locale's catalogue. Run `pnpm --filter @kept/web i18n:extract` to fix it.
//
// It also fails when a message has an empty translation in a non-source locale (step-2 plan
// task 30: every Arabic msgstr is written; an empty one would show English in the Arabic UI).
//
// D204: the five launch languages (English, Arabic, French, German, Italian) must all be in the
// Lingui config, and each must be complete. A translation must also keep its source's shape: the
// same placeholders ({name}, {0}), the same numbered tags (<0>…</0>) and the same number of ICU
// plurals, or the message would drop a value or break at runtime.
//
// It does NOT fail on:
//   - obsolete entries (in a catalogue, gone from the source): harmless at runtime (counted);
//   - moved source references (`#:` lines): cosmetic.
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const web = join(repo, 'apps/web');

/**
 * Pure comparison, for tests. `extracted`: the ids Lingui's extractor found in the source.
 * `catalogues`: per locale, id → translation ('' when untranslated).
 */
export function compareCatalogues(extracted, catalogues, sourceLocale = 'en') {
  const result = { missing: {}, untranslated: {}, obsolete: {} };
  for (const [locale, entries] of Object.entries(catalogues)) {
    const have = new Set(Object.keys(entries));
    result.missing[locale] = [...extracted.keys()].filter((id) => !have.has(id));
    result.obsolete[locale] = [...have].filter((id) => !extracted.has(id)).length;
    result.untranslated[locale] =
      locale === sourceLocale
        ? 0
        : [...have].filter((id) => extracted.has(id) && !entries[id]).length;
  }
  return result;
}

/** The launch languages (D204). Removing one from lingui.config.ts fails the check. */
export const REQUIRED_LOCALES = ['en', 'ar', 'fr', 'de', 'it'];

/** Required locales the config doesn't list. */
export function missingLocales(configLocales) {
  return REQUIRED_LOCALES.filter((l) => !configLocales.includes(l));
}

/**
 * A message's shape: the argument names it uses (which, not how often: a language may name a
 * value once where English repeats it) and how many plural/select arguments it has. An ICU walk,
 * not a regex: a plural branch's body is text, so `{n, plural, one {thing} other {things}}` uses
 * `n` only; "thing" is a word a translation is free to change, not a placeholder. ICU quoting
 * (`'{'`, `''`) is honoured.
 */
export function icuShape(s) {
  const names = new Set();
  let plurals = 0;
  let i = 0;
  const ws = () => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };
  /** Skips past the `}` that closes the brace already opened (nested braces counted). */
  const skipBraces = () => {
    let depth = 1;
    while (i < s.length && depth > 0) {
      if (s[i] === '{') depth++;
      else if (s[i] === '}') depth--;
      i++;
    }
  };
  /** Text up to an unmatched `}` (left for the caller), or the end. */
  const message = (nested) => {
    while (i < s.length) {
      const c = s[i];
      if (c === "'") {
        if (s[i + 1] === "'") i += 2;
        else if (s[i + 1] === '{' || s[i + 1] === '}' || s[i + 1] === '#') {
          const end = s.indexOf("'", i + 1);
          i = end < 0 ? s.length : end + 1;
        } else i++;
      } else if (c === '}') {
        if (nested) return;
        i++;
      } else if (c === '{') {
        i++;
        argument();
      } else i++;
    }
  };
  /** After an argument's `{`: its name, then a plain end, a typed one, or plural/select branches. */
  const argument = () => {
    ws();
    const name = /^[A-Za-z0-9_]+/.exec(s.slice(i))?.[0];
    if (!name) return skipBraces();
    names.add(name);
    i += name.length;
    ws();
    if (s[i] === '}') {
      i++;
      return;
    }
    if (s[i] !== ',') return skipBraces();
    i++;
    ws();
    const type = /^[A-Za-z]+/.exec(s.slice(i))?.[0] ?? '';
    i += type.length;
    ws();
    if (!['plural', 'select', 'selectordinal'].includes(type) || s[i] !== ',') return skipBraces();
    plurals++;
    i++;
    // Branches: `selector {message}` … up to the argument's own `}`.
    while (i < s.length) {
      ws();
      if (s[i] === '}') {
        i++;
        return;
      }
      while (i < s.length && s[i] !== '{' && s[i] !== '}') i++;
      if (s[i] !== '{') continue;
      i++;
      message(true);
      if (s[i] === '}') i++;
    }
  };
  message(false);
  return { names: [...names].sort().join(','), plurals };
}

const placeholders = (s) => icuShape(s).names;
const tags = (s) =>
  [...s.matchAll(/<\/?(\d+)\/?>/g)]
    .map((m) => m[0])
    .sort()
    .join(',');
const plurals = (s) => icuShape(s).plurals;

/**
 * Translations whose shape differs from their source: placeholders, numbered tags or ICU plural
 * count. Per locale, a list of `{ id, why }`. Untranslated (empty) entries are skipped here.
 */
export function shapeProblems(extracted, catalogues, sourceLocale = 'en') {
  const out = {};
  for (const [locale, entries] of Object.entries(catalogues)) {
    if (locale === sourceLocale) continue;
    out[locale] = [];
    for (const [id, message] of extracted) {
      const t = entries[id];
      if (!t) continue;
      const source = message?.message ?? id;
      if (placeholders(t) !== placeholders(source)) out[locale].push({ id, why: 'placeholders' });
      else if (tags(t) !== tags(source)) out[locale].push({ id, why: 'tags' });
      else if (plurals(t) !== plurals(source)) out[locale].push({ id, why: 'plurals' });
    }
  }
  return out;
}

/** How a missing message reads in the report: its source text and where it is. */
function describe(id, message) {
  const text = message?.message ?? id;
  const where = message?.origin?.[0]?.[0];
  const ctx = message?.context ? ` [context: ${message.context}]` : '';
  return `  ${JSON.stringify(text)}${ctx}${where ? `  (${where})` : ''}`;
}

async function main() {
  // @lingui/* are apps/web's dependencies, not the root's: resolve them from there.
  const requireWeb = createRequire(join(web, 'package.json'));
  const load = (name) => import(pathToFileURL(requireWeb.resolve(name)).href);
  const { getConfig } = await load('@lingui/conf');
  const { getCatalogs } = await load('@lingui/cli/api');

  // The config's `include: ['src']` is relative to the working directory, as for `lingui extract`.
  process.chdir(web);
  const config = getConfig({ configPath: join(web, 'lingui.config.ts') });
  const catalogs = await getCatalogs(config);
  let failed = false;
  const absent = missingLocales(config.locales);
  if (absent.length > 0) {
    failed = true;
    console.error(
      `check-i18n: lingui.config.ts must list every launch language (D204); missing: ${absent.join(', ')}.`,
    );
  }
  for (const catalog of catalogs) {
    const next = await catalog.collect();
    if (!next) {
      console.error('check-i18n: Lingui could not extract the messages (see the errors above).');
      process.exit(1);
    }
    const extracted = new Map(Object.entries(next));
    const catalogues = {};
    for (const locale of config.locales) {
      const read = (await catalog.read(locale)) ?? {};
      catalogues[locale] = Object.fromEntries(
        Object.entries(read).map(([id, m]) => [id, m.translation ?? '']),
      );
    }
    const r = compareCatalogues(extracted, catalogues, config.sourceLocale);
    const where = relative(repo, dirname(dirname(catalog.getFilename(config.sourceLocale))));
    for (const locale of config.locales) {
      const missing = r.missing[locale];
      if (missing.length > 0) {
        failed = true;
        console.error(
          `check-i18n: ${missing.length} message(s) in the source are not in ${where}/${locale}/messages.po:`,
        );
        for (const id of missing.slice(0, 40)) console.error(describe(id, extracted.get(id)));
        if (missing.length > 40) console.error(`  … and ${missing.length - 40} more`);
      }
    }
    for (const locale of config.locales) {
      if (locale === config.sourceLocale || r.untranslated[locale] === 0) continue;
      failed = true;
      const empty = [...extracted.keys()].filter(
        (id) => id in catalogues[locale] && !catalogues[locale][id],
      );
      console.error(
        `check-i18n: ${empty.length} message(s) have no translation in ${where}/${locale}/messages.po:`,
      );
      for (const id of empty.slice(0, 40)) console.error(describe(id, extracted.get(id)));
      if (empty.length > 40) console.error(`  … and ${empty.length - 40} more`);
    }
    const shapes = shapeProblems(extracted, catalogues, config.sourceLocale);
    for (const [locale, problems] of Object.entries(shapes)) {
      if (problems.length === 0) continue;
      failed = true;
      console.error(
        `check-i18n: ${problems.length} translation(s) in ${where}/${locale}/messages.po don't keep their source's placeholders, tags or plurals:`,
      );
      for (const { id, why } of problems.slice(0, 40))
        console.error(`${describe(id, extracted.get(id))}  [${why}]`);
    }
    const notes = [];
    const obsolete = r.obsolete[config.sourceLocale];
    if (obsolete > 0) notes.push(`${obsolete} obsolete`);
    console.log(
      `check-i18n: ${extracted.size} messages; ${failed ? 'catalogues are missing some' : 'every one is in the catalogues'}${notes.length ? ` (${notes.join('; ')})` : ''}.`,
    );
  }
  if (failed) {
    console.error(
      'check-i18n: run `pnpm --filter @kept/web i18n:extract`, write the missing translations, and commit the .po files.',
    );
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
