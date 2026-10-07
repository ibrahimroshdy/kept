/** "Leave this location" with the D180 confirmation: what stops working, and how to come back. */
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { removeMember } from '@/api/locations';
import { keys, useMembers } from '@/api/queries';
import type { LocationSummary } from '@/api/types';
import { LeaveIcon } from '@/components/icons';
import { useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { toast } from '@/components/ui/toast';

export function LeaveLocation({ location }: { location: LocationSummary }) {
  const { t } = useLingui();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const members = useMembers(location.id);
  const mine = members.data?.members.find((m) => m.isYou);
  const name = location.name;
  const leave = useMutation({
    mutationFn: () => removeMember(location.id, mine?.membershipId ?? ''),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.locations });
      toast({ title: t`You left ${name}`, tone: 'ok' });
      void navigate({ to: '/' });
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });
  return (
    <Button
      variant="secondary"
      className="w-full text-danger"
      isDisabled={!mine}
      isPending={leave.isPending}
      onPress={async () => {
        const ok = await confirm({
          title: t`Leave ${name}?`,
          body: (
            <div className="grid gap-2">
              <p className="m-0">
                <Trans>
                  You lose access to {name}. What you added stays in {name}.
                </Trans>
              </p>
              <p className="m-0 text-warn">
                <Trans>Webhooks, share links and exports you made for {name} stop working.</Trans>
              </p>
              <p className="m-0 text-small">
                <Trans>To come back, someone in {name} has to invite you again.</Trans>
              </p>
            </div>
          ),
          confirmLabel: t`Leave ${name}`,
          destructive: true,
        });
        if (ok) leave.mutate();
      }}
    >
      <LeaveIcon />
      <Trans>Leave this location</Trans>
    </Button>
  );
}
