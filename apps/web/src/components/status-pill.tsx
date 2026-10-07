/**
 * A thing's derived state as a pill: always an icon, a word and a colour together, never colour
 * alone (screens §4, D134). Step 2 has uncertain, draft, ended and needs review; step 4 adds
 * lent, borrowed and in repair (D119).
 */
import { useLingui } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import type { DerivedState } from '@/api/inventory/types';
import {
  AlertIcon,
  EndedIcon,
  HandoffIcon,
  PencilIcon,
  QuestionIcon,
  WrenchIcon,
} from '@/components/icons';
import { Pill, type PillTone } from '@/components/page';

export type StatusKind = DerivedState | 'needs_review';

export function StatusPill({
  state,
  label,
  className,
}: {
  state: StatusKind;
  /** Overrides the word, e.g. the lifecycle for `ended` ("Given away"). */
  label?: ReactNode;
  className?: string;
}) {
  const { t } = useLingui();
  const spec: Record<StatusKind, { tone: PillTone; icon: ReactNode; word: string }> = {
    uncertain: { tone: 'warn', icon: <QuestionIcon />, word: t`Not sure where` },
    draft: { tone: 'info', icon: <PencilIcon />, word: t`Draft` },
    ended: { tone: 'neutral', icon: <EndedIcon />, word: t`Ended` },
    needs_review: { tone: 'warn', icon: <AlertIcon />, word: t`Needs review` },
    lent: { tone: 'info', icon: <HandoffIcon />, word: t`Lent out` },
    borrowed: {
      tone: 'info',
      icon: <HandoffIcon className="-scale-x-100" />,
      word: t`Borrowed`,
    },
    in_repair: { tone: 'info', icon: <WrenchIcon />, word: t`In repair` },
  };
  const s = spec[state];
  return (
    <span data-status={state} className="contents">
      <Pill tone={s.tone} icon={s.icon} className={className}>
        {label ?? s.word}
      </Pill>
    </span>
  );
}
