import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { signOut } from '@/api/auth';
import { useMe } from '@/api/queries';
import { LeaveIcon } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { currentOffline, wipeOffline } from '@/offline/open';

/** Ops on this phone the server hasn't answered: captures, moves, readings (D36). */
async function unsyncedCount(): Promise<number> {
  const offline = await currentOffline().catch(() => null);
  if (!offline) return 0;
  try {
    return (await offline.store.pending()).length;
  } catch {
    return 0;
  }
}

/**
 * Signs out, then clears every cached response and the phone's offline copy (D36, D181: nothing
 * stays behind on logout). Unsynced captures would go with it, so it asks first (D36). Resolves
 * false when the person chose to stay. `next`: where the sign-in page returns to (a fresh sign-in
 * to re-authenticate, e.g. the recovery kit's download).
 */
export function useSignOut() {
  const { t } = useLingui();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const userId = useMe().data?.user.id ?? null;
  return async (opts: { next?: string } = {}): Promise<boolean> => {
    const unsynced = await unsyncedCount();
    if (
      unsynced > 0 &&
      !(await confirm({
        title: plural(unsynced, {
          one: "# capture hasn't synced. Signing out deletes it.",
          other: "# captures haven't synced. Signing out deletes them.",
        }),
        body: t`Stay signed in and open Kept with a connection to finish syncing first.`,
        confirmLabel: t`Sign out anyway`,
        destructive: true,
      }))
    )
      return false;
    try {
      await signOut();
    } catch {
      // Signed out or not, the local state goes.
    }
    await wipeOffline(userId).catch(() => {});
    qc.clear();
    void navigate({ to: '/signin', search: opts.next ? { next: opts.next } : {} });
    return true;
  };
}

export function SignOutButton() {
  const signOutAndLeave = useSignOut();
  const [pending, setPending] = useState(false);
  return (
    <Button
      variant="secondary"
      className="w-full"
      isPending={pending}
      onPress={async () => {
        setPending(true);
        try {
          await signOutAndLeave();
        } finally {
          setPending(false);
        }
      }}
    >
      <LeaveIcon />
      <Trans>Sign out</Trans>
    </Button>
  );
}
