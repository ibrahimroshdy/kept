import { createHash, randomBytes } from 'node:crypto';
import { renderSVG } from 'uqr';

// Invite tokens (task 20; D33, D181, D193). 32 random bytes, base64url in the link; only the
// SHA-256 (hex) is stored, so a read of `invites` can't join anyone. The link is the web page
// `/invite#<token>` (screens §2): the token rides in the fragment, never reaches a server log,
// and the page spends it by POST.

export const INVITE_TOKEN_BYTES = 32;
export const INVITE_TTL_DAYS = 7;

/** base64url of 32 bytes is 43 characters; anything else is not one of ours. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function isInviteTokenShape(token: string): boolean {
  return TOKEN.test(token);
}

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function newInviteToken(): { token: string; hash: string } {
  const token = randomBytes(INVITE_TOKEN_BYTES).toString('base64url');
  return { token, hash: hashInviteToken(token) };
}

/** The invite page, from KEPT_PUBLIC_URL (§7.11: the source of truth for links and QR codes). */
export function inviteUrl(publicUrl: string, token: string): string {
  const url = new URL('/invite', publicUrl);
  url.hash = token;
  return url.toString();
}

/** The link as an SVG QR code (D193), rendered here so the invite screen needs no library to
 * show it. uqr (MIT, no dependencies). Error correction M: a phone reads it off a screen. */
export function inviteQrSvg(url: string): string {
  return renderSVG(url, { ecc: 'M', border: 2, pixelSize: 6 });
}
