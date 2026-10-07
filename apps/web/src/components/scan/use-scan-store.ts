/**
 * The offline store the scan, tray and box-check screens use (plan T26): the signed-in person's
 * Dexie store once it has opened (T24), or the page's memory store where this browser has no
 * IndexedDB (the component tests' jsdom, some locked-down browsers). Null while Dexie opens.
 */
import { offlineSupported } from '@/offline/open';
import { useOffline } from '@/offline/provider';
import { pageStore } from '@/pwa/page-store';
import type { ScanStore } from './resolve';

export function useScanStore(): ScanStore | null {
  const offline = useOffline();
  return offline?.store ?? (offlineSupported() ? null : pageStore());
}

/** After queueing an op: the sync engine sends it now if it can (T24). */
export function useKick(): () => void {
  const offline = useOffline();
  return () => offline?.engine.kick();
}
