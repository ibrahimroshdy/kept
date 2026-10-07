/**
 * A vehicle in words (plan T17, T18; D52, D188): the odometer's latest reading and how old it is,
 * the usage estimate, what's due next ("estimated ~14 Nov" when the date comes from the usage,
 * never for a meter whose reading is too old to trust), and a document coming due. Shared by the
 * Vehicles list and the vehicle page, so both say the same thing the same way.
 *
 * Digits (D143): readings, dates and counts follow the reader's setting through `useFormat`.
 * Estimates: `advice` is the server's (`kept.meter_estimate`, T7): `stale` at 30 days, `unknown`
 * at 60, when the estimate is no longer used and the screens say "unknown — reading needed".
 */
import type { DocumentKind, ReadingAdvice } from '@kept/shared';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import type { ActorRef, ReadingSource } from '@/api/inventory/types';
import type { Estimate, VehicleRow } from '@/api/vehicles/types';
import { AlertIcon, ClockIcon } from '@/components/icons';
import { Pill } from '@/components/page';
import { daysBetween } from '@/components/schedules/access';
import { useFormat } from '@/lib/format';
import { useMeterUnit } from '@/lib/units';

/** "52,340 km": a reading with its meter's unit, in the reader's digits. */
export function useReadingText() {
  const fmt = useFormat();
  const unitOf = useMeterUnit();
  return (value: string, unit: string) => `${fmt.num(Number(value))} ${unitOf(unit)}`;
}

/** The pill for a reading that is getting old (`stale`) or too old to estimate from (`unknown`). */
export function AdvicePill({ estimate }: { estimate: Estimate | undefined }) {
  if (!estimate) return null;
  if (estimate.advice === 'unknown')
    return (
      <Pill tone="danger" icon={<AlertIcon />}>
        <Trans>Unknown: reading needed</Trans>
      </Pill>
    );
  if (estimate.advice === 'stale' && estimate.ageDays !== null)
    return (
      <Pill tone="warn" icon={<ClockIcon />}>
        <Plural value={estimate.ageDays} one="Reading is # day old" other="Reading is # days old" />
      </Pill>
    );
  return null;
}

/** "read today", "read 12 days ago": the latest reading's age, from the server's `ageDays`. */
export function ReadAgo({ ageDays }: { ageDays: number | null }) {
  if (ageDays === null) return null;
  if (ageDays <= 0) return <Trans>read today</Trans>;
  return <Plural value={ageDays} one="read # day ago" other="read # days ago" />;
}

/** "from a photo by Alfred", "typed by Alfred", "from a fill by Alfred" (D27, the board's words). */
export function ReadingSourceText({ source, by }: { source: ReadingSource; by: ActorRef }) {
  const name = <bdi>{by.displayName}</bdi>;
  switch (source) {
    case 'photo':
      return <Trans>from a photo by {name}</Trans>;
    case 'fuel':
      return <Trans>from a fill by {name}</Trans>;
    case 'service':
      return <Trans>from a service by {name}</Trans>;
    default:
      return <Trans>typed by {name}</Trans>;
  }
}

/** "About 62 km a day over the last 90 days", or null without a rate (or when it's unknown). */
export function UsageText({
  estimate,
  unit: stored,
}: {
  estimate: Estimate | undefined;
  unit: string;
}) {
  const fmt = useFormat();
  const unit = useMeterUnit()(stored);
  if (!estimate?.perDay || estimate.advice === 'unknown' || estimate.basisDays === null)
    return null;
  const perDay = fmt.num(Math.round(Number(estimate.perDay)));
  const days = estimate.basisDays;
  return (
    <Plural
      value={days}
      one={`About ${perDay} ${unit} a day over the last # day`}
      other={`About ${perDay} ${unit} a day over the last # days`}
    />
  );
}

/**
 * What's due next on a vehicle: "Oil & filter · estimated ~14 Nov", "Brake fluid · due 18 Dec",
 * "Oil & filter · at 55,000 km" (no date to estimate). With the reading too old (`unknown`), an
 * estimated date isn't shown: "Oil & filter · at 55,000 km · reading needed" (D188).
 */
export function NextDueText({
  next,
  unit: stored,
  advice,
}: {
  next: NonNullable<VehicleRow['nextDue']>;
  unit: string | undefined;
  advice: ReadingAdvice | undefined;
}) {
  const fmt = useFormat();
  const unit = useMeterUnit()(stored);
  const name = <bdi>{next.name}</bdi>;
  const at = next.dueValue && unit ? `${fmt.num(Number(next.dueValue))} ${unit}` : null;
  if (next.estimated && advice === 'unknown')
    return at ? (
      <Trans>
        {name} · at {at} · reading needed
      </Trans>
    ) : (
      <Trans>{name} · reading needed</Trans>
    );
  if (next.dueOn) {
    const day = fmt.day(next.dueOn);
    return next.estimated ? (
      <Trans>
        {name} · estimated ~{day}
      </Trans>
    ) : (
      <Trans>
        {name} · due {day}
      </Trans>
    );
  }
  return at ? (
    <Trans>
      {name} · at {at}
    </Trans>
  ) : (
    name
  );
}

/** A document coming due or run out, in days from `today`: "Licence due in 23 days". */
export function DocumentDueText({
  kind,
  expiresOn,
  today,
}: {
  kind: DocumentKind;
  expiresOn: string;
  today: string;
}) {
  const kinds = useDocumentKinds();
  const days = daysBetween(today, expiresOn);
  const name = kinds[kind];
  if (days < 0) {
    const ago = -days;
    return (
      <Plural value={ago} one={`${name} ran out # day ago`} other={`${name} ran out # days ago`} />
    );
  }
  if (days === 0) return <Trans>{name} runs out today</Trans>;
  return <Plural value={days} one={`${name} due in # day`} other={`${name} due in # days`} />;
}

function useDocumentKinds(): Record<DocumentKind, string> {
  const { t } = useLingui();
  return {
    registration: t`Registration`,
    insurance: t`Insurance`,
    licence: t`Licence`,
    inspection: t`Inspection`,
    lease: t`Lease`,
    contract: t`Contract`,
    other: t`Document`,
  };
}

/** A small labelled line: an icon and its words, wrapping on a phone (never cut short). */
export function Line({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex min-w-0 items-start gap-1.5 text-small text-ink-2 [overflow-wrap:anywhere] [&_svg]:mt-0.5 [&_svg]:size-3.5 [&_svg]:shrink-0">
      {icon}
      <span className="min-w-0">{children}</span>
    </span>
  );
}

/** Where a reading came from, as a table cell or a filter value. */
export function useReadingSourceLabels(): Record<ReadingSource, string> {
  const { t } = useLingui();
  return {
    manual: t`Typed`,
    photo: t`Photo`,
    fuel: t`Fuel`,
    service: t`Service`,
    import: t`Import`,
    home_assistant: t`Home Assistant`,
  };
}
