/**
 * "I have a one-time code" (D47, D164): a managed account's first sign-in, or after its admin
 * reset it. The admin never learns the password: the person sets it here with the code, then
 * is signed in with it.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { redeemResetCode, signInWithPassword } from '@/api/auth';
import { isApiError } from '@/api/client';
import { keys } from '@/api/queries';
import { AuthFrame } from '@/components/auth-frame';
import { LinkButton, Notice, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { PasswordField } from '@/components/ui/password-field';
import { TextField } from '@/components/ui/text-field';

export const Route = createFileRoute('/signin/code')({ component: CodePage });

function CodePage() {
  const { t } = useLingui();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const errorText = useErrorText();
  const [username, setUsername] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errors = {
    username: username.trim() ? undefined : t`Enter your username.`,
    code: code.replace(/[\s-]/g, '').length === 8 ? undefined : t`The code is 8 characters.`,
    password: password.length < 8 ? t`At least 8 characters.` : undefined,
  };
  const show = (k: keyof typeof errors) => (tried ? errors[k] : undefined);
  const redeem = useMutation({
    mutationFn: async () => {
      await redeemResetCode(username, code, password);
      return signInWithPassword(username, password);
    },
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: keys.me });
      if ('twoFactorRedirect' in r && r.twoFactorRedirect)
        return void navigate({ to: '/signin/two-factor' });
      void navigate({ to: '/' });
    },
    onError: (e) =>
      setError(
        isApiError(e) && (e.status === 400 || e.status === 401)
          ? t`That username and code don't match, or the code has expired. Ask for a new one.`
          : errorText(e),
      ),
  });
  return (
    <AuthFrame
      title={t`Sign in with a one-time code`}
      intro={
        <Trans>
          For an account someone made for you. Enter your username and the code they gave you, then
          choose your password. The code works once.
        </Trans>
      }
    >
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          setError(null);
          if (errors.username || errors.code || errors.password) return;
          redeem.mutate();
        }}
      >
        <TextField
          label={t`Username`}
          value={username}
          onChange={setUsername}
          isInvalid={!!show('username')}
          errorMessage={show('username')}
          autoComplete="username"
          autoFocus
          inputProps={{ dir: 'ltr', autoCapitalize: 'none', spellCheck: false }}
        />
        <TextField
          label={t`One-time code`}
          value={code}
          onChange={(v) => setCode(v.toUpperCase())}
          isInvalid={!!show('code')}
          errorMessage={show('code')}
          inputProps={{ dir: 'ltr', autoComplete: 'one-time-code', spellCheck: false }}
        />
        <PasswordField
          label={t`New password`}
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
          isInvalid={!!show('password')}
          errorMessage={show('password')}
          description={t`At least 8 characters. A few unrelated words is easy to remember.`}
        />
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Button type="submit" isPending={redeem.isPending}>
          <Trans>Set password and sign in</Trans>
        </Button>
      </form>
      <LinkButton to="/signin" variant="ghost">
        <Trans>Back to sign in</Trans>
      </LinkButton>
    </AuthFrame>
  );
}
