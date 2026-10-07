/**
 * The second-factor challenge (D176, spike S2). Reached after a password sign-in that answered
 * `twoFactorRedirect`, or when a magic-link or passkey session is still pending (the server
 * answers 403 mfa_required until a factor is proven). An authenticator code, a backup code, or
 * a passkey with user verification all count; an emailed code never does.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import {
  PasskeyCancelled,
  passkeysSupported,
  signInWithPasskey,
  signOut,
  verifyBackupCode,
  verifyTotp,
} from '@/api/auth';
import { isApiError } from '@/api/client';
import { keys } from '@/api/queries';
import { AuthFrame } from '@/components/auth-frame';
import { KeyIcon } from '@/components/icons';
import { Notice, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { nextSearch } from '@/lib/next';

export const Route = createFileRoute('/signin/two-factor')({
  validateSearch: nextSearch,
  component: TwoFactorPage,
});

function TwoFactorPage() {
  const { t } = useLingui();
  const { next } = Route.useSearch();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const errorText = useErrorText();
  const [backup, setBackup] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();

  const router = useRouter();
  const done = async () => {
    await qc.invalidateQueries({ queryKey: keys.me });
    // `next` may carry a #fragment (an invite link), so it goes to history as a whole href.
    router.history.push(next ?? '/');
  };
  const describe = (e: unknown) => {
    if (isApiError(e) && e.code === 'rate_limited')
      return t`Too many attempts. Wait a minute and try again.`;
    if (isApiError(e) && e.authCode?.includes('COOKIE'))
      return t`This sign-in timed out. Start again from the sign-in page.`;
    if (isApiError(e) && (e.status === 400 || e.status === 401))
      return backup
        ? t`That backup code didn't work. Each one works only once.`
        : t`That code didn't match. Try the newest one your app shows.`;
    return errorText(e);
  };
  const verify = useMutation({
    mutationFn: () => (backup ? verifyBackupCode(code) : verifyTotp(code)),
    onSuccess: done,
    onError: (e) => setError(describe(e)),
  });
  const passkey = useMutation({
    mutationFn: signInWithPasskey,
    onSuccess: done,
    onError: (e) =>
      setError(
        e instanceof PasskeyCancelled
          ? t`Passkey sign-in was cancelled.`
          : t`That passkey couldn't confirm it's you. Use a code instead.`,
      ),
  });

  return (
    <AuthFrame
      title={t`Confirm it's you`}
      intro={
        backup ? (
          <Trans>Enter one of the backup codes you saved when you turned on two-factor.</Trans>
        ) : (
          <Trans>Enter the 6-digit code from your authenticator app.</Trans>
        )
      }
    >
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          const clean = code.replace(/\s/g, '');
          if (!backup && !/^\d{6}$/.test(clean)) return setFieldError(t`Enter the 6 digits.`);
          if (backup && clean.length < 6) return setFieldError(t`Enter a backup code.`);
          verify.mutate();
        }}
      >
        <TextField
          key={backup ? 'backup' : 'totp'}
          label={backup ? t`Backup code` : t`6-digit code`}
          value={code}
          onChange={(v) => {
            setCode(backup ? v : v.replace(/[^\d\s]/g, ''));
            setFieldError(undefined);
          }}
          isInvalid={!!fieldError}
          errorMessage={fieldError}
          autoFocus
          inputProps={{
            dir: 'ltr',
            inputMode: backup ? 'text' : 'numeric',
            autoComplete: 'one-time-code',
            autoCapitalize: 'none',
            spellCheck: false,
          }}
        />
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Button type="submit" isPending={verify.isPending}>
          <Trans>Continue</Trans>
        </Button>
      </form>
      <div className="grid gap-2">
        <Button
          variant="ghost"
          onPress={() => {
            setBackup(!backup);
            setCode('');
            setError(null);
            setFieldError(undefined);
          }}
        >
          {backup ? (
            <Trans>Use my authenticator app instead</Trans>
          ) : (
            <Trans>Use a backup code instead</Trans>
          )}
        </Button>
        {passkeysSupported() ? (
          <Button
            variant="secondary"
            isPending={passkey.isPending}
            onPress={() => passkey.mutate()}
          >
            <KeyIcon />
            <Trans>Use a passkey</Trans>
          </Button>
        ) : null}
        <Button
          variant="ghost"
          onPress={async () => {
            try {
              await signOut();
            } catch {
              // Nothing to end.
            }
            qc.clear();
            void navigate({ to: '/signin' });
          }}
        >
          <Trans>Sign in as someone else</Trans>
        </Button>
      </div>
    </AuthFrame>
  );
}
