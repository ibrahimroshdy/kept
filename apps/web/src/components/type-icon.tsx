/**
 * Type and place-kind icons (D98): `lucide:<name>`, `tabler:<name>` or `kept:<name>`.
 *
 * The built-in library's icons (packages/shared builtin-types.ts, the place kinds, and the
 * generic fallbacks) are a static map of named imports, so only these ~45 icons reach the
 * bundle. Any other Lucide name (an account's custom type, chosen in the icon picker) renders
 * through `lucide-react/dynamic`, loaded lazily in its own chunk, never the entry chunk; the
 * picker itself (task 28) imports the same module inside the lazy type-editor chunk. Tabler has
 * no usable dynamic entry in 3.48.0 (its dynamic-imports map points at `.ts` files that aren't
 * shipped), so an unknown `tabler:*` falls back to the generic box. Decorative: the row or
 * control that holds the icon carries the name.
 */
import { IconEngine, IconHanger } from '@tabler/icons-react';
import {
  AlarmSmoke,
  Baby,
  BatteryFull,
  Bike,
  Box,
  BriefcaseMedical,
  Cable,
  Camera,
  Car,
  CarFront,
  CircleDashed,
  Cpu,
  Dices,
  DoorOpen,
  Drill,
  FireExtinguisher,
  Funnel,
  Gamepad2,
  Gem,
  HardHat,
  Laptop,
  Layers,
  type LucideIcon,
  MapPin,
  Medal,
  Microwave,
  MonitorSmartphone,
  Motorbike,
  Package,
  PlugZap,
  Refrigerator,
  Router,
  ShieldPlus,
  ShoppingBasket,
  Smartphone,
  Sofa,
  SquareDashed,
  Tablet,
  Trophy,
  Tv,
  Vault,
  WashingMachine,
  Wrench,
} from 'lucide-react';
import { type ComponentType, lazy, Suspense, type SVGProps } from 'react';
import { cn } from '@/lib/utils';

type IconComponent = ComponentType<{ className?: string; strokeWidth?: number | string }>;

/** A safe: a strongbox with a dial and handle (D98: the custom icon where both sets lack one). */
function KeptSafe(props: SVGProps<SVGSVGElement>) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative; TypeIcon passes aria-hidden
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <rect x="3.5" y="3.5" width="17" height="15" rx="2" />
      <circle cx="11" cy="11" r="3.2" />
      <path d="M11 7.8v1M11 13.2v1M7.8 11h1M13.2 11h1M17 9v4M6 18.5V20.5M18 18.5v2" />
    </svg>
  );
}

const lucide = (C: LucideIcon): IconComponent => C as unknown as IconComponent;

/** Every built-in icon, by its `set:name` reference. Keep in step with builtin-types.ts. */
export const STATIC_ICONS: Record<string, IconComponent> = {
  // types (D154, D192)
  'lucide:sofa': lucide(Sofa),
  'lucide:refrigerator': lucide(Refrigerator),
  'lucide:washing-machine': lucide(WashingMachine),
  'lucide:microwave': lucide(Microwave),
  'lucide:monitor-smartphone': lucide(MonitorSmartphone),
  'lucide:smartphone': lucide(Smartphone),
  'lucide:tablet': lucide(Tablet),
  'lucide:laptop': lucide(Laptop),
  'lucide:tv': lucide(Tv),
  'lucide:router': lucide(Router),
  'lucide:camera': lucide(Camera),
  'lucide:gamepad-2': lucide(Gamepad2),
  'lucide:cable': lucide(Cable),
  'lucide:plug-zap': lucide(PlugZap),
  'lucide:wrench': lucide(Wrench),
  'lucide:drill': lucide(Drill),
  'lucide:package': lucide(Package),
  'lucide:vault': lucide(Vault),
  'lucide:car-front': lucide(CarFront),
  'lucide:car': lucide(Car),
  'lucide:motorbike': lucide(Motorbike),
  'lucide:bike': lucide(Bike),
  'tabler:engine': IconEngine as unknown as IconComponent,
  'lucide:hard-hat': lucide(HardHat),
  'lucide:shield-plus': lucide(ShieldPlus),
  'lucide:fire-extinguisher': lucide(FireExtinguisher),
  'lucide:briefcase-medical': lucide(BriefcaseMedical),
  'lucide:alarm-smoke': lucide(AlarmSmoke),
  'lucide:baby': lucide(Baby),
  'lucide:gem': lucide(Gem),
  'lucide:trophy': lucide(Trophy),
  'lucide:medal': lucide(Medal),
  'lucide:shopping-basket': lucide(ShoppingBasket),
  'lucide:battery-full': lucide(BatteryFull),
  'lucide:funnel': lucide(Funnel),
  'lucide:cpu': lucide(Cpu),
  'lucide:dices': lucide(Dices),
  // place kinds (D33) and the Unplaced area (D118)
  'lucide:layers': lucide(Layers),
  'lucide:door-open': lucide(DoorOpen),
  'lucide:square-dashed': lucide(SquareDashed),
  'tabler:hanger': IconHanger as unknown as IconComponent,
  'lucide:circle-dashed': lucide(CircleDashed),
  // generic fallbacks
  'lucide:box': lucide(Box),
  'lucide:map-pin': lucide(MapPin),
  // Kept's own (D98)
  'kept:safe': KeptSafe as IconComponent,
};

/** What an unknown or missing reference renders as. */
export const FALLBACK_ICON = 'lucide:box';

export type IconSource = 'static' | 'dynamic' | 'fallback';

/** How a reference resolves: a static icon, a lazily loaded Lucide icon, or the fallback. */
export function resolveIcon(ref: string | null | undefined): { source: IconSource; name: string } {
  if (ref && STATIC_ICONS[ref]) return { source: 'static', name: ref };
  const m = /^lucide:([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(ref ?? '');
  if (m?.[1]) return { source: 'dynamic', name: m[1] };
  return { source: 'fallback', name: FALLBACK_ICON };
}

// The Lucide map and icon chunks are cached on first use, not precached (sw.ts): offline, one never
// loaded before can't load, so the generic box stands in instead of an error.
const LazyLucide = lazy(() =>
  import('./type-icon-dynamic').catch(() => ({
    default: ({
      name: _name,
      ...props
    }: {
      name: string;
      className?: string;
      strokeWidth?: number;
    }) => {
      const Box = STATIC_ICONS[FALLBACK_ICON] as IconComponent;
      return <Box {...props} />;
    },
  })),
);

export function TypeIcon({
  icon,
  className,
}: {
  /** `lucide:cable`, `tabler:engine`, `kept:safe`; null ⇒ the generic box. */
  icon: string | null | undefined;
  className?: string;
}) {
  const r = resolveIcon(icon);
  const cls = cn('size-5 shrink-0', className);
  const Fallback = STATIC_ICONS[FALLBACK_ICON] as IconComponent;
  const common = { className: cls, strokeWidth: 1.8, 'aria-hidden': true, 'data-icon': icon ?? '' };
  if (r.source === 'dynamic') {
    return (
      <Suspense fallback={<Fallback {...common} data-icon-loading="" />}>
        <LazyLucide name={r.name} {...common} />
      </Suspense>
    );
  }
  const Icon = STATIC_ICONS[r.name] as IconComponent;
  return <Icon {...common} />;
}
