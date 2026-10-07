/**
 * A vehicle's Overview (plan T18; the board's phone frame, screens §8; D26, D52, D188): a banner
 * when a document is coming due; the odometer card (the latest reading, how old it is and whose,
 * the usage, Log a reading); the schedules with their estimated dates and what the estimate rests
 * on; recent services; the fuel card (T21's); the documents; and the history report (T23's).
 * Every card's "All" opens its tab (a phone scrolls to its section).
 */
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { useSubjectSchedules } from '@/api/household/queries';
import type { Schedule } from '@/api/household/types';
import { useReadings, useVehicleDocuments } from '@/api/vehicles/queries';
import type { ExpiringDocumentV5 } from '@/api/vehicles/types';
import { useDocumentName } from '@/components/documents/labels';
import { AlertIcon, DocumentIcon } from '@/components/icons';
import { List, Notice, Pill, Skeleton } from '@/components/page';
import { accessOf, daysBetween } from '@/components/schedules/access';
import { ScheduleStatePill, useScheduleText } from '@/components/schedules/labels';
import { useThingCtx } from '@/components/things/context';
import { useMeterName } from '@/components/things/meters-section';
import { Button } from '@/components/ui/button';
import { useFormat } from '@/lib/format';
import { useMeterUnit } from '@/lib/units';
import { EstimatedPill, useEstimatedDates, useMainMeter } from './estimates';
import { useVehicleNav } from './nav';
import { ServiceRecordsList } from './recent-services';
import { FuelSummaryCard, HistoryReportButton, LogReadingSheet } from './slots';
import { AdvicePill, ReadingSourceText, UsageText } from './words';

export function Card({
  title,
  action,
  children,
  label,
}: {
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  label?: string;
}) {
  return (
    <section
      aria-label={label}
      className="grid min-w-0 content-start gap-3 rounded-[12px] border border-line bg-surface p-3.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="m-0 font-semibold text-[15px] text-ink">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** "All 4": a card's way to its tab. */
export function AllLink({ count, onPress }: { count?: number; onPress: () => void }) {
  const fmt = useFormat();
  return (
    <Button size="small" variant="ghost" onPress={onPress}>
      {count !== undefined ? <Trans>All {fmt.num(count)}</Trans> : <Trans>All</Trans>}
    </Button>
  );
}

export function VehicleOverview() {
  const { moduleOn } = useThingCtx();
  const nav = useVehicleNav();
  return (
    <div className="grid min-w-0 gap-4">
      <DocumentBanner />
      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <OdometerCard />
        {moduleOn('schedules') ? <SchedulesCard /> : null}
        <Card
          title={<Trans>Recent services</Trans>}
          action={<AllLink onPress={() => nav.go('services')} />}
        >
          <ServiceRecordsList limit={2} />
        </Card>
        {moduleOn('fuel') ? (
          <FuelSummaryCard allFills={<AllLink onPress={() => nav.go('fuel')} />} />
        ) : null}
        <DocumentsCard />
      </div>
      <HistoryReportButton />
    </div>
  );
}

/** The first document coming due or run out: "Licence due in 23 days, on 6 Nov". */
function DocumentBanner() {
  const { thing, location } = useThingCtx();
  const nav = useVehicleNav();
  const fmt = useFormat();
  const docName = useDocumentName();
  const docs = useVehicleDocuments(thing.id);
  const today = accessOf(location).today;
  const due = (docs.data?.pages.flatMap((p) => p.items) ?? [])
    .filter((d) => !d.supersededById && d.state !== 'ok')
    .sort((a, b) => a.expiresOn.localeCompare(b.expiresOn))[0];
  if (!due) return null;
  const name = docName(due);
  const day = fmt.day(due.expiresOn);
  const days = daysBetween(today, due.expiresOn);
  return (
    <Notice
      tone={due.state === 'expired' ? 'danger' : 'warn'}
      title={
        days < 0 ? (
          <Trans>
            {name} ran out on {day}
          </Trans>
        ) : (
          <Plural
            value={days}
            one={`${name} due in # day, on ${day}`}
            other={`${name} due in # days, on ${day}`}
          />
        )
      }
      action={
        <Button size="small" variant="secondary" onPress={() => nav.go('documents')}>
          <Trans>Open</Trans>
        </Button>
      }
    />
  );
}

/** The odometer card: the latest reading, its age and source, the usage, Log a reading. */
export function OdometerCard() {
  const { thing, location } = useThingCtx();
  const { t } = useLingui();
  const fmt = useFormat();
  const meterName = useMeterName();
  const meter = useMainMeter();
  const [logging, setLogging] = useState(false);
  const latestRow = useReadings(meter?.id ?? '', {
    'f.state': ['accepted'],
    sort: 'takenAt',
    dir: 'desc',
    limit: 1,
  });
  const last = latestRow.data?.pages[0]?.items[0];
  const canLog = accessOf(location).can('logs.add');
  const unitOf = useMeterUnit();
  if (!meter) return null;
  const latest = meter.latest;
  const age = meter.estimate?.ageDays ?? null;
  const unit = unitOf(meter.unit);
  return (
    <Card
      title={meterName(meter)}
      label={meterName(meter)}
      action={
        canLog ? (
          <Button size="small" onPress={() => setLogging(true)}>
            <Trans>Log a reading</Trans>
          </Button>
        ) : null
      }
    >
      {latest ? (
        <div className="grid gap-1">
          <span className="font-semibold text-[24px] text-ink tabular-nums">
            {fmt.num(Number(latest.value))} {unit}
          </span>
          <span className="text-small text-ink-2 [overflow-wrap:anywhere]">
            <LastReadingText ageDays={age} day={fmt.day(latest.takenAt)} />
            {last && Number(last.value) === Number(latest.value) ? (
              <>
                {t`, `}
                <ReadingSourceText source={last.source} by={last.loggedBy} />
              </>
            ) : null}
          </span>
          <span className="text-small text-ink-2">
            <UsageText estimate={meter.estimate} unit={meter.unit} />
          </span>
          <div>
            <AdvicePill estimate={meter.estimate} />
          </div>
        </div>
      ) : (
        <p className="m-0 text-ink-2">
          <Trans>No readings yet. Log the first one to start the estimates.</Trans>
        </p>
      )}
      {canLog ? (
        <LogReadingSheet
          target={
            logging
              ? {
                  thingId: thing.id,
                  thingName: thing.name ?? t`Untitled`,
                  locationId: thing.locationId,
                  meter,
                }
              : null
          }
          onClose={() => setLogging(false)}
        />
      ) : null}
    </Card>
  );
}

/** "Last reading 12 days ago, 2 Oct" (or "today"). */
function LastReadingText({ ageDays, day }: { ageDays: number | null; day: string }) {
  if (ageDays === null || ageDays <= 0) return <Trans>Last reading today, {day}</Trans>;
  return (
    <Plural
      value={ageDays}
      one={`Last reading # day ago, ${day}`}
      other={`Last reading # days ago, ${day}`}
    />
  );
}

/** The schedules, soonest first, each with its estimated date; what the estimates rest on. */
function SchedulesCard() {
  const { thing, location } = useThingCtx();
  const nav = useVehicleNav();
  const fmt = useFormat();
  const meter = useMainMeter();
  const estimated = useEstimatedDates();
  const q = useSubjectSchedules({ thingId: thing.id });
  const today = accessOf(location).today;
  const items = (q.data?.items ?? []).filter((s) => s.active);
  const firstEstimate = items
    .map((s) => estimated.get(s.id))
    .filter((d): d is string => !!d)
    .sort()[0];
  return (
    <Card
      title={<Trans>Schedules</Trans>}
      action={<AllLink count={items.length} onPress={() => nav.go('schedules')} />}
    >
      {q.isPending ? (
        <Skeleton className="h-24" />
      ) : items.length === 0 ? (
        <p className="m-0 text-small text-ink-2">
          <Trans>Nothing scheduled yet. Add the usual ones from the Schedules tab.</Trans>
        </p>
      ) : (
        <List>
          {items.slice(0, 3).map((s) => (
            <li key={s.id}>
              <ScheduleLine schedule={s} today={today} estimatedOn={estimated.get(s.id)} />
            </li>
          ))}
        </List>
      )}
      {meter?.estimate ? (
        <EstimateNote
          ageDays={meter.estimate.ageDays}
          advice={meter.estimate.advice}
          nudgeDays={meter.nudgeDays ?? 30}
          next={firstEstimate ? fmt.day(firstEstimate) : null}
          show={items.some((s) => s.meter)}
        />
      ) : null}
    </Card>
  );
}

export function ScheduleLine({
  schedule: s,
  today,
  estimatedOn,
}: {
  schedule: Schedule;
  today: string;
  estimatedOn: string | undefined;
}) {
  const { t } = useLingui();
  const text = useScheduleText();
  const last = text.last(s);
  return (
    <div className="grid gap-1 px-3.5 py-2.5" data-schedule={s.id}>
      <span className="font-semibold text-[15px] leading-snug text-ink [overflow-wrap:anywhere]">
        <bdi>{s.name}</bdi>
      </span>
      <span className="text-small text-ink-2 [overflow-wrap:anywhere]">
        {text.interval(s)}
        {last ? `${t`, `}${last}` : null}
      </span>
      <div className="flex flex-wrap items-center gap-1.5">
        <ScheduleStatePill state={s.next.state}>{text.due(s, today)}</ScheduleStatePill>
        {estimatedOn ? <EstimatedPill on={estimatedOn} /> : null}
      </div>
    </div>
  );
}

/**
 * "Estimates use the reading from 12 days ago. A fresh one keeps ~14 Nov honest; Kept nudges you
 * at 30 days." With the reading too old, why the dates are gone instead (D188).
 */
export function EstimateNote({
  ageDays,
  advice,
  nudgeDays,
  next,
  show,
}: {
  ageDays: number | null;
  advice: string;
  nudgeDays: number;
  next: string | null;
  show: boolean;
}) {
  if (!show || ageDays === null) return null;
  if (advice === 'unknown')
    return (
      <p className="m-0 flex items-start gap-1.5 text-small text-ink-2">
        <AlertIcon className="mt-0.5 size-3.5 shrink-0 text-danger" />
        <Trans>
          The latest reading is too old to estimate from, so there are no estimated dates. Log a
          reading to bring them back.
        </Trans>
      </p>
    );
  return (
    <p className="m-0 text-small text-ink-3">
      {ageDays <= 0 ? (
        <Trans>Estimates use today's reading.</Trans>
      ) : (
        <Plural
          value={ageDays}
          one="Estimates use the reading from # day ago."
          other="Estimates use the reading from # days ago."
        />
      )}{' '}
      {next ? (
        <Plural
          value={nudgeDays}
          one={`A fresh one keeps ~${next} honest; Kept nudges you at # day.`}
          other={`A fresh one keeps ~${next} honest; Kept nudges you at # days.`}
        />
      ) : (
        <Plural
          value={nudgeDays}
          one="Kept nudges you at # day."
          other="Kept nudges you at # days."
        />
      )}
    </p>
  );
}

/** The vehicle's documents, with their state; "All" opens the Documents tab (T22's). */
function DocumentsCard() {
  const { thing, location } = useThingCtx();
  const { t } = useLingui();
  const nav = useVehicleNav();
  const fmt = useFormat();
  const docName = useDocumentName();
  const docs = useVehicleDocuments(thing.id);
  const today = accessOf(location).today;
  const items = (docs.data?.pages.flatMap((p) => p.items) ?? []).filter((d) => !d.supersededById);
  return (
    <Card
      title={<Trans>Documents</Trans>}
      action={<AllLink count={items.length} onPress={() => nav.go('documents')} />}
    >
      {docs.isPending ? (
        <Skeleton className="h-16" />
      ) : items.length === 0 ? (
        <p className="m-0 text-small text-ink-2">
          <Trans>No documents yet: the licence, the insurance, the registration card.</Trans>
        </p>
      ) : (
        <List aria-label={t`Documents`}>
          {items.slice(0, 3).map((d) => (
            <li key={d.id} className="flex items-start gap-3 px-3.5 py-2.5">
              <DocumentIcon className="mt-0.5 size-4 shrink-0 text-ink-2" />
              <div className="grid min-w-0 flex-1 gap-0.5">
                <span className="font-semibold text-[15px] text-ink [overflow-wrap:anywhere]">
                  <bdi>{docName(d)}</bdi>
                </span>
                <span className="text-small text-ink-2">
                  <Trans>Valid to {fmt.day(d.expiresOn)}</Trans>
                </span>
              </div>
              <DocumentStatePill doc={d} today={today} />
            </li>
          ))}
        </List>
      )}
    </Card>
  );
}

function DocumentStatePill({ doc, today }: { doc: ExpiringDocumentV5; today: string }) {
  const days = daysBetween(today, doc.expiresOn);
  if (doc.state === 'expired')
    return (
      <Pill tone="danger">
        <Trans>Expired</Trans>
      </Pill>
    );
  if (doc.state === 'expiring')
    return (
      <Pill tone="warn">
        {days <= 0 ? (
          <Trans>Due today</Trans>
        ) : (
          <Plural value={days} one="Due in # day" other="Due in # days" />
        )}
      </Pill>
    );
  return (
    <Pill tone="ok">
      <Trans>Valid</Trans>
    </Pill>
  );
}
