/**
 * The lock screen (step-8 plan T23; D181; board frame 111). It covers everything, online and
 * offline, until the PIN or the passkey unlocks the app. Its chunk is precached (it isn't in
 * vite.config.ts's on-demand lists), so a cold start with no connection still opens it.
 *
 * The PIN is tried once its length is typed (each try costs PBKDF2's ~0.3 s). Ten wrong PINs
 * remove this device's copy and sign out, keeping the person's own unsent captures (D210);
 * "Forgot it?" does the same after a confirm, drawn here: the lock sits above any dialog the app
 * had open (z 55, dialogs are 50, toasts 60), so a confirm from useConfirm() would hide under it.
 */
import { APP_LOCK } from '@kept/shared';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { Button } from 'react-aria-components';
import { KeyIcon } from '@/components/icons';
import { Button as ActionButton } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useAppLock } from './app-lock';
import { PinPad } from './pin-pad';

export default function LockScreen() {
  const lock = useAppLock();
  const { t } = useLingui();
  const [forgetting, setForgetting] = useState(false);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const record = lock?.record ?? null;
  const length = record?.pinLength ?? APP_LOCK.pinMin;

  useEffect(() => {
    if (!lock || busy || pin.length < length) return;
    setBusy(true);
    void lock
      .unlockPin(pin)
      .then((result) => {
        if (result === 'ok' || result === 'wiped') return;
        const left = APP_LOCK.maxPinTries - ((lock.record?.failedTries ?? 0) + 1);
        setError(
          plural(left, {
            one: 'Wrong PIN. # try left before this device’s copy is removed.',
            other: 'Wrong PIN. # tries left before this device’s copy is removed.',
          }),
        );
      })
      .finally(() => {
        setPin('');
        setBusy(false);
      });
  }, [pin, length, lock, busy]);

  if (!lock || !record) return null;

  const passkey = record.passkey ? (
    <Button
      className="grid min-h-14 place-items-center rounded-full px-2 text-[14px] text-ink-2 outline-none pressed:bg-sunken focus-visible:outline-2 focus-visible:outline-info"
      isDisabled={busy}
      onPress={() => {
        setError(null);
        void lock.unlockPasskey().catch(() => {
          setError(t`Face ID or fingerprint didn’t work. Enter your PIN.`);
        });
      }}
    >
      <Trans>Face ID</Trans>
    </Button>
  ) : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="lock-title"
      className="fixed inset-0 z-[55] grid place-items-center overflow-y-auto bg-paper px-4 py-8"
    >
      <div className="grid w-full max-w-sm justify-items-center gap-5 text-center">
        <span className="text-ink-2 [&_svg]:size-10" aria-hidden="true">
          <KeyIcon />
        </span>
        <h1 id="lock-title" className="m-0 font-semibold text-[20px]">
          <Trans>Enter your PIN</Trans>
        </h1>
        <PinPad
          value={pin}
          onChange={(v) => {
            setError(null);
            setPin(v);
          }}
          length={length}
          max={length}
          disabled={busy}
          extra={passkey}
          label={t`PIN`}
        />
        <p role="alert" className={cn('m-0 min-h-5 text-small text-danger', !error && 'invisible')}>
          {error}
        </p>
        {forgetting ? (
          <div className="grid w-full gap-3 rounded-[10px] border border-line bg-surface p-4 text-start">
            <h2 className="m-0 font-semibold text-[16px]">
              <Trans>Sign out and sign in again?</Trans>
            </h2>
            <p className="m-0 text-small text-ink-2">
              <Trans>
                This device’s copy and what you kept offline are removed. Captures you haven’t sent
                yet stay on this phone and go once you sign in again.
              </Trans>
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <ActionButton variant="secondary" onPress={() => setForgetting(false)}>
                <Trans>Cancel</Trans>
              </ActionButton>
              <ActionButton variant="danger" onPress={() => void lock.forgot()}>
                <Trans>Sign out</Trans>
              </ActionButton>
            </div>
          </div>
        ) : (
          <Button
            className="min-h-11 rounded-md px-3 text-small text-ink-2 underline-offset-2 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-info"
            onPress={() => setForgetting(true)}
          >
            <Trans>Forgot it? Sign out and sign in again.</Trans>
          </Button>
        )}
      </div>
    </div>
  );
}
