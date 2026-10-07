/**
 * The links of an email change (D176, D181). The first goes to the current address; confirming
 * it mails the second to the new address, whose confirmation changes the email and signs out
 * every other session. The token is in the #fragment, never sent to the server by the browser,
 * and nothing is spent on load: a mail scanner that fetches the link only gets this page. The
 * page works signed in or out (the token is the permission).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useRouterState } from '@tanstack/react-router';
import { useState } from 'react';
import { confirmEmailChange } from '@/api/auth';
import { isApiError } from '@/api/client';
import { keys } from '@/api/queries';
import { AuthFrame } from '@/components/auth-frame';
import { LinkButton, Notice, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { tokenFromHash } from '@/lib/fragment';

export const Route = createFileRoute('/auth/email-change')({ component: EmailChangePage });

function EmailChangePage() {
  const { t } = useLingui();
  const qc = useQueryClient();
  const errorText = useErrorText();
  // Read once: the fragment is cleared from the address bar after it's spent.
  const hash = useRouterState({ select: (s) => s.location.hash });
  const [token] = useState(() => tokenFromHash(hash));
  const confirm = useMutation({
    mutationFn: async () => {
      if (!token) throw new Error('no token');
      const { stage } = await confirmEmailChange(token);
      history.replaceState(null, '', location.pathname);
      return stage;
    },
    onSuccess: async (stage) => {
      if (stage === 'done') await qc.invalidateQueries({ queryKey: keys.me });
    },
  });

  if (!token)
    return (
      <AuthFrame
        title={t`This link is incomplete`}
        intro={
          <Trans>
            The email-change link is missing its code. Open it straight from the email, or start
            again from Settings.
          </Trans>
        }
        footer={
          <LinkButton to="/settings" variant="primary">
            <Trans>Go to Settings</Trans>
          </LinkButton>
        }
      >
        {null}
      </AuthFrame>
    );

  if (confirm.data === 'verify_new' || confirm.data === 'confirm_old')
    return (
      <AuthFrame
        title={t`Now check your new inbox`}
        intro={
          <Trans>
            Your current address confirmed the change. We sent a link to the new address: open it to
            finish. It works once, for an hour. Until then, you sign in with your current address.
          </Trans>
        }
      >
        {null}
      </AuthFrame>
    );

  if (confirm.data === 'done')
    return (
      <AuthFrame
        title={t`Your email address changed`}
        intro={
          <Trans>
            Sign in with the new address from now on. Every other device was signed out, and your
            old address was told about the change.
          </Trans>
        }
        footer={
          <LinkButton to="/" variant="primary">
            <Trans>Open Kept</Trans>
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
    (failed.code === 'token_invalid' || failed.status === 400 || failed.status === 404);
  return (
    <AuthFrame
      title={t`Confirm the email change`}
      intro={
        <Trans>
          You opened a link to change the email address you sign in with. Confirm it here.
        </Trans>
      }
    >
      {failed ? (
        <Notice
          tone="danger"
          title={expired ? <Trans>This link no longer works</Trans> : undefined}
        >
          {expired ? (
            <Trans>
              Email-change links work once, for an hour.{' '}
              <Link to="/settings" className="underline">
                Start again from Settings
              </Link>
              .
            </Trans>
          ) : (
            errorText(failed)
          )}
        </Notice>
      ) : null}
      <Button isPending={confirm.isPending} isDisabled={!!expired} onPress={() => confirm.mutate()}>
        <Trans>Confirm</Trans>
      </Button>
    </AuthFrame>
  );
}
