/**
 * Deleting your own account (1.2, D225): Settings → Me → Delete my account, and the screen an
 * account sees for its 30 days before it goes.
 *
 * The sheet first asks the server what stops it (locations it owns besides Personal, being the
 * instance's last admin, a managed account) and lists those with where to go; with nothing in the
 * way it offers Export my data, then asks for the password again (ReauthSheet, D176). After that
 * the account waits: /me says when it goes, and the signed-in frame shows only
 * AccountDeletionPending, with Keep my account and Sign out.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { getAccountDeletion, keepAccount, requestAccountDeletion } from '@/api/account';
import { keys } from '@/api/queries';
import { ReauthSheet } from '@/components/ops/reauth-sheet';
import { ErrorState, LinkButton, Notice, useErrorText } from '@/components/page';
import { useSignOut } from '@/components/sign-out';
import { Button } from '@/components/ui/button';
import { Dialog, DialogFooter, Modal } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { useFormat } from '@/lib/format';

const deletionKey = ['me', 'deletion'] as const;

export function DeleteAccount() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="small" variant="danger" onPress={() => setOpen(true)}>
        <Trans>Delete…</Trans>
      </Button>
      {open ? <DeleteAccountSheet onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function DeleteAccountSheet({ onClose }: { onClose: () => void }) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const state = useQuery({ queryKey: deletionKey, queryFn: getAccountDeletion });

  if (state.isPending || state.error) {
    return (
      <Modal isOpen onOpenChange={(open) => (open ? null : onClose())}>
        <Dialog title={t`Delete your account`}>
          {state.error ? (
            <ErrorState error={state.error} onRetry={() => void state.refetch()} />
          ) : (
            <p className="text-ink-2" role="status">
              <Trans>Checking your account…</Trans>
            </p>
          )}
        </Dialog>
      </Modal>
    );
  }

  const { blockers } = state.data;
  const blocked = blockers.locations.length > 0 || blockers.lastInstanceAdmin || blockers.managed;
  if (blocked) {
    return (
      <Modal isOpen onOpenChange={(open) => (open ? null : onClose())}>
        <Dialog title={t`Your account can't be deleted yet`}>
          <div className="grid gap-3">
            {blockers.managed ? (
              <p>
                <Trans>
                  This account was made for you by someone who runs a location. Ask them to remove
                  it.
                </Trans>
              </p>
            ) : null}
            {blockers.lastInstanceAdmin ? (
              <p>
                <Trans>
                  You're the only person who runs this Kept. Make someone else an instance admin
                  first.
                </Trans>
              </p>
            ) : null}
            {blockers.locations.length > 0 ? (
              <div className="grid gap-2">
                <p>
                  <Trans>
                    You own these locations. Hand each one to someone else, or delete it, first.
                  </Trans>
                </p>
                <ul className="grid gap-1.5">
                  {blockers.locations.map((l) => (
                    <li key={l.id} className="flex items-center justify-between gap-3">
                      <span className="min-w-0 font-semibold [overflow-wrap:anywhere]">
                        {l.name}
                      </span>
                      <LinkButton
                        size="small"
                        to="/settings/location/$id/general"
                        params={{ id: l.id }}
                      >
                        <Trans>Open</Trans>
                      </LinkButton>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="secondary" onPress={onClose}>
              <Trans>Close</Trans>
            </Button>
          </DialogFooter>
        </Dialog>
      </Modal>
    );
  }

  return (
    <ReauthSheet
      title={t`Delete your account`}
      submitLabel={t`Delete my account`}
      submitVariant="danger"
      returnTo="/settings"
      onClose={onClose}
      onSubmit={async (password) => {
        await requestAccountDeletion(password);
        await qc.invalidateQueries({ queryKey: keys.me });
      }}
    >
      <div className="grid gap-3">
        <p>
          <Trans>
            Your account, your Personal location and everything in it are deleted 30 days from now.
            Until then you can sign in and keep the account; nothing else opens.
          </Trans>
        </p>
        <p className="text-ink-2">
          <Trans>
            What you added to other people's locations stays there. Your other devices are signed
            out now.
          </Trans>
        </p>
        <Notice
          tone="info"
          title={<Trans>Keep a copy first?</Trans>}
          action={
            <LinkButton to="/settings/export" search={{ sheet: 'me' }} size="small">
              <Trans>Export my data</Trans>
            </LinkButton>
          }
        >
          <Trans>Your Personal location, profile and preferences, as one file.</Trans>
        </Notice>
      </div>
    </ReauthSheet>
  );
}

/** The whole app for an account waiting to be deleted (D225): the date, Keep, Sign out. */
export function AccountDeletionPending({ purgeAfter }: { purgeAfter: string }) {
  const { t } = useLingui();
  const f = useFormat();
  const qc = useQueryClient();
  const errorText = useErrorText();
  const signOut = useSignOut();
  const [pending, setPending] = useState(false);
  const day = f.longDay(purgeAfter);

  const keep = async () => {
    setPending(true);
    try {
      await keepAccount();
      await qc.invalidateQueries();
      toast({ title: t`Your account stays`, tone: 'ok' });
    } catch (e) {
      toast({ title: errorText(e), tone: 'danger' });
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="grid min-h-dvh place-items-center bg-paper p-4">
      <section
        aria-labelledby="deletion-title"
        className="grid w-full max-w-md gap-4 rounded-[14px] border border-line bg-surface p-5"
      >
        <h1 id="deletion-title" className="font-semibold text-[20px] leading-tight">
          <Trans>Your account will be deleted on {day}</Trans>
        </h1>
        <p className="text-ink-2">
          <Trans>
            You asked for it, with your Personal location and everything in it. Until then nothing
            else in Kept opens. Keep the account to go back to it as it was.
          </Trans>
        </p>
        <div className="grid gap-2">
          <Button isPending={pending} onPress={() => void keep()}>
            <Trans>Keep my account</Trans>
          </Button>
          <Button variant="secondary" onPress={() => void signOut()}>
            <Trans>Sign out</Trans>
          </Button>
        </div>
      </section>
    </main>
  );
}
