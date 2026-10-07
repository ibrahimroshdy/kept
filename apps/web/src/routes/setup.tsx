/**
 * First-run setup (screens §6, §8, D32, D190, D193): setup code → first account → instance
 * options → Finish setup. Three steps; the recovery-kit acknowledgement no longer blocks Finish
 * (D193): the status page asks for it. The code is 6 Crockford characters from the server's
 * logs (`KEPT SETUP CODE: XXX-XXX`); the dash is optional and case doesn't matter.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { completeSetup, getSetupStatus } from '@/api/account';
import { putAdminSettings } from '@/api/admin';
import { signInWithPassword } from '@/api/auth';
import { isApiError } from '@/api/client';
import { keys, useSetupStatus } from '@/api/queries';
import { AuthFrame, type FrameStep, StepCounter } from '@/components/auth-frame';
import { ErrorState, LoadingRows, Notice, useErrorText } from '@/components/page';
import { SetupCodeHelp } from '@/components/setup-code-help';
import { Button } from '@/components/ui/button';
import { PasswordField } from '@/components/ui/password-field';
import { Switch } from '@/components/ui/switch';
import { TextField } from '@/components/ui/text-field';

export const Route = createFileRoute('/setup')({
  // Already set up: nothing to do here. Checked once on entry, so finishing setup on this page
  // doesn't bounce the person away mid-flow.
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient
      .ensureQueryData({ queryKey: keys.setup, queryFn: getSetupStatus })
      .catch(() => null);
    if (status && !status.needed) throw redirect({ to: '/', replace: true });
  },
  component: SetupPage,
});

/** Crockford base32 without the dash: 0-9 and A-Z minus I, L, O, U. */
const CODE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}$/;
const normaliseCode = (raw: string) =>
  raw.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');

function SetupPage() {
  const status = useSetupStatus();
  const [step, setStep] = useState(1);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | undefined>();
  const { t } = useLingui();

  const labels = [t`Setup code`, t`First account`, t`Instance options`];
  const steps: FrameStep[] = labels.map((label, i) => ({
    label,
    state: i + 1 < step ? 'done' : i + 1 === step ? 'current' : 'todo',
  }));
  const eyebrow = <StepCounter current={step} total={3} />;

  if (status.isPending)
    return (
      <AuthFrame title={t`Set up this Kept`} steps={steps} railTitle={t`Set up this Kept`}>
        <LoadingRows rows={2} />
      </AuthFrame>
    );
  if (status.error)
    return (
      <AuthFrame title={t`Set up this Kept`}>
        <ErrorState error={status.error} onRetry={() => void status.refetch()} />
      </AuthFrame>
    );
  if (step === 1)
    return (
      <CodeStep
        steps={steps}
        eyebrow={eyebrow}
        code={code}
        error={codeError}
        onChange={(v) => {
          setCode(v);
          setCodeError(undefined);
        }}
        onNext={() => {
          if (!CODE.test(normaliseCode(code)))
            return setCodeError(t`The code is 6 letters and digits, like K7Q-2M9.`);
          setStep(2);
        }}
      />
    );
  if (step === 2)
    return (
      <AccountStep
        steps={steps}
        eyebrow={eyebrow}
        code={normaliseCode(code)}
        onBack={() => setStep(1)}
        onBadCode={() => {
          setCodeError(t`That setup code isn't right. Check the server's logs.`);
          setStep(1);
        }}
        onDone={() => setStep(3)}
      />
    );
  return <OptionsStep steps={steps} eyebrow={eyebrow} />;
}

type StepProps = { steps: FrameStep[]; eyebrow: React.ReactNode };

function CodeStep({
  steps,
  eyebrow,
  code,
  error,
  onChange,
  onNext,
}: StepProps & {
  code: string;
  error: string | undefined;
  onChange: (v: string) => void;
  onNext: () => void;
}) {
  const { t } = useLingui();
  return (
    <AuthFrame
      title={t`Enter the setup code`}
      eyebrow={eyebrow}
      steps={steps}
      railTitle={t`Set up this Kept`}
      intro={
        <Trans>
          When Kept started for the first time, it printed a one-time setup code in the server's
          logs. Entering it shows you're the person who installed this server. The code stops
          working once it's used.
        </Trans>
      }
    >
      <form
        id="setup-code"
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          onNext();
        }}
      >
        <SetupCodeHelp />
        <TextField
          label={t`Setup code`}
          value={code}
          onChange={onChange}
          isInvalid={!!error}
          errorMessage={error}
          autoFocus
          maxLength={9}
          description={
            <Trans>
              6 characters, printed as{' '}
              <code className="ltr whitespace-nowrap">KEPT SETUP CODE: K7Q-2M9</code>. The dash is
              optional; case doesn't matter.
            </Trans>
          }
          inputProps={{
            dir: 'ltr',
            autoCapitalize: 'characters',
            autoComplete: 'off',
            spellCheck: false,
          }}
        />
        <Notice tone="info">
          <Trans>
            Until setup is finished, anyone who can open this address could try to claim the server.
            Finish it now.
          </Trans>
        </Notice>
      </form>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <span className="text-small text-ink-3">
          <Trans>
            Lost the logs? Issue a new one with{' '}
            <code className="ltr whitespace-nowrap">kept admin setup-code</code>.
          </Trans>
        </span>
        <Button type="submit" form="setup-code">
          <Trans>Continue</Trans>
        </Button>
      </div>
    </AuthFrame>
  );
}

function AccountStep({
  steps,
  eyebrow,
  code,
  onBack,
  onBadCode,
  onDone,
}: StepProps & {
  code: string;
  onBack: () => void;
  onBadCode: () => void;
  onDone: () => void;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tried, setTried] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const errors = {
    name: !displayName.trim() ? t`Enter your name.` : undefined,
    email: !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
      ? t`Enter an email address, like name@example.com.`
      : undefined,
    password: password.length < 8 ? t`At least 8 characters.` : undefined,
  };
  const create = useMutation({
    mutationFn: async () => {
      await completeSetup({
        // Canonical form: 6 characters, upper case, no dash (the server normalises too).
        code,
        email: email.trim(),
        password,
        displayName: displayName.trim(),
      });
      await signInWithPassword(email.trim(), password);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.setup });
      await qc.invalidateQueries({ queryKey: keys.me });
      onDone();
    },
    onError: (e) => {
      if (isApiError(e) && e.code === 'setup_code_invalid') return onBadCode();
      if (isApiError(e) && e.code === 'conflict')
        return setFormError(t`This Kept is already set up. Sign in instead.`);
      setFormError(errorText(e));
    },
  });
  const show = (k: keyof typeof errors) => (tried ? errors[k] : undefined);
  return (
    <AuthFrame
      title={t`Create the first account`}
      eyebrow={eyebrow}
      steps={steps}
      railTitle={t`Set up this Kept`}
      intro={
        <Trans>
          This account runs the server: users, sign-up and backups. It can't see inside anyone's
          home unless they invite it.
        </Trans>
      }
    >
      <form
        id="setup-account"
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          setFormError(null);
          if (errors.name || errors.email || errors.password) return;
          create.mutate();
        }}
      >
        <TextField
          label={t`Your name`}
          value={displayName}
          onChange={setDisplayName}
          isInvalid={!!show('name')}
          errorMessage={show('name')}
          autoFocus
          autoComplete="name"
        />
        <TextField
          label={t`Email`}
          type="email"
          value={email}
          onChange={setEmail}
          isInvalid={!!show('email')}
          errorMessage={show('email')}
          autoComplete="email"
          inputProps={{ dir: 'ltr' }}
        />
        <PasswordField
          label={t`Password`}
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
          isInvalid={!!show('password')}
          errorMessage={show('password')}
          description={t`At least 8 characters. A few unrelated words is easy to remember.`}
        />
        {formError ? <Notice tone="danger">{formError}</Notice> : null}
      </form>
      <div className="flex items-center justify-end gap-2 border-t border-line pt-4">
        <Button variant="secondary" onPress={onBack}>
          <Trans>Back</Trans>
        </Button>
        <Button type="submit" form="setup-account" isPending={create.isPending}>
          <Trans>Create account</Trans>
        </Button>
      </div>
    </AuthFrame>
  );
}

function OptionsStep({ steps, eyebrow }: StepProps) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const navigate = useNavigate();
  const [signupOpen, setSignupOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const finish = useMutation({
    mutationFn: () => putAdminSettings({ signupOpen }),
    onSuccess: () => void navigate({ to: '/' }),
    onError: (e) => setError(errorText(e)),
  });
  return (
    <AuthFrame
      title={t`How should this Kept work?`}
      eyebrow={eyebrow}
      steps={steps}
      railTitle={t`Set up this Kept`}
      intro={<Trans>You can change these any time in Settings → Admin.</Trans>}
    >
      <div className="grid gap-3">
        <div className="rounded-[10px] border border-line bg-surface px-3.5 py-2">
          <Switch
            isSelected={signupOpen}
            onChange={setSignupOpen}
            className="w-full flex-row-reverse justify-between"
          >
            <span className="grid gap-0.5 py-1">
              <span className="font-semibold">
                <Trans>Let anyone with the address create an account</Trans>
              </span>
              <span className="text-small text-ink-3">
                <Trans>
                  Off is right for a household: people join through an invite, or you add them.
                </Trans>
              </span>
            </span>
          </Switch>
        </div>
        <Notice tone="info">
          <Trans>
            AI and barcode lookup can be connected later, from Settings. Kept works without them.
          </Trans>
        </Notice>
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-line pt-4">
        <Button isPending={finish.isPending} onPress={() => finish.mutate()}>
          <Trans>Finish setup</Trans>
        </Button>
      </div>
    </AuthFrame>
  );
}
