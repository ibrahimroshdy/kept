/**
 * Revoke a token or disconnect an app, after the in-app confirm (never window.confirm). The
 * server revokes at once (`DELETE /tokens/:id`, `revoked_reason = 'user'`); an OAuth app's Better
 * Auth tokens go with it (T10, T12). Offline it's disabled with the reason.
 */
import { useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { connectionsApi, connectionsKeys } from '@/api/connections/queries';
import type { TokenRow } from '@/api/connections/types';
import { useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { toast } from '@/components/ui/toast';
import { isolate } from '@/lib/bidi';
import { useOnline } from '@/lib/online';

export function RevokeButton({
  token,
  label,
  title,
  body,
}: {
  token: TokenRow;
  label: string;
  title: string;
  body: string;
}) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const online = useOnline();
  const errorText = useErrorText();
  const plain = token.clientName ?? token.name;
  const name = isolate(plain);
  const revoke = useMutation({
    mutationFn: () => connectionsApi.revokeToken(token.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: connectionsKeys.all });
      toast({ title: t`${name} can't reach your Kept any more`, tone: 'ok' });
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });
  return (
    <Button
      variant="secondary"
      size="small"
      className="shrink-0"
      isDisabled={!online}
      isPending={revoke.isPending}
      aria-label={t`${label}: ${plain}`}
      onPress={async () => {
        const ok = await confirm({ title, body, confirmLabel: label, destructive: true });
        if (ok) revoke.mutate();
      }}
    >
      {label}
    </Button>
  );
}
