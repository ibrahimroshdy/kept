/**
 * "Type the code" (plan T26; WCAG 1.1/2.1: an alternative to the camera, always reachable). The 6
 * characters printed under a label's QR code, folded the way the server folds them
 * (`normaliseInputCode`: case, spaces, hyphens, O → 0, I/L → 1), with the chip previewing the code
 * exactly as the label prints it. The field stays left to right in Arabic (screens §8).
 */
import { isShortCode, normaliseInputCode } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { Form } from 'react-aria-components';
import { IdChip } from '@/components/id-chip';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';

export function ManualCode({
  onCode,
  onCancel,
}: {
  onCode: (code: string) => void;
  onCancel?: () => void;
}) {
  const { t } = useLingui();
  const [raw, setRaw] = useState('');
  const [tried, setTried] = useState(false);
  const code = normaliseInputCode(raw);
  const valid = isShortCode(code);
  const error = tried && !valid ? t`A Kept code is 6 letters and digits, like 7KQ‑4MZ.` : undefined;
  return (
    <Form
      aria-label={t`Type the code`}
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (valid) onCode(code);
      }}
    >
      <TextField
        label={t`Code on the label`}
        description={t`The 6 characters printed under the QR code.`}
        value={raw}
        onChange={(v) => {
          setRaw(v);
          setTried(false);
        }}
        isInvalid={!!error}
        errorMessage={error}
        placeholder="7KQ‑4MZ"
        autoFocus
        inputProps={{
          dir: 'ltr',
          autoCapitalize: 'characters',
          autoComplete: 'off',
          autoCorrect: 'off',
          spellCheck: false,
          maxLength: 12,
        }}
      />
      <div className="flex min-h-9 items-center gap-2" aria-live="polite">
        {valid ? (
          <>
            <IdChip code={code} />
            <span className="text-small text-ink-3">
              <Trans>Ready to look up</Trans>
            </span>
          </>
        ) : null}
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        {onCancel ? (
          <Button variant="secondary" onPress={onCancel}>
            <Trans>Cancel</Trans>
          </Button>
        ) : null}
        <Button type="submit">
          <Trans>Find</Trans>
        </Button>
      </div>
    </Form>
  );
}
