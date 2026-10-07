/**
 * Set a new password from a reset link (D176, D181): a reset mail, or the link that
 * `kept admin reset-password` prints. The token is in the #fragment, which never reaches the
 * server, and nothing is spent on load: the POST behind the button uses it. A reset signs out
 * every session, so the person signs in again afterwards.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation } from '@tanstack/react-query';
import { createFileRoute, useRouterState } from '@tanstack/react-router';
import { useState } from 'react';
import { resetPassword } from '@/api/auth';
import { isApiError } from '@/api/client';
import { AuthFrame } from '@/components/auth-frame';
import { LinkButton, Notice, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { PasswordField } from '@/components/ui/password-field';
import { tokenFromHash } from '@/lib/fragment';

export const Route = createFileRoute('/auth/reset')({ component: ResetPage });

function ResetPage() {
  const { t } = useLingui();
  const errorText = useErrorText();
  // Read once: the fragment is cleared from the address bar after it's spent.
  const hash = useRouterState({ select: (s) => s.location.hash });
  const [token] = useState(() => tokenFromHash(hash));
  const [password, setPassword] = useState('');
  const [tried, setTried] = useState(false);
  const tooShort = password.length < 8 ? t`At least 8 characters.` : undefined;
  const reset = useMutation({
    mutationFn: async () => {
      if (!token) throw new Error('no token');
      await resetPassword(token, password);
      history.replaceState(null, '', location.pathname);
    },
  });

  if (!token || reset.isSuccess)
    return (
      <AuthFrame
        title={reset.isSuccess ? t`Password changed` : t`This link is incomplete`}
        intro={
          reset.isSuccess ? (
            <Trans>
              Your new password works now. Every device that was signed in has been signed out.
            </Trans>
          ) : (
            <Trans>
              The reset link is missing its code. Open it straight from the email, or ask for a new
              one on the sign-in page.
            </Trans>
          )
        }
        footer={
          <LinkButton to="/signin" variant="primary">
            <Trans>Go to sign in</Trans>
          </LinkButton>
        }
      >
        {null}
      </AuthFrame>
    );

  const failed = reset.error;
  const expired = failed && isApiError(failed) && (failed.status === 400 || failed.status === 404);
  return (
    <AuthFrame
      title={t`Choose a new password`}
      intro={<Trans>Setting it signs you out on every device.</Trans>}
    >
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (tooShort) return;
          reset.mutate();
        }}
      >
        <PasswordField
          label={t`New password`}
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
          isInvalid={tried && !!tooShort}
          errorMessage={tried ? tooShort : undefined}
          description={t`At least 8 characters. A few unrelated words is easy to remember.`}
          autoFocus
        />
        {failed ? (
          <Notice
            tone="danger"
            title={expired ? <Trans>This link no longer works</Trans> : undefined}
          >
            {expired ? (
              <Trans>
                Reset links work once, for an hour. Ask for a new one on the sign-in page.
              </Trans>
            ) : (
              errorText(failed)
            )}
          </Notice>
        ) : null}
        <Button type="submit" isPending={reset.isPending} isDisabled={!!expired}>
          <Trans>Set password</Trans>
        </Button>
      </form>
    </AuthFrame>
  );
}
