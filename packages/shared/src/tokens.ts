/**
 * Personal tokens and OAuth grants (D15, D60, D63, D179, D180; engineering spec §3.2, §7.3,
 * §7.13). A personal token is `kpt_<lookup>_<secret>`: an 8-character lookup id the server finds
 * the row by, and a 32-byte random secret in base64url that only its HMAC is stored for. It is
 * shown once.
 */

export const TOKEN_PREFIX = 'kpt_';
export const TOKEN_SCOPES = ['read', 'write'] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];
export const TOKEN_KINDS = ['personal', 'oauth'] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];

/** Why a token stopped working (`api_tokens.revoked_reason`). */
export const TOKEN_REVOKED_REASONS = [
  'user',
  'membership_ended',
  'role_lost',
  'expired',
  'admin',
  'client_revoked',
] as const;
export type TokenRevokedReason = (typeof TOKEN_REVOKED_REASONS)[number];

/** Per token, per minute (§3.2); MCP tool calls count by the tool's scope. */
export const TOKEN_RATE = Object.freeze({ readsPerMinute: 120, writesPerMinute: 30 });

/** The OAuth scopes a connector asks for (step-6 plan Q7). */
export const OAUTH_SCOPES = Object.freeze({ read: 'kept:read', write: 'kept:write' });

export const TOKEN_LOOKUP_LENGTH = 8;
export const TOKEN_SECRET_BYTES = 32;
const LOOKUP_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const TOKEN = /^kpt_([A-Za-z0-9]{8})_([A-Za-z0-9_-]{43})$/;

export type TokenParts = { lookup: string; secret: string };

export function formatToken({ lookup, secret }: TokenParts): string {
  return `${TOKEN_PREFIX}${lookup}_${secret}`;
}

/** The lookup and secret of a personal token, or null for anything else (an OAuth JWT too). */
export function parseToken(value: string): TokenParts | null {
  const m = TOKEN.exec(value.trim());
  return m?.[1] && m[2] ? { lookup: m[1], secret: m[2] } : null;
}

export function isPersonalToken(value: string): boolean {
  return value.trim().startsWith(TOKEN_PREFIX);
}

/** A new token's parts from the platform's CSPRNG. */
export function newTokenParts(): TokenParts {
  // 62 is not a power of two: draw bytes below 248 (4 × 62) so every character is equally likely.
  let lookup = '';
  while (lookup.length < TOKEN_LOOKUP_LENGTH) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < 248 && lookup.length < TOKEN_LOOKUP_LENGTH) lookup += LOOKUP_ALPHABET[b % 62];
    }
  }
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_SECRET_BYTES));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const secret = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { lookup, secret };
}
