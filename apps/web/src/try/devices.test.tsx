/**
 * Try Kept (D246) never asks the browser for a device: with the flag on, the camera, the
 * microphone, the position, push, persistent storage and another site's sign-in each stop
 * before the browser is asked, and Capture says the camera is off instead.
 */
import { screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { dictationSupport, recognitionCtor } from '@/assistant/dictation';
import { deviceGeo } from '@/camera/geo';
import { openCamera, problemUpfront } from '@/camera/session';
import { FileFallback } from '@/components/capture/file-fallback';
import { toastQueue } from '@/components/ui/toast';
import { activateLocale } from '@/i18n/i18n';
import { leave } from '@/lib/leave';
import { requestPersistence } from '@/offline/persist';
import { runProbe } from '@/pwa/probes';
import { pushBlocker } from '@/pwa/push';
import { renderUI } from '@/test/render';

vi.mock('@/try/flag', async (original) => ({
  ...(await original<typeof import('./flag')>()),
  TRY: true,
}));

beforeAll(() => activateLocale('en'));
afterEach(() => vi.restoreAllMocks());

describe('Try Kept asks for no device', () => {
  it('never opens the camera', async () => {
    const getUserMedia = vi.fn();
    const env = { secure: true, media: { getUserMedia } };
    expect(problemUpfront(env)).toBe('demo');
    expect(await openCamera(env)).toEqual({ ok: false, problem: 'demo' });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('shows no mic, even where the browser has a recogniser', () => {
    const w = window as unknown as { SpeechRecognition?: unknown };
    w.SpeechRecognition = class {};
    try {
      expect(recognitionCtor()).toBeNull();
      expect(dictationSupport()).toBeNull();
    } finally {
      delete w.SpeechRecognition;
    }
  });

  it('never reads the position', () => {
    expect(deviceGeo()).toBeNull();
  });

  it('offers no push, and says why', () => {
    expect(pushBlocker({ available: true })).toBe('demo');
  });

  it('never asks for persistent storage', async () => {
    const persist = vi.fn(async () => true);
    const persisted = vi.fn(async () => false);
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { persist, persisted },
    });
    expect(await requestPersistence()).toBeNull();
    expect(persist).not.toHaveBeenCalled();
  });

  it("doesn't run the diagnostics' camera check", async () => {
    const getUserMedia = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    expect(await runProbe('camera')).toEqual({
      key: 'camera',
      status: 'info',
      facts: ['off-in-demo'],
    });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("doesn't leave for another site's sign-in", () => {
    const add = vi.spyOn(toastQueue, 'add');
    const before = location.href;
    leave.to('https://accounts.google.com/o/oauth2/v2/auth?client_id=kept');
    expect(location.href).toBe(before);
    expect(add).toHaveBeenCalledOnce();
  });

  it('says the camera is off in Capture, and picks photos without the camera app', async () => {
    const { container } = await renderUI(<FileFallback problem="demo" onFiles={() => {}} />);
    expect(screen.getByRole('heading', { name: 'The camera is off in this demo' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Choose photos' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Take a photo' })).toBeNull();
    expect(container.querySelector('input[capture]')).toBeNull();
  });
});
