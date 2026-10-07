/**
 * The signed-in gate, shared by the app frame (routes/_app.tsx) and the print view
 * (routes/_print.tsx), which has no app shell but the same rule. Before any signed-in page
 * loads: set up yet (task 22)? Signed in? Second factor proven (D176)? Each "no" is a redirect,
 * decided in `beforeLoad` so it happens once per navigation.
 *
 * **A cold start offline** (a reload, or the installed app opened with no signal: D17, D101):
 * the server can't answer, so the frame starts from the phone's last-known state (offline/
 * shell.ts), kept in the person's own database, never in the Cache API (D181). Screens then say
 * "as of last sync". Online again, the queries refetch and the server is the truth; a 401 then
 * locks the phone as always (D210). Nothing saved (never signed in here, signed out, or locked by
 * a 401) → "Needs a connection", as before.
 */
import { onlineManager, type QueryClient } from '@tanstack/react-query';
import { redirect } from '@tanstack/react-router';
import { getMe, getSetupStatus } from '@/api/account';
import { isApiError } from '@/api/client';
import { keys } from '@/api/queries';
import type { SetupStatus } from '@/api/types';
import { lastKnownShell, lockOffline } from '@/offline/open';

/** The browser says there is no network at all (not merely a server that can't be reached). */
const browserOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

/**
 * Puts the phone's last-known `/setup`, `/me` and locations in the query cache, dated when the
 * server last sent them, so they refetch as soon as they can. Answers whether there was one.
 */
export async function startFromPhone(qc: QueryClient): Promise<boolean> {
  const shell = await lastKnownShell();
  if (!shell) return false;
  const at = { updatedAt: shell.savedAt };
  const setup: SetupStatus = { needed: false };
  qc.setQueryData(keys.setup, setup, at);
  qc.setQueryData(keys.me, shell.me, at);
  qc.setQueryData(keys.locations, shell.locations, at);
  // TanStack Query assumes it is online until the browser says otherwise with an event, which a
  // cold start never sees. Told now, the frame's queries wait instead of failing, and the
  // browser's `online` event resumes them.
  if (browserOffline()) onlineManager.setOnline(false);
  return true;
}

export async function signedInGate({
  context,
  location,
}: {
  context: { queryClient: QueryClient };
  location: { href: string };
}): Promise<void> {
  const qc = context.queryClient;
  const next = location.href === '/' ? {} : { next: location.href };
  // No network and nothing loaded yet: don't wait out the retries.
  const loaded = qc.getQueryData(keys.setup) && qc.getQueryData(keys.me);
  if (!loaded && browserOffline() && (await startFromPhone(qc))) return;
  try {
    const setup = await qc.ensureQueryData({ queryKey: keys.setup, queryFn: getSetupStatus });
    if (setup.needed) throw redirect({ to: '/setup', replace: true });
    await qc.ensureQueryData({ queryKey: keys.me, queryFn: getMe });
  } catch (e) {
    if (isApiError(e) && e.code === 'unauthenticated') {
      // D181, D210: a 401 clears the phone's cached copy, even one this tab never opened; the
      // person's own unsent captures stay, locked, for their next sign-in (offline/open.ts).
      void lockOffline();
      throw redirect({ to: '/signin', search: next, replace: true });
    }
    if (isApiError(e) && e.code === 'mfa_required')
      throw redirect({ to: '/signin/two-factor', search: next, replace: true });
    if (!isApiError(e)) throw e; // a redirect, or a bug
    // The network failed (the browser thinks it's online): the phone's copy, if there is one.
    if (e.code === 'offline' && (await startFromPhone(qc))) return;
    // Anything else (server down, nothing on the phone): the component shows it with a retry.
  }
}
