import { describe, expect, it } from 'vitest';
import { vinValid } from './vin.js';

describe('vinValid (ISO 3779 check digit, North American VINs)', () => {
  it.each([
    '1M8GDM9AXKP042788', // check digit X (remainder 10)
    '11111111111111111',
    '21111111911111111', // a Canadian WMI; check digit 9
    ' 1m8gdm9axkp042788 ', // trimmed and upper-cased
  ])('accepts %s', (vin) => {
    expect(vinValid(vin)).toBe(true);
  });

  it.each([
    '1M8GDM9A1KP042788', // wrong check digit
    '11111111211111111',
    '1M8GDM9AXKP04278O', // O is never used in a VIN
    '1M8GDM9AXKP04278I',
  ])('rejects %s', (vin) => {
    expect(vinValid(vin)).toBe(false);
  });

  it.each([
    'WVWZZZ1JZXW000001', // Europe: no mandatory check digit
    'JH4KA7560PC004185', // Japan
    '1M8GDM9AXKP04278', // 16 characters
    'ABC',
    '',
  ])('has no checksum to test for %s', (vin) => {
    expect(vinValid(vin)).toBeNull();
  });
});
