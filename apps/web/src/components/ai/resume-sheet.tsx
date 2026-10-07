/**
 * "Resume now" (D206, screens §5 "AI paused and waiting"): for whoever set the cap. "Home has used
 * USD 5.00 of USD 5.00 this month · Raise to [6.25] · Remove the cap · Keep paused". Raising or
 * removing resumes paused work at once, oldest first and paced (`POST /ai/caps/:id/resume`);
 * a manual pause just resumes. The raise is prefilled 25% above what was used.
 */
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { captureApi, captureKeys, useAiCaps } from '@/api/capture/queries';
import type { AiCap, AiStatus, ResumeAiBody } from '@/api/capture/types';
import { ErrorState, LoadingRows, useErrorText } from '@/components/page';
import { Sheet } from '@/components/places/sheet';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { useFormat } from '@/lib/format';
import { useCapWho } from './cap-bars';
import { useMoney } from './labels';

/** 25% above what was used, rounded up to a cent (or a thousand tokens). */
export function raisedBy25(used: number, tokens = false): string {
  const up = used * 1.25;
  return tokens ? String(Math.ceil(up / 1000) * 1000) : (Math.ceil(up * 100) / 100).toFixed(2);
}

/** The cap that paused AI, among those the caller can edit. */
export function pausingCap(caps: AiCap[], status: Pick<AiStatus, 'pausedBy'>): AiCap | undefined {
  const paused = caps.filter((c) => c.state === 'paused' && c.canEdit);
  return paused.find((c) => c.target.label === status.pausedBy?.label) ?? paused[0];
}

export function ResumeSheet({
  status,
  isOpen,
  onOpenChange,
}: {
  status: AiStatus;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLingui();
  return (
    <Sheet isOpen={isOpen} onOpenChange={onOpenChange} title={t`Resume AI`}>
      {({ close }) => <ResumeBody status={status} close={close} />}
    </Sheet>
  );
}

function ResumeBody({ status, close }: { status: AiStatus; close: () => void }) {
  // Owners resume account, location and member caps; a personal key's cap is the person's own.
  const account = useAiCaps({ scope: 'account' });
  const me = useAiCaps({ scope: 'me' });
  if (account.isPending && me.isPending) return <LoadingRows rows={2} />;
  const caps = [...(account.data?.caps ?? []), ...(me.data?.caps ?? [])];
  const cap = pausingCap(caps, status);
  if (!cap)
    return account.isError ? (
      <ErrorState error={account.error} onRetry={() => void account.refetch()} />
    ) : (
      <p className="m-0 text-ink-2">
        <Trans>Nothing is paused that you can resume.</Trans>
      </p>
    );
  return <ResumeForm cap={cap} close={close} />;
}

function ResumeForm({ cap, close }: { cap: AiCap; close: () => void }) {
  const { t } = useLingui();
  const fmt = useFormat();
  const money = useMoney();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const who = useCapWho()(cap);
  const currency = cap.monthlyCap?.currency;
  const usedMoney = Number(cap.used.cost.find((c) => c.currency === currency)?.amount ?? 0);
  const [raise, setRaise] = useState(() =>
    cap.monthlyCap
      ? raisedBy25(Math.max(usedMoney, Number(cap.monthlyCap.amount)))
      : cap.tokensPerMonth
        ? raisedBy25(Math.max(cap.used.tokens, cap.tokensPerMonth), true)
        : '',
  );
  const manual = cap.reason === 'manual';
  const resume = useMutation({
    mutationFn: (body: ResumeAiBody) => captureApi.resumeAi(cap.id, body),
    onSuccess: async (out) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: captureKeys.ai.all }),
        qc.invalidateQueries({ queryKey: captureKeys.inbox.all }),
        qc.invalidateQueries({ queryKey: ['extractions'] }),
      ]);
      toast({
        tone: 'ok',
        title: t`AI resumed`,
        ...(out.resumed > 0
          ? {
              description: (
                <Plural
                  value={out.resumed}
                  one="# photo is being named"
                  other="# photos are being named"
                />
              ),
            }
          : {}),
      });
      close();
    },
    onError: (e) => toast({ tone: 'danger', title: errorText(e) }),
  });
  const valid = raise.trim() !== '' && Number(raise) > 0 && Number.isFinite(Number(raise));
  const raiseBody = (): ResumeAiBody =>
    cap.monthlyCap
      ? { raiseTo: { amount: Number(raise).toFixed(2), currency: cap.monthlyCap.currency } }
      : { raiseTo: { tokens: Math.round(Number(raise)) } };

  return (
    <div className="grid gap-4">
      <p className="m-0 text-[15px] text-ink">
        {manual ? (
          <Trans>
            AI for <bdi>{who}</bdi> was paused by hand. Resume it, and the photos waiting are named
            now, oldest first.
          </Trans>
        ) : cap.monthlyCap ? (
          <Trans>
            <bdi>{who}</bdi> has used {money(usedMoney, cap.monthlyCap.currency)} of{' '}
            {money(cap.monthlyCap.amount, cap.monthlyCap.currency)} this month.
          </Trans>
        ) : (
          <Trans>
            <bdi>{who}</bdi> has used {fmt.num(cap.used.tokens)} of{' '}
            {fmt.num(cap.tokensPerMonth ?? 0)} tokens this month.
          </Trans>
        )}
      </p>
      {manual ? null : (
        <TextField
          label={
            cap.monthlyCap ? (
              <Trans>Raise the cap to ({cap.monthlyCap.currency})</Trans>
            ) : (
              <Trans>Raise the limit to (tokens)</Trans>
            )
          }
          value={raise}
          onChange={setRaise}
          inputProps={{ inputMode: 'decimal', dir: 'ltr' }}
          {...(raise && !valid ? { errorMessage: t`Enter an amount above zero.` } : {})}
          isInvalid={!!raise && !valid}
        />
      )}
      <DialogFooter className="flex-col-reverse items-stretch sm:flex-row sm:items-center">
        <Button variant="ghost" onPress={close}>
          <Trans>Keep paused</Trans>
        </Button>
        {manual ? (
          <Button isPending={resume.isPending} onPress={() => resume.mutate({})}>
            <Trans>Resume now</Trans>
          </Button>
        ) : (
          <>
            <Button
              variant="secondary"
              isPending={resume.isPending && !!resume.variables?.remove}
              onPress={() => resume.mutate({ remove: true })}
            >
              <Trans>Remove the cap</Trans>
            </Button>
            <Button
              isDisabled={!valid}
              isPending={resume.isPending && !resume.variables?.remove}
              onPress={() => resume.mutate(raiseBody())}
            >
              <Trans>Raise and resume</Trans>
            </Button>
          </>
        )}
      </DialogFooter>
    </div>
  );
}
