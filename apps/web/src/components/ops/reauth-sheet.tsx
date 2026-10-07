/**
 * Re-authentication before a sensitive action (D176; step-8 T22): the recovery kit's download.
 * The password again, or, for an account without one (passkey or magic link only) whose sign-in
 * is over ten minutes old, "Sign in again". The server says which (403 `reauth_required` with
 * `details.reauth`: `password` or `sign_in`); a wrong password keeps the sheet open with the
 * message. The password lives in this component's state only, and is cleared after each try.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { type FormEvent, type ReactNode, useState } from 'react';
import { isApiError } from '@/api/client';
import { Notice, useErrorText } from '@/components/page';
import { useSignOut } from '@/components/sign-out';
import { Button } from '@/components/ui/button';
import { Dialog, DialogFooter, Modal } from '@/components/ui/dialog';
import { PasswordField } from '@/components/ui/password-field';

type Refusal = 'missing' | 'wrong' | 'sign_in';

export type ReauthSheetProps = {
  title: ReactNode;
  /** What the action does and what it hands out; extra choices (a format) go here too. */
  children: ReactNode;
  submitLabel: ReactNode;
  /** Runs with the typed password (undefined when the field is empty). Throws to refuse. */
  onSubmit: (password: string | undefined) => Promise<void>;
  onClose: () => void;
  /** The page the sign-in returns to after "Sign in again". */
  returnTo: string;
};

export function ReauthSheet({
  title,
  children,
  submitLabel,
  onSubmit,
  onClose,
  returnTo,
}: ReauthSheetProps) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const signOut = useSignOut();
  const [password, setPassword] = useState('');
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setRefusal(null);
    setFailure(null);
    const typed = password === '' ? undefined : password;
    try {
      await onSubmit(typed);
    } catch (err) {
      if (isApiError(err) && err.code === 'reauth_required') {
        setRefusal(err.details.reauth === 'sign_in' ? 'sign_in' : typed ? 'wrong' : 'missing');
      } else {
        setFailure(err);
      }
    } finally {
      setPassword('');
      setPending(false);
    }
  };

  const passwordError =
    refusal === 'wrong'
      ? t`That password isn't right.`
      : refusal === 'missing'
        ? t`Enter your password.`
        : undefined;

  return (
    <Modal isOpen onOpenChange={(open) => (open ? null : onClose())}>
      <Dialog title={title}>
        <form className="grid gap-4" noValidate onSubmit={submit}>
          {children}
          {refusal === 'sign_in' ? (
            <Notice
              tone="warn"
              title={<Trans>Sign in again</Trans>}
              action={
                <Button
                  size="small"
                  variant="secondary"
                  onPress={() => void signOut({ next: returnTo })}
                >
                  <Trans>Sign in again</Trans>
                </Button>
              }
            >
              <Trans>
                Your account has no password, and you signed in over ten minutes ago. Sign in again,
                then come back here.
              </Trans>
            </Notice>
          ) : (
            <PasswordField
              label={t`Your password`}
              description={t`No password on your account? Leave this empty: a sign-in in the last ten minutes is enough.`}
              value={password}
              onChange={setPassword}
              isInvalid={!!passwordError}
              errorMessage={passwordError}
              autoFocus
            />
          )}
          {failure ? <Notice tone="danger">{errorText(failure)}</Notice> : null}
          <DialogFooter>
            <Button variant="secondary" onPress={onClose}>
              <Trans>Cancel</Trans>
            </Button>
            <Button type="submit" isPending={pending} isDisabled={refusal === 'sign_in'}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
    </Modal>
  );
}
