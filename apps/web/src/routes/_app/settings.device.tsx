/**
 * Settings → Me → This device (step-8 plan T23; D159, D181; board frame 110): the app lock (a PIN,
 * and Face ID or fingerprint where the device offers it) and "keep this location available
 * offline". Its chunk loads on demand from assets/household/ (vite.config.ts); the lock screen
 * itself is in the shell (components/device/app-lock.tsx), precached, so a locked app opens
 * offline. Nothing here is sent to the server: the lock and what is kept live on the device.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { useLocations } from '@/api/queries';
import { useAppLock } from '@/components/device/app-lock';
import { AppLockSettings } from '@/components/device/app-lock-settings';
import { KeepOffline } from '@/components/device/keep-offline';
import { SettingsRouteError } from '@/components/on-demand-route-error';
import { LoadingRows, Page, Section } from '@/components/page';
import type { KeptOfflineRow } from '@/offline/db';

export const Route = createFileRoute('/_app/settings/device')({
  component: DevicePage,
  errorComponent: SettingsRouteError,
});

function DevicePage() {
  const { t } = useLingui();
  const lock = useAppLock();
  const locations = useLocations();
  const [kept, setKept] = useState<KeptOfflineRow[]>([]);
  const db = lock?.db ?? null;
  const record = lock?.record ?? null;

  const reload = useCallback(async () => {
    if (!db) return setKept([]);
    const m = await import('@/offline/extras');
    setKept(await m.keptLocations(db));
  }, [db]);

  // Again whenever the lock changes: turning it off removes what was kept.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `record` is the trigger, not an input
  useEffect(() => {
    void reload().catch(() => setKept([]));
  }, [reload, record]);

  return (
    <Page title={t`This device`} back="/settings">
      <Section title={<Trans>App lock</Trans>}>
        <AppLockSettings keptCount={kept.length} />
      </Section>
      {lock?.supported ? (
        <Section title={<Trans>Keep available offline</Trans>}>
          {locations.data ? (
            <KeepOffline locations={locations.data} kept={kept} reload={reload} />
          ) : (
            <LoadingRows rows={2} label={t`Loading your locations`} />
          )}
        </Section>
      ) : null}
    </Page>
  );
}
