/**
 * Short IDs (D120, D45, engineering spec §7.13): 6 characters of Crockford base32, allocated by
 * the server, permanent and never reissued. 32⁶ ≈ 1.07 billion codes. The alphabet leaves out
 * I, L, O and U, so a printed label can't be misread; typed input is folded back onto it.
 */

export const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const SHORT_CODE_LENGTH = 6;

/** A canonical short code. The same pattern is the SQL CHECK on `short_ids.code`. */
export const SHORT_CODE = /^[0-9A-HJKMNP-TV-Z]{6}$/;

export function isShortCode(s: string): boolean {
  return SHORT_CODE.test(s);
}

/**
 * A uniformly random code from `crypto.getRandomValues` (Node and browsers). 256 is a multiple
 * of 32, so masking a byte to 5 bits has no bias. Uniqueness is the database's job (the PK).
 */
export function randomShortCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SHORT_CODE_LENGTH));
  let code = '';
  for (const b of bytes) code += ALPHABET[b & 31];
  return code;
}

/** U+2011, the non-breaking hyphen a printed code is split with, so it never wraps. */
export const PRINTED_CODE_HYPHEN = '\u2011';

/**
 * A code as it is printed (D134): the app's chip and the inventory report show it 3 + 3 around a
 * non-breaking hyphen, "7KQ4MZ" → "7KQ‑4MZ". Anything that isn't 6 characters is shown as it is.
 */
export function printedCode(code: string): string {
  return code.length === SHORT_CODE_LENGTH
    ? `${code.slice(0, 3)}${PRINTED_CODE_HYPHEN}${code.slice(3)}`
    : code;
}

/**
 * What a person typed or a scanner read, folded onto the alphabet: upper case, `O` → `0`,
 * `I`/`L` → `1`, and spaces and hyphens dropped (Crockford's decoding rules), the printed code's
 * non-breaking hyphen and its Unicode cousins included (a code copied from a report). The result
 * is not validated; check it with `isShortCode`.
 */
export function normaliseInputCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s\u2010-\u2015-]+/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

/**
 * A legacy or own code as it is stored and compared (engineering spec §1.10, §7.16; D146, D208):
 * Eastern Arabic (٠–٩) and Persian (۰–۹) digits as Western ones, composed (NFC), trimmed, upper
 * case. Unlike a short ID, nothing else is folded: `BOLT-01` stays `BOLT-01`. The server's
 * `legacyCodeOf` (apps/server/src/imports/csv.ts) is the same.
 */
export function storedCodeOf(value: string): string {
  return value
    .replace(/[٠-٩۰-۹]/g, (d) => {
      const c = d.charCodeAt(0);
      return String(c >= 0x06f0 ? c - 0x06f0 : c - 0x0660);
    })
    .normalize('NFC')
    .trim()
    .toUpperCase();
}
