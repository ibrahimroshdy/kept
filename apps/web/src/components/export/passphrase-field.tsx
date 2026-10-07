/**
 * The export's passphrase, twice (D68; plan T21, Q7): the app's own password inputs, at least
 * PASSPHRASE_MIN characters and no composition rules. A mismatch is said beside the second field,
 * as it's typed, and announced (WCAG 4.1.3); the parent's button waits until both agree. The
 * passphrase lives only in the parent's state while the sheet is open: never browser storage,
 * never the URL, never the query cache.
 */
import { PASSPHRASE_MIN } from '@kept/shared';
import { useLingui } from '@lingui/react/macro';
import { PasswordField } from '@/components/ui/password-field';
import { useFormat } from '@/lib/format';

export type Passphrase = { first: string; again: string };

/** Whether the two fields make a passphrase the server takes. */
export const passphraseReady = (p: Passphrase) =>
  p.first.length >= PASSPHRASE_MIN && p.first === p.again;

export function PassphraseFields({
  value,
  onChange,
}: {
  value: Passphrase;
  onChange: (value: Passphrase) => void;
}) {
  const { t } = useLingui();
  const f = useFormat();
  const min = f.num(PASSPHRASE_MIN);
  const short = value.first.length > 0 && value.first.length < PASSPHRASE_MIN;
  const differs = value.again.length > 0 && value.again !== value.first;
  return (
    <div className="grid gap-3">
      <PasswordField
        label={t`Passphrase`}
        autoComplete="new-password"
        value={value.first}
        onChange={(first) => onChange({ ...value, first })}
        description={short ? undefined : t`At least ${min} characters.`}
        isInvalid={short}
        errorMessage={t`At least ${min} characters.`}
      />
      <PasswordField
        label={t`The passphrase again`}
        autoComplete="new-password"
        value={value.again}
        onChange={(again) => onChange({ ...value, again })}
        isInvalid={differs}
        errorMessage={t`The two passphrases are different.`}
      />
    </div>
  );
}
