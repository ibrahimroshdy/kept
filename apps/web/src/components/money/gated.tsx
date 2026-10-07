/**
 * Money through the gate (D13, D110; the server's `serialize/gates.ts`): a step-4 amount arrives
 * as `{amount, currency}` or as `{moneyHidden: true}` alone, and the web shows exactly that. It
 * never guesses a hidden amount and never formats one itself outside `useMoney` (D143 digits).
 *
 *   <GatedAmount value={claim.cost} empty={t`None`} />
 */
import { Trans } from '@lingui/react/macro';
import { type ReactNode, useCallback } from 'react';
import type { GatedMoney } from '@/api/household/types';
import { useMoney } from '@/components/things/values';

export const isMoneyHidden = (m: GatedMoney | null | undefined): m is { moneyHidden: true } =>
  !!m && 'moneyHidden' in m;

/** The amount as text, or null when there's none or it's hidden. */
export function useGatedMoney() {
  const money = useMoney();
  return useCallback(
    (m: GatedMoney | null | undefined): string | null =>
      m && !('moneyHidden' in m) ? money(m.amount, m.currency) : null,
    [money],
  );
}

/** "Hidden in this location", the words for an amount the gate kept back (T20). */
export function MoneyHiddenText() {
  return (
    <span className="text-ink-3">
      <Trans>Hidden in this location</Trans>
    </span>
  );
}

export function GatedAmount({
  value,
  empty = null,
}: {
  value: GatedMoney | null | undefined;
  /** Shown when there is no amount at all. */
  empty?: ReactNode;
}) {
  const text = useGatedMoney();
  if (!value) return <>{empty}</>;
  if (isMoneyHidden(value)) return <MoneyHiddenText />;
  return <bdi>{text(value)}</bdi>;
}
