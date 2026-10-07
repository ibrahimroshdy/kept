/**
 * Change the sign-in email (D176): Settings → Me. The first try sends no password; when the
 * server answers 403 `reauth_required` the password field appears and the next try sends it. A
 * success mails a link to the *current* address; that link's page (/auth/email-change) mails the
 * new one. The same 403 after a password means it was wrong, or the account has no password and
 * its sign-in is older than 10 minutes (passkey only), so the field says both.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { startEmailChange } from '@/api/account';
import { isApiError } from '@/api/client';
import { Notice, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Dialog, DialogFooter, Modal } from '@/components/ui/dialog';
import { PasswordField } from '@/components/ui/password-field';
import { TextField } from '@/components/ui/text-field';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ChangeEmail({ current }: { current: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="small" variant="secondary" onPress={() => setOpen(true)}>
        <Trans>Change email</Trans>
      </Button>
      {open ? <ChangeEmailDialog current={current} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function ChangeEmailDialog({ current, onClose }: { current: string; onClose: () => void }) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [needsPassword, setNeedsPassword] = useState(false);
  const [wrongPassword, setWrongPassword] = useState(false);
  const [tried, setTried] = useState(false);
  const next = email.trim().toLowerCase();

  const emailError = !tried
    ? undefined
    : !EMAIL.test(next)
      ? t`Enter an email address.`
      : next === current.toLowerCase()
        ? t`That's already your email address.`
        : undefined;
  const passwordError =
    tried && needsPassword && !password
      ? t`Enter your password.`
      : wrongPassword
        ? t`That password isn't right.`
        : undefined;

  const start = useMutation({
    mutationFn: () =>
      startEmailChange(needsPassword ? { newEmail: next, password } : { newEmail: next }),
    onError: (e) => {
      if (isApiError(e) && e.code === 'reauth_required') {
        if (needsPassword) setWrongPassword(true);
        // The field is new: no "Enter your password." until they try with it.
        else setTried(false);
        setNeedsPassword(true);
      }
    },
  });
  const failed =
    start.error && !(isApiError(start.error) && start.error.code === 'reauth_required')
      ? start.error
      : null;

  return (
    <Modal isOpen onOpenChange={(o) => (o ? null : onClose())}>
      <Dialog title={t`Change your email`}>
        {start.isSuccess ? (
          <div className="grid gap-4">
            <p className="m-0 text-ink-2">
              <Trans>
                We sent a link to <span className="ltr font-semibold">{current}</span>. Open it to
                confirm the change; then a second link goes to{' '}
                <span className="ltr font-semibold">{next}</span>. Each link works once, for an
                hour. Until the second one is opened, you sign in with your current address.
              </Trans>
            </p>
            <DialogFooter>
              <Button onPress={onClose}>
                <Trans>Done</Trans>
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            className="grid gap-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              setTried(true);
              setWrongPassword(false);
              if (!EMAIL.test(next) || next === current.toLowerCase()) return;
              if (needsPassword && !password) return;
              start.mutate();
            }}
          >
            <p className="m-0 text-ink-2">
              <Trans>
                You sign in with <span className="ltr">{current}</span>. To change it, we send a
                link to that address first, then one to the new address.
              </Trans>
            </p>
            <TextField
              label={t`New email address`}
              value={email}
              onChange={setEmail}
              isInvalid={!!emailError}
              errorMessage={emailError}
              type="email"
              autoComplete="email"
              autoFocus
              inputProps={{ dir: 'ltr', autoCapitalize: 'none', spellCheck: false }}
            />
            {needsPassword ? (
              <PasswordField
                label={t`Your password`}
                value={password}
                onChange={(v) => {
                  setPassword(v);
                  setWrongPassword(false);
                }}
                isInvalid={!!passwordError}
                errorMessage={passwordError}
                autoFocus
                description={t`Confirm it's you. Signed in with a passkey only? Sign out and back in, then change your email within 10 minutes.`}
              />
            ) : null}
            {failed ? <Notice tone="danger">{errorText(failed)}</Notice> : null}
            <DialogFooter>
              <Button variant="secondary" onPress={onClose}>
                <Trans>Cancel</Trans>
              </Button>
              <Button type="submit" isPending={start.isPending}>
                <Trans>Send confirmation link</Trans>
              </Button>
            </DialogFooter>
          </form>
        )}
      </Dialog>
    </Modal>
  );
}
