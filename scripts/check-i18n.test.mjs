import { describe, expect, it } from 'vitest';
import { compareCatalogues, icuShape, missingLocales, shapeProblems } from './check-i18n.mjs';

const extracted = (...ids) => new Map(ids.map((id) => [id, { message: id }]));

describe('compareCatalogues', () => {
  it('passes when every extracted message is in every catalogue', () => {
    const r = compareCatalogues(extracted('a', 'b'), {
      en: { a: 'A', b: 'B' },
      ar: { a: 'أ', b: 'ب' },
    });
    expect(r.missing).toEqual({ en: [], ar: [] });
  });

  it('reports a message that is in the source but in no catalogue, per locale', () => {
    const r = compareCatalogues(extracted('a', 'new'), { en: { a: 'A' }, ar: { a: 'أ' } });
    expect(r.missing).toEqual({ en: ['new'], ar: ['new'] });
  });

  it('reports a message missing from one locale only', () => {
    const r = compareCatalogues(extracted('a', 'b'), { en: { a: 'A', b: 'B' }, ar: { a: 'أ' } });
    expect(r.missing).toEqual({ en: [], ar: ['b'] });
  });

  it('counts an empty Arabic translation as untranslated, not missing (English shows)', () => {
    const r = compareCatalogues(extracted('a', 'b'), {
      en: { a: 'A', b: 'B' },
      ar: { a: 'أ', b: '' },
    });
    expect(r.missing.ar).toEqual([]);
    expect(r.untranslated).toEqual({ en: 0, ar: 1 });
  });

  it('counts obsolete entries without failing on them', () => {
    const r = compareCatalogues(extracted('a'), {
      en: { a: 'A', gone: 'G' },
      ar: { a: 'أ', gone: '' },
    });
    expect(r.missing).toEqual({ en: [], ar: [] });
    expect(r.obsolete).toEqual({ en: 1, ar: 1 });
    // An obsolete entry is not "untranslated" either.
    expect(r.untranslated.ar).toBe(0);
  });
});

describe('the launch languages (D204)', () => {
  it('requires all five in the config', () => {
    expect(missingLocales(['en', 'ar', 'fr', 'de', 'it'])).toEqual([]);
    expect(missingLocales(['en', 'ar'])).toEqual(['fr', 'de', 'it']);
  });

  it('flags a translation that drops a placeholder, a tag or a plural', () => {
    const src = new Map([
      ['p', { message: 'Moved {name} to {place}' }],
      ['t', { message: '<0>{0}</0> is empty' }],
      ['n', { message: '{n, plural, one {# thing} other {# things}}' }],
      ['ok', { message: 'Saved {n}' }],
    ]);
    const r = shapeProblems(src, {
      en: {},
      fr: {
        p: '{name} déplacé',
        t: '{0} est vide',
        n: '{n} objets',
        ok: 'Enregistré : {n}',
      },
      de: { p: '', t: '<0>{0}</0> ist leer' },
    });
    expect(r.fr).toEqual([
      { id: 'p', why: 'placeholders' },
      { id: 't', why: 'tags' },
      { id: 'n', why: 'plurals' },
    ]);
    // Empty entries are the untranslated check's business, not this one's.
    expect(r.de).toEqual([]);
  });
});

describe("a message's shape (an ICU walk, not a regex)", () => {
  it('takes a one-word plural branch as text, not a placeholder', () => {
    expect(icuShape('{n, plural, one {thing} other {things}}')).toEqual({ names: 'n', plurals: 1 });
    const src = new Map([['k', { message: '{n, plural, one {thing} other {things}}' }]]);
    const r = shapeProblems(src, {
      en: {},
      ar: {
        k: '{n, plural, zero {أشياء} one {شيء} two {شيئان} few {أشياء} many {شيئًا} other {شيء}}',
      },
      fr: { k: '{n, plural, one {objet} other {objets}}' },
    });
    expect(r).toEqual({ ar: [], fr: [] });
  });

  it('still finds a placeholder inside a branch, a nested plural, and a typed argument', () => {
    expect(
      icuShape('{n, plural, one {# of {name}} other {{m, plural, one {x} other {y}} {name}}}'),
    ).toEqual({
      names: 'm,n,name',
      plurals: 2,
    });
    expect(icuShape('Due {when, date, short} at {km, number}')).toEqual({
      names: 'km,when',
      plurals: 0,
    });
    expect(icuShape('{kind, select, car {a car} other {{kind}}}')).toEqual({
      names: 'kind',
      plurals: 1,
    });
  });

  it("honours ICU quoting: '{x}' is text, '' an apostrophe", () => {
    expect(icuShape("'{x}' and l''{name}")).toEqual({ names: 'name', plurals: 0 });
  });

  it('flags a translation that loses a placeholder a branch carried', () => {
    const src = new Map([['k', { message: '{n, plural, one {# by {who}} other {# by {who}}}' }]]);
    const r = shapeProblems(src, {
      en: {},
      de: { k: '{n, plural, one {# von jemandem} other {#}}' },
    });
    expect(r.de).toEqual([{ id: 'k', why: 'placeholders' }]);
  });
});
