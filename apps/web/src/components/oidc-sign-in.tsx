/**
 * "Sign in with <name>" (step 6 T16/T22; D127, D176, spike S6.7): shown only when the server says
 * a generic OIDC provider is configured (`GET /setup`'s `oidc`), and "Sign in with Google" when
 * Google is (`google`, 1.2, D226). It reaches only an account that
 * is already linked to that sign-in, or an invited person (the invite's token travels with it);
 * Kept never joins accounts because their email matches (D176). Back from the provider, Kept
 * lands on `next`, or on /signin with `?error=<code>`, which `OidcError` puts in words.
 */
import { Trans } from '@lingui/react/macro';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { getSetupStatus } from '@/api/account';
import { GOOGLE_PROVIDER_ID, type OutsideProvider, startOidcSignIn } from '@/api/auth';
import { keys } from '@/api/queries';
import { KeyIcon } from '@/components/icons';
import { Notice, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { leave } from '@/lib/leave';

/** The configured provider's name, or null when OIDC is off (or the server predates it). */
export function useOidcName(): string | null {
  const setup = useQuery({ queryKey: keys.setup, queryFn: getSetupStatus });
  return setup.data?.oidc?.name ?? null;
}

/** Whether "Sign in with Google" is offered (1.2, D226). */
export function useGoogleOn(): boolean {
  const setup = useQuery({ queryKey: keys.setup, queryFn: getSetupStatus });
  return setup.data?.google === true;
}

/** The sign-in page's address for a failed outside sign-in, keeping where the person was going,
 * and `via=google` so the page names Google rather than the OIDC provider. */
export function oidcErrorPath(next?: string, provider?: OutsideProvider): string {
  const q = new URLSearchParams();
  if (next) q.set('next', next);
  if (provider === GOOGLE_PROVIDER_ID) q.set('via', GOOGLE_PROVIDER_ID);
  const s = q.toString();
  return s ? `/signin?${s}` : '/signin';
}

export function OidcSignInButton({
  provider,
  name,
  next,
  inviteToken,
  label,
}: {
  /** Default: the instance's OIDC provider. */
  provider?: OutsideProvider;
  name: string;
  /** Where to land after signing in (a same-app path). */
  next?: string;
  inviteToken?: string;
  /** The button's words; default "Sign in with <name>". */
  label?: ReactNode;
}) {
  const errorText = useErrorText();
  const start = useMutation({
    mutationFn: () =>
      startOidcSignIn({
        ...(provider ? { provider } : {}),
        callbackURL: next ?? '/',
        errorCallbackURL: oidcErrorPath(next, provider),
        ...(inviteToken ? { inviteToken } : {}),
      }),
    onSuccess: ({ url }) => leave.to(url),
  });
  return (
    <div className="grid gap-2">
      <Button variant="secondary" isPending={start.isPending} onPress={() => start.mutate()}>
        <KeyIcon />
        {label ?? (
          <Trans>
            Sign in with <bdi>{name}</bdi>
          </Trans>
        )}
      </Button>
      {start.error ? <Notice tone="danger">{errorText(start.error)}</Notice> : null}
    </div>
  );
}

/**
 * What a failed OIDC sign-in's `?error=` means (the codes the spike found Kept's rules and Better
 * Auth answer with), in words; "account not linked" explains invites (D127).
 */
export function OidcError({ code, name }: { code: string; name: string | null }) {
  const who = name ?? 'OIDC';
  switch (code) {
    case 'account_not_linked':
      return (
        <Notice tone="warn" title={<Trans>No Kept account uses that sign-in yet</Trans>}>
          <Trans>
            Kept never matches accounts by their email. If you're new here, open the invite someone
            sent you and join with <bdi>{who}</bdi> from there. If you already have an account, sign
            in another way.
          </Trans>
        </Notice>
      );
    case 'signup_closed':
      return (
        <Notice tone="warn" title={<Trans>There's no account for you here yet</Trans>}>
          <Trans>
            This Kept lets people in by invite. Ask someone who uses it to invite you, then join
            from the invite link.
          </Trans>
        </Notice>
      );
    case 'email_unverified':
      return (
        <Notice tone="warn" title={<Trans>Your email isn't confirmed</Trans>}>
          <Trans>
            <bdi>{who}</bdi> hasn't confirmed your email address, so Kept can't use it. Confirm it
            there, then try again.
          </Trans>
        </Notice>
      );
    case 'email_undeliverable':
      return (
        <Notice tone="warn" title={<Trans>That email address can't be used</Trans>}>
          <Trans>Kept needs an address that can receive mail for an account.</Trans>
        </Notice>
      );
    case 'invite_email_mismatch':
    case 'email_does_not_match':
      return (
        <Notice tone="warn" title={<Trans>The email addresses don't match</Trans>}>
          <Trans>
            The email on your <bdi>{who}</bdi> account isn't the one this invite or account is for.
          </Trans>
        </Notice>
      );
    default:
      return (
        <Notice
          tone="danger"
          title={
            <Trans>
              Signing in with <bdi>{who}</bdi> didn't work
            </Trans>
          }
        >
          <Trans>
            Try again, or sign in another way. The reason it gave:{' '}
            <code dir="ltr" className="font-mono">
              {code}
            </code>
          </Trans>
        </Notice>
      );
  }
}
