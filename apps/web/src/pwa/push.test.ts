/**
 * Push on this device, the page's half (plan T25; D139, D193). Every browser API is a stub: no
 * test asks a real browser for the notification permission.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  disablePush,
  enablePush,
  keyBytes,
  PUSH_ID_KEY,
  PushDenied,
  pushBlocker,
  thisDeviceSubscriptionId,
} from './push';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const server = { available: true };

function stubPushBrowser({
  permission = 'default' as NotificationPermission,
  answer = 'granted' as NotificationPermission,
} = {}) {
  const requestPermission = vi.fn(async () => answer);
  vi.stubGlobal('Notification', { permission, requestPermission });
  vi.stubGlobal('PushManager', function PushManager() {});
  const subscription = {
    toJSON: () => ({
      endpoint: 'https://push.example/send/abc',
      keys: { p256dh: 'BPk', auth: 'au' },
    }),
    unsubscribe: vi.fn(async () => true),
  };
  const pushManager = {
    subscribe: vi.fn(async (_options: PushSubscriptionOptionsInit) => subscription),
    getSubscription: vi.fn(async () => subscription),
  };
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { ready: Promise.resolve({ pushManager }) },
  });
  return { requestPermission, pushManager, subscription };
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // @ts-expect-error back to jsdom's (absent) property
  delete navigator.serviceWorker;
});

describe('pushBlocker', () => {
  it('says HTTPS first over plain HTTP (D193)', () => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    try {
      expect(pushBlocker(server)).toBe('no_https');
    } finally {
      // @ts-expect-error jsdom has none of its own
      delete window.isSecureContext;
    }
  });

  it("says when the server can't push", () => {
    stubPushBrowser();
    expect(pushBlocker({ available: false, reason: 'no_subject' })).toBe('server');
    expect(pushBlocker({ available: false, reason: 'no_https' })).toBe('no_https');
  });

  it('on an iPhone in the browser, push is for the installed app (D139)', () => {
    stubPushBrowser();
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE);
    expect(pushBlocker(server)).toBe('ios_not_installed');
    // Opened from the Home Screen, it can.
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
    try {
      expect(pushBlocker(server)).toBeNull();
    } finally {
      // @ts-expect-error Safari's own flag
      delete navigator.standalone;
    }
  });

  it('knows a browser without push, and a blocked permission', () => {
    expect(pushBlocker(server)).toBe('unsupported');
    stubPushBrowser({ permission: 'denied' });
    expect(pushBlocker(server)).toBe('denied');
    stubPushBrowser();
    expect(pushBlocker(server)).toBeNull();
  });
});

describe('enablePush', () => {
  it('asks for permission, subscribes with the key and remembers the id', async () => {
    const { requestPermission, pushManager } = stubPushBrowser();
    const post = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        endpoint: 'https://push.example/send/abc',
        keys: { p256dh: 'BPk', auth: 'au' },
        label: 'Chrome on Mac',
      });
      return new Response(JSON.stringify({ id: 'sub-1' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', post);
    await expect(enablePush('AQAB', 'Chrome on Mac')).resolves.toBe('sub-1');
    expect(requestPermission).toHaveBeenCalledTimes(1);
    const options = pushManager.subscribe.mock.calls[0]?.[0] as {
      userVisibleOnly: boolean;
      applicationServerKey: Uint8Array;
    };
    expect(options.userVisibleOnly).toBe(true);
    expect([...options.applicationServerKey]).toEqual([1, 0, 1]);
    expect(thisDeviceSubscriptionId()).toBe('sub-1');
  });

  it('stops when the person says no, and posts nothing', async () => {
    const { pushManager } = stubPushBrowser({ answer: 'denied' });
    const post = vi.fn();
    vi.stubGlobal('fetch', post);
    await expect(enablePush('AQAB', 'x')).rejects.toBeInstanceOf(PushDenied);
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
});

describe('disablePush', () => {
  it("unsubscribes the browser, deletes the server's row and forgets it", async () => {
    const { subscription } = stubPushBrowser({ permission: 'granted' });
    localStorage.setItem(PUSH_ID_KEY, 'sub-1');
    const del = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', del);
    await disablePush('sub-1');
    expect(subscription.unsubscribe).toHaveBeenCalled();
    expect(String((del.mock.calls[0] as unknown[])[0])).toContain('/me/push-subscriptions/sub-1');
    expect(thisDeviceSubscriptionId()).toBeNull();
  });
});

describe('keyBytes', () => {
  it('decodes unpadded base64url', () => {
    expect([...keyBytes('-_8')]).toEqual([251, 255]);
    expect([...keyBytes('AQAB')]).toEqual([1, 0, 1]);
  });
});
