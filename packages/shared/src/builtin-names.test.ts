import { describe, expect, it } from 'vitest';
import {
  BUILTIN_FIELD_NAMES_MORE,
  BUILTIN_TYPE_NAMES_MORE,
  builtinFieldName,
  builtinTypeName,
} from './builtin-names.js';
import { BUILTIN_TYPES } from './builtin-types.js';

const MORE = ['fr', 'de', 'it'] as const;

describe('built-in names in the five languages (D204)', () => {
  it('names every built-in type and field in French, German and Italian', () => {
    const typeKeys = BUILTIN_TYPES.map((t) => t.key).sort();
    const fieldKeys = [...new Set(BUILTIN_TYPES.flatMap((t) => t.fields.map((f) => f.key)))].sort();
    expect(Object.keys(BUILTIN_TYPE_NAMES_MORE).sort()).toEqual(typeKeys);
    expect(Object.keys(BUILTIN_FIELD_NAMES_MORE).sort()).toEqual(fieldKeys);
    for (const names of [
      ...Object.values(BUILTIN_TYPE_NAMES_MORE),
      ...Object.values(BUILTIN_FIELD_NAMES_MORE),
    ])
      for (const l of MORE) {
        expect(names[l].trim()).not.toBe('');
        // ICU and typography: the typographic apostrophe only.
        expect(names[l]).not.toContain("'");
      }
  });

  it('reads English and Arabic from the definitions, the others from the table', () => {
    expect(builtinTypeName('furniture', 'en')).toBe('Furniture');
    expect(builtinTypeName('furniture', 'ar')).toBe('أثاث');
    expect(builtinTypeName('furniture', 'fr')).toBe(BUILTIN_TYPE_NAMES_MORE.furniture?.fr);
    expect(builtinFieldName('imei', 'de')).toBe(BUILTIN_FIELD_NAMES_MORE.imei?.de);
    expect(builtinTypeName('no_such_type', 'it')).toBeUndefined();
    expect(builtinFieldName('no_such_field', 'en')).toBeUndefined();
  });
});
