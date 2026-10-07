/**
 * The thing page's step-4 parts, loaded on demand from ./household-sections.tsx (its own chunk,
 * cached by the service worker on first use; see there). While it loads, a skeleton; when it
 * can't load (offline before it was ever fetched), the §3 reason: "Needs a connection".
 */
import { useLingui } from '@lingui/react/macro';
import { type ComponentType, lazy, Suspense } from 'react';
import { LoadingRows, Notice } from '@/components/page';

type Sections = typeof import('./household-sections');

function Unavailable() {
  const { t } = useLingui();
  return <Notice title={t`Needs a connection`} />;
}

function part<P extends object>(pick: (m: Sections) => ComponentType<P>, quiet = false) {
  const fallback: ComponentType<P> = quiet ? () => null : Unavailable;
  const Lazy = lazy(() =>
    import('./household-sections')
      .then((m) => ({ default: pick(m) }))
      .catch(() => ({ default: fallback })),
  );
  return function Part(props: P) {
    return (
      <Suspense fallback={quiet ? null : <LoadingRows rows={2} />}>
        <Lazy {...props} />
      </Suspense>
    );
  };
}

export const ValueSection = part((m) => m.ValueSection);
export const ThingLoansSection = part((m) => m.ThingLoansSection);
export const ClaimsSection = part((m) => m.ClaimsSection);
export const ThingSchedulesSection = part((m) => m.ThingSchedulesSection);
export const WarrantiesBlock = part((m) => m.WarrantiesBlock);
/** Sheets render nothing until opened, so they load quietly. */
export const LendSheet = part((m) => m.LendSheet, true);
export const ReturnSheet = part((m) => m.ReturnSheet, true);
