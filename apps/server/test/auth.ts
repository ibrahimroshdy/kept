import { createHmac, randomBytes } from 'node:crypto';
import {
  type AuthDeps,
  createAuth,
  type MagicLinkMail,
  type SecurityNoticeMail,
} from '../src/auth/auth.js';
import { authRequestHeaders } from '../src/auth/client-ip.js';
import type { TestDb } from './db.js';

export const PUBLIC_URL = 'http://localhost:5173';
const SECRET = randomBytes(32).toString('base64url');

export type TestAuth = ReturnType<typeof createAuth> & {
  mails: MagicLinkMail[];
  resets: MagicLinkMail[];
  notices: SecurityNoticeMail[];
};

/** A Better Auth instance on the worker's database, logging in as kept_auth. Instances made in
 * the same test share the database (and so the rate-limit store), like two replicas would. */
export function testAuth(db: TestDb, overrides: Partial<AuthDeps> = {}): TestAuth {
  const mails: MagicLinkMail[] = [];
  const resets: MagicLinkMail[] = [];
  const notices: SecurityNoticeMail[] = [];
  const auth = createAuth({
    pool: db.pools.auth,
    mail: {
      sendMagicLink: async (mail) => {
        mails.push(mail);
      },
      sendPasswordReset: async (mail) => {
        resets.push(mail);
      },
      sendSecurityNotice: async (mail) => {
        notices.push(mail);
      },
    },
    ...overrides,
    env: { KEPT_AUTH_SECRET: SECRET, KEPT_PUBLIC_URL: PUBLIC_URL, ...overrides.env },
  });
  return Object.assign(auth, { mails, resets, notices });
}

/** The `Cookie` header a browser would send back after these `Set-Cookie` headers. Cookies
 * cleared with Max-Age=0 are dropped. */
export function cookieHeader(headers: Headers | null | undefined, previous = ''): string {
  const jar = new Map<string, string>();
  for (const pair of previous.split('; ').filter(Boolean)) {
    const i = pair.indexOf('=');
    jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
  for (const line of headers?.getSetCookie() ?? []) {
    const [pair = ''] = line.split(';');
    const i = pair.indexOf('=');
    const name = pair.slice(0, i);
    if (/max-age=0/i.test(line) || pair.slice(i + 1) === '') jar.delete(name);
    else jar.set(name, pair.slice(i + 1));
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

/** Headers as the Fastify mount hands them to Better Auth: `ip` is the socket's address, turned
 * into Kept's client-IP header by the same conversion (auth/client-ip.ts). */
export function requestHeaders(cookie = '', ip = '203.0.113.10'): Headers {
  const headers: Record<string, string> = { origin: PUBLIC_URL };
  if (cookie) headers.cookie = cookie;
  return authRequestHeaders({ headers, remoteAddress: ip, trustedProxies: [] });
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input: string): Buffer {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of input.replace(/=+$/, '').toUpperCase()) {
    const value = BASE32.indexOf(char);
    if (value < 0) throw new Error(`bad base32 character ${char}`);
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits): what an authenticator app shows for this secret. */
export function totp(secretBase32: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const mac = createHmac('sha1', base32Decode(secretBase32)).update(counter).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, '0');
}

export type SignedIn = { userId: string; cookie: string };

export async function signUp(
  auth: TestAuth,
  email: string,
  password = 'correct horse battery',
): Promise<SignedIn> {
  const { headers, response } = await auth.api.signUpEmail({
    body: { email, password, name: email.split('@')[0] ?? email },
    headers: requestHeaders(),
    returnHeaders: true,
  });
  return { userId: response.user.id, cookie: cookieHeader(headers) };
}

/** Enrols TOTP the way the app would: enable, then confirm with a first code. Returns the
 * secret and the replacement session's cookie. */
export async function enrolTotp(
  auth: TestAuth,
  signedIn: SignedIn,
  password = 'correct horse battery',
): Promise<{ secret: string; cookie: string }> {
  const enabled = await auth.api.enableTwoFactor({
    body: { password },
    headers: requestHeaders(signedIn.cookie),
  });
  const uri = new URL('totpURI' in enabled ? enabled.totpURI : '');
  const secret = uri.searchParams.get('secret') ?? '';
  const { headers } = await auth.api.verifyTOTP({
    body: { code: totp(secret) },
    headers: requestHeaders(signedIn.cookie),
    returnHeaders: true,
  });
  return { secret, cookie: cookieHeader(headers, signedIn.cookie) };
}
