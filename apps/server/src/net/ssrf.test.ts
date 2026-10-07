import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedFetch, isPrivateAddress, PrivateAddressError } from './ssrf.js';

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"data":[]}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
});

describe('isPrivateAddress', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.0.0.5', true],
    ['172.20.1.1', true],
    ['192.168.1.1', true],
    // RFC 6598 shared address space (carrier-grade NAT, and the range Tailscale hands out).
    ['100.64.0.1', true],
    ['100.127.255.254', true],
    // RFC 5737 documentation ranges.
    ['192.0.2.10', true],
    ['198.51.100.7', true],
    ['203.0.113.9', true],
    ['169.254.169.254', true],
    ['224.0.0.1', true],
    ['::1', true],
    ['fd12::1', true],
    ['fe80::1', true],
    ['::ffff:10.0.0.1', true],
    // Spike S6.2 §7's gaps (step 6, the CIMD fetch).
    ['192.88.99.1', true],
    ['2002:7f00:1::', true],
    ['2001:0:1::1', true],
    ['2001:2::1', true],
    ['::7f00:1', true],
    ['::ffff:0:7f00:1', true],
    ['fec0::1', true],
    ['3fff::1', true],
    ['5f00::1', true],
    ['64:ff9b:1::1', true],
    ['2606:4700::1111', false],
    ['not-an-ip', true],
    ['8.8.8.8', false],
    ['1.1.1.1', false],
    ['2606:4700:4700::1111', false],
  ])('%s → %s', (addr, want) => {
    expect(isPrivateAddress(addr)).toBe(want);
  });
});

describe('guardedFetch', () => {
  it('refuses a private IP literal with 400 private_address and the admin hint', async () => {
    const f = guardedFetch({ allowPrivate: false });
    const err = await f(`http://127.0.0.1:${port}/models`).catch((e) => e);
    expect(err).toBeInstanceOf(PrivateAddressError);
    expect(err).toMatchObject({ code: 'private_address', status: 400 });
    expect(err.hint).toMatch(/Allow private addresses/);
  });

  it('refuses IPv6 loopback', async () => {
    await expect(
      guardedFetch({ allowPrivate: false })('http://[::1]:9/models'),
    ).rejects.toBeInstanceOf(PrivateAddressError);
  });

  it('refuses a name that resolves to a private address, at connect time', async () => {
    const f = guardedFetch({
      allowPrivate: false,
      resolve: (_host, cb) => cb(null, [{ address: '10.0.0.5', family: 4 }]),
    });
    await expect(f('http://ollama.example.test:11434/v1/models')).rejects.toBeInstanceOf(
      PrivateAddressError,
    );
  });

  it('refuses redirects', async () => {
    const f = guardedFetch({ allowPrivate: true });
    await expect(f(`http://127.0.0.1:${port}/redirect`)).rejects.toThrow();
  });

  it('allows private addresses when the instance allows them', async () => {
    const res = await guardedFetch({ allowPrivate: true })(`http://127.0.0.1:${port}/models`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
  });
});
