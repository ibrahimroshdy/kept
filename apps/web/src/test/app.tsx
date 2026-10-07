/**
 * Render the whole app at a path, against the in-memory mock server (src/api/mock), in English
 * or Arabic. Screens are tested through the real route tree, so the session gate, redirects and
 * links are exercised too. `fetch` is stubbed; nothing leaves the test.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, vi } from 'vitest';
import { type MockState, ownerScenario } from '@/api/mock/fixtures';
import { createMockApi, type MockApi } from '@/api/mock/server';
import { assistantStore } from '@/assistant/store';
import { toastQueue } from '@/components/ui/toast';
import { activateLocale } from '@/i18n/i18n';
import { type Digits, directionOf, type Locale, setDigits, setLocale } from '@/lib/prefs';
import { routeTree } from '@/routeTree.gen';

export async function renderApp(
  path: string,
  {
    state = ownerScenario(),
    locale = 'en',
    digits = 'eastern',
    setup,
  }: {
    state?: MockState;
    locale?: Locale;
    digits?: Digits;
    setup?: (mock: MockApi) => void;
  } = {},
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
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { queryClient },
  });
  const user = userEvent.setup();
  const result = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { user, mock, router, queryClient, ...result };
}

/** The path the router ended on, after redirects. */
export function pathOf(router: { state: { location: { pathname: string } } }) {
  return router.state.location.pathname;
}

/** Wait for the first heading with this name (pages load their data first). */
export const findHeading = (name: string | RegExp) =>
  screen.findByRole('heading', { name }, { timeout: 3000 });

afterEach(() => {
  vi.unstubAllGlobals();
  // The assistant's open state lives outside React (assistant/store.ts).
  assistantStore.reset();
  for (const t of toastQueue.visibleToasts) toastQueue.close(t.key);
  try {
    localStorage.clear();
  } catch {
    // jsdom always has it.
  }
});
