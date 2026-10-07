/** Words for a claim's status (D54), shared by the card, the sheet and the thing's header. */
import type { ClaimStatus } from '@kept/shared';
import { useLingui } from '@lingui/react/macro';

export function useClaimStatusLabels(): Record<ClaimStatus, string> {
  const { t } = useLingui();
  return {
    // A claim's own words ("Open" is otherwise the verb elsewhere in the app).
    open: t({ message: 'Open', context: 'claim status' }),
    in_repair: t`In repair`,
    resolved: t({ message: 'Resolved', context: 'claim status' }),
    rejected: t({ message: 'Rejected', context: 'claim status' }),
  };
}
