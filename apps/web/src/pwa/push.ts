/**
 * Push on this device, the page's half (plan T25; D30, D139, D193; spike
 * docs/spikes/2026-09-30-step4-push.md). The worker's half is ./push-worker.ts.
 *
 * - **Where push can work** (`pushBlocker`): a secure context (plain HTTP: "Push needs HTTPS",
 *   D193), the server's VAPID key (`push.available`), a browser with service workers, the Push API
 *   and notifications, and on an iPhone or iPad only the installed app (D139, V8: iOS 16.4+ gives
 *   push to Home Screen web apps alone).
 * - **The permission prompt appears only when the person taps Enable** (D139): `enablePush` is the
 *   one place `Notification.requestPermission()` is called, never on load.
 * - **This device's subscription** is the one the server answered with its id; the id is kept on
 *   this device (it isn't secret, and the server never returns endpoints), so Settings can tell
 *   "this device" from the others. The same endpoint posted again updates it (T15).
 */
import { householdApi } from '@/api/household/queries';
import { isAppleMobile } from './install';

/** Where this device's subscription id is kept. Per device, never synced. */
export const PUSH_ID_KEY = 'kept.push.subscription';

export type PushBlocker =
  /** Plain HTTP (D193): no service worker, no push. */
  | 'no_https'
  /** The server has no VAPID key or subject (T15's `push.reason`). */
  | 'server'
  /** An iPhone or iPad in the browser: push is for the installed app (D139). */
  | 'ios_not_installed'
  /** This browser has no Push API or notifications. */
  | 'unsupported'
  /** The person, or the browser, blocked notifications for Kept. */
  | 'denied';

/** Whether Kept runs as the installed app (a Home Screen web app or an installed PWA). */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  if (nav.standalone === true) return true;
  try {
    return window.matchMedia?.('(display-mode: standalone)').matches === true;
  } catch {
    return false;
  }
}

function browserHasPush(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** What stops push on this device, or null when Enable can be offered. */
export function pushBlocker(server: { available: boolean; reason?: string }): PushBlocker | null {
  if (typeof window !== 'undefined' && window.isSecureContext === false) return 'no_https';
  if (!server.available) return server.reason === 'no_https' ? 'no_https' : 'server';
  if (isAppleMobile() && !isStandalone()) return 'ios_not_installed';
  if (!browserHasPush()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return null;
}

export function thisDeviceSubscriptionId(): string | null {
  try {
    return localStorage.getItem(PUSH_ID_KEY);
  } catch {
    return null;
  }
}

function remember(id: string | null): void {
  try {
    if (id) localStorage.setItem(PUSH_ID_KEY, id);
    else localStorage.removeItem(PUSH_ID_KEY);
  } catch {
    // Storage blocked: this device just won't be marked as such.
  }
}

/** The VAPID public key (unpadded base64url, 65 bytes) as the bytes `subscribe()` takes. */
export function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export class PushDenied extends Error {
  constructor() {
    super('Notifications are blocked for Kept.');
  }
}
export class PushUnavailable extends Error {
  constructor() {
    super('This browser can not receive push notifications from Kept.');
  }
}

/** The worker, or none within a few seconds (dev mode, or registration failed). */
async function workerRegistration(timeoutMs = 10_000): Promise<ServiceWorkerRegistration> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new PushUnavailable()), timeoutMs),
  );
  return Promise.race([navigator.serviceWorker.ready, timeout]);
}

/**
 * Enable: asks for permission (the only place Kept does, D139), subscribes with the server's key
 * and registers the subscription. Returns the server's id for it.
 */
export async function enablePush(publicKey: string, label: string): Promise<string> {
  if (!browserHasPush()) throw new PushUnavailable();
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new PushDenied();
  const registration = await workerRegistration();
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: keyBytes(publicKey),
  });
  const json = subscription.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) throw new PushUnavailable();
  const { id } = await householdApi.createPushSubscription({
    endpoint: json.endpoint,
    keys: { p256dh, auth },
    label,
  });
  remember(id);
  return id;
}

/** Turn off push on this device: the browser's subscription and the server's row. */
export async function disablePush(id: string): Promise<void> {
  try {
    if (browserHasPush()) {
      const registration = await workerRegistration(3_000);
      const subscription = await registration.pushManager.getSubscription();
      await subscription?.unsubscribe();
    }
  } catch {
    // The server's row still goes; the browser drops a subscription nobody sends to.
  }
  await householdApi.deletePushSubscription(id);
  if (thisDeviceSubscriptionId() === id) remember(null);
}

/** After another device removed this one's row: forget it here too. */
export function forgetThisDevice(): void {
  remember(null);
}
