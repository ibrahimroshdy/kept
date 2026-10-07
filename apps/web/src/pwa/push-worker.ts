/**
 * The service worker's half of web push (plan T24; D30, D139; spike
 * docs/spikes/2026-09-30-step4-push.md). src/sw.ts wires these to its `push` and
 * `notificationclick` events; they take the worker's parts as arguments so a unit test can hand
 * them stubs (nothing clicks a notification from the DevTools protocol, so the tap's URL logic is
 * tested here and the real tap is a device check).
 *
 * - **push:** the server's payload is `{title, body, url, tag}` (T15's `notify/push.ts`), text
 *   only, in the person's language. A push must always show a notification (`userVisibleOnly`),
 *   so a payload that can't be read still shows "Kept" and opens the notification centre. The
 *   tag makes a re-sent reminder replace the one already showing instead of stacking.
 * - **notificationclick:** closes the notification, then focuses an open Kept window and takes
 *   it to the URL, or opens one. Only same-origin URLs are followed; anything else opens the
 *   notification centre.
 */

/** What the server sends in a push (T15). */
export type PushPayload = { title: string; body?: string; url?: string; tag?: string };

/** Where a notification opens when its URL is missing or not Kept's own. */
export const PUSH_FALLBACK_PATH = '/notifications';
/** The icon a notification shows: the manifest's 192 px one. */
export const PUSH_ICON = '/icon-192.png';

const text = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.trim() ? v.slice(0, max) : undefined;

/** The payload of a push event, or the plain fallback when there's none or it isn't JSON. */
export function readPushPayload(data: { json(): unknown } | null | undefined): PushPayload {
  let raw: unknown = null;
  try {
    raw = data ? data.json() : null;
  } catch {
    raw = null;
  }
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const title = text(o.title, 200) ?? 'Kept';
  const body = text(o.body, 1000);
  const url = text(o.url, 2000);
  const tag = text(o.tag, 200);
  return { title, ...(body ? { body } : {}), ...(url ? { url } : {}), ...(tag ? { tag } : {}) };
}

/**
 * The absolute URL a tap opens: the payload's own when it is on Kept's origin (a relative path
 * counts), else the notification centre. Never another origin, never `javascript:`.
 */
export function clickTarget(url: unknown, origin: string): string {
  const fallback = new URL(PUSH_FALLBACK_PATH, origin).href;
  if (typeof url !== 'string' || !url) return fallback;
  let target: URL;
  try {
    target = new URL(url, origin);
  } catch {
    return fallback;
  }
  if (target.origin !== new URL(origin).origin) return fallback;
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return fallback;
  return target.href;
}

type Registration = {
  showNotification(title: string, options?: NotificationOptions): Promise<void>;
};

/** Shows the notification a push asks for. */
export function showPush(registration: Registration, payload: PushPayload): Promise<void> {
  return registration.showNotification(payload.title, {
    ...(payload.body ? { body: payload.body } : {}),
    ...(payload.tag ? { tag: payload.tag } : {}),
    icon: PUSH_ICON,
    data: { url: payload.url ?? PUSH_FALLBACK_PATH },
  });
}

type WindowLike = {
  url: string;
  focused?: boolean;
  focus(): Promise<unknown>;
  navigate(url: string): Promise<unknown>;
};
type ClientsLike = {
  matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<readonly unknown[]>;
  openWindow(url: string): Promise<unknown>;
};

/**
 * After a tap: the focused Kept window if there is one, else any Kept window, is focused and
 * sent to the target; with no window (or one that can't be navigated), a new one opens there.
 */
export async function openFromNotification(
  clients: ClientsLike,
  url: unknown,
  origin: string,
): Promise<void> {
  const target = clickTarget(url, origin);
  const all = (await clients.matchAll({ type: 'window', includeUncontrolled: true })) as
    | readonly WindowLike[]
    | undefined;
  const ours = (all ?? []).filter((c) => {
    try {
      return new URL(c.url).origin === new URL(origin).origin;
    } catch {
      return false;
    }
  });
  const client = ours.find((c) => c.focused) ?? ours[0];
  if (client) {
    try {
      await client.focus();
      await client.navigate(target);
      return;
    } catch {
      // Not controlled by this worker yet, or gone: open a new window instead.
    }
  }
  await clients.openWindow(target);
}

type PushEventLike = {
  data: { json(): unknown } | null;
  waitUntil(p: Promise<unknown>): void;
};
type ClickEventLike = {
  notification: { data?: unknown; close(): void };
  waitUntil(p: Promise<unknown>): void;
};
type WorkerLike = {
  registration: Registration;
  clients: ClientsLike;
  location: { origin: string };
};

/** The `push` handler. */
export function onPush(worker: Pick<WorkerLike, 'registration'>, event: PushEventLike): void {
  event.waitUntil(showPush(worker.registration, readPushPayload(event.data)));
}

/** The `notificationclick` handler. */
export function onNotificationClick(
  worker: Pick<WorkerLike, 'clients' | 'location'>,
  event: ClickEventLike,
): void {
  event.notification.close();
  const data = event.notification.data;
  const url = data && typeof data === 'object' ? (data as { url?: unknown }).url : undefined;
  event.waitUntil(openFromNotification(worker.clients, url, worker.location.origin));
}
