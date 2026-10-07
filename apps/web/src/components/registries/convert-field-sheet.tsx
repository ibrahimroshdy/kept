/**
 * Convert a type's field (step-7 T24): Make secret, Make plain or Change kind, from
 * ./convert-field-sheet.household.tsx, loaded on demand (its own chunk, cached by the service
 * worker on first use; the type editor itself is precached for /types/<id>). Until a target is
 * chosen nothing loads; offline before its first load, it shows nothing (its buttons are disabled
 * with "Needs a connection" there).
 *
 *   <ConvertFieldSheet target={{ field, mode: 'secret' }} onClose={…} onConverted={…} />
 */
import { type ComponentProps, lazy, Suspense } from 'react';

type Household = typeof import('./convert-field-sheet.household');

export type { ConvertMode } from './convert-field-sheet.household';

const Lazy = lazy(() =>
  import('./convert-field-sheet.household')
    .then((m) => ({ default: m.ConvertFieldSheet }))
    .catch(() => ({ default: (() => null) as Household['ConvertFieldSheet'] })),
);

export function ConvertFieldSheet(props: ComponentProps<Household['ConvertFieldSheet']>) {
  if (!props.target) return null;
  return (
    <Suspense fallback={null}>
      <Lazy {...props} />
    </Suspense>
  );
}
