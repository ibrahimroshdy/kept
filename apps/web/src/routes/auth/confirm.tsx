/**
 * Magic-link confirm (task 17, D176, D181). The emailed link opens this page with the token in
 * the #fragment, which never reaches the server. Nothing happens on load: a mail scanner that
 * fetches the link only gets this page. The token is spent by the POST behind the button.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { useState } from 'react';
import { getMe } from '@/api/account';
import { confirmMagicLink } from '@/api/auth';
import { isApiError } from '@/api/client';
import { keys } from '@/api/queries';
import { AuthFrame } from '@/components/auth-frame';
import { LinkButton, Notice, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { tokenFromHash } from '@/lib/fragment';

export const Route = createFileRoute('/auth/confirm')({ component: ConfirmPage });

function ConfirmPage() {
  const { t } = useLingui();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const errorText = useErrorText();
  // Read once: the fragment is cleared from the address bar after it's spent.
  const hash = useRouterState({ select: (s) => s.location.hash });
  const [token] = useState(() => tokenFromHash(hash));
  const confirm = useMutation({
    mutationFn: async () => {
      if (!token) throw new Error('no token');
      const { mfaRequired } = await confirmMagicLink(token);
      // Take the token out of the address bar and history as soon as it's spent.
      history.replaceState(null, '', location.pathname);
      if (mfaRequired) return 'mfa' as const;
      try {
        return await getMe();
      } catch (e) {
        if (isApiError(e) && e.code === 'mfa_required') return 'mfa' as const;
        throw e;
      }
    },
    onSuccess: async (result) => {
      await qc.invalidateQueries({ queryKey: keys.me });
      if (result === 'mfa') void navigate({ to: '/signin/two-factor' });
      else void navigate({ to: '/' });
    },
  });

  if (!token)
    return (
      <AuthFrame
        title={t`This link is incomplete`}
        intro={
          <Trans>
            The sign-in link is missing its code. Open it straight from the email, or ask for a new
            one.
          </Trans>
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

  const failed = confirm.error;
  const expired =
    failed &&
    isApiError(failed) &&
    (failed.status === 400 || failed.status === 401 || failed.status === 404);
  return (
    <AuthFrame
      title={t`Sign in to Kept`}
      intro={<Trans>You opened a sign-in link. Continue to sign in on this device.</Trans>}
    >
      {failed ? (
        <Notice
          tone="danger"
          title={expired ? <Trans>This link no longer works</Trans> : undefined}
        >
          {expired ? (
            <Trans>
              Sign-in links work once, for 5 minutes.{' '}
              <Link to="/signin" className="underline">
                Ask for a new one
              </Link>
              .
            </Trans>
          ) : (
            errorText(failed)
          )}
        </Notice>
      ) : null}
      <Button isPending={confirm.isPending} isDisabled={!!expired} onPress={() => confirm.mutate()}>
        <Trans>Continue</Trans>
      </Button>
    </AuthFrame>
  );
}
