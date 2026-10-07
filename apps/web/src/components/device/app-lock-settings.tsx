/**
 * This device → App lock (step-8 plan T23; D181, Q22; board frame 110): the lock on or off, Face ID
 * or fingerprint where the platform can verify the person (L1 finding 4), and Change PIN.
 */
import { APP_LOCK } from '@kept/shared';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { Notice } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { sep } from '@/lib/format';
import { type PinResult, useAppLock } from './app-lock';
import { PinSheet, type PinStep } from './pin-sheet';

type Sheet = 'enable' | 'disable' | 'change' | 'passkey' | null;

export function AppLockSettings({ keptCount }: { keptCount: number }) {
  const lock = useAppLock();
  const { t } = useLingui();
  const [sheet, setSheet] = useState<Sheet>(null);
  const [canPasskey, setCanPasskey] = useState(false);

  useEffect(() => {
    let live = true;
    void import('@/offline/lock')
      .then((m) => m.passkeyAvailable())
      .then((ok) => {
        if (live) setCanPasskey(ok);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  if (!lock?.supported) {
    return (
      <Notice tone="info" title={<Trans>Not available in this browser</Trans>}>
        <Trans>The app lock needs storage this browser doesn’t give Kept.</Trans>
      </Notice>
    );
  }
  const on = lock.record !== null;
  const record = lock.record;

  const pinError = (result: PinResult): string | null => {
    if (result === 'ok' || result === 'wiped') return null;
    const left = APP_LOCK.maxPinTries - (lock.record?.failedTries ?? 0) - 1;
    return plural(left, {
      one: 'Wrong PIN. # try left before this device’s copy is removed.',
      other: 'Wrong PIN. # tries left before this device’s copy is removed.',
    });
  };

  const current: PinStep = {
    prompt: <Trans>Enter your current PIN.</Trans>,
    length: record?.pinLength ?? APP_LOCK.pinMin,
  };
  const fresh: PinStep[] = [
    { prompt: <Trans>Choose a PIN of 6 to 12 digits.</Trans> },
    { prompt: <Trans>Type it again.</Trans>, repeat: true },
  ];

  const enrol = async () => {
    try {
      await lock.enrolPasskey(t`Kept app lock`);
      toast({ title: t`Face ID or fingerprint can unlock Kept now`, tone: 'ok' });
    } catch {
      toast({ title: t`Face ID or fingerprint wasn’t set up`, tone: 'danger' });
    }
  };

  return (
    <div className="grid gap-2 rounded-[10px] border border-line bg-surface p-3.5">
      <Switch isSelected={on} onChange={(v) => setSheet(v ? 'enable' : 'disable')}>
        <Trans>Lock Kept on this device</Trans>
      </Switch>
      {on && canPasskey ? (
        <Switch
          isSelected={record?.passkey != null}
          onChange={(v) => {
            if (!v) void lock.removePasskey();
            else if (lock.dataKey) void enrol();
            else setSheet('passkey');
          }}
        >
          <Trans>Use Face ID or fingerprint</Trans>
        </Switch>
      ) : null}
      {on ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-small text-ink-2">
            {t`PIN set`}
            {sep()}
            {plural(APP_LOCK.idleMinutes, {
              one: 'locks after # minute away',
              other: 'locks after # minutes away',
            })}
          </span>
          <Button size="small" variant="secondary" onPress={() => setSheet('change')}>
            <Trans>Change PIN</Trans>
          </Button>
        </div>
      ) : (
        <p className="m-0 text-small text-ink-2">
          <Trans>
            Ask for a PIN when Kept opens and after five minutes away. Keeping a location offline
            needs it.
          </Trans>
        </p>
      )}
      {record?.passkey && !record.passkey.wrapped ? (
        <p className="m-0 text-small text-ink-2">
          <Trans>
            On this phone Face ID or fingerprint opens Kept, but prices and documents kept offline
            still ask for the PIN.
          </Trans>
        </p>
      ) : null}

      {sheet === 'enable' ? (
        <PinSheet
          title={<Trans>Lock Kept on this device</Trans>}
          steps={fresh}
          note={
            <Trans>
              The PIN keeps out someone holding this phone. Forgot it? Sign out and sign in again.
            </Trans>
          }
          onClose={() => setSheet(null)}
          onDone={async ([pin]) => {
            await lock.enable(pin as string);
            setSheet(null);
            toast({ title: t`Kept locks on this device now`, tone: 'ok' });
            return null;
          }}
        />
      ) : null}
      {sheet === 'disable' ? (
        <PinSheet
          title={<Trans>Turn the app lock off</Trans>}
          steps={[current]}
          note={
            keptCount > 0
              ? plural(keptCount, {
                  one: 'The # location kept offline is removed from this device too.',
                  other: 'The # locations kept offline are removed from this device too.',
                })
              : undefined
          }
          onClose={() => setSheet(null)}
          onDone={async ([pin]) => {
            const result = await lock.disable(pin as string);
            if (result === 'ok') setSheet(null);
            return pinError(result);
          }}
        />
      ) : null}
      {sheet === 'change' ? (
        <PinSheet
          title={<Trans>Change PIN</Trans>}
          steps={[current, ...fresh]}
          onClose={() => setSheet(null)}
          onDone={async ([old, next]) => {
            const result = await lock.changePin(old as string, next as string);
            if (result === 'ok') {
              setSheet(null);
              toast({ title: t`PIN changed`, tone: 'ok' });
            }
            return pinError(result);
          }}
        />
      ) : null}
      {sheet === 'passkey' ? (
        <PinSheet
          title={<Trans>Use Face ID or fingerprint</Trans>}
          steps={[current]}
          onClose={() => setSheet(null)}
          onDone={async ([pin]) => {
            const result = await lock.openExtras(pin as string);
            if (result === 'ok') {
              setSheet(null);
              toast({ title: t`Now turn on Face ID or fingerprint again`, tone: 'neutral' });
            }
            return pinError(result);
          }}
        />
      ) : null}
    </div>
  );
}
