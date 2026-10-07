import { describe, expect, it } from 'vitest';
import { gtinValid, parseScan, upcEToUpcA } from './scan.js';

describe('parseScan: Kept labels (D120, §2.4)', () => {
  it.each([
    ['https://old.example/l/ab1lo0', 'AB1100'],
    ['https://kept.example/l/AB1100', 'AB1100'],
    ['http://192.168.1.20:8080/l/AB1100/', 'AB1100'],
    ['https://example.org/kept/l/ab1100?utm=1#x', 'AB1100'],
    ['AB1100', 'AB1100'],
    [' ab-11o0 ', 'AB1100'],
    ['123456', '123456'],
  ])('%s → %s', (text, code) => {
    expect(parseScan(text)).toEqual({ kind: 'kept', code });
  });

  it('ignores the host, so a label keeps working after a domain change', () => {
    expect(parseScan('https://anything.invalid/l/ZZZZZZ')).toEqual({
      kind: 'kept',
      code: 'ZZZZZZ',
    });
  });

  it.each([
    'http://x/l/ABC', // too short
    'https://x.example/l/ABCDEFG', // too long
    'https://x.example/l/AB U100', // U is not in the alphabet
    'ftp://x.example/l/AB1100', // not http(s)
    'https://x.example/k/AB1100',
    'ABCDEFG',
  ])('%s is other', (text) => {
    expect(parseScan(text)).toEqual({ kind: 'other', text: text.trim() });
  });
});

describe('parseScan: Homebox labels (D146)', () => {
  const uuid = '8f1c2b4e-3d5a-4c6b-9e7f-0a1b2c3d4e5f';
  it.each([
    ['https://homebox.lan/a/000-001', { path: 'a', assetId: '000-001' }],
    ['https://homebox.lan/a/000001', { path: 'a', assetId: '000-001' }],
    ['http://10.0.0.5:7745/a/12', { path: 'a', assetId: '000-012' }],
    [`https://hb.example/item/${uuid}`, { path: 'item', uuid }],
    [`https://hb.example/location/${uuid.toUpperCase()}`, { path: 'location', uuid }],
  ])('%s', (text, expected) => {
    expect(parseScan(text)).toEqual({ kind: 'homebox', ...expected });
  });

  it.each([
    'https://hb.example/a/abc',
    'https://hb.example/a/1234567',
    'https://hb.example/item/not-a-uuid',
  ])('%s is other', (text) => {
    expect(parseScan(text).kind).toBe('other');
  });
});

describe('parseScan: product barcodes', () => {
  it.each([
    ['4006381333931', undefined, 'ean_13'],
    ['4006381333931', 'ean_13', 'ean_13'],
    ['96385074', undefined, 'ean_8'],
    ['036000291452', undefined, 'upc_a'],
    ['036000291452', 'upc_a', 'upc_a'],
    ['04252614', 'upc_e', 'upc_e'],
  ])('%s (%s) → %s', (code, format, symbology) => {
    expect(parseScan(code, format)).toEqual({ kind: 'barcode', code, symbology });
  });

  it('refuses a wrong check digit', () => {
    expect(parseScan('4006381333932')).toEqual({ kind: 'other', text: '4006381333932' });
    expect(parseScan('4006381333932', 'ean_13').kind).toBe('other');
    expect(parseScan('04252615', 'upc_e').kind).toBe('other');
  });

  it('takes any other 1D format the detector names as it is', () => {
    expect(parseScan('SN-4411-A', 'code_128')).toEqual({
      kind: 'barcode',
      code: 'SN-4411-A',
      symbology: 'code_128',
    });
  });

  it('does not read a 6-digit product barcode as a Kept code', () => {
    expect(parseScan('123456', 'code_128')).toEqual({
      kind: 'barcode',
      code: '123456',
      symbology: 'code_128',
    });
  });

  it('shows any other QR text as other', () => {
    expect(parseScan('WIFI:T:WPA;S:home;P:secret;;', 'qr_code')).toEqual({
      kind: 'other',
      text: 'WIFI:T:WPA;S:home;P:secret;;',
    });
    expect(parseScan('')).toEqual({ kind: 'other', text: '' });
  });
});

describe('check digits', () => {
  it('validates GTIN-8/12/13 and expands UPC-E', () => {
    expect(gtinValid('4006381333931')).toBe(true);
    expect(gtinValid('4006381333932')).toBe(false);
    expect(gtinValid('96385074')).toBe(true);
    expect(gtinValid('abc')).toBe(false);
    expect(upcEToUpcA('04252614')).toBe('042100005264');
    expect(upcEToUpcA('01234505')).toBe('012000003455');
    expect(upcEToUpcA('21234565')).toBeNull(); // number system 2 has no UPC-E
  });
});
