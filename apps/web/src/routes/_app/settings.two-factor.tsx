/**
 * Two-factor enrolment (D176): confirm the password, scan the QR code (drawn here from the
 * otpauth URI; the secret never leaves this page), prove one code, then keep the backup codes.
 * Two-factor is on only after the code is proven. Kept never offers "trust this device" (S2).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { enableTwoFactor, requestMagicLink, verifyTotp } from '@/api/auth';
import { isApiError } from '@/api/client';
import { keys, useMe } from '@/api/queries';
import type { TwoFactorEnableResult } from '@/api/types';
import { StepCounter } from '@/components/auth-frame';
import { TwoFactorRouteError } from '@/components/on-demand-route-error';
import { Notice, Page, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { PasswordField } from '@/components/ui/password-field';
import { QrCode } from '@/components/ui/qr-code';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { secretOf } from '@/lib/otp';

export const Route = createFileRoute('/_app/settings/two-factor')({
  component: EnrolPage,
  errorComponent: TwoFactorRouteError,
});

function EnrolPage() {
  const { t } = useLingui();
  const [step, setStep] = useState(1);
  const [enrol, setEnrol] = useState<TwoFactorEnableResult | null>(null);
  return (
    <Page
      title={t`Turn on two-factor`}
      back="/settings"
      actions={
        <span className="eyebrow whitespace-nowrap">
          <StepCounter current={step} total={3} />
        </span>
      }
    >
      {step === 1 ? (
        <PasswordStep
          onDone={(r) => {
            setEnrol(r);
            setStep(2);
          }}
        />
      ) : null}
      {step === 2 && enrol ? <ScanStep uri={enrol.totpURI} onDone={() => setStep(3)} /> : null}
      {step === 3 && enrol ? <BackupCodes codes={enrol.backupCodes} /> : null}
    </Page>
  );
}

/**
 * D197: with mail configured, an account whose address isn't confirmed can't enrol a second
 * factor (403 EMAIL_UNVERIFIED). Confirming it is a magic link, which claims the account: the
 * server removes its password, passkeys and other sessions, so whoever set them up before the
 * owner arrived keeps nothing. Two-factor needs a password, so the person then sets a new one.
 */
function ConfirmAddressFirst() {
  const { t } = useLingui();
  const errorText = useErrorText();
  const me = useMe();
  const email = me.data?.user.email ?? null;
  const send = useMutation({
    mutationFn: () => requestMagicLink(email ?? ''),
    onSuccess: () =>
      toast({ title: t`Sign-in link sent. It works once, for 5 minutes.`, tone: 'ok' }),
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });
  return (
    <Notice tone="warn" title={<Trans>Confirm your email address first</Trans>}>
      <div className="grid gap-3">
        <p className="m-0">
          <Trans>
            Kept emails you a sign-in link; opening it confirms the address. Opening it also removes
            this account's password, passkeys and other sessions, so nobody who set them up before
            you keeps a way in. Two-factor needs a password, so afterwards set a new one with
            “Forgot your password?” on the sign-in page, then come back here.
          </Trans>
        </p>
        {email ? (
          <div>
            <Button
              size="small"
              variant="secondary"
              isPending={send.isPending}
              isDisabled={send.isSuccess}
              onPress={() => send.mutate()}
            >
              {send.isSuccess ? <Trans>Link sent</Trans> : <Trans>Email me a sign-in link</Trans>}
            </Button>
          </div>
        ) : null}
      </div>
    </Notice>
  );
}

function PasswordStep({ onDone }: { onDone: (r: TwoFactorEnableResult) => void }) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [unverified, setUnverified] = useState(false);
  const start = useMutation({
    mutationFn: () => enableTwoFactor(password),
    onSuccess: onDone,
    onError: (e) => {
      if (isApiError(e) && e.authCode === 'EMAIL_UNVERIFIED') return setUnverified(true);
      setError(
        isApiError(e) && (e.authCode === 'INVALID_PASSWORD' || e.status === 400)
          ? t`That password isn't right.`
          : errorText(e),
      );
    },
  });
  if (unverified) return <ConfirmAddressFirst />;
  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!password) return setError(t`Enter your password.`);
        start.mutate();
      }}
    >
      <p className="m-0 text-ink-2">
        <Trans>
          After this, signing in asks for a 6-digit code from an authenticator app (1Password,
          Google Authenticator, Aegis…) as well as your password or sign-in link.
        </Trans>
      </p>
      <PasswordField
        label={t`Your password`}
        value={password}
        onChange={(v) => {
          setPassword(v);
          setError(undefined);
        }}
        isInvalid={!!error}
        errorMessage={error}
        autoFocus
      />
      <Button type="submit" isPending={start.isPending}>
        <Trans>Continue</Trans>
      </Button>
    </form>
  );
}

function ScanStep({ uri, onDone }: { uri: string; onDone: () => void }) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | undefined>();
  const secret = secretOf(uri);
  const verify = useMutation({
    mutationFn: () => verifyTotp(code),
    onSuccess: onDone,
    onError: (e) =>
      setError(
        isApiError(e) && (e.status === 400 || e.status === 401)
          ? t`That code didn't match. Check the time on your phone, then try the newest code.`
          : errorText(e),
      ),
  });
  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!/^\d{6}$/.test(code.replace(/\s/g, ''))) return setError(t`Enter the 6 digits.`);
        verify.mutate();
      }}
    >
      <p className="m-0 text-ink-2">
        <Trans>Scan this with your authenticator app, then type the code it shows.</Trans>
      </p>
      <div className="flex flex-wrap items-center gap-4 rounded-[10px] border border-line bg-surface p-3.5">
        <div className="rounded-lg border border-line bg-white p-1.5">
          <QrCode value={uri} label={t`QR code for your authenticator app`} size={168} />
        </div>
        <div className="grid min-w-0 flex-1 basis-44 gap-1.5">
          <div className="eyebrow">
            <Trans>Can't scan it?</Trans>
          </div>
          <div className="text-small text-ink-2">
            <Trans>Enter this key in the app instead:</Trans>
          </div>
          <div className="ltr font-mono text-[15px] font-semibold tracking-[.06em] [overflow-wrap:anywhere]">
            {secret}
          </div>
          <CopyButton text={secret.replace(/\s/g, '')} label={t`Copy key`} size="small" />
        </div>
      </div>
      <TextField
        label={t`6-digit code`}
        value={code}
        onChange={(v) => {
          setCode(v.replace(/[^\d\s]/g, ''));
          setError(undefined);
        }}
        isInvalid={!!error}
        errorMessage={error}
        inputProps={{
          inputMode: 'numeric',
          autoComplete: 'one-time-code',
          dir: 'ltr',
        }}
        maxLength={7}
      />
      <Button type="submit" isPending={verify.isPending}>
        <Trans>Turn on two-factor</Trans>
      </Button>
    </form>
  );
}

function BackupCodes({ codes }: { codes: string[] }) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const navigate = useNavigate();
  return (
    <div className="grid gap-4">
      <Notice tone="ok" title={<Trans>Two-factor is on</Trans>}>
        <Trans>Next time you sign in, Kept asks for a code from your app.</Trans>
      </Notice>
      <div className="grid gap-1">
        <h2 className="m-0 font-semibold text-[18px]">
          <Trans>Keep your backup codes</Trans>
        </h2>
        <p className="m-0 text-ink-2">
          <Trans>
            If you lose your phone, each of these signs you in once. Keep them somewhere other than
            this phone: a password manager or a printed page.
          </Trans>
        </p>
      </div>
      <ul className="ltr m-0 grid list-none grid-cols-2 gap-2 rounded-[10px] border border-line bg-sunken p-3.5 font-mono text-[15px]">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <CopyButton text={codes.join('\n')} label={t`Copy all codes`} className="w-full" />
      <Button
        onPress={async () => {
          await qc.invalidateQueries({ queryKey: keys.me });
          toast({ title: t`Two-factor is on`, tone: 'ok' });
          void navigate({ to: '/settings' });
        }}
      >
        <Trans>I've saved them</Trans>
      </Button>
    </div>
  );
}
