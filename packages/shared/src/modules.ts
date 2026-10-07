/**
 * The module registry (engineering spec §7.6; product design §5, D61, D75, D113, re-cut by D191).
 *
 * The core is always on and is not listed here. Each module is switched per location, through
 * its preset and then `location_modules` rows. Its effective state is
 * enabled ∧ dependencies met ∧ (a resolved AI provider, for the AI modules).
 *
 * - Insights is part of Money (§7.6, D113), not a module of its own.
 * - Vehicles is in Household (D191).
 * - AI capture and the AI assistant are in every preset: they follow the provider, and the
 *   module toggle can still turn them off (D191).
 *
 * `label` is the English preset-card wording (D191's outcome labels); the web app translates
 * it. Route tags, tools and built-in fields (§7.6) join each entry as the steps that build those
 * modules land. Reminder sources and nav entries joined in step 4.
 */

import { SOURCE_MODULE, SOURCE_TYPES, type SourceType } from './reminders.js';

export const PRESETS = ['essentials', 'household', 'complete'] as const;
export type Preset = (typeof PRESETS)[number];

export const MODULE_IDS = [
  'labels',
  'money',
  'warranties',
  'schedules',
  'lending',
  'paperwork',
  'vehicles',
  'fuel',
  'consumables',
  'moving',
  'secrets',
  'ai_capture',
  'ai_assistant',
  'mcp',
] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

/**
 * The global views a module brings into the navigation (screens §1: an entry shows when its
 * module is on in any of your locations). Notifications, Activity and Trash are core.
 */
export const MODULE_NAV = [
  'schedules',
  'lending',
  'paperwork',
  'vehicles',
  'insights',
  'consumables',
] as const;
export type ModuleNav = (typeof MODULE_NAV)[number];

export type ModuleDef = {
  deps: readonly ModuleId[];
  label: string;
  presets: readonly Preset[];
  /** Off unless an AI provider is resolved for the location (D113, D191). */
  requiresProvider: boolean;
  /** The reminder sources that pause when the module is off (reminders.ts SOURCE_MODULE). */
  reminderSources: readonly SourceType[];
  /** Its nav entries (screens §1); Insights is part of Money (§7.6). */
  nav: readonly ModuleNav[];
};

const E = ['essentials', 'household', 'complete'] as const;
const H = ['household', 'complete'] as const;
const C = ['complete'] as const;

const NAV: Partial<Record<ModuleId, readonly ModuleNav[]>> = {
  money: ['insights'],
  schedules: ['schedules'],
  lending: ['lending'],
  paperwork: ['paperwork'],
  vehicles: ['vehicles'],
  consumables: ['consumables'],
};

const def = (
  id: ModuleId,
  label: string,
  presets: readonly Preset[],
  deps: readonly ModuleId[] = [],
  requiresProvider = false,
): ModuleDef =>
  Object.freeze({
    label,
    presets,
    deps,
    requiresProvider,
    reminderSources: Object.freeze(SOURCE_TYPES.filter((s) => SOURCE_MODULE[s] === id)),
    nav: Object.freeze([...(NAV[id] ?? [])]),
  });

export const MODULES: Readonly<Record<ModuleId, ModuleDef>> = Object.freeze({
  labels: def('labels', 'Labels & QR', E),
  money: def('money', 'Money', H),
  warranties: def('warranties', 'Warranties & claims', H),
  schedules: def('schedules', 'Schedules & reminders', H),
  lending: def('lending', 'Lending & borrowing', H),
  paperwork: def('paperwork', 'Paperwork library', H),
  vehicles: def('vehicles', 'Vehicles', H),
  fuel: def('fuel', 'Fuel & charging', C, ['vehicles']),
  consumables: def('consumables', 'Things you run out of', C),
  moving: def('moving', 'Moving mode', C, ['labels']),
  secrets: def('secrets', 'Passwords and codes', C),
  ai_capture: def('ai_capture', 'AI capture', E, [], true),
  ai_assistant: def('ai_assistant', 'AI assistant', E, [], true),
  mcp: def('mcp', 'Connect ChatGPT or Claude', C),
});

export function isModuleId(value: string): value is ModuleId {
  return Object.hasOwn(MODULES, value);
}

/** The modules a preset switches on. */
export function presetModules(preset: Preset): Set<ModuleId> {
  return new Set(MODULE_IDS.filter((id) => MODULES[id].presets.includes(preset)));
}

/**
 * The modules that are on: enabled, every dependency on (transitively), and, for the AI
 * modules, a resolved provider. Unknown ids in `enabled` are ignored.
 */
export function effectiveModules(
  enabled: Iterable<string>,
  opts: { providerResolved: boolean },
): Set<ModuleId> {
  const on = new Set<ModuleId>();
  for (const id of enabled) if (isModuleId(id)) on.add(id);
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...on]) {
      const m = MODULES[id];
      if ((m.requiresProvider && !opts.providerResolved) || m.deps.some((d) => !on.has(d))) {
        on.delete(id);
        changed = true;
      }
    }
  }
  return new Set(MODULE_IDS.filter((id) => on.has(id)));
}
