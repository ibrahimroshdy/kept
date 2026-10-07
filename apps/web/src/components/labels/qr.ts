/**
 * QR codes for labels (D120): `uqr` (MIT, 0.1.3, already the invite page's encoder) loaded only
 * when a label is drawn, so it stays out of every other chunk. A label's QR has the standard
 * quiet zone of 4 modules, which a sticker's edge would otherwise eat, and error correction M.
 */
import { useEffect, useState } from 'react';

export type Encode = typeof import('uqr').encode;

let loading: Promise<Encode> | null = null;

export function loadQr(): Promise<Encode> {
  loading ??= import('uqr').then((m) => m.encode);
  return loading;
}

/** The encoder once loaded; null while it loads. */
export function useQrEncoder(): Encode | null {
  const [encode, setEncode] = useState<Encode | null>(null);
  useEffect(() => {
    let live = true;
    void loadQr().then((fn) => {
      if (live) setEncode(() => fn);
    });
    return () => {
      live = false;
    };
  }, []);
  return encode;
}

export const QUIET_ZONE = 4;

/** The module matrix, quiet zone included: `true` is a dark module. */
export function qrMatrix(encode: Encode, url: string): boolean[][] {
  return encode(url, { ecc: 'M', border: QUIET_ZONE }).data;
}

/** One SVG path of unit squares, one per dark module: no inline styles, so the CSP allows it. */
export function qrPath(matrix: readonly (readonly boolean[])[]): string {
  let d = '';
  matrix.forEach((row, y) => {
    row.forEach((on, x) => {
      if (on) d += `M${x} ${y}h1v1h-1z`;
    });
  });
  return d;
}
