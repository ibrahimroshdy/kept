import { BlockList, isIP, isIPv4 } from 'node:net';

// Who is the client? (Phase B review, item 2.) Better Auth reads the client IP from request
// headers only; it never sees the TCP socket. Left to itself it trusts a single-value
// X-Forwarded-For, which any client can write, and behind an appending proxy (a multi-value
// header) it gets no IP at all and falls back to one shared bucket, so anyone could lock
// everyone out.
//
// So Kept decides the address itself, from the socket, when it turns a Fastify request into
// the Web Request Better Auth handles (task 17), and hands it over in one header of its own:
// - the socket's address is the client, unless that socket is a trusted proxy
//   (KEPT_TRUSTED_PROXIES, empty by default);
// - behind trusted proxies, X-Forwarded-For is walked from the right, skipping trusted hops;
//   the first untrusted hop is the client. Entries to its left were written by the client and
//   are never read;
// - the header is always overwritten, so a client can't supply it;
// - no address means the request is refused. There is no shared placeholder bucket.
// Better Auth is configured to read only CLIENT_IP_HEADER (auth.ts), and Kept's own limiters
// read it through requestClientIp(). Only X-Forwarded-For is understood, not RFC 7239
// `Forwarded`.

/** The header carrying the resolved client address from the request conversion to Better Auth. */
export const CLIENT_IP_HEADER = 'x-kept-client-ip';

type HeaderSource = Headers | Record<string, string | string[] | undefined>;

export type ClientIpInput = {
  /** The request's headers as received (Fastify's `request.headers`, or a Web `Headers`). */
  headers: HeaderSource;
  /** The TCP peer (Fastify's `request.socket.remoteAddress`). */
  remoteAddress: string | undefined;
  /** Addresses and CIDR ranges of reverse proxies to believe (`env.KEPT_TRUSTED_PROXIES`). */
  trustedProxies: readonly string[];
};

export class ClientIpError extends Error {
  readonly code = 'client_ip_unknown';

  constructor() {
    super('The client address could not be determined.');
    this.name = 'ClientIpError';
  }
}

/** "::ffff:10.0.0.2" → "10.0.0.2"; anything else unchanged. */
function unmapped(ip: string): string {
  const match = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return match?.[1] && isIPv4(match[1]) ? match[1] : ip;
}

/** A valid address, IPv4-mapped IPv6 unwrapped; null otherwise. */
function address(value: string | undefined): string | null {
  if (!value) return null;
  const ip = unmapped(value.trim());
  return isIP(ip) ? ip : null;
}

function parseEntry(entry: string): { ip: string; prefix: number; family: 'ipv4' | 'ipv6' } {
  const [ipPart = '', prefixPart, ...rest] = entry.split('/');
  const ip = address(ipPart);
  if (!ip || rest.length > 0) throw new Error(`not an IP address or CIDR range: ${entry}`);
  const family = isIPv4(ip) ? 'ipv4' : 'ipv6';
  const max = family === 'ipv4' ? 32 : 128;
  if (prefixPart === undefined) return { ip, prefix: max, family };
  if (!/^\d{1,3}$/.test(prefixPart) || Number(prefixPart) > max) {
    throw new Error(`not an IP address or CIDR range: ${entry}`);
  }
  return { ip, prefix: Number(prefixPart), family };
}

/** Parses `KEPT_TRUSTED_PROXIES`: comma-separated addresses and CIDR ranges. Throws on junk. */
export function parseTrustedProxies(value: string): string[] {
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of entries) parseEntry(entry);
  return entries;
}

const compiled = new WeakMap<readonly string[], BlockList>();

function trustedList(trustedProxies: readonly string[]): BlockList {
  let list = compiled.get(trustedProxies);
  if (!list) {
    list = new BlockList();
    for (const entry of trustedProxies) {
      const { ip, prefix, family } = parseEntry(entry);
      list.addSubnet(ip, prefix, family);
    }
    compiled.set(trustedProxies, list);
  }
  return list;
}

function isTrusted(list: BlockList, ip: string): boolean {
  return list.check(ip, isIPv4(ip) ? 'ipv4' : 'ipv6');
}

function headerValues(headers: HeaderSource, name: string): string[] {
  if (headers instanceof Headers) {
    const value = headers.get(name);
    return value === null ? [] : [value];
  }
  const value = headers[name];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** The client's address, or null when the request has no usable socket address. */
export function resolveClientIp(input: ClientIpInput): string | null {
  const peer = address(input.remoteAddress);
  if (!peer || input.trustedProxies.length === 0) return peer;
  const list = trustedList(input.trustedProxies);
  if (!isTrusted(list, peer)) return peer;

  const hops = headerValues(input.headers, 'x-forwarded-for')
    .join(',')
    .split(',')
    .map((hop) => hop.trim())
    .filter(Boolean);
  // `current` is always an address some trusted party vouched for.
  let current = peer;
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = address(hops[i]);
    if (!hop) return current;
    if (!isTrusted(list, hop)) return hop;
    current = hop;
  }
  return current;
}

/**
 * The headers to hand Better Auth for this request: the originals, with CLIENT_IP_HEADER set to
 * the resolved client address (replacing anything the client sent). Throws ClientIpError when
 * there is no address; the caller answers 400.
 */
export function authRequestHeaders(input: ClientIpInput): Headers {
  const ip = resolveClientIp(input);
  if (!ip) throw new ClientIpError();
  const headers = new Headers();
  if (input.headers instanceof Headers) {
    for (const [name, value] of input.headers) headers.append(name, value);
  } else {
    for (const [name, value] of Object.entries(input.headers)) {
      if (value === undefined) continue;
      for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
    }
  }
  headers.set(CLIENT_IP_HEADER, ip);
  return headers;
}

/** Keeps the /64 of an IPv6 address: one household or host is one limiter bucket. */
function ipv6Prefix64(ip: string): string {
  // An embedded dotted IPv4 tail ("::ffff:1.2.3.4" was unwrapped earlier; "64:ff9b::1.2.3.4"
  // was not) fills the last two groups, so it counts as two when expanding "::".
  const width = (part: string) => (part.includes('.') ? 2 : 1);
  const [head = '', tail] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const used = [...left, ...right].reduce((n, part) => n + width(part), 0);
  const groups =
    tail === undefined ? left : [...left, ...Array<string>(8 - used).fill('0'), ...right];
  const first4 = groups.slice(0, 4).map((g) => Number.parseInt(g, 16).toString(16));
  return `${first4.join(':')}::/64`;
}

/**
 * The client address Kept's own limiters key on: CLIENT_IP_HEADER as set by
 * authRequestHeaders(), normalised (IPv6 to its /64). Null when absent or malformed, and the
 * caller refuses the request rather than sharing a bucket. X-Forwarded-For is never read here.
 */
export function requestClientIp(headers: Headers | undefined): string | null {
  const ip = address(headers?.get(CLIENT_IP_HEADER) ?? undefined);
  if (!ip) return null;
  return isIPv4(ip) ? ip : ipv6Prefix64(ip.toLowerCase());
}
