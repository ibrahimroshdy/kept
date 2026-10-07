/**
 * The PIN asked for on This device (step-8 plan T23): one or more steps on the app's own keypad
 * (pin-pad.tsx). A new PIN is 6 to 12 digits and typed twice; a current one is tried as soon as
 * its length is in. `onDone` gets every step's PIN and answers an error to show, or null.
 */
import { APP_LOCK } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { type ReactNode, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogFooter, Modal } from '@/components/ui/dialog';
import { PinPad } from './pin-pad';

export type PinStep = {
  prompt: ReactNode;
  /** A known length: tried once typed. Otherwise a new PIN, confirmed with Continue. */
  length?: number;
  /** This step repeats the one before it ("Type it again"). */
  repeat?: boolean;
};

export function PinSheet({
  title,
  steps,
  note,
  onDone,
  onClose,
}: {
  title: ReactNode;
  steps: PinStep[];
  note?: ReactNode;
  onDone: (pins: string[]) => Promise<string | null>;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [pins, setPins] = useState<string[]>([]);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const index = pins.length;
  const step = steps[index] as PinStep;

  const next = async (pin: string) => {
    if (step.repeat && pin !== pins[index - 1]) {
      setError(t`The PINs don’t match. Type the new PIN again.`);
      setPins(pins.slice(0, -1));
      setValue('');
      return;
    }
    const all = [...pins, pin];
    setValue('');
    if (all.length < steps.length) {
      setPins(all);
      setError(null);
      return;
    }
    setBusy(true);
    const problem = await onDone(all).catch(() => t`That didn’t work. Try again.`);
    setBusy(false);
    if (problem) {
      setError(problem);
      setPins([]);
    }
  };

  useEffect(() => {
    if (step?.length !== undefined && value.length === step.length && !busy) void next(value);
  });

  const newPin = step?.length === undefined;
  return (
    <Modal isOpen onOpenChange={(o) => (o ? null : onClose())}>
      <Dialog title={title}>
        <div className="grid justify-items-center gap-4">
          <p className="m-0 text-center text-ink-2">{step?.prompt}</p>
          <PinPad
            value={value}
            onChange={(v) => {
              setError(null);
              setValue(v);
            }}
            length={step?.length ?? APP_LOCK.pinMin}
            max={step?.length ?? APP_LOCK.pinMax}
            disabled={busy}
            label={t`PIN`}
          />
          <p role="alert" className="m-0 min-h-5 text-center text-small text-danger">
            {error}
          </p>
          {note ? <div className="w-full text-small text-ink-2">{note}</div> : null}
        </div>
        {newPin ? (
          <DialogFooter>
            <Button variant="secondary" onPress={onClose}>
              <Trans>Cancel</Trans>
            </Button>
            <Button
              isDisabled={busy || value.length < APP_LOCK.pinMin}
              onPress={() => void next(value)}
            >
              <Trans>Continue</Trans>
            </Button>
          </DialogFooter>
        ) : null}
      </Dialog>
    </Modal>
  );
}
