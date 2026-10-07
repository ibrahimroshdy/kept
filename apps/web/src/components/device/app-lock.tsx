/**
 * The app lock (step-8 plan T23; D181, D210, Q22): off by default; when on, Kept asks for the PIN
 * (or Face ID / fingerprint) on a cold start and after APP_LOCK.idleMinutes hidden or idle, and
 * the lock screen covers everything, online and offline, until it is unlocked. Mounted by the
 * signed-in frame (routes/_app.tsx) around the shell.
 *
 * - On a cold start nothing of the app renders until the lock is read: a locked app shows only
 *   the lock screen. Locked again later, the app stays mounted (its state kept) but hidden and
 *   inert under the lock screen.
 * - While unlocked, the data key that opens what is kept offline lives here, in memory only; it
 *   goes when the app locks. A passkey without PRF unlocks the app but not the key: the kept
 *   extras then ask for the PIN (`openExtras`).
 * - Ten wrong PINs in a row (counted on the device, across reloads) remove this device's copy and
 *   what was kept offline, keep the person's own unsent captures, locked (D210), and sign out.
 *   "Forgot it?" does the same.
 * - Where IndexedDB doesn't exist (component tests' jsdom, a locked-down browser) there is no
 *   lock: `supported` is false and This device says why.
 */
import { APP_LOCK } from '@kept/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  createContext,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { signOut } from '@/api/auth';
import type { KeptDb } from '@/offline/db';
import type { LockRecord } from '@/offline/lock';
import { lockOffline } from '@/offline/open';

const LockScreen = lazy(() => import('./lock-screen'));

export type LockStatus = 'checking' | 'off' | 'locked' | 'unlocked';
export type PinResult = 'ok' | 'wrong' | 'wiped';

export type AppLock = {
  supported: boolean;
  status: LockStatus;
  record: LockRecord | null;
  /** The data key while unlocked by the PIN or a PRF passkey; null otherwise. */
  dataKey: CryptoKey | null;
  db: KeptDb | null;
  /** Turns the lock on with `pin`. */
  enable: (pin: string) => Promise<void>;
  /** Turns it off after the PIN; what was kept offline goes with it. */
  disable: (pin: string) => Promise<PinResult>;
  changePin: (current: string, next: string) => Promise<PinResult>;
  enrolPasskey: (name: string) => Promise<void>;
  removePasskey: () => Promise<void>;
  /** The PIN, to open the kept extras after a passkey without PRF. */
  openExtras: (pin: string) => Promise<PinResult>;
  /** On the lock screen. */
  unlockPin: (pin: string) => Promise<PinResult>;
  unlockPasskey: () => Promise<void>;
  forgot: () => Promise<void>;
  lockNow: () => void;
};

const AppLockContext = createContext<AppLock | null>(null);

/** The app lock, or null outside the signed-in frame. */
export function useAppLock(): AppLock | null {
  return useContext(AppLockContext);
}

const supportedHere = () => typeof indexedDB !== 'undefined' && !!globalThis.crypto?.subtle;
const ACTIVITY = ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const;

export function AppLockGate({ userId, children }: { userId: string; children: ReactNode }) {
  const supported = supportedHere();
  const [status, setStatus] = useState<LockStatus>(supported ? 'checking' : 'off');
  const [record, setRecord] = useState<LockRecord | null>(null);
  const [dataKey, setDataKey] = useState<CryptoKey | null>(null);
  const [db, setDb] = useState<KeptDb | null>(null);
  /** The app has been shown since this tab started: a later lock hides it instead. */
  const [shown, setShown] = useState(!supported);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const recordRef = useRef(record);
  recordRef.current = record;

  const lockDb = useCallback(() => import('@/offline/app-lock-db'), []);
  const crypto = useCallback(() => import('@/offline/lock'), []);

  useEffect(() => {
    if (!supported) return;
    let live = true;
    (async () => {
      const m = await lockDb();
      const opened = m.deviceDb(userId);
      const found = await m.readLock(opened);
      if (!live) return;
      setDb(opened);
      setRecord(found);
      setDataKey(null);
      setStatus(found ? 'locked' : 'off');
      if (!found) setShown(true);
    })().catch(() => {
      // IndexedDB refused (a locked-down browser): no lock can have been set here.
      if (live) {
        setStatus('off');
        setShown(true);
      }
    });
    return () => {
      live = false;
    };
  }, [userId, supported, lockDb]);

  const lockNow = useCallback(() => {
    if (!recordRef.current) return;
    setDataKey(null);
    setStatus('locked');
  }, []);

  // Idle or hidden for APP_LOCK.idleMinutes: locked.
  useEffect(() => {
    if (status !== 'unlocked') return;
    const limit = APP_LOCK.idleMinutes * 60_000;
    let timer = setTimeout(lockNow, limit);
    let hiddenAt: number | null = null;
    const active = () => {
      clearTimeout(timer);
      timer = setTimeout(lockNow, limit);
    };
    const visibility = () => {
      if (document.visibilityState === 'hidden') hiddenAt = Date.now();
      else if (hiddenAt !== null) {
        if (Date.now() - hiddenAt >= limit) lockNow();
        hiddenAt = null;
      }
    };
    for (const e of ACTIVITY) window.addEventListener(e, active, { passive: true });
    document.addEventListener('visibilitychange', visibility);
    return () => {
      clearTimeout(timer);
      for (const e of ACTIVITY) window.removeEventListener(e, active);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [status, lockNow]);

  const save = useCallback(
    async (next: LockRecord) => {
      if (!db) return;
      await (await lockDb()).saveLock(db, next);
      setRecord(next);
    },
    [db, lockDb],
  );

  /** Ten wrong PINs, or "Forgot it?": the copy goes, the unsent queue stays, signed out. */
  const wipe = useCallback(async () => {
    setDataKey(null);
    await lockOffline().catch(() => {});
    if (db) await (await lockDb()).wipeAfterTooManyTries(db);
    setRecord(null);
    await signOut().catch(() => {});
    qc.clear();
    setStatus('off');
    void navigate({ to: '/signin', replace: true });
  }, [db, lockDb, qc, navigate]);

  /** Tries `pin`; counts a wrong one, and wipes at the limit. */
  const tryPin = useCallback(
    async (pin: string): Promise<{ result: PinResult; key: CryptoKey | null }> => {
      const current = recordRef.current;
      if (!current) return { result: 'wrong', key: null };
      const key = await (await crypto()).unlockWithPin(current, pin);
      if (key) {
        if (current.failedTries > 0) await save({ ...current, failedTries: 0 });
        return { result: 'ok', key };
      }
      const failedTries = current.failedTries + 1;
      if (failedTries >= APP_LOCK.maxPinTries) {
        await wipe();
        return { result: 'wiped', key: null };
      }
      await save({ ...current, failedTries });
      return { result: 'wrong', key: null };
    },
    [crypto, save, wipe],
  );

  const value = useMemo<AppLock>(
    () => ({
      supported,
      status,
      record,
      dataKey,
      db,
      enable: async (pin) => {
        if (!db) throw new Error('no device database');
        const { record: next, dataKey: key } = await (await crypto()).createLock(pin);
        await save(next);
        setDataKey(key);
        setStatus('unlocked');
      },
      disable: async (pin) => {
        const { result } = await tryPin(pin);
        if (result !== 'ok' || !db) return result;
        await (await lockDb()).removeLock(db);
        setRecord(null);
        setDataKey(null);
        setStatus('off');
        return 'ok';
      },
      changePin: async (current, next) => {
        const { result, key } = await tryPin(current);
        if (result !== 'ok' || !key || !recordRef.current) return result;
        await save(await (await crypto()).changePin(recordRef.current, key, next));
        setDataKey(key);
        return 'ok';
      },
      enrolPasskey: async (name) => {
        const current = recordRef.current;
        if (!current || !dataKey) throw new Error('unlock with the PIN first');
        await save(await (await crypto()).enrolPasskey(current, dataKey, name));
      },
      removePasskey: async () => {
        const current = recordRef.current;
        if (current) await save({ ...current, passkey: null });
      },
      openExtras: async (pin) => {
        const { result, key } = await tryPin(pin);
        if (key) setDataKey(key);
        return result;
      },
      unlockPin: async (pin) => {
        const { result, key } = await tryPin(pin);
        if (result === 'ok') {
          setDataKey(key);
          setStatus('unlocked');
          setShown(true);
        }
        return result;
      },
      unlockPasskey: async () => {
        const current = recordRef.current;
        if (!current) return;
        const key = await (await crypto()).unlockWithPasskey(current);
        setDataKey(key);
        setStatus('unlocked');
        setShown(true);
      },
      forgot: wipe,
      lockNow,
    }),
    [supported, status, record, dataKey, db, crypto, lockDb, save, tryPin, wipe, lockNow],
  );

  const locked = status === 'locked' || status === 'checking';
  return (
    <AppLockContext.Provider value={value}>
      {shown ? (
        <div hidden={locked} inert={locked} className={locked ? undefined : 'contents'}>
          {children}
        </div>
      ) : null}
      {status === 'checking' ? (
        <div className="fixed inset-0 z-[55] bg-paper" role="status" aria-busy="true" />
      ) : null}
      {status === 'locked' ? (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-[55] bg-paper" role="status" aria-busy="true" />
          }
        >
          <LockScreen />
        </Suspense>
      ) : null}
    </AppLockContext.Provider>
  );
}
