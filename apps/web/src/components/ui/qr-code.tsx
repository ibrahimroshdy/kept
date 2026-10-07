/**
 * A QR code drawn as one SVG path from uqr's module matrix (MIT). No inline styles and no
 * data: URIs, so it renders under the server's `default-src 'self'` CSP. Always dark on white
 * with a quiet zone, whatever the theme: scanners need the contrast.
 */
import { useMemo } from 'react';
import { encode } from 'uqr';

export function QrCode({
  value,
  label,
  size = 160,
  className,
}: {
  value: string;
  label: string;
  size?: number;
  className?: string;
}) {
  const { d, n } = useMemo(() => {
    const qr = encode(value, { ecc: 'M', border: 2 });
    let path = '';
    qr.data.forEach((row, y) => {
      row.forEach((on, x) => {
        if (on) path += `M${x} ${y}h1v1h-1z`;
      });
    });
    return { d: path, n: qr.size };
  }, [value]);
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${n} ${n}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className={className}
    >
      <rect width={n} height={n} fill="#FFFFFF" />
      <path d={d} fill="#1C1B19" />
    </svg>
  );
}
