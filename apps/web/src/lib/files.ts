/**
 * Handing a file Kept made (an inventory PDF, label images, a CSV) to the person, on every
 * platform. An installed iPhone or iPad app (iOS standalone) doesn't handle downloads: an
 * `attachment` link and an `<a download>` of a blob both do nothing there. So a finished file is
 * offered as buttons the person presses:
 *
 * - **Open**: an inline URL in a new tab, which the installed app shows in its in-app browser;
 * - **Share**: the share sheet with the file itself (Save to Files, Print, Messages…), where the
 *   browser can share files. Call it in the press's own turn with a file already in hand: iOS
 *   refuses a share that first waited on the network;
 * - **Download**: wherever downloads work.
 *
 * Only a browser off Apple's phones and tablets gets a download that starts by itself.
 */
import { isStandalone } from '@/lib/media';
import { isAppleMobile } from '@/pwa/install';

type ShareNavigator = Navigator & { canShare?: (data: ShareData) => boolean };

function appleMobile(): boolean {
  try {
    return isAppleMobile();
  } catch {
    return false;
  }
}

/** Opened as the installed app on an iPhone or iPad, where downloads go nowhere. */
export function isAppleStandalone(): boolean {
  return appleMobile() && isStandalone();
}

/** Whether a download (an attachment link, `<a download>`) reaches the person here. */
export function downloadsWork(): boolean {
  return !isAppleStandalone();
}

/** Whether a download may start by itself: not on an iPhone or iPad, where it's a prompt at
 * best and nothing at all in the installed app. */
export function autoDownloads(): boolean {
  return !appleMobile();
}

/** Whether the share sheet takes these files. */
export function canShareFiles(files: File[]): boolean {
  try {
    const nav = navigator as ShareNavigator;
    return typeof nav.share === 'function' && typeof nav.canShare === 'function'
      ? nav.canShare({ files })
      : false;
  } catch {
    return false;
  }
}

/** Whether the share sheet takes a file of this type, asked before the file exists. */
export function canShareType(name: string, type: string): boolean {
  if (typeof File !== 'function') return false;
  return canShareFiles([new File(['.'], name, { type })]);
}

export type ShareOutcome = 'shared' | 'cancelled' | 'refused';

/** Opens the share sheet with `files`: 'cancelled' when the person closed it, 'refused' when the
 * browser wouldn't (too many files, or the press was too long ago). */
export async function shareFiles(files: File[], title?: string): Promise<ShareOutcome> {
  try {
    await navigator.share({ files, ...(title ? { title } : {}) });
    return 'shared';
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled';
    return 'refused';
  }
}

/** Starts a download of `url`, as a link click would: the server sends it as an attachment. */
export function downloadUrl(url: string): void {
  try {
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    a.click();
  } catch {
    // The page's own Download button is still there to press.
  }
}

/** Saves a file made on the page through `<a download>`. */
export function saveFile(file: File): void {
  if (typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  // Let the download start before the URL goes.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
