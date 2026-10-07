/**
 * VIN check digits (ISO 3779; engineering spec §2.1 "a VIN must pass its checksum where the
 * format has one"). The ninth character is a check digit for vehicles made for North America
 * (world manufacturer codes starting 1–5). Elsewhere the position is not a checksum, so those
 * VINs are not tested: `null` means "no checksum", never "invalid".
 */

const TRANSLITERATION: Readonly<Record<string, number>> = Object.freeze({
  A: 1,
  B: 2,
  C: 3,
  D: 4,
  E: 5,
  F: 6,
  G: 7,
  H: 8,
  J: 1,
  K: 2,
  L: 3,
  M: 4,
  N: 5,
  P: 7,
  R: 9,
  S: 2,
  T: 3,
  U: 4,
  V: 5,
  W: 6,
  X: 7,
  Y: 8,
  Z: 9,
});
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2] as const;

function value(ch: string): number | undefined {
  return ch >= '0' && ch <= '9' ? Number(ch) : TRANSLITERATION[ch];
}

/**
 * True or false for a 17-character North American VIN; null for any other format. Letters I,
 * O and Q never appear in a VIN, so a North American VIN containing one is false.
 */
export function vinValid(input: string): boolean | null {
  const vin = input.trim().toUpperCase();
  if (vin.length !== 17 || !/^[1-5]/.test(vin)) return null;
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const v = value(vin[i] as string);
    if (v === undefined) return false;
    sum += v * (WEIGHTS[i] as number);
  }
  const r = sum % 11;
  return vin[8] === (r === 10 ? 'X' : String(r));
}
