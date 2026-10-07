/**
 * The five launch languages (D204): each shown in its own name with a flag. Flags are SVG, not
 * emoji (Windows has no flag emoji), from country-flag-icons (MIT); only these five are imported,
 * so the rest of the set never reaches the bundle.
 *
 * The flag for each language is the maintainer's choice and changes here, in one line each.
 */
import DE from 'country-flag-icons/react/3x2/DE';
import EG from 'country-flag-icons/react/3x2/EG';
import FR from 'country-flag-icons/react/3x2/FR';
import GB from 'country-flag-icons/react/3x2/GB';
import IT from 'country-flag-icons/react/3x2/IT';
import type { Key } from 'react-aria-components';
import { directionOf, LOCALES, type Locale, localeOfTag } from '@/lib/prefs';
import { cn } from '@/lib/utils';
import { Select, SelectItem } from './ui/select';

type Flag = typeof GB;

export type Language = { id: Locale; name: string };

/** Each language's name in itself, so a reader finds theirs whatever the interface says. */
export const LANGUAGE_NAMES: Readonly<Record<Locale, string>> = {
  en: 'English',
  ar: 'العربية',
  fr: 'Français',
  de: 'Deutsch',
  it: 'Italiano',
};

const FLAGS: Readonly<Record<Locale, Flag>> = { en: GB, ar: EG, fr: FR, de: DE, it: IT };

export const LANGUAGES: readonly Language[] = LOCALES.map((id) => ({
  id,
  name: LANGUAGE_NAMES[id],
}));

/** A 3:2 flag, decorative: the language's name always sits beside it. */
export function LanguageFlag({ locale, className }: { locale: Locale; className?: string }) {
  const Flag = FLAGS[locale];
  return (
    <Flag
      aria-hidden="true"
      data-flag={locale}
      className={cn('h-[14px] w-[21px] shrink-0 rounded-[2px] ring-1 ring-line', className)}
    />
  );
}

/** The flag and the name, marked with the language so screen readers pronounce it right. */
export function LanguageName({ locale }: { locale: Locale }) {
  return (
    <span className="inline-flex items-center gap-2">
      <LanguageFlag locale={locale} />
      <span lang={locale} dir={directionOf(locale)}>
        {LANGUAGE_NAMES[locale]}
      </span>
    </span>
  );
}

/** The interface language: one choice (Settings → Me, the sign-in pages). */
export function LanguageSelect({
  label,
  value,
  onChange,
  compact = false,
  className,
}: {
  label: string;
  value: Locale;
  onChange: (locale: Locale) => void;
  /** No visible label and a small trigger (the sign-in header); the label stays accessible. */
  compact?: boolean;
  className?: string;
}) {
  return (
    <Select<Language>
      {...(compact ? { 'aria-label': label } : { label })}
      items={LANGUAGES}
      value={value}
      onChange={(key) => {
        if (key != null && key !== value) onChange(key as Locale);
      }}
      renderValue={([item]) => (item ? <LanguageName locale={item.id} /> : null)}
      triggerClassName={compact ? 'min-h-10 w-auto py-1.5 text-[14px]' : undefined}
      className={className}
    >
      {(item) => (
        <SelectItem id={item.id} textValue={item.name}>
          <LanguageName locale={item.id} />
        </SelectItem>
      )}
    </Select>
  );
}

/**
 * A location's languages (D41): the languages AI writes search aliases in. Several choices. The
 * stored tags can carry a region (`ar-EG`); a chosen language keeps its stored tag, a new one is
 * stored as the bare language, and tags outside the five are kept as they are.
 */
export function LanguagesMultiSelect({
  label,
  description,
  value,
  onChange,
  isDisabled,
}: {
  label: string;
  description?: string;
  value: readonly string[];
  onChange: (tags: string[]) => void;
  isDisabled?: boolean;
}) {
  const chosen = new Set(value.map(localeOfTag).filter((l): l is Locale => l !== null));
  const change = (keys: Key[]) => {
    const next = new Set(keys as Locale[]);
    const kept = value.filter((tag) => {
      const l = localeOfTag(tag);
      return l === null || next.has(l);
    });
    const added = LOCALES.filter((l) => next.has(l) && !chosen.has(l));
    onChange([...kept, ...added]);
  };
  return (
    <Select<Language, 'multiple'>
      label={label}
      description={description}
      selectionMode="multiple"
      items={LANGUAGES}
      value={[...chosen]}
      onChange={change}
      isDisabled={isDisabled ?? false}
      renderValue={(items) => items.map((item) => <LanguageName key={item.id} locale={item.id} />)}
    >
      {(item) => (
        <SelectItem id={item.id} textValue={item.name}>
          <LanguageName locale={item.id} />
        </SelectItem>
      )}
    </Select>
  );
}
