/** The words for the thing screen's enums, in the reader's language (Lingui). */
import { useLingui } from '@lingui/react/macro';
import type {
  AttachmentRole,
  Condition,
  Lifecycle,
  LinkKind,
  ReviewReason,
} from '@/api/inventory/types';

export function useLifecycleLabels(): Record<Lifecycle, string> {
  const { t } = useLingui();
  return {
    in_use: t`In use`,
    sold: t`Sold`,
    given_away: t`Given away`,
    lost: t`Lost`,
    disposed: t`Thrown away`,
    stolen: t`Stolen`,
    destroyed: t`Destroyed`,
    returned_to_owner: t`Returned to its owner`,
  };
}

export function useConditionLabels(): Record<Condition, string> {
  const { t } = useLingui();
  return { new: t`New`, good: t`Good`, fair: t`Fair`, poor: t`Poor`, broken: t`Broken` };
}

/** D76. `from` reads "this thing is … that one"; `to` reads it the other way round. */
export function useLinkKindLabels(): Record<LinkKind, { from: string; to: string }> {
  const { t } = useLingui();
  return {
    accessory_of: { from: t`Accessory of`, to: t`Has accessory` },
    spare_part_for: { from: t`Spare part for`, to: t`Has spare part` },
    consumable_for: { from: t`Used up by`, to: t`Uses up` },
    bundled_with: { from: t`Bundled with`, to: t`Bundled with` },
    replaces: { from: t`Replaces`, to: t`Replaced by` },
    related: { from: t`Related to`, to: t`Related to` },
  };
}

export function useRoleLabels(): Record<AttachmentRole, string> {
  const { t } = useLingui();
  return {
    photo: t`Photo`,
    receipt: t`Receipt`,
    invoice: t`Invoice`,
    manual: t`Manual`,
    warranty_doc: t`Warranty`,
    proof: t`Proof`,
    condition_out: t`Condition when lent`,
    condition_in: t`Condition when returned`,
    registration: t`Registration`,
    document: t`Document`,
  };
}

export function useReviewReasonLabels(): Record<ReviewReason, string> {
  const { t } = useLingui();
  return {
    lower_than_previous: t`Lower than the reading before it`,
    higher_than_next: t`Higher than the reading after it`,
    implausible_jump: t`A bigger jump than it could make`,
    ai_read: t`Read by AI: check it`,
  };
}
