import { describe, expect, it } from 'vitest';
import {
  effectiveModules,
  MODULE_IDS,
  MODULE_NAV,
  MODULES,
  type ModuleId,
  PRESETS,
  presetModules,
} from './modules.js';
import { SOURCE_MODULE, SOURCE_TYPES } from './reminders.js';

// Product design §5 (module table), as re-cut by D191; engineering spec §7.6.

const all = new Set<ModuleId>(MODULE_IDS);

describe('the module registry', () => {
  it('has the §5 modules, and Insights inside Money rather than a module of its own', () => {
    expect([...MODULE_IDS].sort()).toEqual(
      [
        'ai_assistant',
        'ai_capture',
        'consumables',
        'fuel',
        'labels',
        'lending',
        'mcp',
        'money',
        'moving',
        'paperwork',
        'schedules',
        'secrets',
        'vehicles',
        'warranties',
      ].sort(),
    );
  });

  it('declares the §5 dependencies', () => {
    expect(MODULES.fuel.deps).toEqual(['vehicles']);
    expect(MODULES.moving.deps).toEqual(['labels']);
    const withDeps = MODULE_IDS.filter((id) => MODULES[id].deps.length > 0).sort();
    expect(withDeps).toEqual(['fuel', 'moving']);
  });

  it('marks exactly the AI modules as needing a provider', () => {
    expect(MODULE_IDS.filter((id) => MODULES[id].requiresProvider).sort()).toEqual([
      'ai_assistant',
      'ai_capture',
    ]);
  });

  it('only depends on modules that exist, and ids fit the location_modules CHECK', () => {
    for (const id of MODULE_IDS) {
      expect(id).toMatch(/^[a-z][a-z0-9_]*$/);
      for (const dep of MODULES[id].deps) expect(MODULE_IDS).toContain(dep);
    }
  });
});

describe('presets (D75 re-cut by D191)', () => {
  it('Essentials is Labels, plus AI that follows the provider', () => {
    expect([...presetModules('essentials')].sort()).toEqual([
      'ai_assistant',
      'ai_capture',
      'labels',
    ]);
  });

  it('Household includes vehicles', () => {
    expect([...presetModules('household')].sort()).toEqual(
      [
        'ai_assistant',
        'ai_capture',
        'labels',
        'lending',
        'money',
        'paperwork',
        'schedules',
        'vehicles',
        'warranties',
      ].sort(),
    );
  });

  it('Complete is everything', () => {
    expect(presetModules('complete')).toEqual(all);
  });

  it('each module lists the presets that include it', () => {
    for (const preset of PRESETS) {
      for (const id of MODULE_IDS) {
        expect(presetModules(preset).has(id), `${preset} ${id}`).toBe(
          MODULES[id].presets.includes(preset),
        );
      }
    }
  });
});

describe('effectiveModules()', () => {
  it('turns off the dependents of a disabled dependency', () => {
    const enabled = new Set<ModuleId>(all);
    enabled.delete('vehicles');
    enabled.delete('labels');
    const on = effectiveModules(enabled, { providerResolved: true });
    expect(on.has('fuel')).toBe(false);
    expect(on.has('moving')).toBe(false);
    expect(on.has('money')).toBe(true);
  });

  it('keeps the AI modules off without a provider, and on with one', () => {
    expect(effectiveModules(all, { providerResolved: false }).has('ai_capture')).toBe(false);
    expect(effectiveModules(all, { providerResolved: false }).has('ai_assistant')).toBe(false);
    expect(effectiveModules(all, { providerResolved: true }).has('ai_capture')).toBe(true);
  });

  it('lets the module toggle still turn AI off when a provider is connected', () => {
    const enabled = new Set<ModuleId>(all);
    enabled.delete('ai_assistant');
    const on = effectiveModules(enabled, { providerResolved: true });
    expect(on.has('ai_assistant')).toBe(false);
    expect(on.has('ai_capture')).toBe(true);
  });

  it('ignores ids that are not modules', () => {
    const on = effectiveModules(new Set(['money', 'insights', 'nope']), {
      providerResolved: false,
    });
    expect([...on]).toEqual(['money']);
  });
});

describe('reminder sources and nav (§7.6; step 4)', () => {
  it('maps every source type to exactly one module, or to core', () => {
    for (const source of SOURCE_TYPES) {
      const owners = MODULE_IDS.filter((id) => MODULES[id].reminderSources.includes(source));
      const module = SOURCE_MODULE[source];
      expect(owners, source).toEqual(module === null ? [] : [module]);
    }
  });

  it('pauses the step-4 sources with their modules', () => {
    expect(MODULES.schedules.reminderSources).toEqual(['schedule', 'thing_expiry']);
    expect(MODULES.warranties.reminderSources).toEqual(['warranty', 'registration']);
    expect(MODULES.paperwork.reminderSources).toEqual(['document']);
    expect(MODULES.lending.reminderSources).toEqual(['loan']);
    expect(MODULES.consumables.reminderSources).toEqual(['stock']);
  });

  it('gives each global view one module (screens §1); Notifications is core', () => {
    const entries = MODULE_IDS.flatMap((id) => MODULES[id].nav);
    expect([...entries].sort()).toEqual([...MODULE_NAV].sort());
    expect(MODULES.money.nav).toEqual(['insights']);
    expect((MODULE_NAV as readonly string[]).includes('notifications')).toBe(false);
  });

  it('still switches on every preset as before', () => {
    for (const preset of PRESETS) {
      expect(effectiveModules(presetModules(preset), { providerResolved: true })).toEqual(
        presetModules(preset),
      );
    }
  });
});
