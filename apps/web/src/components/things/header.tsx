/**
 * The thing's header (screens §5 Thing detail): the photos, the ID chip, the full path, the
 * derived-state pills and the lifecycle when it has ended. The name is the page's heading. User
 * text is isolated (`<bdi>`, `dir="auto"`), so an Arabic box name inside an English path keeps
 * its shape; the ID chip is always left to right (§8).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';
import { Fragment } from 'react';
import type { PathStep } from '@/api/inventory/types';
import { ExtractionStatus } from '@/components/ai/extraction-status';
import { ChevronEndIcon, ClockIcon } from '@/components/icons';
import { IdChip } from '@/components/id-chip';
import { useLoanText } from '@/components/lending/loan-text';
import { Pill } from '@/components/page';
import { usePlaceName } from '@/components/places/labels';
import { StatusPill } from '@/components/status-pill';
import { TypeIcon } from '@/components/type-icon';
import { addressOf } from '@/lib/address';
import { sep, useFormat } from '@/lib/format';
import { useLocationName } from '@/lib/labels';
import { cn } from '@/lib/utils';
import { useThingCtx } from './context';
import { useFresh } from './fresh';
import { useLifecycleLabels } from './labels';
import { useTypeName } from './names';
import { PhotoCarousel } from './photos';

export function ThingPath({ path, usually = false }: { path: PathStep[]; usually?: boolean }) {
  const { location } = useThingCtx();
  const { t } = useLingui();
  const locationName = useLocationName();
  const placeName = usePlaceName();
  return (
    <nav
      aria-label={usually ? t`Where it usually is` : t`Where it is`}
      className="text-small text-ink-2"
    >
      <ol className="m-0 flex list-none flex-wrap items-center gap-1 p-0">
        {/* Lent or in repair, the place is where it lives, not where it is (screens §8). */}
        {usually ? (
          <li className="text-ink-3">
            <Trans>Usually in</Trans>
          </li>
        ) : null}
        <li>
          <Link
            to="/loc/$id"
            params={{ id: location.id }}
            className="underline-offset-2 hover:underline"
          >
            <bdi>{locationName(location)}</bdi>
          </Link>
        </li>
        {path.map((step) => (
          <Fragment key={step.id}>
            <li aria-hidden="true" className="text-ink-3">
              <ChevronEndIcon className="size-3.5" />
            </li>
            <li>
              <Link
                to={step.kind === 'container' ? '/t/$id' : '/p/$id'}
                params={{
                  id:
                    step.kind === 'container'
                      ? step.id
                      : addressOf({ id: step.id, shortCode: step.shortCode }),
                }}
                className="underline-offset-2 hover:underline"
              >
                <bdi>{placeName(step)}</bdi>
              </Link>
            </li>
          </Fragment>
        ))}
      </ol>
    </nav>
  );
}

export function ThingHeader() {
  const { thing, location, can, moduleOn } = useThingCtx();
  const fmt = useFormat();
  const lifecycle = useLifecycleLabels();
  const typeName = useTypeName();
  const fresh = useFresh(thing.id);
  const loanText = useLoanText();
  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] md:items-start">
      <PhotoCarousel />
      <div className="grid content-start gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <IdChip code={thing.shortCode} size="large" fresh={fresh} />
          <span className="inline-flex items-center gap-1.5 text-small text-ink-2">
            <TypeIcon icon={thing.type?.icon} className="size-4" />
            {typeName(thing.type)}
          </span>
        </div>
        <ThingPath
          path={thing.path}
          usually={thing.derivedState.includes('lent') || thing.derivedState.includes('in_repair')}
        />
        <div className="flex flex-wrap gap-1.5">
          {thing.derivedState.map((s) =>
            s === 'ended' ? (
              <StatusPill key={s} state="ended" label={lifecycle[thing.lifecycle]} />
            ) : (s === 'lent' || s === 'borrowed') && thing.loanLine ? (
              // "With Murdock since 3 Oct · due 17 Oct" (D57): the loan in the path, everywhere.
              <StatusPill
                key={s}
                state={s}
                className={cn('max-w-full', thing.loanLine.overdue && 'border-danger text-danger')}
                label={
                  thing.loanLine.overdue ? (
                    <Trans>{loanText.line(thing.loanLine)} · overdue</Trans>
                  ) : (
                    loanText.line(thing.loanLine)
                  )
                }
              />
            ) : s === 'in_repair' ? (
              // "At Samsung Service Centre" (D54, screens §8).
              <StatusPill
                key={s}
                state={s}
                className="max-w-full"
                {...(thing.repairAt?.vendorName
                  ? {
                      label: (
                        <Trans>
                          At <bdi>{thing.repairAt.vendorName}</bdi>
                        </Trans>
                      ),
                    }
                  : {})}
              />
            ) : (
              <StatusPill key={s} state={s} />
            ),
          )}
          {thing.quantity !== 1 ? (
            <Pill>
              <Trans>× {fmt.num(thing.quantity)}</Trans>
            </Pill>
          ) : null}
          {thing.lastSeenAt ? (
            <Pill icon={<ClockIcon />}>
              <Trans>Seen {fmt.relative(thing.lastSeenAt)}</Trans>
            </Pill>
          ) : null}
        </div>
        {thing.ended ? <EndedLine /> : null}
        <ExtractionStatus
          thingId={thing.id}
          locationId={location.id}
          canRerun={can('ai.capture') && moduleOn('ai_capture')}
        />
      </div>
    </div>
  );
}

function EndedLine() {
  const { thing } = useThingCtx();
  const fmt = useFormat();
  const lifecycle = useLifecycleLabels();
  const e = thing.ended;
  if (!e) return null;
  return (
    <p className="m-0 text-small text-ink-2">
      <span className="font-semibold text-ink">{lifecycle[thing.lifecycle]}</span>
      {e.on ? (
        <>
          {sep()}
          {fmt.day(e.on)}
        </>
      ) : null}
      {e.to ? (
        <>
          {sep()}
          <Trans>to</Trans> <bdi>{e.to}</bdi>
        </>
      ) : null}
      {e.notes ? (
        <>
          {sep()}
          <bdi>{e.notes}</bdi>
        </>
      ) : null}
    </p>
  );
}
