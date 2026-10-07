/**
 * "Set a monthly limit?" (D206, screens §5 AI settings §3), once, after the first key is saved:
 * the suggested cap filled in (§3.5: the larger of 5.00 and three times the projected month, or
 * 3,000,000 tokens without a price), "Set USD 5.00 a month" · "No limit". Nothing is capped
 * unless chosen.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { captureApi, captureKeys } from '@/api/capture/queries';
import type { AiCapScope, SuggestedAiCap } from '@/api/capture/types';
import { Notice, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useMoney, useTokens } from './labels';

export function CapSuggest({
  scope,
  suggested,
  onDone,
}: {
  scope: Extract<AiCapScope, 'account' | 'user' | 'instance'>;
  suggested: SuggestedAiCap;
  onDone: () => void;
}) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const money = useMoney();
  const tokens = useTokens();
  const errorText = useErrorText();
  const set = useMutation({
    mutationFn: () =>
      captureApi.putAiCap({
        scope,
        ...(suggested.monthlyCap ? { monthlyCap: suggested.monthlyCap } : {}),
        ...(suggested.tokensPerMonth ? { tokensPerMonth: suggested.tokensPerMonth } : {}),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: captureKeys.ai.all });
      toast({ tone: 'ok', title: t`Monthly limit set` });
      onDone();
    },
    onError: (e) => toast({ tone: 'danger', title: errorText(e) }),
  });
  const label = suggested.monthlyCap
    ? t`Set ${money(suggested.monthlyCap.amount, suggested.monthlyCap.currency)} a month`
    : t`Set ${tokens(suggested.tokensPerMonth ?? 0)} tokens a month`;
  return (
    <Notice
      tone="info"
      title={<Trans>Set a monthly limit?</Trans>}
      action={
        <div className="flex flex-wrap gap-2">
          <Button size="small" isPending={set.isPending} onPress={() => set.mutate()}>
            {label}
          </Button>
          <Button size="small" variant="ghost" onPress={onDone}>
            <Trans>No limit</Trans>
          </Button>
        </div>
      }
    >
      <Trans>
        Nothing is capped unless you choose. At 80% you get a warning; at the limit AI pauses until
        the 1st, and captures still save.
      </Trans>
    </Notice>
  );
}
