/**
 * One agenda item as the Expiring screen shows it (plan T13, T23; D141, Q7): what it is (a
 * warranty, a document, a thing that expires, and when Home's rows open it, a schedule or a loan),
 * what it's on, the day it's due or runs out, and where it stands. A document's Renew is here
 * (D172); a schedule's Complete and a loan's Mark returned live on their own screens, so those rows
 * link there.
 */
import type { ActiveSourceType, AgendaState, DocumentKind, WarrantyKind } from '@kept/shared';
import { DOCUMENT_KINDS, WARRANTY_KINDS } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import type { AgendaItem } from '@/api/household/types';
import { noonOf, useDocumentKindLabels } from '@/components/documents/labels';
import {
  ActivityIcon,
  BoxIcon,
  ClockIcon,
  DocumentIcon,
  HandoffIcon,
  ScheduleIcon,
  ShieldCheckIcon,
} from '@/components/icons';
import { IconTile, LinkButton, Pill, type PillTone } from '@/components/page';
import { SubjectLink } from '@/components/paperwork/rows';
import { Button } from '@/components/ui/button';
import { isolate, plainText } from '@/lib/bidi';
import { sep, useFormat } from '@/lib/format';
import { useMeterUnit } from '@/lib/units';

export const STATE_TONE: Record<AgendaState, PillTone> = {
  overdue: 'danger',
  expired: 'danger',
  due: 'warn',
  expiring: 'warn',
  upcoming: 'neutral',
};

export function useAgendaStateLabels(): Record<AgendaState, string> {
  const { t } = useLingui();
  return {
    overdue: t`Overdue`,
    expired: t`Ran out`,
    due: t`Due`,
    expiring: t`Runs out soon`,
    upcoming: t`Later`,
  };
}

export function useWarrantyKindLabels(): Record<WarrantyKind, string> {
  const { t } = useLingui();
  return {
    manufacturer: t`Maker's warranty`,
    extended: t`Extended warranty`,
    store: t`Store warranty`,
    credit_card: t`Card cover`,
    insurance: t`Insurance cover`,
  };
}

const SOURCE_ICON: Record<ActiveSourceType, ReactNode> = {
  warranty: <ShieldCheckIcon />,
  registration: <ShieldCheckIcon />,
  document: <DocumentIcon />,
  thing_expiry: <ClockIcon />,
  schedule: <ScheduleIcon />,
  loan: <HandoffIcon />,
  reading_stale: <ActivityIcon />,
  stock: <BoxIcon />,
};

/**
 * The item's name: a schedule's name, a thing's, a document's title. A document without a title
 * arrives as its kind, which is said in the reader's words. A warranty arrives as its provider or,
 * without one, its kind: both read as a warranty ("B.TECH warranty", "Maker's warranty"), never
 * as a bare provider (UI step-4 review L6).
 */
function useItemTitle(): (item: AgendaItem) => string {
  const { t } = useLingui();
  const docs = useDocumentKindLabels();
  const warranties = useWarrantyKindLabels();
  return (item) => {
    if (
      item.sourceType === 'document' &&
      (DOCUMENT_KINDS as readonly string[]).includes(item.title)
    )
      return docs[item.title as DocumentKind];
    if (item.sourceType === 'warranty' || item.sourceType === 'registration') {
      if ((WARRANTY_KINDS as readonly string[]).includes(item.title))
        return warranties[item.title as WarrantyKind];
      const provider = isolate(item.title);
      return t`${provider} warranty`;
    }
    // A stale reading arrives as its meter's label, or none (step 5).
    if (item.sourceType === 'reading_stale') return item.title || t`Reading needed`;
    return item.title;
  };
}

/** "Runs out 20 Oct", "Register by 12 Oct", "Due at ٦٠٬٠٠٠ km"… */
function When({ item }: { item: AgendaItem }) {
  const f = useFormat();
  const unitOf = useMeterUnit();
  if (!item.dueOn) {
    if (item.dueValue === null) return null;
    const n = Number(item.dueValue);
    const value = Number.isFinite(n) ? f.num(n) : item.dueValue;
    const unit = unitOf(item.unit);
    return (
      <Trans>
        Due at {value} {unit}
      </Trans>
    );
  }
  const day = f.day(noonOf(item.dueOn));
  const late = item.state === 'overdue' || item.state === 'expired';
  switch (item.sourceType) {
    case 'warranty':
      return <Trans>Warranty ends {day}</Trans>;
    case 'registration':
      return <Trans>Register the warranty by {day}</Trans>;
    case 'document':
      return late ? <Trans>Ran out {day}</Trans> : <Trans>Runs out {day}</Trans>;
    case 'thing_expiry':
      return late ? <Trans>Expired {day}</Trans> : <Trans>Expires {day}</Trans>;
    case 'loan':
      return <Trans>Due back {day}</Trans>;
    case 'schedule':
      return <Trans>Due {day}</Trans>;
    case 'reading_stale':
      return <Trans>Reading due {day}</Trans>;
    case 'stock':
      return <Trans>Low since {day}</Trans>;
  }
}

export function AgendaRow({
  item,
  onRenew,
}: {
  item: AgendaItem;
  /** Renew a document (its Renew sheet). */
  onRenew: (item: AgendaItem, name: string) => void;
}) {
  const { t } = useLingui();
  const states = useAgendaStateLabels();
  const titleOf = useItemTitle();
  const name = titleOf(item);
  const renew = item.sourceType === 'document' && item.actions.includes('renew');
  return (
    <article
      aria-label={plainText(name)}
      className="grid gap-2 px-3.5 py-3 md:flex md:items-center md:gap-3"
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <IconTile>{SOURCE_ICON[item.sourceType]}</IconTile>
        <div className="grid min-w-0 flex-1 gap-1">
          <div className="font-semibold text-[15px] leading-snug text-ink [overflow-wrap:anywhere]">
            <bdi>{name}</bdi>
          </div>
          <div className="text-small text-ink-2 [overflow-wrap:anywhere]">
            <SubjectLink subject={item.subject} />
            {item.subject.path && item.subject.path !== item.subject.name ? (
              <span className="text-ink-3">
                {sep()}
                <bdi>{item.subject.path}</bdi>
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-ink-2">
            <Pill tone={STATE_TONE[item.state]}>{states[item.state]}</Pill>
            <span>
              <When item={item} />
            </span>
          </div>
        </div>
      </div>
      {renew ? (
        <div className="flex flex-wrap gap-2 ps-13 md:ps-0">
          <Button
            size="small"
            variant="secondary"
            aria-label={t`Renew ${name}`}
            onPress={() => onRenew(item, name)}
          >
            <Trans>Renew</Trans>
          </Button>
        </div>
      ) : item.sourceType === 'schedule' || item.sourceType === 'loan' ? (
        <div className="flex flex-wrap gap-2 ps-13 md:ps-0">
          <LinkButton size="small" to={item.sourceType === 'schedule' ? '/schedules' : '/lending'}>
            {item.sourceType === 'schedule' ? (
              <Trans>Open Schedules</Trans>
            ) : (
              <Trans>Open Lending</Trans>
            )}
          </LinkButton>
        </div>
      ) : null}
    </article>
  );
}
