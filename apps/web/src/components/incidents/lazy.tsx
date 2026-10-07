/**
 * Plan T26's screens, loaded on demand from ./screens.household.tsx (its own chunk, cached by the
 * service worker on first use, never precached; vite.config.ts). While it loads, a skeleton in the
 * page's frame; when it can't load (offline before it was ever fetched), the §3 reason: "Needs a
 * connection".
 *
 *   <Screens.Incidents />   <Screens.Report kind="insurance" search={…} />
 */
import { useLingui } from '@lingui/react/macro';
import { type ComponentType, lazy, type ReactNode, Suspense } from 'react';
import { LoadingRows, Notice, Page } from '@/components/page';

type Module = typeof import('./screens.household');

function Unavailable() {
  const { t } = useLingui();
  return <Notice title={t`Needs a connection`} />;
}

/**
 * One export of the chunk as a component. `frame` puts the skeleton and the offline notice in the
 * page they stand for (a Page with its title); sheets load quietly.
 */
function part<P extends object>(
  pick: (m: Module) => ComponentType<P>,
  frame: ((body: ReactNode, props: P) => ReactNode) | null,
) {
  const Fallback = (props: P) => (frame ? frame(<Unavailable />, props) : null);
  const Lazy = lazy(() =>
    import('./screens.household')
      .then((m) => ({ default: pick(m) }))
      .catch(() => ({ default: Fallback as ComponentType<P> })),
  );
  return function Part(props: P) {
    return (
      <Suspense fallback={frame ? frame(<LoadingRows rows={3} />, props) : null}>
        <Lazy {...props} />
      </Suspense>
    );
  };
}

function Framed({
  title,
  children,
}: {
  title: 'incidents' | 'incident' | 'insurance' | 'claim';
  children: ReactNode;
}) {
  const { t } = useLingui();
  const titles = {
    incidents: t`Incidents`,
    incident: t`Incident`,
    insurance: t`Insurance report`,
    claim: t`Claim pack`,
  };
  return (
    <Page title={titles[title]} {...(title === 'incident' ? { back: '/incidents' as const } : {})}>
      {children}
    </Page>
  );
}

export const IncidentsScreen = part(
  (m) => m.IncidentsScreen,
  (body) => <Framed title="incidents">{body}</Framed>,
);
export const IncidentScreen = part(
  (m) => m.IncidentScreen,
  (body) => <Framed title="incident">{body}</Framed>,
);
export const InsuranceReportScreen = part(
  (m) => m.InsuranceReportScreen,
  (body) => <Framed title="insurance">{body}</Framed>,
);
export const ClaimPackScreen = part(
  (m) => m.ClaimPackScreen,
  (body) => <Framed title="claim">{body}</Framed>,
);
/** Inside the Account frame, which has its own Page. */
export const ExchangeRatesTab = part(
  (m) => m.ExchangeRatesTab,
  (body) => body,
);
export const AddToIncidentSheet = part((m) => m.AddToIncidentSheet, null);
