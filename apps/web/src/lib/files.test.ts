/**
 * lib/files.ts: where a download works and where it may start by itself, and what the share
 * sheet answered. The screens' use of it is in test/screens/file-delivery.test.tsx.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { autoDownloads, canShareType, downloadsWork, isAppleStandalone, shareFiles } from './files';

const MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';

const added: string[] = [];
function define(key: string, value: unknown) {
  Object.defineProperty(navigator, key, { value, configurable: true, writable: true });
  added.push(key);
}
function on(ua: string, touchPoints: number, standalone: boolean) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua);
  define('maxTouchPoints', touchPoints);
  define('standalone', standalone);
}

afterEach(() => {
  for (const key of added.splice(0)) delete (navigator as unknown as Record<string, unknown>)[key];
  vi.restoreAllMocks();
});

describe('where downloads work', () => {
  it.each([
    ['a Mac', MAC, 0, false, { work: true, auto: true, appleApp: false }],
    ['Android, installed', ANDROID, 5, true, { work: true, auto: true, appleApp: false }],
    ['iPhone Safari', IPHONE, 5, false, { work: true, auto: false, appleApp: false }],
    ['the installed iPhone app', IPHONE, 5, true, { work: false, auto: false, appleApp: true }],
    // iPadOS asks for desktop sites and reports a Mac; its touch points give it away.
    ['the installed iPad app', MAC, 5, true, { work: false, auto: false, appleApp: true }],
  ])('%s', (_name, ua, touch, standalone, want) => {
    on(ua, touch, standalone);
    expect(downloadsWork()).toBe(want.work);
    expect(autoDownloads()).toBe(want.auto);
    expect(isAppleStandalone()).toBe(want.appleApp);
  });
});

describe('the share sheet', () => {
  it("can't share without navigator.share and canShare", () => {
    expect(canShareType('a.pdf', 'application/pdf')).toBe(false);
    define('share', vi.fn());
    expect(canShareType('a.pdf', 'application/pdf')).toBe(false);
  });

  it('asks canShare with a file of the type, and follows its answer', () => {
    define('share', vi.fn());
    const canShare = vi.fn((d: ShareData) => d.files?.[0]?.type === 'application/pdf');
    define('canShare', canShare);
    expect(canShareType('a.pdf', 'application/pdf')).toBe(true);
    expect(canShareType('a.csv', 'text/csv')).toBe(false);
    expect(canShare.mock.calls[0]?.[0].files?.[0]?.name).toBe('a.pdf');
  });

  it('says whether it shared, the person closed it, or the browser refused', async () => {
    const file = new File(['x'], 'a.pdf', { type: 'application/pdf' });
    const share = vi.fn(async (_d: ShareData) => {});
    define('share', share);
    expect(await shareFiles([file], 'Kept')).toBe('shared');
    expect(share).toHaveBeenCalledWith({ files: [file], title: 'Kept' });
    share.mockRejectedValueOnce(new DOMException('closed', 'AbortError'));
    expect(await shareFiles([file])).toBe('cancelled');
    share.mockRejectedValueOnce(new DOMException('no gesture', 'NotAllowedError'));
    expect(await shareFiles([file])).toBe('refused');
  });
});
