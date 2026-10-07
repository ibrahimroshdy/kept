/**
 * Translated names for roles, location kinds, modules and presets, plus the location templates
 * (screens §8) and the timezone/currency guess the new-location wizard shows (D194).
 */
import type { ModuleId, Preset, Role } from '@kept/shared';
import { useLingui } from '@lingui/react/macro';
import type { LocationKind } from '@/api/types';

export function useRoleLabels() {
  const { t } = useLingui();
  const one: Record<Role, string> = {
    owner: t`Owner`,
    admin: t`Admin`,
    member: t`Member`,
    viewer: t`Viewer`,
  };
  const group: Record<Role, string> = {
    owner: t`Owner`,
    admin: t`Admins`,
    member: t`Members`,
    viewer: t`Viewers`,
  };
  const what: Record<Role, string> = {
    owner: t`Owns this location and decides who runs it.`,
    admin: t`Admins manage members, viewers and settings. Only the owner changes admins.`,
    member: t`Members add, move and edit things. They can't change settings or people.`,
    viewer: t`Viewers look around and copy links. They can't change anything.`,
  };
  /** "You're a member": how a location page says your role. */
  const you: Record<Role, string> = {
    owner: t`You own it`,
    admin: t`You're an admin`,
    member: t`You're a member`,
    viewer: t`You're a viewer`,
  };
  return { one, group, what, you };
}

/** The kinds a person can create (Personal is made for them, D114). */
export const CREATABLE_KINDS = [
  'home',
  'apartment',
  'garage',
  'storage_unit',
  'office',
  'vacation_home',
  'custom',
] as const satisfies readonly Exclude<LocationKind, 'personal'>[];

export function useKindLabels(): Record<LocationKind, string> {
  const { t } = useLingui();
  return {
    personal: t`Personal`,
    home: t`House`,
    apartment: t`Apartment`,
    garage: t`Garage`,
    storage_unit: t`Storage unit`,
    office: t`Office`,
    vacation_home: t`Vacation home`,
    custom: t`Other`,
  };
}

/** Screens §8's templates. House adds a second floor, a hallway and a storage room. */
export function useTemplateRooms(): Record<Exclude<LocationKind, 'personal'>, string[]> {
  const { t } = useLingui();
  const apartment = [
    t`Living room`,
    t`Kitchen`,
    t`Bedroom`,
    t`Second bedroom`,
    t`Bathroom`,
    t`Balcony`,
  ];
  return {
    apartment,
    home: [...apartment, t`Second floor`, t`Hallway`, t`Storage room`],
    garage: [t`Tool wall`, t`Shelves`, t`Floor`],
    storage_unit: [t`Front`, t`Back`, t`Shelves`],
    office: [],
    vacation_home: [],
    custom: [],
  };
}

/** D191's outcome wording for each switchable module. */
export function useModuleLabels(): Record<ModuleId, string> {
  const { t } = useLingui();
  return {
    labels: t`Labels and QR codes`,
    money: t`Money and spending`,
    warranties: t`Receipts and warranties`,
    schedules: t`Reminders`,
    lending: t`Lending`,
    paperwork: t`Paperwork`,
    vehicles: t`Vehicles`,
    fuel: t`Fuel`,
    consumables: t`Things you run out of`,
    moving: t`Moving house`,
    secrets: t`Passwords and codes`,
    ai_capture: t`AI capture`,
    ai_assistant: t`AI assistant`,
    mcp: t`Connect ChatGPT or Claude`,
  };
}

export function usePresetCopy(): Record<Preset, { name: string; outcome: string }> {
  const { t } = useLingui();
  return {
    essentials: {
      name: t`Essentials`,
      outcome: t`Finding things: rooms, boxes, labels and search.`,
    },
    household: {
      name: t`Household`,
      outcome: t`Adds receipts and warranties, reminders, lending, paperwork and vehicles.`,
    },
    complete: {
      name: t`Complete`,
      outcome: t`Adds fuel, things you run out of, passwords and codes, moving house, and "Connect ChatGPT or Claude".`,
    },
  };
}

/** The browser's timezone, or UTC when it can't say. */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

const EUROZONE = new Set([
  'at',
  'be',
  'cy',
  'de',
  'ee',
  'es',
  'fi',
  'fr',
  'gr',
  'hr',
  'ie',
  'it',
  'lt',
  'lu',
  'lv',
  'mt',
  'nl',
  'pt',
  'si',
  'sk',
]);

/**
 * The same guess the server makes for Personal (task 18): ar-EG → EGP, en-GB → GBP, en-CA and
 * fr-CA → CAD, a eurozone region → EUR, otherwise USD. Only the enabled currencies (D168).
 */
export function currencyForLocale(tag: string): string {
  const [lang = '', region = ''] = tag.toLowerCase().split('-');
  if (region === 'eg') return 'EGP';
  if (region === 'gb') return 'GBP';
  if (region === 'ca' && (lang === 'en' || lang === 'fr')) return 'CAD';
  if (EUROZONE.has(region)) return 'EUR';
  return 'USD';
}

export function browserCurrency(): string {
  return currencyForLocale(typeof navigator === 'undefined' ? 'en-US' : navigator.language);
}

/** First letter for an avatar; works for Arabic names too. */
export function initialOf(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? '?';
}

/**
 * A location's display name. Personal is created by the server with the English name
 * "Personal" (task 18); it's a system location, so it's shown in the reader's language.
 */
export function useLocationName() {
  const { t } = useLingui();
  // `kind` may be missing where a list only names the location (an older server's answer).
  return (l: { kind?: LocationKind | string; name: string }) =>
    l.kind === 'personal' ? t`Personal` : l.name;
}
