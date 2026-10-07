import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { assertBlobKey, isBlobKey } from './blob-store.js';

// Signed file URLs for local storage (Q16, D157). Every file is fetched through a short-lived URL
// on a path that never reads the session (`/f/<token>`, T17), so a file served there can't ride
// on anyone's cookie. The token carries everything the file route needs to answer, and nothing it
// has to look up as the user:
//
//   base64url(JSON {k: key, exp: unix seconds, d: disposition, n: filename, t: content type})
//   + "." + base64url(HMAC-SHA256(that first part))
//
// The HMAC key is derived from KEPT_AUTH_SECRET with HKDF (info `signed-url`), so it is never the
// auth secret itself and rotates with it. S3 uses presigned URLs instead (T18).

/** Q16: five minutes. */
export const SIGNED_URL_TTL_SECONDS = 300;
/** The longest life a URL may be given: a day (a share link is another mechanism). */
const MAX_TTL_SECONDS = 86_400;
const FILENAME_MAX = 255;
const CONTENT_TYPE = /^[a-z]+\/[a-z0-9.+-]+$/;
const PART = /^[A-Za-z0-9_-]+$/;

export type SignedFile = {
  key: string;
  disposition: 'inline' | 'attachment';
  filename: string;
  contentType: string;
};

export type VerifiedFile = SignedFile & {
  /** Unix seconds. */
  expiresAt: number;
};

export type UrlSigner = {
  /** A token for `file`, valid for `expiresIn` seconds (default 300). */
  sign(file: SignedFile, expiresIn?: number): string;
  /** The file a token names, or null when it is malformed, forged, expired, or (with
   * `expect.key`) made for another key. Never throws on bad input. */
  verify(token: string, expect?: { key?: string }): VerifiedFile | null;
};

type Payload = { k: string; exp: number; d: 'inline' | 'attachment'; n: string; t: string };

export type UrlSignerOptions = {
  /** The clock, in milliseconds (tests). */
  now?: () => number;
};

/** HKDF-SHA256(authSecret, salt `kept-files`, info `signed-url`), 32 bytes. */
export function signedUrlKey(authSecret: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', authSecret, 'kept-files', 'signed-url', 32));
}

function isPayload(value: unknown): value is Payload {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.k === 'string' &&
    isBlobKey(p.k) &&
    typeof p.exp === 'number' &&
    Number.isInteger(p.exp) &&
    (p.d === 'inline' || p.d === 'attachment') &&
    typeof p.n === 'string' &&
    p.n.length <= FILENAME_MAX &&
    typeof p.t === 'string' &&
    CONTENT_TYPE.test(p.t)
  );
}

export function createUrlSigner(authSecret: Buffer, opts: UrlSignerOptions = {}): UrlSigner {
  const hmacKey = signedUrlKey(authSecret);
  const now = opts.now ?? Date.now;
  const mac = (payload: string) => createHmac('sha256', hmacKey).update(payload).digest();

  return {
    sign(file, expiresIn = SIGNED_URL_TTL_SECONDS) {
      assertBlobKey(file.key);
      if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > MAX_TTL_SECONDS) {
        throw new RangeError(`a signed URL's lifetime is 1 to ${MAX_TTL_SECONDS} seconds`);
      }
      if (!CONTENT_TYPE.test(file.contentType)) throw new TypeError('not a content type');
      const payload: Payload = {
        k: file.key,
        exp: Math.floor(now() / 1000) + expiresIn,
        d: file.disposition,
        n: file.filename.slice(0, FILENAME_MAX),
        t: file.contentType,
      };
      const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
      return `${encoded}.${mac(encoded).toString('base64url')}`;
    },

    verify(token, expect = {}) {
      if (typeof token !== 'string') return null;
      const parts = token.split('.');
      if (parts.length !== 2) return null;
      const [encoded, signature] = parts as [string, string];
      if (!PART.test(encoded) || !PART.test(signature)) return null;
      const given = Buffer.from(signature, 'base64url');
      const wanted = mac(encoded);
      if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;
      let payload: unknown;
      try {
        payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
      } catch {
        return null;
      }
      if (!isPayload(payload)) return null;
      if (payload.exp * 1000 <= now()) return null;
      if (expect.key !== undefined && expect.key !== payload.k) return null;
      return {
        key: payload.k,
        disposition: payload.d,
        filename: payload.n,
        contentType: payload.t,
        expiresAt: payload.exp,
      };
    },
  };
}
