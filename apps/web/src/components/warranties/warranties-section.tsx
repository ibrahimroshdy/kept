/**
 * Warranties on the thing page (screens §5 "Paperwork and warranties", D53, D195): the longest
 * cover first (the server's order), each active one with its coverage bar, the one that covers
 * longest marked. A warranty covers one thing, so a quantity above 1 is split first (D10, Q26).
 * The Warranties module off: "Off in this location" (screens §3); a viewer only reads.
 */
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { useWarranties } from '@/api/household/queries';
import type { Warranty } from '@/api/household/types';
import { ShieldCheckIcon } from '@/components/icons';
import { EmptyState, ErrorState, LoadingRows, Pill, type PillTone } from '@/components/page';
import { ModuleOff, useThingCtx } from '@/components/things/context';
import { todayIn, useBlocked } from '@/components/things/household';
import { Bidi } from '@/components/things/values';
import { Button } from '@/components/ui/button';
import { sep, useFormat } from '@/lib/format';
import { CoverageBar } from './coverage-bar';
import { useTermText, useWarrantyKindLabels } from './labels';
import { WarrantySheet } from './warranty-sheet';

export function WarrantiesBlock() {
  const { thing, can, moduleOn, location } = useThingCtx();
  const { t } = useLingui();
  const fmt = useFormat();
  const blocked = useBlocked();
  const on = moduleOn('warranties');
  const q = useWarranties(on ? thing.id : '');
  const [open, setOpen] = useState<Warranty | 'new' | null>(null);
  const edit = can('things.edit');
  if (!on) return edit ? <ModuleOff what={<Trans>Warranties</Trans>} /> : null;
  const items = q.data?.items ?? [];
  const today = todayIn(location.timezone);
  const count = items.length;
  return (
    <section className="grid gap-2" aria-labelledby="thing-warranties">
      <div className="flex min-h-8 items-center justify-between gap-2">
        <h3 id="thing-warranties" className="m-0 font-semibold text-[15px] text-ink">
          {count ? t`Warranties · ${fmt.num(count)}` : t`Warranties`}
        </h3>
        {edit && thing.quantity === 1 ? (
          <Button
            size="small"
            variant="secondary"
            isDisabled={!!blocked}
            onPress={() => setOpen('new')}
          >
            <Trans>Add</Trans>
          </Button>
        ) : null}
      </div>
      {blocked && edit ? <p className="m-0 text-small text-ink-3">{blocked}</p> : null}
      {q.isPending ? (
        <LoadingRows rows={2} label={t`Loading the warranties`} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : count === 0 ? (
        <EmptyState icon={<ShieldCheckIcon />} title={<Trans>No warranties yet</Trans>}>
          {thing.quantity > 1 ? (
            <Trans>A warranty covers one thing: split this one first to add one.</Trans>
          ) : (
            <Trans>The maker's, the shop's, an extended one: each with its own end date.</Trans>
          )}
        </EmptyState>
      ) : (
        <ul className="m-0 grid list-none gap-2 p-0">
          {items.map((w) => (
            <li key={w.id}>
              <WarrantyCard
                warranty={w}
                longest={q.data?.coverage.longestId === w.id && count > 1}
                today={today}
                {...(edit && !blocked ? { onEdit: () => setOpen(w) } : {})}
              />
            </li>
          ))}
        </ul>
      )}
      {edit ? <WarrantySheet warranty={open} onClose={() => setOpen(null)} /> : null}
    </section>
  );
}

function WarrantyCard({
  warranty: w,
  longest,
  today,
  onEdit,
}: {
  warranty: Warranty;
  longest: boolean;
  today: string;
  onEdit?: () => void;
}) {
  const { thing } = useThingCtx();
  const { t } = useLingui();
  const fmt = useFormat();
  const kinds = useWarrantyKindLabels();
  const boughtOn = thing.purchase?.purchasedOn ?? null;
  const term = useTermText();
  const end = w.effectiveEndsOn ? fmt.day(w.effectiveEndsOn) : null;
  const pill: { tone: PillTone; text: string } = w.lifetime
    ? { tone: 'ok', text: t`Lifetime` }
    : w.state === 'ended'
      ? { tone: 'neutral', text: t`Ended ${end ?? ''}` }
      : w.state === 'expiring'
        ? { tone: 'warn', text: t`Ends ${end ?? ''}` }
        : { tone: 'ok', text: t`Covered to ${end ?? ''}` };
  const started = fmt.day(w.startsOn);
  const length = w.lifetime
    ? t`for life, from ${started}`
    : w.termMonths
      ? t`${term(w.termMonths)} from ${started}`
      : t`from ${started}`;
  const deadline = w.registrationDeadline ? fmt.day(w.registrationDeadline) : null;
  return (
    <article className="grid gap-2 rounded-[10px] border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={pill.tone}>{pill.text}</Pill>
        {longest ? (
          <span className="eyebrow">
            <Trans>Longest cover</Trans>
          </span>
        ) : null}
        {onEdit ? (
          <Button size="small" variant="ghost" className="ms-auto" onPress={onEdit}>
            <Trans>Edit</Trans>
          </Button>
        ) : null}
      </div>
      <div className="font-semibold text-[15px] text-ink">{kinds[w.kind]}</div>
      <p className="m-0 text-small text-ink-2 [overflow-wrap:anywhere]">
        {w.provider ? (
          <>
            <Bidi>{w.provider}</Bidi>
            {sep()}
          </>
        ) : null}
        {length}
        {w.claimContact ? (
          <>
            {sep()}
            <Trans>claims:</Trans> <Bidi>{w.claimContact}</Bidi>
          </>
        ) : null}
        {w.documents.length ? (
          <>
            {sep()}
            {plural(w.documents.length, { one: '# document', other: '# documents' })}
          </>
        ) : null}
      </p>
      {!w.registered && deadline ? (
        <p className="m-0 text-small text-warn">
          <Trans>Not registered yet · register by {deadline}</Trans>
        </p>
      ) : null}
      {w.state !== 'ended' ? (
        <CoverageBar
          boughtOn={boughtOn}
          startsOn={w.startsOn}
          endsOn={w.effectiveEndsOn}
          today={today}
        />
      ) : null}
    </article>
  );
}
