/**
 * An SSRF-guarded `fetch` for URLs a person typed (D83, D128, D172; step-3 plan Q9): an
 * OpenAI-compatible base URL, and later webhooks and barcode lookups.
 *
 * - The check runs **at connect time**: an undici `Agent` whose `connect.lookup` resolves the
 *   name and refuses private, loopback, link-local (incl. 169.254.169.254), CGNAT, multicast,
 *   ULA and reserved addresses, so a name that re-resolves between a check and the connection
 *   can't slip through. Node skips `lookup` for an IP literal, so literals are checked first.
 * - **Redirects are refused** (`redirect: 'error'`): a public host can't bounce the request to
 *   a private one.
 * - `allowPrivate` comes from `instance_settings.ssrf_allow_private` (default false, Q9), the
 *   switch self-hosters flip for Ollama on the LAN.
 * A refusal is 400 `private_address`, with a hint that names the admin setting.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { AppError } from '../http/errors.js';

const HINT =
  'That address is on a private network. An instance admin can allow private addresses (Admin → Settings → "Allow private addresses") on a self-hosted server.';

export class PrivateAddressError extends AppError {
  constructor(readonly address: string) {
    super('private_address', 400, HINT);
    this.name = 'PrivateAddressError';
  }
}

export const PRIVATE_RANGES = (() => {
  const b = new BlockList();
  for (const [net, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const) {
    b.addSubnet(net, prefix, 'ipv4');
  }
  for (const [net, prefix] of [
    ['::', 128],
    ['::1', 128],
    // Step 6 (spike S6.2 §7, the CIMD fetch): special-use ranges Better Auth's own
    // isPublicRoutableHost() refuses and this list didn't: IPv4-compatible and -translated
    // addresses, NAT64's local-use prefix, Teredo, benchmarking, 6to4 (which embeds any IPv4,
    // a private one included), site-local, documentation and 5f00::/16.
    ['::', 96],
    ['::ffff:0:0:0', 96],
    ['64:ff9b::', 96],
    ['64:ff9b:1::', 48],
    ['100::', 64],
    ['2001::', 32],
    ['2001:2::', 48],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['3fff::', 20],
    ['5f00::', 16],
    ['fc00::', 7],
    ['fe80::', 10],
    ['fec0::', 10],
    ['ff00::', 8],
  ] as const) {
    b.addSubnet(net, prefix, 'ipv6');
  }
  return b;
})();

/** Whether an address is one Kept refuses to connect to (IPv4-mapped IPv6 checked as IPv4). */
export function isPrivateAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare);
  if (mapped?.[1]) return PRIVATE_RANGES.check(mapped[1], 'ipv4');
  const family = isIP(bare);
  if (family === 4) return PRIVATE_RANGES.check(bare, 'ipv4');
  if (family === 6) return PRIVATE_RANGES.check(bare, 'ipv6');
  return true; // not an address at all: refuse
}

export type Resolve = (
  host: string,
  cb: (err: Error | null, addresses: LookupAddress[]) => void,
) => void;

const systemResolve: Resolve = (host, cb) =>
  dnsLookup(host, { all: true }, (err, addrs) => cb(err, addrs ?? []));

/**
 * A connect-time `lookup` that refuses private addresses (and a name with none). Also used by
 * web push's `https.Agent` (notify/push.ts), which refuses them whatever `ssrf_allow_private`
 * says (step-4 plan Q12). Node skips `lookup` for an IP literal: check those first.
 */
export function guardedLookup(resolve: Resolve = systemResolve): LookupFunction {
  return ((hostname: string, options: { all?: boolean }, cb: (...args: unknown[]) => void) => {
    resolve(hostname, (err, addresses) => {
      if (err) return cb(err);
      const bad = addresses.find((a) => isPrivateAddress(a.address));
      if (bad || addresses.length === 0)
        return cb(new PrivateAddressError(bad?.address ?? hostname));
      if (options?.all) return cb(null, addresses);
      const first = addresses[0] as LookupAddress;
      return cb(null, first.address, first.family);
    });
  }) as unknown as LookupFunction;
}

/** The PrivateAddressError somewhere in a fetch failure's cause chain. */
function privateCause(e: unknown): PrivateAddressError | null {
  for (let c: unknown = e, i = 0; c && i < 6; c = (c as { cause?: unknown }).cause, i++) {
    if (c instanceof PrivateAddressError) return c;
  }
  return null;
}

/**
 * A `fetch` that refuses private addresses (unless `allowPrivate`) and every redirect.
 * `resolve` is for tests (a stubbed DNS answer).
 */
export function guardedFetch(opts: { allowPrivate: boolean; resolve?: Resolve }): typeof fetch {
  const dispatcher = opts.allowPrivate
    ? new Agent()
    : new Agent({ connect: { lookup: guardedLookup(opts.resolve ?? systemResolve) } });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!opts.allowPrivate && isIP(host) !== 0 && isPrivateAddress(host))
      throw new PrivateAddressError(host);
    try {
      return (await undiciFetch(url, {
        ...(init as object),
        redirect: 'error',
        dispatcher,
      } as Parameters<typeof undiciFetch>[1])) as unknown as Response;
    } catch (e) {
      throw privateCause(e) ?? e;
    }
  }) as typeof fetch;
}
