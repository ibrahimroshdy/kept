/**
 * The brand (D135, "B · Label tape"). The mark is a square of amber label tape with the tape's
 * punched hole at the top start and a heavy mono K (the font's outline as a path), at every size;
 * the lockup is that mark with KEPT beside it in IBM Plex Mono SemiBold (the shipped font), also
 * as outlines. scripts/render-icons.mjs draws the favicon, app icons and README lockups from the
 * same geometry. The tape is the short-ID chip's material too: brand and label are one object.
 *
 * The hole is cut out of the tape, so it shows whatever the mark sits on. The tape keeps its
 * colours in both themes (amber is a fill, ink on it is 8.2:1, D131); the wordmark is the text
 * colour (`text-ink` unless the caller sets one).
 */
import { cn } from '@/lib/utils';

const TAPE = '#F0B03A';
const INK = '#2E2100';

/**
 * Plex Mono SemiBold outlines, taken from the shipped font so the brand needs no font at any
 * size. Font units: 1000 per em, advance 600, baseline at y=0. scripts/render-icons.mjs carries
 * the same outlines.
 */
const GLYPHS = {
  K: 'M277 306 204 210V0H73V698H204V384H210L291 500L438 698H586L367 404L596 0H448Z',
  E: 'M83 0V698H524V590H214V408H513V300H214V108H524V0Z',
  P: 'M80 0V698H345Q447 698 501 640Q555 582 555 482Q555 382 501 324Q447 266 345 266H211V0ZM211 373H318Q371 373 394 394.5Q417 416 417 463V501Q417 548 394 569.5Q371 591 318 591H211Z',
  T: 'M365 590V0H235V590H25V698H575V590Z',
} as const;

/** The tape (60 units, squarish corners) with the punched hole cut out, even-odd. */
const TAPE_CUT =
  'M9 2H55A7 7 0 0 1 62 9V55A7 7 0 0 1 55 62H9A7 7 0 0 1 2 55V9A7 7 0 0 1 9 2ZM12 8.5A3.5 3.5 0 1 0 12 15.5A3.5 3.5 0 1 0 12 8.5Z';

/** The mark in its 64-unit square. */
function MarkArt() {
  return (
    <>
      <path d={TAPE_CUT} fill={TAPE} fillRule="evenodd" />
      <path d={GLYPHS.K} fill={INK} transform="translate(21.4 48) scale(0.042 -0.042)" />
    </>
  );
}

/** The lockup's width in mark units (the mark is 64). */
const LOCKUP_W = 191;
/** KEPT at the mark's K size and baseline, 0.12 em tracking, from x=74. */
const WORDMARK = (['K', 'E', 'P', 'T'] as const).map((g, i) => ({
  g,
  x: +(74 + i * 30.2).toFixed(1),
}));

export function BrandLockup({ className, width = 96 }: { className?: string; width?: number }) {
  return (
    <svg
      width={width}
      height={+((width * 64) / LOCKUP_W).toFixed(1)}
      viewBox={`0 0 ${LOCKUP_W} 64`}
      role="img"
      aria-label="Kept"
      className={cn('shrink-0 text-ink', className)}
    >
      <MarkArt />
      <g fill="currentColor">
        {WORDMARK.map(({ g, x }) => (
          <path key={g} d={GLYPHS[g]} transform={`translate(${x} 48) scale(0.042 -0.042)`} />
        ))}
      </g>
    </svg>
  );
}

/** The square mark, as the design board draws it (D135, "B · Label tape"). */
export function AppMark({
  size = 32,
  label,
  className,
}: {
  size?: number;
  /** Accessible name; without one the mark is decorative. */
  label?: string;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={cn('shrink-0', className)}
      role="img"
      aria-label={label ?? 'Kept'}
      aria-hidden={label ? undefined : true}
    >
      <MarkArt />
    </svg>
  );
}
