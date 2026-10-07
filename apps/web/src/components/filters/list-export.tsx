/**
 * "Export" for a things list (D169, step-7 T16): Export view (CSV) and Print, from
 * ./list-export.household.tsx, loaded on demand (its own chunk, cached by the service worker on
 * first use, never precached; vite.config.ts). While it loads nothing shows; offline before its
 * first load, a disabled button says "Needs a connection" (screens §3).
 *
 *   <ListExport params={thingsParams} />
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { type ComponentProps, lazy, Suspense } from 'react';
import { DocumentIcon } from '@/components/icons';
import { Button } from '@/components/ui/button';

type Household = typeof import('./list-export.household');

function Unavailable() {
  const { t } = useLingui();
  return (
    <Button
      size="small"
      variant="secondary"
      isDisabled
      aria-label={t`Needs a connection`}
      className="[&_svg]:size-4"
    >
      <DocumentIcon aria-hidden="true" />
      <span className="max-sm:sr-only">
        <Trans>Export</Trans>
      </span>
    </Button>
  );
}

const Lazy = lazy(() =>
  import('./list-export.household')
    .then((m) => ({ default: m.ListExport }))
    .catch(() => ({ default: Unavailable as Household['ListExport'] })),
);

export function ListExport(props: ComponentProps<Household['ListExport']>) {
  return (
    <Suspense fallback={null}>
      <Lazy {...props} />
    </Suspense>
  );
}
