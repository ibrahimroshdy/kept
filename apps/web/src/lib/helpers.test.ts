import { describe, expect, it } from 'vitest';
import { makeFormatter } from './format';
import { tokenFromHash } from './fragment';
import { currencyForLocale } from './labels';
import { safeNext } from './next';
import { secretOf } from './otp';
import { formatLocale } from './prefs';
import { grantableRoles } from './roles';
import { describeUserAgent } from './user-agent';

describe('tokenFromHash (D181)', () => {
  it.each([
    ['#token=abc123DEF', 'abc123DEF'],
    ['#K7q2Rm9TxVd4', 'K7q2Rm9TxVd4'],
    ['token=xyz789', 'xyz789'],
    ['', null],
    ['#', null],
    ['#token=', null],
    ['#<script>', null],
  ])('%s → %s', (hash, token) => expect(tokenFromHash(hash)).toBe(token));
});

describe('safeNext', () => {
  it.each([
    ['/settings', '/settings'],
    ['/invite#abc', '/invite#abc'],
    ['//evil.example', undefined],
    ['/\\evil.example', undefined],
    ['https://evil.example', undefined],
    [42, undefined],
  ])('%s → %s', (v, out) => expect(safeNext(v)).toBe(out));
});

describe('currencyForLocale (same guess as the server, task 18)', () => {
  it.each([
    ['ar-EG', 'EGP'],
    ['en-GB', 'GBP'],
    ['fr-CA', 'CAD'],
    ['en-CA', 'CAD'],
    ['de-DE', 'EUR'],
    ['en-US', 'USD'],
    ['ar', 'USD'],
  ])('%s → %s', (tag, code) => expect(currencyForLocale(tag)).toBe(code));
});

describe('digits (D143)', () => {
  it('Eastern and Western Arabic digits, English always Western', () => {
    expect(makeFormatter(formatLocale('ar', 'eastern')).num(214)).toBe('٢١٤');
    expect(makeFormatter(formatLocale('ar', 'western')).num(214)).toBe('214');
    expect(makeFormatter(formatLocale('en', 'eastern')).num(214)).toBe('214');
  });
});

describe('small helpers', () => {
  it('secretOf groups the otpauth secret in fours', () => {
    expect(secretOf('otpauth://totp/Kept:a@b.c?secret=JBSWY3DPEHPK3PXP&issuer=Kept')).toBe(
      'JBSW Y3DP EHPK 3PXP',
    );
    expect(secretOf('not a uri')).toBe('');
  });

  it('grantableRoles: admin only for the owner (D48)', () => {
    expect(grantableRoles('owner')).toEqual(['admin', 'member', 'viewer']);
    expect(grantableRoles('admin')).toEqual(['member', 'viewer']);
    expect(grantableRoles('member')).toEqual([]);
  });

  it('describeUserAgent', () => {
    expect(
      describeUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) Version/19.0 Mobile Safari/604.1',
      ),
    ).toEqual({ browser: 'Safari', os: 'iPhone', kind: 'phone' });
    expect(describeUserAgent(null)).toEqual({ browser: null, os: null, kind: 'computer' });
  });
});
