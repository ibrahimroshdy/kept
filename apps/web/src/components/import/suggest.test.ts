/**
 * The stepper's guesses (T30): fields from headers in the five languages, Arabic included; a field
 * that takes one column goes to the first; the date format and the place separator from values.
 */
import { describe, expect, it } from 'vitest';
import {
  dateFormatsFor,
  fieldFromHeader,
  normaliseHeader,
  separatorFor,
  suggestMapping,
} from './suggest';

describe('fields from headers', () => {
  it('reads Arabic headers, with or without the article, hamza and tatweel', () => {
    expect(fieldFromHeader('الاسم')).toBe('name');
    expect(fieldFromHeader('اسم')).toBe('name');
    expect(fieldFromHeader('المكان')).toBe('place_path');
    expect(fieldFromHeader('الكميـــة')).toBe('quantity');
    expect(fieldFromHeader('تاريخ الشراء')).toBe('purchased_on');
    expect(fieldFromHeader('السعر')).toBe('price');
    expect(fieldFromHeader('رقم الأصل')).toBe('legacy_code');
    expect(fieldFromHeader('الماركة')).toBe('brand');
    expect(fieldFromHeader('ملاحظات')).toBe('notes');
  });

  it('reads English, French, German and Italian, ignoring case, accents and brackets', () => {
    expect(fieldFromHeader('Item Name')).toBe('name');
    expect(fieldFromHeader('Purchase Price (EGP)')).toBe('price');
    expect(fieldFromHeader('Désignation')).toBe('name');
    expect(fieldFromHeader('Numéro de série')).toBe('serial');
    expect(fieldFromHeader('Kaufdatum')).toBe('purchased_on');
    expect(fieldFromHeader('Händler')).toBe('vendor');
    expect(fieldFromHeader('Quantità')).toBe('quantity');
    expect(fieldFromHeader('Colore')).toBe('colour');
  });

  it("looks past a Homebox export's HB. prefix", () => {
    expect(fieldFromHeader('HB.name')).toBe('name');
    expect(fieldFromHeader('HB.location')).toBe('place_path');
    expect(fieldFromHeader('HB.labels')).toBe('tags');
    expect(fieldFromHeader('HB.asset_id')).toBe('legacy_code');
    expect(fieldFromHeader('HB.import_ref')).toBe('source_id');
    expect(fieldFromHeader('HB.purchase_from')).toBe('vendor');
  });

  it("leaves a header it doesn't know alone", () => {
    expect(fieldFromHeader('Wattage')).toBeNull();
    expect(normaliseHeader('  Serial   No. ')).toBe('serial no');
  });

  it('maps a single-valued field once, and a list field from every column that names it', () => {
    expect(suggestMapping(['الاسم', 'Name', 'Notes', 'Comments', 'المكان', 'Wattage'])).toEqual({
      الاسم: 'name',
      Name: 'ignore',
      Notes: 'notes',
      Comments: 'notes',
      المكان: 'place_path',
      Wattage: 'ignore',
    });
  });
});

describe('values', () => {
  it('finds the date format the dates read in, and says when it is ambiguous', () => {
    expect(dateFormatsFor(['31/12/2024', '١٢/٠٣/٢٠٢٤'])).toEqual(['DD/MM/YYYY']);
    expect(dateFormatsFor(['12/31/2024'])).toEqual(['MM/DD/YYYY']);
    expect(dateFormatsFor(['2024-03-12', ''])).toEqual(['YYYY-MM-DD']);
    expect(dateFormatsFor(['03/04/2024'])).toEqual(['DD/MM/YYYY', 'MM/DD/YYYY']);
    expect(dateFormatsFor(['soon'])).toEqual([]);
  });

  it('picks the separator the place paths use most', () => {
    expect(separatorFor(['Garage / Shelf A', 'Kitchen/Drawer'])).toBe('/');
    expect(separatorFor(['المطبخ > الرف'])).toBe('>');
    expect(separatorFor(['Garage'])).toBe('>');
  });
});
