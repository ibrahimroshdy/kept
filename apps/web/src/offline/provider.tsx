/**
 * The offline store and sync engine for the signed-in frame (plan T24). Mounted once around the
 * app shell; opens the person's database through the lazy door (open.ts), so nothing of Dexie is
 * in the entry chunk, and starts the engine (app open is a sync trigger, D101).
 *
 * It also watches every query and mutation for a 401 (the session ended): the phone's cached
 * copy is cleared at once (D181), whatever screen made the request, while the person's own unsent
 * captures stay, locked, for their next sign-in (D210). The gate (lib/signed-in-gate.ts) does the
 * same for a 401 met before this frame mounts.
 *
 * Before opening the store it looks for **another person's** kept queue (D210): a screen says how
 * many captures and photos it holds, then it is discarded; "Sign out instead" leaves it for them.
 *
 * It keeps the frame's last-known `/me` and locations in that store (shell.ts), so a cold start
 * with no connection can still open the app (lib/signed-in-gate.ts).
 *
 * Where IndexedDB doesn't exist (the component tests' jsdom), nothing loads and the hooks answer
 * null: screens then behave as online-only.
 */
import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react';
import { signOut } from '@/api/auth';
import { isApiError } from '@/api/client';
import { useLocations, useMe } from '@/api/queries';
import { useConfirm } from '@/components/ui/confirm';
import {
  discardOrphan,
  findOrphans,
  loadOffline,
  lockOffline,
  type Offline,
  type Orphan,
  offlineSupported,
} from './open';
import { shellOf } from './shell';
import type { SyncStatus } from './sync-engine';

/** Exported for component tests, which provide a stand-in engine. */
export const OfflineContext = createContext<Offline | null>(null);

/** A 401 that means "no session", not a wrong password on a sign-in form (Better Auth's codes). */
const sessionEnded = (e: unknown) => isApiError(e) && e.status === 401 && !e.authCode;

export function OfflineProvider({ children }: { children: ReactNode }) {
  const me = useMe();
  const userId = me.data?.user.id ?? null;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { t } = useLingui();
  const [offline, setOffline] = useState<Offline | null>(null);

  useEffect(() => {
    if (!userId || !offlineSupported()) return;
    let live = true;
    const discardText = (o: Orphan) => {
      const captures = plural(o.captures, { one: '# capture', other: '# captures' });
      const photos = plural(o.photos, { one: '# photo', other: '# photos' });
      const main = t`${captures} and ${photos} were taken on this phone by someone who has signed out. They can't go to your account, so they will be deleted.`;
      if (o.others === 0) return main;
      const others = plural(o.others, {
        one: '# other change goes too.',
        other: '# other changes go too.',
      });
      return `${main} ${others}`;
    };
    (async () => {
      for (const o of await findOrphans(userId)) {
        if (!live) return;
        if (o.captures + o.photos + o.others > 0) {
          const ok = await confirm({
            title: t`Captures from another account are on this phone`,
            body: discardText(o),
            confirmLabel: t`Delete them`,
            cancelLabel: t`Sign out instead`,
            destructive: true,
          });
          if (!live) return; // a newer run asked again
          if (!ok) {
            // Leave them for the person they belong to.
            await signOut().catch(() => {});
            qc.clear();
            void navigate({ to: '/signin', replace: true });
            return;
          }
        }
        await discardOrphan(o.userId);
      }
      if (!live) return;
      const loaded = await loadOffline(userId, {
        onSignedOut: () => void navigate({ to: '/signin', replace: true }),
      });
      if (live) setOffline(loaded);
    })().catch(() => {
      // No IndexedDB after all (a locked-down browser): online-only, as without support.
    });
    return () => {
      live = false;
    };
  }, [userId, navigate, confirm, qc, t]);

  // The frame's last-known state, for a cold start offline (shell.ts): saved each time `/me` and
  // the locations answer. Only a success: after a failed refetch (a 401 included) the status is
  // `error`, so nothing is written back over a cleared cache.
  const locations = useLocations();
  useEffect(() => {
    if (!offline || !me.isSuccess || !locations.isSuccess) return;
    if (me.data.user.id !== offline.userId) return;
    const savedAt = Math.min(me.dataUpdatedAt, locations.dataUpdatedAt);
    void offline.store.setMeta('shell', shellOf(me.data, locations.data, savedAt)).catch(() => {
      // A full phone: the next answer tries again; an online start never needs it.
    });
  }, [
    offline,
    me.isSuccess,
    me.data,
    me.dataUpdatedAt,
    locations.isSuccess,
    locations.data,
    locations.dataUpdatedAt,
  ]);

  useEffect(() => {
    const onError = (error: unknown) => {
      if (!sessionEnded(error)) return;
      setOffline(null);
      void lockOffline();
    };
    const q = qc.getQueryCache().subscribe((e) => {
      if (e.type === 'updated' && e.action.type === 'error') onError(e.action.error);
    });
    const m = qc.getMutationCache().subscribe((e) => {
      if (e.type === 'updated' && e.action.type === 'error') onError(e.action.error);
    });
    return () => {
      q();
      m();
    };
  }, [qc]);

  return <OfflineContext.Provider value={offline}>{children}</OfflineContext.Provider>;
}

/** The loaded store and engine, or null (still loading, or no IndexedDB). */
export function useOffline(): Offline | null {
  return useContext(OfflineContext);
}

const noSubscribe = () => () => {};
const noStatus = () => null;

/** The engine's status, live; null until the store has loaded. */
export function useSyncStatus(): SyncStatus | null {
  const o = useOffline();
  return useSyncExternalStore(
    o ? o.engine.subscribe : noSubscribe,
    o ? o.engine.getStatus : noStatus,
    noStatus,
  );
}
