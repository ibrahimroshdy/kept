/**
 * One printed label (D120, D134): the QR of `<public-url>/l/<code>` with its quiet zone, the code
 * large in Plex Mono, then the name and where it lives. Always black on white, whatever the
 * theme: it is paper. The code is the chip's printed form (7KQ‑4MZ, a non-breaking hyphen) and
 * stays left to right in every language (D143); the name and path take their own direction
 * (`dir=auto`) and the browser shapes Arabic (D97). A compact stock prints the QR and code only.
 *
 * Sizes are millimetres from `cellMetrics`, set through React's style prop (the CSSOM, which the
 * CSP allows; a `style` attribute in markup it would not).
 */
import { type LabelStock, printedCode } from '@kept/shared';
import { useMemo } from 'react';
import type { LabelCellContent } from '@/api/capture/types';
import { cellMetrics, LABEL_MONO, LABEL_SANS, mm } from './layout';
import { type Encode, qrMatrix, qrPath } from './qr';

export function LabelCell({
  label,
  stock,
  encode,
}: {
  label: LabelCellContent;
  stock: LabelStock;
  /** The QR encoder; null while it loads (the square stays white until then). */
  encode: Encode | null;
}) {
  const m = cellMetrics(stock);
  const qr = useMemo(() => {
    if (!encode) return null;
    const matrix = qrMatrix(encode, label.url);
    return { d: qrPath(matrix), n: matrix.length };
  }, [encode, label.url]);
  return (
    <div
      dir="ltr"
      data-slot="label"
      className="flex size-full items-center overflow-hidden bg-white text-black"
      style={{ padding: mm(m.pad), columnGap: mm(m.pad) }}
    >
      <svg
        aria-hidden="true"
        viewBox={qr ? `0 0 ${qr.n} ${qr.n}` : '0 0 1 1'}
        width={mm(m.qr)}
        height={mm(m.qr)}
        shapeRendering="crispEdges"
        className="shrink-0"
      >
        <rect width="100%" height="100%" fill="#FFFFFF" />
        {qr ? <path d={qr.d} fill="#000000" /> : null}
      </svg>
      <div
        className="grid min-w-0 content-center"
        style={{ inlineSize: mm(m.text), rowGap: mm(m.pad * 0.6) }}
      >
        <bdi
          dir="ltr"
          className="block font-semibold whitespace-nowrap"
          style={{
            fontFamily: LABEL_MONO,
            fontSize: mm(m.code),
            lineHeight: 1,
            letterSpacing: '0.06em',
          }}
        >
          {printedCode(label.code)}
        </bdi>
        {!m.compact && label.name ? (
          <p
            dir="auto"
            className="m-0 line-clamp-2 font-semibold [overflow-wrap:anywhere]"
            style={{ fontFamily: LABEL_SANS, fontSize: mm(m.name), lineHeight: 1.25 }}
          >
            {label.name}
          </p>
        ) : null}
        {!m.compact && label.path ? (
          <p
            dir="auto"
            className="m-0 line-clamp-2 [overflow-wrap:anywhere]"
            style={{
              fontFamily: LABEL_SANS,
              fontSize: mm(m.path),
              lineHeight: 1.25,
              color: '#444444',
            }}
          >
            {label.path}
          </p>
        ) : null}
      </div>
    </div>
  );
}
