/**
 * A location card's map preview (D240): a small static isometric drawing of a floor and its rooms,
 * with a pin for each kind of flag the location has, as the approved Home design draws it.
 *
 * It is a stand-in until the location map (D237) can give a live snapshot: everything Home knows
 * about a location reaches it through `MapPreviewProps`, so swapping this component for a
 * snapshot changes nothing around it. The drawing follows the location's kind, not its real
 * rooms; the pins follow its real flags. Decorative: the card says the same in words.
 */
import type { LocationKind } from '@/api/types';

export type MapPreviewTone = 'danger' | 'amber' | 'warn' | 'info' | 'violet';

export type MapPreviewProps = {
  kind: LocationKind;
  /** Live places, Unplaced left out: none draws an empty floor. */
  places: number;
  /** Things in it: an empty Personal location is an empty floor too. */
  things: number;
  /** One pin per tone, at most three, most urgent first. */
  pins: readonly MapPreviewTone[];
};

type Box = {
  x: number;
  y: number;
  w: number;
  d: number;
  h: number;
  z?: number;
  gap?: number;
  top?: string;
  front?: string;
  side?: string;
};
type Plan = { floor: [number, number]; rooms: Box[]; anchors: [number, number, number][] };

const tint = (color: string, pct: number) => `color-mix(in srgb, ${color} ${pct}%, var(--surface))`;

/** The drawings, by kind (the design's Home, Garage, Personal and an empty floor). */
const PLANS: Record<'home' | 'garage' | 'personal' | 'empty', Plan> = {
  home: {
    floor: [12, 9],
    rooms: [
      { x: 0, y: 0, w: 6, d: 5, h: 1.1 },
      { x: 6, y: 0, w: 3.5, d: 3, h: 1.1 },
      { x: 9.5, y: 0, w: 2.5, d: 3, h: 1.1 },
      { x: 6, y: 3, w: 6, d: 2, h: 1.1 },
      { x: 0, y: 5, w: 4.5, d: 4, h: 1.1 },
      { x: 4.5, y: 5, w: 3.5, d: 4, h: 1.1 },
      { x: 8, y: 5, w: 4, d: 4, h: 1.1 },
      { x: 1, y: 0.8, w: 3.2, d: 1.3, h: 0.7, z: 1.1, gap: 0, top: tint('var(--s1)', 22) },
    ],
    anchors: [
      [3, 2.6, 1.1],
      [7.7, 1.4, 1.1],
      [10.2, 4, 1.1],
    ],
  },
  garage: {
    floor: [10, 7],
    rooms: [
      { x: 0, y: 0, w: 5, d: 7, h: 0.25 },
      { x: 5, y: 0, w: 3, d: 7, h: 0.25 },
      { x: 8.2, y: 0, w: 1.8, d: 3.2, h: 3 },
      { x: 8.2, y: 3.6, w: 1.8, d: 3.4, h: 3 },
      {
        x: 1.2,
        y: 1.4,
        w: 2.6,
        d: 4.4,
        h: 1.5,
        z: 0.25,
        gap: 0,
        top: tint('var(--s1)', 30),
        front: tint('var(--s1)', 45),
        side: tint('var(--s1)', 60),
      },
    ],
    anchors: [
      [2.5, 3.6, 1.75],
      [9.1, 1.6, 3],
      [9.1, 5.3, 3],
    ],
  },
  personal: {
    floor: [5, 4],
    rooms: [
      { x: 0.6, y: 0.6, w: 2, d: 1.4, h: 0.35, gap: 0, top: tint('var(--s2)', 25) },
      { x: 2.8, y: 1.8, w: 1.4, d: 1.4, h: 0.25, gap: 0, top: tint('var(--amber)', 45) },
    ],
    anchors: [
      [1.6, 1.3, 0.35],
      [3.5, 2.5, 0.25],
      [4.2, 0.8, 0],
    ],
  },
  empty: {
    floor: [5, 4],
    rooms: [],
    anchors: [
      [1.5, 1.5, 0],
      [3.5, 2.5, 0],
      [2.5, 3.2, 0],
    ],
  },
};

const S = 8;
const fmt = (n: number) => n.toFixed(1);

function planOf(kind: LocationKind, places: number, things: number): Plan {
  if (kind === 'personal') return things > 0 ? PLANS.personal : PLANS.empty;
  if (places === 0) return PLANS.empty;
  return kind === 'garage' ? PLANS.garage : PLANS.home;
}

export function LocationMapPreview({ kind, places, things, pins }: MapPreviewProps) {
  const plan = planOf(kind, places, things);
  const points: [number, number][] = [];
  const pr = (x: number, y: number, z: number): [number, number] => {
    const p: [number, number] = [(x - y) * 0.866 * S, (x + y) * 0.5 * S - z * S];
    points.push(p);
    return p;
  };
  const stroke = {
    stroke: 'var(--ink-3)',
    strokeOpacity: 0.45,
    strokeWidth: 0.6,
    strokeLinejoin: 'round' as const,
  };
  const shapes: { pts: [number, number][]; fill: string }[] = [];
  const [W, D] = plan.floor;
  shapes.push({
    pts: [pr(0, D, 0), pr(W, D, 0), pr(W, D, -0.5), pr(0, D, -0.5)],
    fill: 'color-mix(in srgb, var(--ink-3) 30%, var(--paper))',
  });
  shapes.push({
    pts: [pr(W, 0, 0), pr(W, D, 0), pr(W, D, -0.5), pr(W, 0, -0.5)],
    fill: 'color-mix(in srgb, var(--ink-3) 42%, var(--paper))',
  });
  shapes.push({ pts: [pr(0, 0, 0), pr(W, 0, 0), pr(W, D, 0), pr(0, D, 0)], fill: 'var(--sunken)' });
  const depth = (r: Box) => r.x + r.w + r.y + r.d + (r.z ?? 0) * 4;
  for (const r of [...plan.rooms].sort((a, b) => depth(a) - depth(b))) {
    const g = r.gap ?? 0.14;
    const x = r.x + g;
    const y = r.y + g;
    const w = r.w - 2 * g;
    const d = r.d - 2 * g;
    const z0 = r.z ?? 0;
    const h = z0 + r.h;
    shapes.push({
      pts: [pr(x, y + d, z0), pr(x + w, y + d, z0), pr(x + w, y + d, h), pr(x, y + d, h)],
      fill: r.front ?? tint('var(--ink-3)', 24),
    });
    shapes.push({
      pts: [pr(x + w, y, z0), pr(x + w, y + d, z0), pr(x + w, y + d, h), pr(x + w, y, h)],
      fill: r.side ?? tint('var(--ink-3)', 38),
    });
    shapes.push({
      pts: [pr(x, y, h), pr(x + w, y, h), pr(x + w, y + d, h), pr(x, y + d, h)],
      fill: r.top ?? 'var(--surface)',
    });
  }
  const marks = pins.slice(0, 3).map((tone, i) => {
    const [x, y, z] = plan.anchors[i] ?? plan.anchors[0] ?? [0, 0, 0];
    return { tone, a: pr(x, y, z), b: pr(x, y, z + 2.4) };
  });
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const minX = Math.min(...xs) - 5;
  const minY = Math.min(...ys) - 6;
  const w = Math.max(...xs) - minX + 5;
  const h = Math.max(...ys) - minY + 4;
  return (
    <svg
      viewBox={`${fmt(minX)} ${fmt(minY)} ${fmt(w)} ${fmt(h)}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      className="block size-full max-h-[120px]"
    >
      {shapes.map((s, i) => (
        <polygon
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed drawing, never reordered.
          key={i}
          points={s.pts.map((p) => p.map(fmt).join(',')).join(' ')}
          style={{ fill: s.fill, ...stroke }}
        />
      ))}
      {marks.map((m) => (
        <g key={m.tone}>
          <line
            x1={fmt(m.a[0])}
            y1={fmt(m.a[1])}
            x2={fmt(m.b[0])}
            y2={fmt(m.b[1])}
            style={{ stroke: 'var(--ink-2)', strokeWidth: 0.9 }}
          />
          <circle
            cx={fmt(m.b[0])}
            cy={fmt(m.b[1])}
            r="3.6"
            data-pin={m.tone}
            style={{ fill: `var(--${m.tone})`, stroke: 'var(--surface)', strokeWidth: 1.4 }}
          />
        </g>
      ))}
    </svg>
  );
}
