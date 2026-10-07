/**
 * What a scan says, before any lookup (engineering spec §2.4; D120, D137, D146). The phone's
 * scanner, the capture camera and `POST /api/v1/scan/resolve` all start here, so every entry
 * point reads a label the same way.
 *
 * - **Kept labels:** any host's `/l/<code>`, or a bare code typed or read. The host is ignored
 *   (D120), so labels keep working after a domain change.
 * - **Homebox labels:** `/a/<assetId>`, `/item/<uuid>`, `/location/<uuid>` on any host (D146).
 *   Asset IDs are `%06d` shown as `000-001`; they come back in that form.
 * - **Product barcodes:** EAN-8, EAN-13, UPC-A and UPC-E with a valid check digit, or any other
 *   1D format the detector names.
 * - **Anything else** is `other`, and the scanner shows its text ("Not a Kept label").
 */

import { normaliseInputCode, SHORT_CODE } from './short-code.js';

export type ScanResult =
  | { kind: 'kept'; code: string }
  | {
      kind: 'homebox';
      path: 'a' | 'item' | 'location';
      assetId?: string;
      uuid?: string;
      /** Not carried by Homebox's label URLs; asset IDs repeat per collection, so an ambiguous
       * one is resolved by asking (D146). Reserved for a caller that knows the collection. */
      collection?: string;
    }
  | { kind: 'barcode'; code: string; symbology: string }
  | { kind: 'other'; text: string };

/** Formats (BarcodeDetector names) that carry a GTIN and so have a check digit. */
const PRODUCT_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'] as const;
/** Other 1D formats: their text is taken as a barcode as it is. */
const LINEAR_FORMATS = ['code_128', 'code_39', 'code_93', 'codabar', 'itf'] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The GS1 check digit of a GTIN-8, -12 or -13 (weights 3,1,3,… from the right). */
export function gtinValid(digits: string): boolean {
  if (!/^(?:\d{8}|\d{12}|\d{13})$/.test(digits)) return false;
  let sum = 0;
  for (let i = digits.length - 2, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) {
    sum += Number(digits[i]) * w;
  }
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
}

/**
 * A UPC-E code (number system 0 or 1, six digits, check digit) expanded to its UPC-A, whose
 * check digit it shares. Null when it isn't an 8-digit UPC-E.
 */
export function upcEToUpcA(upcE: string): string | null {
  if (!/^[01]\d{7}$/.test(upcE)) return null;
  const ns = upcE[0] as string;
  const m = upcE.slice(1, 7);
  const check = upcE[7] as string;
  const last = Number(m[5]);
  let body: string;
  if (last <= 2) body = `${m.slice(0, 2)}${m[5]}0000${m.slice(2, 5)}`;
  else if (last === 3) body = `${m.slice(0, 3)}00000${m.slice(3, 5)}`;
  else if (last === 4) body = `${m.slice(0, 4)}00000${m[4]}`;
  else body = `${m.slice(0, 5)}0000${m[5]}`;
  return `${ns}${body}${check}`;
}

function productBarcode(text: string, format?: string): ScanResult | null {
  const ok = (symbology: string): ScanResult => ({ kind: 'barcode', code: text, symbology });
  switch (format) {
    case 'ean_13':
      return text.length === 13 && gtinValid(text) ? ok('ean_13') : null;
    case 'ean_8':
      return text.length === 8 && gtinValid(text) ? ok('ean_8') : null;
    case 'upc_a':
      return text.length === 12 && gtinValid(text) ? ok('upc_a') : null;
    case 'upc_e': {
      const a = upcEToUpcA(text);
      return a !== null && gtinValid(a) ? ok('upc_e') : null;
    }
  }
  if (!/^\d+$/.test(text)) return null;
  if (text.length === 13) return gtinValid(text) ? ok('ean_13') : null;
  if (text.length === 12) return gtinValid(text) ? ok('upc_a') : null;
  if (text.length === 8) {
    if (gtinValid(text)) return ok('ean_8');
    const a = upcEToUpcA(text);
    return a !== null && gtinValid(a) ? ok('upc_e') : null;
  }
  return null;
}

/** A Homebox asset ID in its canonical `000-001` form (as `/a/<assetId>` carries it, padded or
 * not), or null when it isn't one. The Homebox importer writes legacy codes in this form too
 * (homebox.ts homeboxAssetCode()), so a printed label and an imported code always match. */
export function homeboxAssetId(raw: string): string | null {
  const m = /^(\d{3})-(\d{3})$/.exec(raw);
  if (m) return `${m[1]}-${m[2]}`;
  if (!/^\d{1,6}$/.test(raw)) return null;
  const padded = raw.padStart(6, '0');
  return `${padded.slice(0, 3)}-${padded.slice(3)}`;
}

function fromUrl(text: string): ScanResult | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname).replace(/\/+$/, '');
  } catch {
    return null;
  }

  const kept = /\/l\/([^/]+)$/.exec(path);
  if (kept) {
    const code = normaliseInputCode(kept[1] as string);
    return SHORT_CODE.test(code) ? { kind: 'kept', code } : null;
  }

  const hb = /\/(a|item|location)\/([^/]+)$/.exec(path);
  if (hb) {
    const kind = hb[1] as 'a' | 'item' | 'location';
    const value = hb[2] as string;
    if (kind === 'a') {
      const assetId = homeboxAssetId(value);
      return assetId ? { kind: 'homebox', path: 'a', assetId } : null;
    }
    return UUID.test(value) ? { kind: 'homebox', path: kind, uuid: value.toLowerCase() } : null;
  }
  return null;
}

/**
 * Classifies scanned or typed text. `format` is the BarcodeDetector format name when the
 * detector gave one (`qr_code`, `ean_13`, `code_128`…). A product format is only read as a
 * product barcode, never as a Kept code.
 */
export function parseScan(input: string, format?: string): ScanResult {
  const text = input.trim();
  const other: ScanResult = { kind: 'other', text };
  if (!text) return other;

  if ((PRODUCT_FORMATS as readonly string[]).includes(format ?? '')) {
    return productBarcode(text, format) ?? other;
  }
  if ((LINEAR_FORMATS as readonly string[]).includes(format ?? '')) {
    return { kind: 'barcode', code: text, symbology: format as string };
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    return fromUrl(text) ?? other;
  }
  const code = normaliseInputCode(text);
  if (SHORT_CODE.test(code)) return { kind: 'kept', code };
  return productBarcode(text) ?? other;
}
