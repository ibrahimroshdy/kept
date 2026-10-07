import { randomInt } from 'node:crypto';

// Crockford base32 for codes a person reads off one screen and types into another (the setup
// code, managed accounts' reset codes): no I, L, O or U, so a code read aloud or copied by hand
// survives, and its look-alikes are read as the digits they stand for.

export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** `length` characters drawn uniformly from the alphabet with a CSPRNG. */
export function randomCrockford(length: number): string {
  let code = '';
  for (let i = 0; i < length; i++) code += CROCKFORD_ALPHABET[randomInt(CROCKFORD_ALPHABET.length)];
  return code;
}

/** What the person typed, as the code was issued: case, spaces and hyphens ignored, and
 * Crockford's look-alikes read as the digits they stand for (I and L as 1, O as 0). */
export function normaliseCrockford(code: string): string {
  return code.trim().toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
}

/** Whether `normalised` is exactly `length` alphabet characters. */
export function isCrockford(normalised: string, length: number): boolean {
  return (
    normalised.length === length && [...normalised].every((c) => CROCKFORD_ALPHABET.includes(c))
  );
}
