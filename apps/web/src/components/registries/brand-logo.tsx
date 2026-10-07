/**
 * A brand's logo and, for its account's owners and admins, Add · Replace · Remove
 * (./brand-logo.household.tsx, loaded on demand). While it loads, or offline before its first
 * load, the brand's icon shows and the actions stay out.
 */
import { type ComponentProps, lazy, type ReactNode, Suspense } from 'react';

type Household = typeof import('./brand-logo.household');
const load = () => import('./brand-logo.household');

const Logo = lazy(() =>
  load()
    .then((m) => ({ default: m.BrandLogo }))
    .catch(() => ({ default: ((p) => p.fallback) as Household['BrandLogo'] })),
);
const Actions = lazy<(p: { brandId: string }) => ReactNode>(() =>
  load()
    .then((m) => ({ default: m.BrandLogoActions }))
    .catch(() => ({ default: () => null })),
);

export function BrandLogo(p: ComponentProps<Household['BrandLogo']> & { fallback: ReactNode }) {
  return (
    <Suspense fallback={p.fallback}>
      <Logo {...p} />
    </Suspense>
  );
}

export function BrandLogoActions(p: ComponentProps<Household['BrandLogoActions']>) {
  return (
    <Suspense fallback={null}>
      <Actions {...p} />
    </Suspense>
  );
}
