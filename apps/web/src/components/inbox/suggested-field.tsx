/**
 * A value AI read that waits for a person (D18, D19; T10's suggestions): a serial, a quantity
 * above 1, and from a label a VIN, plate, expiry or manufacture date. Marked three ways, never by
 * colour alone (screens §4): an icon, the word "Suggested", and violet. Confirm (`y`) or reject
 * (`n`); the choice is sent with the item's Accept, so nothing is written until then.
 *
 * Accept writes only the fields T15 can (`canAcceptSuggestion`); any other suggestion offers
 * Reject alone and says where it is set instead, so the UI never sends an accept the server
 * refuses.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { canAcceptSuggestion, isDocumentSuggestion, type Suggestion } from '@/api/capture/types';
import type { Money } from '@/api/inventory/types';
import { useDocumentKindLabels } from '@/components/documents/labels';
import { CheckIcon, XIcon } from '@/components/icons';
import { Printed, useMoney } from '@/components/things/values';
import { Button } from '@/components/ui/button';
import { sep, useFormat } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useFieldLabels } from './labels';

export type Decision = 'confirm' | 'reject';

/** The "Suggested" mark: a spark, in violet beside the word. */
export function SuggestedMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path d="M12 3.5 13.9 9.1 19.5 11 13.9 12.9 12 18.5 10.1 12.9 4.5 11 10.1 9.1Z" />
      <path d="M19 3v3M17.5 4.5h3" />
    </svg>
  );
}

const isMoney = (v: unknown): v is Money =>
  typeof v === 'object' && v !== null && 'amount' in v && 'currency' in v;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A suggested value as it reads: money in the reader's digits, days on Kept's calendar. */
export function useSuggestedValue() {
  const money = useMoney();
  const fmt = useFormat();
  const kinds = useDocumentKindLabels();
  return (s: Pick<Suggestion, 'field' | 'value'>) => {
    const v = s.value;
    // Step 5 (T22): a vehicle's card, "Licence · expires Fri 6 Nov 2026".
    if (s.field === 'document' && isDocumentSuggestion(v)) {
      const day = fmt.longDay(`${v.expiresOn}T12:00:00`);
      return (
        <>
          {kinds[v.kind]}
          {sep()}
          <Trans>expires {day}</Trans>
        </>
      );
    }
    if (isMoney(v)) return <span className="tabular-nums">{money(v.amount, v.currency)}</span>;
    if (typeof v === 'string' && DAY.test(v)) return fmt.longDay(`${v}T12:00:00`);
    // As printed (screens: digits), codes a person checks against the label itself.
    if (s.field === 'serial' || s.field === 'vin' || s.field === 'plate')
      return <Printed>{String(v)}</Printed>;
    if (s.field === 'quantity' && !Number.isNaN(Number(v))) return fmt.num(Number(v));
    return <bdi dir="auto">{String(v)}</bdi>;
  };
}

export function SuggestedField({
  suggestion,
  decision,
  onDecide,
  current = false,
  disabledReason,
}: {
  suggestion: Suggestion;
  decision: Decision | undefined;
  onDecide: (d: Decision | undefined) => void;
  /** The field `y` and `n` act on. */
  current?: boolean;
  /** Set when the choice can't be made now ("Needs a connection"). */
  disabledReason?: string;
}) {
  const { t } = useLingui();
  const fieldName = useFieldLabels()(suggestion.field);
  const value = useSuggestedValue()(suggestion);
  const toggle = (d: Decision) => onDecide(decision === d ? undefined : d);
  const acceptable = canAcceptSuggestion(suggestion.field);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group of one value and its two choices
    <div
      role="group"
      aria-label={t`Suggested ${fieldName}`}
      data-current={current ? 'true' : undefined}
      className={cn(
        'grid gap-2 rounded-[10px] border border-dashed border-violet bg-violet-soft/60 px-3 py-2.5 @md:flex @md:flex-wrap @md:items-center',
        current && 'outline-2 outline-offset-2 outline-violet',
        decision === 'reject' && 'opacity-70',
      )}
    >
      <div className="grid min-w-0 flex-1 gap-0.5">
        <span className="inline-flex items-center gap-1 font-semibold text-[12.5px] text-violet">
          <SuggestedMark className="size-3.5" />
          <Trans>Suggested · {fieldName}</Trans>
        </span>
        <span
          className={cn(
            'text-[15px] text-ink [overflow-wrap:anywhere]',
            decision === 'reject' && 'line-through',
          )}
        >
          {value}
        </span>
        {!acceptable && !decision ? (
          <span className="text-small text-ink-2">
            <Trans>Set this on the thing's page. Here it can only be left out.</Trans>
          </span>
        ) : null}
        {decision ? (
          <span className="text-small text-ink-2">
            {decision === 'confirm' ? (
              <Trans>Will be confirmed when you accept</Trans>
            ) : (
              <Trans>Will be left out when you accept</Trans>
            )}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {acceptable ? (
          <Button
            size="small"
            variant={decision === 'confirm' ? 'primary' : 'secondary'}
            aria-pressed={decision === 'confirm'}
            aria-keyshortcuts="Y"
            isDisabled={!!disabledReason}
            onPress={() => toggle('confirm')}
          >
            <CheckIcon aria-hidden="true" />
            <Trans>Confirm</Trans>
          </Button>
        ) : null}
        <Button
          size="small"
          variant={decision === 'reject' ? 'primary' : 'secondary'}
          aria-pressed={decision === 'reject'}
          aria-keyshortcuts="N"
          isDisabled={!!disabledReason}
          onPress={() => toggle('reject')}
        >
          <XIcon aria-hidden="true" />
          <Trans>Reject</Trans>
        </Button>
      </div>
    </div>
  );
}
