/**
 * Claims on the thing page (D54, D195; screens §5): one card per claim, newest first, with its
 * status stepper (opened → in repair → resolved or rejected), where it is, the warranty it uses,
 * the reference, and the cost behind the money gate. A claim resolved at no cost says "Warranty
 * saved you <amount>" when the covered amount is set, otherwise "Covered by the warranty" (Q18).
 * New and Update open the claim sheet; a claim in repair makes the thing read "at <vendor>".
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { useClaims } from '@/api/household/queries';
import type { Claim } from '@/api/household/types';
import { WrenchIcon } from '@/components/icons';
import { GatedAmount, isMoneyHidden, useGatedMoney } from '@/components/money/gated';
import { EmptyState, ErrorState, LoadingRows, Pill, Section } from '@/components/page';
import { useThingCtx } from '@/components/things/context';
import { useBlocked } from '@/components/things/household';
import { Bidi, KeyValues, KV, Printed } from '@/components/things/values';
import { Button } from '@/components/ui/button';
import { useWarrantyKindLabels } from '@/components/warranties/labels';
import { sep, useFormat } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ClaimSheet } from './claim-sheet';
import { useClaimStatusLabels } from './labels';

export function ClaimsSection() {
  const { thing, can } = useThingCtx();
  const { t } = useLingui();
  const blocked = useBlocked();
  const q = useClaims(thing.id);
  const [open, setOpen] = useState<Claim | 'new' | null>(null);
  const manage = can('schedules-claims.manage');
  return (
    <Section
      title={<Trans>Claims</Trans>}
      action={
        manage ? (
          <Button
            size="small"
            variant="secondary"
            isDisabled={!!blocked}
            onPress={() => setOpen('new')}
          >
            <Trans>New claim</Trans>
          </Button>
        ) : null
      }
    >
      {blocked && manage ? <p className="m-0 text-small text-ink-3">{blocked}</p> : null}
      {q.isPending ? (
        <LoadingRows rows={2} label={t`Loading the claims`} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data.items.length === 0 ? (
        <EmptyState icon={<WrenchIcon />} title={<Trans>No claims</Trans>}>
          <Trans>
            When it breaks, open a claim: Kept fills in the warranty that covers longest and
            remembers where it went for repair.
          </Trans>
        </EmptyState>
      ) : (
        <ul className="m-0 grid list-none gap-2 p-0">
          {q.data.items.map((c) => (
            <li key={c.id}>
              <ClaimCard
                claim={c}
                {...(manage && !blocked ? { onUpdate: () => setOpen(c) } : {})}
              />
            </li>
          ))}
        </ul>
      )}
      {manage ? (
        <ClaimSheet
          key={open === null ? 'closed' : open === 'new' ? 'new' : open.id}
          claim={open}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </Section>
  );
}

function ClaimCard({ claim: c, onUpdate }: { claim: Claim; onUpdate?: () => void }) {
  const { moduleOn } = useThingCtx();
  const { t } = useLingui();
  const fmt = useFormat();
  const statuses = useClaimStatusLabels();
  const kinds = useWarrantyKindLabels();
  const gated = useGatedMoney();
  const closed = c.status === 'resolved' || c.status === 'rejected';
  const saved = gated(c.savedYou);
  const noCost = !c.cost || (!isMoneyHidden(c.cost) && Number(c.cost.amount) === 0);
  const steps: { key: string; label: string; done: boolean; current: boolean }[] = [
    {
      key: 'opened',
      label: t`Opened ${fmt.day(c.openedOn)}`,
      done: true,
      current: c.status === 'open',
    },
    {
      key: 'repair',
      label: statuses.in_repair,
      done: c.status !== 'open' && c.status !== 'rejected',
      current: c.status === 'in_repair',
    },
    {
      key: 'closed',
      label:
        c.status === 'rejected'
          ? c.closedOn
            ? t`Rejected ${fmt.day(c.closedOn)}`
            : statuses.rejected
          : c.closedOn
            ? t`Resolved ${fmt.day(c.closedOn)}`
            : statuses.resolved,
      done: closed,
      current: closed,
    },
  ];
  return (
    <article className="grid gap-2.5 rounded-[10px] border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        {/* Open or closed only: the pill and the stepper say where it is (UI step-4 review L5). */}
        <span className="eyebrow">
          {closed ? <Trans>Claim · closed</Trans> : <Trans>Claim · open</Trans>}
        </span>
        {c.status === 'in_repair' ? (
          <Pill tone="info" icon={<WrenchIcon />}>
            {statuses.in_repair}
          </Pill>
        ) : null}
        {onUpdate ? (
          <Button size="small" variant="secondary" className="ms-auto" onPress={onUpdate}>
            <Trans>Update</Trans>
          </Button>
        ) : null}
      </div>
      {c.notes ? (
        <div className="font-semibold text-[15px] text-ink [overflow-wrap:anywhere]">
          <Bidi>{c.notes}</Bidi>
        </div>
      ) : null}
      <ol
        aria-label={t`Claim progress`}
        className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0 text-small"
      >
        {steps
          .filter((s) => !(s.key === 'repair' && c.status === 'rejected'))
          .map((s) => (
            <li
              key={s.key}
              {...(s.current ? { 'aria-current': 'step' as const } : {})}
              className={cn(
                'inline-flex items-center gap-1.5',
                s.done ? 'text-ink' : 'text-ink-3',
                s.current && 'font-semibold',
              )}
            >
              <span
                aria-hidden="true"
                className={cn('size-2 rounded-full', s.done ? 'bg-ink' : 'border border-line')}
              />
              {s.label}
            </li>
          ))}
      </ol>
      <KeyValues label={t`Claim details`}>
        {c.vendor ? (
          <KV label={t`At`}>
            <Bidi>{c.vendor.name}</Bidi>
          </KV>
        ) : null}
        {c.warranty ? (
          <KV label={t`Warranty`}>
            {kinds[c.warranty.kind]}
            {c.warranty.provider ? (
              <>
                {sep()}
                <Bidi>{c.warranty.provider}</Bidi>
              </>
            ) : null}
          </KV>
        ) : null}
        {c.reference ? (
          <KV label={t`Reference`}>
            <Printed>{c.reference}</Printed>
          </KV>
        ) : null}
        {moduleOn('money') && c.cost ? (
          <KV label={t`Cost`}>
            <GatedAmount value={c.cost} />
          </KV>
        ) : null}
      </KeyValues>
      {c.status === 'resolved' && noCost ? (
        <p className="m-0 font-semibold text-[15px] text-ok">
          {saved ? (
            <Trans>Warranty saved you {saved}</Trans>
          ) : (
            <Trans>Covered by the warranty</Trans>
          )}
        </p>
      ) : null}
    </article>
  );
}
