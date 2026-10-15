/** Try Kept (D246): a link to one of Kept's own files says so instead of leaving for a 404. */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { toastQueue } from '@/components/ui/toast';
import { activateLocale } from '@/i18n/i18n';
import { guardServerFiles, isServerFile } from './files';

beforeAll(() => activateLocale('en'));
afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('isServerFile', () => {
  it("is Kept's /f/ URLs on this origin only", () => {
    const origin = 'https://keptinventory.info';
    expect(isServerFile('/f/mock-export-1', origin)).toBe(true);
    expect(isServerFile('https://keptinventory.info/f/x/thumb', origin)).toBe(true);
    expect(isServerFile('https://keptinventory.info/x/mock-123', origin)).toBe(true);
    expect(isServerFile('/try/kept/app/#/f/x', origin)).toBe(false);
    expect(isServerFile('https://example.com/f/x', origin)).toBe(false);
    expect(isServerFile('data:application/pdf;base64,AA==', origin)).toBe(false);
  });
});

describe('guardServerFiles', () => {
  it('stops the link and shows a toast; other links go on', () => {
    const add = vi.spyOn(toastQueue, 'add');
    const stop = guardServerFiles(document, location.origin);
    const file = Object.assign(document.createElement('a'), { href: '/f/mock-export-1' });
    const page = Object.assign(document.createElement('a'), { href: '#/labels' });
    document.body.append(file, page);
    const clickFile = new MouseEvent('click', { bubbles: true, cancelable: true });
    file.dispatchEvent(clickFile);
    expect(clickFile.defaultPrevented).toBe(true);
    expect(add).toHaveBeenCalledOnce();
    const clickPage = new MouseEvent('click', { bubbles: true, cancelable: true });
    page.dispatchEvent(clickPage);
    expect(clickPage.defaultPrevented).toBe(false);
    stop();
    // Removed: the link is left alone (jsdom can't follow it, so this test stops it itself).
    const hold = (e: Event) => e.preventDefault();
    document.addEventListener('click', hold);
    file.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    document.removeEventListener('click', hold);
    expect(add).toHaveBeenCalledOnce();
  });
});
