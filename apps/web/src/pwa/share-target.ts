/**
 * Share into Kept (D140; engineering spec §2.7; plan T23 and Q26).
 *
 * 1. Another app shares images or PDFs; the installed app's manifest sends them as a
 *    multipart POST to `/share`.
 * 2. The service worker (src/sw.ts) reads the form with `shareFromForm()`, holds the share in
 *    memory and answers `303 /capture?shared=<id>`.
 * 3. The capture page calls `claimShare()`: the share comes from the signed-in person's store if
 *    it was claimed before (a reload), else from the worker, and is then kept in the store
 *    (`putShared`) until the "Shared into Kept" sheet keeps or discards it.
 *
 * The worker hands the share to the page rather than writing it itself: the offline store is
 * one database per user (T24), and the worker can't know whose to open.
 *
 * When the worker isn't active yet (the first visit), the server answers the POST itself with
 * `303 /capture?share=unavailable` without reading it (apps/server/src/http/share.ts): the page
 * says "Open Kept once, then share again".
 *
 * iPhone web apps can't be share targets (V9); there, Help and the install sheet say "use Gallery".
 */
import type { OfflineStore, SharedInto } from '@/offline/store';

/** The manifest's `share_target.action`. */
export const SHARE_ACTION = '/share';
/** The manifest's `share_target.params.files[0].name`. */
export const SHARE_FILES_FIELD = 'files';
/** One capture takes at most 20 files (`CreateThingPayload.files`). */
export const SHARE_MAX_FILES = 20;
/** How long the worker holds a share for the page to claim it. */
export const SHARE_HOLD_MS = 60_000;
/** The page → worker message that claims a held share; the answer comes on the port. */
export const TAKE_SHARE = 'KEPT_TAKE_SHARE';

export type TakeShareMessage = { type: typeof TAKE_SHARE; id: string };
export type TakeShareReply = { share: SharedInto | null };

/** What the manifest accepts, checked again here: the sending app may ignore `accept`. */
export function acceptsSharedType(type: string): boolean {
  return type.startsWith('image/') || type === 'application/pdf';
}

const text = (v: FormDataEntryValue | null): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, 500) : null;

/** The share in a share-target POST: the accepted files (at most 20), its title and text. */
export function shareFromForm(form: FormData, id: string, at: string): SharedInto {
  const files = form
    .getAll(SHARE_FILES_FIELD)
    .filter((v): v is File => typeof v !== 'string' && acceptsSharedType(v.type))
    .slice(0, SHARE_MAX_FILES)
    .map((f) => ({ name: f.name, type: f.type, blob: f as Blob }));
  return {
    id,
    at,
    title: text(form.get('title')),
    text: text(form.get('text')) ?? text(form.get('url')),
    files,
  };
}

/** Asks the active service worker for a share it holds; null when it has none or doesn't answer. */
export async function askWorker(id: string, timeoutMs = 3000): Promise<SharedInto | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  const worker =
    navigator.serviceWorker.controller ??
    (await Promise.race([
      navigator.serviceWorker.ready.then((r) => r.active),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]));
  if (!worker) return null;
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), timeoutMs);
    channel.port1.onmessage = (e: MessageEvent<TakeShareReply>) => {
      clearTimeout(timer);
      resolve(e.data?.share ?? null);
    };
    const message: TakeShareMessage = { type: TAKE_SHARE, id };
    worker.postMessage(message, [channel.port2]);
  });
}

/**
 * The share `id`, from the store or else claimed from the worker and kept in the store.
 * Undefined when neither has it (it expired, or it was already kept or discarded).
 */
export async function claimShare(
  id: string,
  store: Pick<OfflineStore, 'shared' | 'putShared'>,
  ask: (id: string) => Promise<SharedInto | null> = askWorker,
): Promise<SharedInto | undefined> {
  const kept = await store.shared(id);
  if (kept) return kept;
  const share = await ask(id);
  if (!share) return undefined;
  await store.putShared(share);
  return share;
}
