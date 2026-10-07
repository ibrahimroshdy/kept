/**
 * Accept invite (screens §5, D33, D127, D181, D190). `/invite#<token>`: the token stays in the
 * fragment and is spent by POST. Shows the location, who invited you, the role and any end
 * date. Signed in: Join. Signed out: create an account, the only way in while sign-up is closed;
 * the account is created and the invite consumed in one step (D190). Or sign in and come back.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate, useRouterState } from '@tanstack/react-router';
import { useState } from 'react';
import { signInWithPassword } from '@/api/auth';
import { isApiError } from '@/api/client';
import { acceptInvite } from '@/api/locations';
import { useInvitePreview, useMe } from '@/api/queries';
import type { AcceptInviteBody, InvitePreview } from '@/api/types';
import { AuthFrame } from '@/components/auth-frame';
import { ClockIcon } from '@/components/icons';
import { KindIcon } from '@/components/kind-icon';
import { OidcSignInButton, useOidcName } from '@/components/oidc-sign-in';
import { LinkButton, LoadingRows, Notice, Pill, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { PasswordField } from '@/components/ui/password-field';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { sep, useFormat } from '@/lib/format';
import { tokenFromHash } from '@/lib/fragment';
import { useKindLabels, useRoleLabels } from '@/lib/labels';

export const Route = createFileRoute('/invite')({ component: AcceptInvitePage });

function AcceptInvitePage() {
  const { t } = useLingui();
  // Read once: the fragment is cleared from the address bar after it's spent.
  const hash = useRouterState({ select: (s) => s.location.hash });
  const [token] = useState(() => tokenFromHash(hash));
  const preview = useInvitePreview(token);

  if (!token)
    return (
      <AuthFrame
        title={t`This invite link is incomplete`}
        intro={
          <Trans>
            The link is missing its code. Open it straight from the message, or scan the QR code
            again.
          </Trans>
        }
      >
        {null}
      </AuthFrame>
    );
  if (preview.isPending)
    return (
      <AuthFrame title={t`Invite`}>
        <LoadingRows rows={2} label={t`Loading the invite`} />
      </AuthFrame>
    );
  if (preview.error) {
    const gone =
      isApiError(preview.error) &&
      (preview.error.code === 'invite_invalid' || preview.error.code === 'not_found');
    return (
      <AuthFrame
        title={gone ? t`This invite no longer works` : t`Couldn't open this invite`}
        intro={
          gone ? (
            <Trans>
              It was used, revoked, or it's more than 7 days old. Ask the person who sent it for a
              new one.
            </Trans>
          ) : undefined
        }
        footer={
          <LinkButton to="/" variant="secondary">
            <Trans>Go to Kept</Trans>
          </LinkButton>
        }
      >
        {gone ? null : <ErrorText error={preview.error} />}
      </AuthFrame>
    );
  }
  return <InviteBody token={token} invite={preview.data} />;
}

function ErrorText({ error }: { error: unknown }) {
  const text = useErrorText();
  return <Notice tone="danger">{text(error)}</Notice>;
}

function InviteBody({ token, invite }: { token: string; invite: InvitePreview }) {
  const { t } = useLingui();
  const me = useMe();
  const kinds = useKindLabels();
  const roles = useRoleLabels();
  const f = useFormat();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const errorText = useErrorText();
  const [creating, setCreating] = useState(false);
  const name = invite.location.name;
  const inviter = invite.inviterName;
  const role = roles.one[invite.role];
  const until = invite.membershipExpiresAt ? f.day(invite.membershipExpiresAt) : null;
  const signedIn = !!me.data;
  // Step 6 (T22, D127): an invited person may join with the server's OIDC provider instead.
  const oidcName = useOidcName();

  const join = useMutation({
    mutationFn: async (body: AcceptInviteBody) => {
      const r = await acceptInvite(token, body);
      if (!('next' in r) || !body.newAccount) return r;
      // A new account joins but isn't signed in (202 `{next: 'sign-in'}`, which is the same
      // answer when the address already had an account). Sign in now, then accept again: for an
      // address that already had an account, that is what joins it.
      let signedIn: Awaited<ReturnType<typeof signInWithPassword>>;
      try {
        signedIn = await signInWithPassword(body.newAccount.email, body.newAccount.password);
      } catch {
        return 'sign-in' as const;
      }
      if ('twoFactorRedirect' in signedIn && signedIn.twoFactorRedirect)
        return 'two-factor' as const;
      try {
        return await acceptInvite(token, {});
      } catch {
        // Already spent by the sign-up itself: the new account is in.
        return 'home' as const;
      }
    },
    onSuccess: async (r) => {
      await qc.invalidateQueries();
      if (r === 'two-factor') {
        // Keep the token: after the second factor the person comes back here and joins.
        return void navigate({ to: '/signin/two-factor', search: { next: `/invite#${token}` } });
      }
      history.replaceState(null, '', location.pathname);
      if (r === 'home') return void navigate({ to: '/' });
      if (r === 'sign-in') {
        toast({ title: t`Your account is ready. Sign in to continue.`, tone: 'ok' });
        return void navigate({ to: '/signin', search: { next: `/invite#${token}` } });
      }
      if ('locationId' in r) void navigate({ to: '/loc/$id', params: { id: r.locationId } });
    },
  });
  const failed = join.error;
  const gone = failed && isApiError(failed) && failed.code === 'invite_invalid';

  const header = (
    <div className="grid justify-items-center gap-2 rounded-[10px] border border-line bg-sunken px-4 py-6 text-center">
      <span className="grid size-14 place-items-center rounded-2xl bg-surface text-ink-2 [&_svg]:size-7">
        <KindIcon kind={invite.location.kind} />
      </span>
      <div className="text-small text-ink-2">
        <Trans>{inviter} invites you to</Trans>
      </div>
      <div className="font-semibold text-[24px] leading-tight text-ink">{name}</div>
      <div className="text-ink-2">
        {kinds[invite.location.kind]}
        {sep()}
        {role}
      </div>
      {until ? (
        <Pill tone="warn" icon={<ClockIcon />}>
          <Trans>
            {role} until {until}
          </Trans>
        </Pill>
      ) : null}
    </div>
  );

  if (invite.alreadyMemberLocationId)
    return (
      <AuthFrame
        title={t`You're already in ${name}`}
        footer={
          <LinkButton
            to="/loc/$id"
            params={{ id: invite.alreadyMemberLocationId }}
            variant="primary"
          >
            <Trans>Open {name}</Trans>
          </LinkButton>
        }
      >
        {header}
      </AuthFrame>
    );

  return (
    <AuthFrame title={t`Invite`}>
      {header}
      <p className="m-0 text-ink-2">{roles.what[invite.role]}</p>
      {invite.require2fa ? (
        <Notice tone="info">
          <Trans>
            {name} asks for two-factor. You can join now; it stays hidden until you add a passkey or
            an authenticator app.
          </Trans>
        </Notice>
      ) : null}
      {invite.emailBound ? (
        <Notice tone="info">
          <Trans>This invite is for one email address: join with that address.</Trans>
        </Notice>
      ) : null}
      {failed ? (
        <Notice tone="danger">
          {gone ? (
            <Trans>This invite no longer works. Ask {inviter} for a new one.</Trans>
          ) : (
            errorText(failed)
          )}
        </Notice>
      ) : null}
      {signedIn ? (
        <Button isPending={join.isPending} onPress={() => join.mutate({})}>
          <Trans>Join {name}</Trans>
        </Button>
      ) : creating ? (
        <NewAccountForm
          pending={join.isPending}
          onBack={() => setCreating(false)}
          onSubmit={(account) => join.mutate({ newAccount: account })}
        />
      ) : (
        <div className="grid gap-2">
          <Button onPress={() => setCreating(true)}>
            <Trans>Create an account and join</Trans>
          </Button>
          {oidcName ? (
            <OidcSignInButton
              name={oidcName}
              next={`/invite#${token}`}
              inviteToken={token}
              label={
                <Trans>
                  Join with <bdi>{oidcName}</bdi>
                </Trans>
              }
            />
          ) : null}
          <LinkButton to="/signin" search={{ next: `/invite#${token}` }} variant="secondary">
            <Trans>I have an account: sign in</Trans>
          </LinkButton>
          <p className="m-0 text-center text-small text-ink-3">
            <Trans>
              Sign-up is closed on this server, and this invite is your way in. It works once.
            </Trans>
          </p>
        </div>
      )}
    </AuthFrame>
  );
}

function NewAccountForm({
  pending,
  onBack,
  onSubmit,
}: {
  pending: boolean;
  onBack: () => void;
  onSubmit: (a: { displayName: string; email: string; password: string }) => void;
}) {
  const { t } = useLingui();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tried, setTried] = useState(false);
  const errors = {
    name: !displayName.trim() ? t`Enter your name.` : undefined,
    email: !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
      ? t`Enter an email address, like name@example.com.`
      : undefined,
    password: password.length < 8 ? t`At least 8 characters.` : undefined,
  };
  const show = (k: keyof typeof errors) => (tried ? errors[k] : undefined);
  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (errors.name || errors.email || errors.password) return;
        onSubmit({ displayName: displayName.trim(), email: email.trim(), password });
      }}
    >
      <TextField
        label={t`Your name`}
        value={displayName}
        onChange={setDisplayName}
        isInvalid={!!show('name')}
        errorMessage={show('name')}
        autoComplete="name"
        autoFocus
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
        description={t`At least 8 characters.`}
      />
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onPress={onBack}>
          <Trans>Back</Trans>
        </Button>
        <Button type="submit" isPending={pending}>
          <Trans>Create account and join</Trans>
        </Button>
      </div>
    </form>
  );
}
