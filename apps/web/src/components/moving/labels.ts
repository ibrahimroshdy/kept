/**
 * Moving mode's words (1.x, D251): a box's state, a move's status, a box's title.
 */
import type { BoxState, MoveStatus } from '@kept/shared';
import { useLingui } from '@lingui/react/macro';
import type { PillTone } from '@/components/page';
import { useFormat } from '@/lib/format';

export function useBoxStateLabels(): Record<BoxState, string> {
  const { t } = useLingui();
  return { packed: t`Packed`, in_transit: t`In transit`, unpacked: t`Unpacked` };
}

export function useMoveStatusLabels(): Record<MoveStatus, string> {
  const { t } = useLingui();
  return { active: t`In progress`, done: t`Done` };
}

/** The state's pill: in transit stands out, unpacked is done. */
export const STATE_TONES: Record<BoxState, PillTone> = {
  packed: 'neutral',
  in_transit: 'warn',
  unpacked: 'ok',
};

/** "Box 7", in the reader's digits. */
export function useBoxTitle(): (n: number) => string {
  const { t } = useLingui();
  const f = useFormat();
  return (n: number) => {
    const number = f.num(n);
    return t`Box ${number}`;
  };
}
