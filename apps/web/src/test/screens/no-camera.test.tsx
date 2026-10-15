/**
 * The camera starts only where a person asked for it (D239's bug: opening Settings → Me →
 * Notifications in a test browser met a camera prompt). `navigator.mediaDevices.getUserMedia` is
 * a stub that records every call, on a secure page so nothing stops short of it: Home, Settings
 * and Notifications (with the whole app shell) never call it; Capture, when "Show me around"
 * brings it rather than the person, waits for "Start the camera"; Scan, a page whose purpose is
 * the camera, does call it, which proves the stub is the one the app reaches. No real device is
 * touched.
 */
import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hintSlot } from '@/components/hints/use-hint';
import { findHeading, renderApp } from '../app';

let getUserMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
  getUserMedia = vi.fn(async () => {
    throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
  });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  });
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
});

afterEach(() => {
  // @ts-expect-error jsdom has none of its own
  delete navigator.mediaDevices;
  // @ts-expect-error jsdom has none of its own
  delete window.isSecureContext;
  vi.unstubAllGlobals();
});

describe('nothing asks for the camera on its own', () => {
  it('Settings → Me → Notifications and the app shell around it', async () => {
    await renderApp('/settings/me/notifications');
    await findHeading('Notifications');
    await screen.findByRole('heading', { name: 'What reaches you' }, { timeout: 3000 });
    await screen.findAllByRole('switch');
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('Home and Settings', async () => {
    const { unmount } = await renderApp('/');
    await screen.findAllByRole('link', { name: 'Capture' }, { timeout: 3000 });
    expect(getUserMedia).not.toHaveBeenCalled();
    unmount();
    await renderApp('/settings');
    await findHeading('Settings');
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('Scan does, once opened (the stub is the one the app reaches)', async () => {
    await renderApp('/scan');
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalled(), { timeout: 3000 });
  });

  it('Capture brought by the guided tour waits for a tap', async () => {
    hintSlot.take('tour');
    try {
      const { user } = await renderApp('/capture');
      const start = await screen.findByRole(
        'button',
        { name: 'Start the camera' },
        { timeout: 3000 },
      );
      expect(getUserMedia).not.toHaveBeenCalled();
      await user.click(start);
      await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    } finally {
      hintSlot.release('tour');
    }
  });
});
