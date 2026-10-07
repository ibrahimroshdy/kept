/**
 * Render one part of the thing page (a vehicle's Fuel tab, its Documents, the history report
 * sheet) on its own, inside the ThingProvider the page gives it, against the in-memory mock
 * server, in English or Arabic. The part sits on a route whose search accepts the list filters it
 * keeps in the URL, as the thing route's does. `fetch` is stubbed; nothing leaves the test.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import { useThing } from '@/api/inventory/queries';
import { type MockState, ownerScenario } from '@/api/mock/fixtures';
import { createMockApi, type MockApi } from '@/api/mock/server';
import { useLocation, useMe } from '@/api/queries';
import { AppProviders } from '@/app-providers';
import { makeCtx, ThingProvider } from '@/components/things/context';
import { activateLocale } from '@/i18n/i18n';
import { type Digits, directionOf, type Locale, setDigits, setLocale } from '@/lib/prefs';
import { listSearch } from '@/lib/url-state';

function Host({ thingId, children }: { thingId: string; children: ReactNode }) {
  const thing = useThing(thingId);
  const location = useLocation(thing.data?.locationId ?? '');
  const me = useMe();
  if (!thing.data || !location.data || !me.data) return <p>Loading the thing</p>;
  return (
    <ThingProvider
      value={makeCtx(thing.data, location.data, me.data.user.displayName, async () => {})}
    >
      {children}
    </ThingProvider>
  );
}

export async function renderThingPart(
  ui: ReactNode,
  {
    thingId,
    state = ownerScenario(),
    locale = 'en',
    digits = 'eastern',
    search = '',
    setup,
  }: {
    thingId: string;
    state?: MockState;
    locale?: Locale;
    digits?: Digits;
    /** The page's query string ("?f.full=0"). */
    search?: string;
    setup?: (mock: MockApi) => void;
  },
) {
  const mock = createMockApi(state);
  setup?.(mock);
  vi.stubGlobal('fetch', mock.fetch);
  await activateLocale(locale, digits);
  setLocale(locale);
  setDigits(digits);
  document.documentElement.lang = locale;
  document.documentElement.dir = directionOf(locale);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  const root = createRootRoute({
    component: () => (
      <AppProviders locale={locale}>
        <Outlet />
      </AppProviders>
    ),
  });
  const page = createRoute({
    getParentRoute: () => root,
    path: '/',
    validateSearch: listSearch(['when', 'unit', 'vendor', 'full']),
    component: () => <Host thingId={thingId}>{ui}</Host>,
  });
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: [`/${search}`] }),
  });
  const user = userEvent.setup();
  const result = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { user, mock, router, queryClient, ...result };
}
