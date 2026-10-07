import { describe, expect, it } from 'vitest';
import {
  authRequestHeaders,
  CLIENT_IP_HEADER,
  ClientIpError,
  parseTrustedProxies,
  requestClientIp,
  resolveClientIp,
} from './client-ip.js';

describe('resolveClientIp', () => {
  it('with no trusted proxies, is the socket address and ignores X-Forwarded-For', () => {
    expect(
      resolveClientIp({
        headers: { 'x-forwarded-for': '1.2.3.4' },
        remoteAddress: '198.51.100.7',
        trustedProxies: [],
      }),
    ).toBe('198.51.100.7');
  });

  it('ignores X-Forwarded-For from a socket that is not a trusted proxy', () => {
    expect(
      resolveClientIp({
        headers: { 'x-forwarded-for': '1.2.3.4' },
        remoteAddress: '198.51.100.7',
        trustedProxies: ['10.0.0.0/8'],
      }),
    ).toBe('198.51.100.7');
  });

  it('behind a trusted proxy, takes the address that proxy saw, not what the client wrote', () => {
    // The client sent "X-Forwarded-For: 1.2.3.4"; the proxy appended the real peer.
    expect(
      resolveClientIp({
        headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.9' },
        remoteAddress: '10.0.0.2',
        trustedProxies: ['10.0.0.0/8'],
      }),
    ).toBe('203.0.113.9');
  });

  it('walks through a chain of trusted proxies to the first untrusted hop', () => {
    expect(
      resolveClientIp({
        headers: new Headers({ 'x-forwarded-for': '1.2.3.4, 203.0.113.9, 10.0.0.5' }),
        remoteAddress: '10.0.0.2',
        trustedProxies: ['10.0.0.0/8'],
      }),
    ).toBe('203.0.113.9');
  });

  it('joins repeated X-Forwarded-For headers in order', () => {
    expect(
      resolveClientIp({
        headers: { 'x-forwarded-for': ['1.2.3.4', '203.0.113.9'] },
        remoteAddress: '10.0.0.2',
        trustedProxies: ['10.0.0.2'],
      }),
    ).toBe('203.0.113.9');
  });

  it('stops at a malformed hop and uses the last address a trusted proxy vouched for', () => {
    expect(
      resolveClientIp({
        headers: { 'x-forwarded-for': 'garbage, 10.0.0.9' },
        remoteAddress: '10.0.0.2',
        trustedProxies: ['10.0.0.0/8'],
      }),
    ).toBe('10.0.0.9');
  });

  it('a trusted proxy talking for itself (no header) is its own client', () => {
    expect(
      resolveClientIp({ headers: {}, remoteAddress: '10.0.0.2', trustedProxies: ['10.0.0.0/8'] }),
    ).toBe('10.0.0.2');
  });

  it('unwraps IPv4-mapped IPv6 socket addresses before matching', () => {
    expect(
      resolveClientIp({
        headers: { 'x-forwarded-for': '203.0.113.9' },
        remoteAddress: '::ffff:10.0.0.2',
        trustedProxies: ['10.0.0.0/8'],
      }),
    ).toBe('203.0.113.9');
  });

  it('matches IPv6 ranges', () => {
    expect(
      resolveClientIp({
        headers: { 'x-forwarded-for': '2001:db8:1::7' },
        remoteAddress: 'fd00::2',
        trustedProxies: ['fd00::/8'],
      }),
    ).toBe('2001:db8:1::7');
  });

  it('is null (never a shared placeholder) when there is no usable socket address', () => {
    expect(resolveClientIp({ headers: {}, remoteAddress: undefined, trustedProxies: [] })).toBe(
      null,
    );
    expect(resolveClientIp({ headers: {}, remoteAddress: 'nope', trustedProxies: [] })).toBe(null);
  });
});

describe('authRequestHeaders', () => {
  it('overwrites any client-supplied client-IP header with the resolved address', () => {
    const headers = authRequestHeaders({
      headers: { [CLIENT_IP_HEADER]: '1.2.3.4', cookie: 'a=b' },
      remoteAddress: '198.51.100.7',
      trustedProxies: [],
    });
    expect(headers.get(CLIENT_IP_HEADER)).toBe('198.51.100.7');
    expect(headers.get('cookie')).toBe('a=b');
  });

  it('refuses a request whose client address cannot be resolved', () => {
    expect(() =>
      authRequestHeaders({ headers: {}, remoteAddress: undefined, trustedProxies: [] }),
    ).toThrow(ClientIpError);
  });
});

describe('requestClientIp', () => {
  it('reads the resolved address and normalises it for limiter keys', () => {
    expect(requestClientIp(new Headers({ [CLIENT_IP_HEADER]: '203.0.113.9' }))).toBe('203.0.113.9');
    // One IPv6 /64 is one bucket, like Better Auth's own limiter.
    expect(requestClientIp(new Headers({ [CLIENT_IP_HEADER]: '2001:db8:1:2:aaaa::1' }))).toBe(
      requestClientIp(new Headers({ [CLIENT_IP_HEADER]: '2001:db8:1:2:bbbb::9' })),
    );
    expect(requestClientIp(new Headers({ [CLIENT_IP_HEADER]: '2001:DB8::1:2:3:4:5' }))).toBe(
      '2001:db8:0:1::/64',
    );
    expect(requestClientIp(new Headers({ [CLIENT_IP_HEADER]: '2001:db8:1:2:3:4:5:6' }))).not.toBe(
      requestClientIp(new Headers({ [CLIENT_IP_HEADER]: '2001:db8:1:3:3:4:5:6' })),
    );
  });

  it('is null when the header is absent or not an address; X-Forwarded-For is never read', () => {
    expect(requestClientIp(new Headers({ 'x-forwarded-for': '203.0.113.9' }))).toBe(null);
    expect(requestClientIp(new Headers({ [CLIENT_IP_HEADER]: 'unknown' }))).toBe(null);
    expect(requestClientIp(undefined)).toBe(null);
  });
});

describe('parseTrustedProxies', () => {
  it('parses a comma-separated list of addresses and CIDR ranges', () => {
    expect(parseTrustedProxies(' 10.0.0.0/8, 172.16.0.1 ,fd00::/8 ')).toEqual([
      '10.0.0.0/8',
      '172.16.0.1',
      'fd00::/8',
    ]);
    expect(parseTrustedProxies('')).toEqual([]);
  });

  it('rejects anything that is not an address or a range', () => {
    expect(() => parseTrustedProxies('10.0.0.0/33')).toThrow(/10\.0\.0\.0\/33/);
    expect(() => parseTrustedProxies('proxy.local')).toThrow(/proxy\.local/);
    expect(() => parseTrustedProxies('10.0.0.0/8x')).toThrow();
  });
});
