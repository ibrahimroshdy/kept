/**
 * Points the PWA shell at the signed-in person's offline store once T24's provider has opened it
 * (offline/provider.tsx): the update prompt then gates on that store's uploads (D148). Rendered
 * once inside the provider; on sign-out the shell goes back to an empty in-memory store.
 */
import { useEffect } from 'react';
import { useOffline } from '@/offline/provider';
import { MemoryStore } from '@/offline/store';
import { setPageStore } from './page-store';

export function PwaStoreBridge() {
  const store = useOffline()?.store ?? null;
  useEffect(() => {
    if (!store) return;
    setPageStore(store);
    return () => setPageStore(new MemoryStore());
  }, [store]);
  return null;
}
