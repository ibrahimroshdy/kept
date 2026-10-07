import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import { AppProviders } from '@/app-providers';
import { NotFound } from '@/components/not-found';
import { usePrefs } from '@/lib/prefs';
import { UpdatePrompt } from '@/pwa/update-prompt';

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: RootLayout,
  notFoundComponent: NotFound,
});

/** Providers only: signed-in pages add the app frame (_app.tsx), entry pages their own. */
function RootLayout() {
  const { locale } = usePrefs();
  return (
    <AppProviders locale={locale}>
      <Outlet />
      <UpdatePrompt />
    </AppProviders>
  );
}
