import { QueryClientProvider } from '@tanstack/react-query';
import { createHashHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createQueryClient } from '@/api/queries';
import { activateLocale, i18n } from '@/i18n/i18n';
import { initialLocale, setLocale, storedDigits, watchSystemTheme } from '@/lib/prefs';
import { captureInstallPrompt } from '@/pwa/install';
import { registerServiceWorker } from '@/pwa/register';
import { TRY } from '@/try/flag';
import { routeTree } from './routeTree.gen';
import './styles/index.css';

// The start guard in index.html reloads once when this never runs; it ran, so clear its flag.
declare global {
  interface Window {
    __keptStarted?: boolean;
  }
}
window.__keptStarted = true;
try {
  sessionStorage.removeItem('kept.bootRetry');
} catch {}

const queryClient = createQueryClient();
// Try Kept (D246, try/flag.ts) is served from a static host's sub-path with one index.html: hash
// history keeps every route, and a reload of one, inside that page.
const router = createRouter({
  routeTree,
  context: { queryClient },
  ...(TRY ? { history: createHashHistory() } : {}),
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

async function start() {
  // Demo mode (`?demo=…`): the API answers from fixtures. Compiled in for dev and for
  // `vite build --mode demo` only; in a production build the condition is the constant false
  // and the whole branch, with its fixtures, is dropped from the bundle.
  if (import.meta.env.DEV || import.meta.env.VITE_KEPT_DEMO === '1') {
    const { installDemo } = await import('./demo');
    installDemo();
  }
  // The service worker exists only in a build (vite.config.ts); it registers only in a secure
  // context (pwa/register.ts). The install prompt is caught before the browser offers its own.
  // Try Kept (D246) installs nothing: no worker, no install prompt.
  if (!TRY) captureInstallPrompt();
  // A share link's page (`/s/<token>`, D233) is for someone without an account: no offline app
  // is installed for them.
  if (import.meta.env.PROD && !TRY && !window.location.pathname.startsWith('/s/'))
    registerServiceWorker();
  const locale = initialLocale();
  // Offline, a catalogue that was never loaded online isn't cached (sw.ts): fall back to English,
  // then to no catalogue, so the shell still renders.
  await activateLocale(locale, storedDigits()).catch(() =>
    activateLocale('en').catch(() => i18n.loadAndActivate({ locale: 'en', messages: {} })),
  );
  setLocale(locale);
  watchSystemTheme();
  const root = document.getElementById('root');
  if (!root) throw new Error('#root is missing from index.html');
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
}

void start();
