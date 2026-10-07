/**
 * The service worker's push handlers (plan T24), with synthetic events: the DevTools protocol can
 * deliver a push but can't tap a notification (spike docs/spikes/2026-09-30-step4-push.md), so
 * the tap's URL logic is proved here and the real tap is a device check.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  clickTarget,
  onNotificationClick,
  onPush,
  PUSH_FALLBACK_PATH,
  PUSH_ICON,
  readPushPayload,
} from './push-worker';

const ORIGIN = 'https://kept.example';
const json = (v: unknown) => ({ json: () => v });

function pushEvent(data: { json(): unknown } | null) {
  const waits: Promise<unknown>[] = [];
  return { event: { data, waitUntil: (p: Promise<unknown>) => void waits.push(p) }, waits };
}

describe('readPushPayload', () => {
  it("reads the server's title, body, url and tag", () => {
    expect(
      readPushPayload(
        json({
          title: 'Boiler service',
          body: 'Home › Kitchen · due 21 Oct',
          url: '/t/2HX9RB',
          tag: 'r1',
        }),
      ),
    ).toEqual({
      title: 'Boiler service',
      body: 'Home › Kitchen · due 21 Oct',
      url: '/t/2HX9RB',
      tag: 'r1',
    });
  });

  it('falls back to "Kept" when there is no payload or it is not JSON', () => {
    expect(readPushPayload(null)).toEqual({ title: 'Kept' });
    const broken = {
      json: () => {
        throw new SyntaxError('not JSON');
      },
    };
    expect(readPushPayload(broken)).toEqual({ title: 'Kept' });
    expect(readPushPayload(json({ title: 42, body: '' }))).toEqual({ title: 'Kept' });
  });
});

describe('clickTarget', () => {
  it('follows a same-origin URL, relative or absolute', () => {
    expect(clickTarget('/t/2HX9RB', ORIGIN)).toBe(`${ORIGIN}/t/2HX9RB`);
    expect(clickTarget(`${ORIGIN}/lending?f.state=overdue`, ORIGIN)).toBe(
      `${ORIGIN}/lending?f.state=overdue`,
    );
  });

  it('never leaves Kept: another origin, a scheme or nothing opens the centre', () => {
    const centre = `${ORIGIN}${PUSH_FALLBACK_PATH}`;
    expect(clickTarget('https://evil.example/t/1', ORIGIN)).toBe(centre);
    expect(clickTarget('//evil.example/t/1', ORIGIN)).toBe(centre);
    expect(clickTarget('javascript:alert(1)', ORIGIN)).toBe(centre);
    expect(clickTarget('http://kept.example/t/1', ORIGIN)).toBe(centre);
    expect(clickTarget(undefined, ORIGIN)).toBe(centre);
    expect(clickTarget(42, ORIGIN)).toBe(centre);
  });
});

describe('the push event', () => {
  it('shows the notification, with its tag, icon and URL', async () => {
    const showNotification = vi.fn(async () => undefined);
    const { event, waits } = pushEvent(
      json({
        title: 'Bosch drill, 18 V',
        body: 'Was due back 17 Oct',
        url: '/lending',
        tag: 'loan-1',
      }),
    );
    onPush({ registration: { showNotification } }, event);
    await Promise.all(waits);
    expect(showNotification).toHaveBeenCalledWith('Bosch drill, 18 V', {
      body: 'Was due back 17 Oct',
      tag: 'loan-1',
      icon: PUSH_ICON,
      data: { url: '/lending' },
    });
  });

  it('still shows something for an empty push (userVisibleOnly)', async () => {
    const showNotification = vi.fn(async () => undefined);
    const { event, waits } = pushEvent(null);
    onPush({ registration: { showNotification } }, event);
    await Promise.all(waits);
    expect(showNotification).toHaveBeenCalledWith('Kept', {
      icon: PUSH_ICON,
      data: { url: PUSH_FALLBACK_PATH },
    });
  });
});

describe('the notificationclick event', () => {
  function click(url: unknown, windows: Array<{ url: string; focused?: boolean; fail?: boolean }>) {
    const close = vi.fn();
    const waits: Promise<unknown>[] = [];
    const clients = windows.map((w) => ({
      url: w.url,
      focused: w.focused ?? false,
      focus: vi.fn(async () => undefined),
      navigate: vi.fn(async () => {
        if (w.fail) throw new TypeError('not controlled');
      }),
    }));
    const worker = {
      location: { origin: ORIGIN },
      clients: {
        matchAll: vi.fn(async () => clients),
        openWindow: vi.fn(async () => null),
      },
    };
    onNotificationClick(worker, {
      notification: { data: { url }, close },
      waitUntil: (p) => void waits.push(p),
    });
    return { close, clients, worker, done: Promise.all(waits) };
  }

  it('focuses the open Kept window and takes it to the URL', async () => {
    const { close, clients, worker, done } = click('/t/2HX9RB', [
      { url: 'https://other.example/' },
      { url: `${ORIGIN}/` },
      { url: `${ORIGIN}/search`, focused: true },
    ]);
    await done;
    expect(close).toHaveBeenCalled();
    const [, second, third] = clients;
    expect(third?.focus).toHaveBeenCalled();
    expect(third?.navigate).toHaveBeenCalledWith(`${ORIGIN}/t/2HX9RB`);
    expect(second?.navigate).not.toHaveBeenCalled();
    expect(worker.clients.openWindow).not.toHaveBeenCalled();
  });

  it('opens a window when none is open', async () => {
    const { worker, done } = click('/lending', [{ url: 'https://other.example/' }]);
    await done;
    expect(worker.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/lending`);
  });

  it("opens a window when the open one can't be navigated", async () => {
    const { worker, done } = click('/lending', [{ url: `${ORIGIN}/`, fail: true }]);
    await done;
    expect(worker.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/lending`);
  });

  it('opens the centre for a URL on another origin', async () => {
    const { worker, done } = click('https://evil.example/phish', []);
    await done;
    expect(worker.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}${PUSH_FALLBACK_PATH}`);
  });
});
