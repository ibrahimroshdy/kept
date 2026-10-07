/**
 * The confirmation card (D22, D179, D213; screens §5 "Assistant" and §8, frames 04 · 5 and 5b).
 * One card per batch: the writes one turn proposed. Drawn by Kept from each proposal's `args`,
 * `before` and `refs` (./confirm-rows.ts), never from model text, with a border, a header and
 * controls that chat text never gets, so a "card" written in an answer is just text.
 *
 * - A checkbox per row, all ticked to start; Confirm counts only the ticked rows and sends each
 *   with its `argsHash`. An `add_thing` item (a spoken list) can also be edited, its name and how
 *   many, before confirming (D213); the hash still binds what was proposed.
 * - A countdown to the 10-minute expiry; at zero the card locks as "Expired · ask again".
 * - A row that changed since it was proposed: a card-level conflict with both values and who
 *   changed it; Confirm is unavailable, only Ask again or Cancel (§8).
 * - Confirmed: what was done in Kept's fixed words ("Moved 2× HDMI cable to Garage › Box 3"), with
 *   Undo in step 3's toast, undoing every event the writes recorded, newest first (D150, D213).
 * - Offline, Confirm is disabled with "Needs a connection" (screens §3).
 */
import { plural } from '@lingui/core/macro';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Checkbox, Input, Label, TextField } from 'react-aria-components';
import { assistantApi, assistantKeys } from '@/api/assistant/queries';
import type { ConfirmItem, ConfirmResult, Proposal } from '@/api/assistant/types';
import { useMoney } from '@/components/ai/labels';
import { useOfferUndo } from '@/components/history/undo';
import {
  AlertIcon,
  CheckCircleIcon,
  CheckIcon,
  ClockIcon,
  PencilIcon,
  ShieldCheckIcon,
} from '@/components/icons';
import { useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { isolate } from '@/lib/bidi';
import { useFormat } from '@/lib/format';
import { useOnline } from '@/lib/online';
import { formatLocale, usePrefs } from '@/lib/prefs';
import { cn } from '@/lib/utils';
import { PathText } from './answer';
import {
  type CardRow,
  cardExpiry,
  cardRows,
  type FieldKey,
  type Val,
  type Verb,
} from './confirm-rows';

type Conflict = NonNullable<ConfirmResult['results'][number]['conflict']>;
type Outcome =
  | { kind: 'open' }
  | { kind: 'done'; title: string }
  | { kind: 'conflict'; conflicts: Conflict[] }
  | { kind: 'expired' }
  | { kind: 'cancelled' }
  | { kind: 'failed' };

/** Seconds left, ticking once a second while there are any. */
function useSecondsLeft(until: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [until]);
  return until === null ? null : Math.max(0, Math.ceil((until - now) / 1000));
}

function useVerbLabels(): Record<Verb, string> {
  const { t } = useLingui();
  return {
    move: t`Move`,
    add: t`Add`,
    change: t`Change`,
    seen: t`Seen it`,
    newPlace: t`New place`,
    attach: t`Add a photo or document`,
    reading: t`Log reading`,
    lend: t`Lend`,
    return: t`Return`,
    borrow: t`Borrow`,
    complete: t`Mark done`,
    snooze: t`Snooze`,
    warranty: t`Add warranty`,
    claim: t`Open claim`,
    claimUpdate: t`Update claim`,
    service: t`Log service`,
    fuel: t`Log fill-up`,
    stock: t`Adjust stock`,
    other: t`Change`,
  };
}

function useFieldLabels(): (key: FieldKey, verb: Verb) => string {
  const { t } = useLingui();
  return (key, verb) => {
    switch (key) {
      case 'from':
        return t`From`;
      case 'to':
        return t`To`;
      case 'place':
        return t`Place`;
      case 'under':
        return t`Inside`;
      case 'type':
        return t`Type`;
      case 'brand':
        return t`Brand`;
      case 'model':
        return t`Model`;
      case 'notes':
        return t`Notes`;
      case 'name':
        return t`Name`;
      case 'aliases':
        return t`Also called`;
      case 'condition':
        return t`Condition`;
      case 'custom':
        return t`Field`;
      case 'reading':
        return t`Reading`;
      case 'when':
        return t`Date`;
      case 'person':
        return verb === 'borrow' ? t`Borrowed from` : t`Lent to`;
      case 'due':
        return t`Due back`;
      case 'kind':
        return t`Kind`;
      case 'endsOn':
        return t`Ends`;
      case 'term':
        return t`Months`;
      case 'provider':
        return t`Provider`;
      case 'reference':
        return t`Reference`;
      case 'status':
        return t`Status`;
      case 'vendor':
        return t`Done by`;
      case 'total':
        return t`Total`;
      case 'lines':
        return t`Work`;
      case 'amount':
        return t`Amount`;
      case 'cost':
        return t`Cost`;
      case 'full':
        return t`Full tank`;
      case 'value':
        return t`Reading`;
      case 'until':
        return t`Until`;
      case 'delta':
        return t`Change in stock`;
      case 'quantity':
        return t`How many`;
    }
  };
}

function ValueView({ v }: { v: Val }) {
  const { t, i18n } = useLingui();
  const f = useFormat();
  const money = useMoney();
  switch (v.t) {
    case 'text':
      return v.v ? <bdi>{v.v}</bdi> : <span className="text-ink-3">{t`Nothing`}</span>;
    case 'path':
      return (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          {v.isNew ? (
            <span className="rounded-full border border-info px-1.5 text-[11.5px] text-info">
              <Trans>New place</Trans>
            </span>
          ) : null}
          <PathText parts={v.v} />
        </span>
      );
    case 'num':
      return (
        <span className="font-mono text-[13px] tabular-nums">
          {f.num(v.v)}
          {v.unit ? ` ${v.unit}` : ''}
        </span>
      );
    case 'date':
      return <span>{f.day(v.v)}</span>;
    case 'money':
      return (
        <span className="font-mono text-[13px] tabular-nums">{money(v.amount, v.currency)}</span>
      );
    case 'yes':
      return <span>{v.v ? t`Yes` : t`No`}</span>;
    case 'list':
      return v.v.length ? (
        <bdi>{new Intl.ListFormat(i18n.locale, { type: 'conjunction' }).format(v.v)}</bdi>
      ) : (
        <span className="text-ink-3">{t`Nothing`}</span>
      );
  }
}

/** "2 of 3 ×" or "2 ×". */
function Count({ n, of }: { n: number; of?: number | undefined }) {
  const f = useFormat();
  const count = f.num(n);
  const total = of === undefined ? '' : f.num(of);
  return (
    <span className="font-normal text-ink-2">
      {of === undefined ? (
        <Trans>{count} ×</Trans>
      ) : (
        <Trans>
          {count} of {total} ×
        </Trans>
      )}
    </span>
  );
}

function TargetView({ row, onNavigate }: { row: CardRow; onNavigate?: () => void }) {
  const { t } = useLingui();
  const target = row.target;
  if (!target) return <span className="text-ink-2">{t`Something Kept can't name`}</span>;
  if (target.kind === 'new') return <bdi>{target.name}</bdi>;
  const cls =
    'text-ink underline decoration-ink-3 decoration-1 underline-offset-[3px] outline-none focus-visible:outline-2 focus-visible:outline-info';
  return target.kind === 'thing' ? (
    <Link to="/t/$id" params={{ id: target.id }} className={cls} onClick={onNavigate}>
      <bdi>{target.name}</bdi>
    </Link>
  ) : (
    <Link to="/p/$id" params={{ id: target.id }} className={cls} onClick={onNavigate}>
      <bdi>{target.name}</bdi>
    </Link>
  );
}

type Edit = { name: string; quantity: string };

function Row({
  row,
  ticked,
  onTick,
  locked,
  edit,
  onEdit,
  onNavigate,
}: {
  row: CardRow;
  ticked: boolean;
  onTick: (v: boolean) => void;
  locked: boolean;
  edit: Edit | null;
  onEdit: (e: Edit | null) => void;
  onNavigate?: () => void;
}) {
  const { t } = useLingui();
  const verbs = useVerbLabels();
  const label = useFieldLabels();
  const nav = onNavigate ? { onNavigate } : {};
  const editing = edit !== null;
  const name = edit?.name ?? row.editable?.name ?? '';
  const title = (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 font-semibold text-[14.5px] leading-snug">
      <span className="font-semibold text-[11.5px] text-ink-3 uppercase tracking-[.06em]">
        {verbs[row.verb]}
      </span>
      {row.count ? <Count n={row.count.n} of={row.count.of} /> : null}
      <TargetView row={row} {...nav} />
    </span>
  );
  const fieldList = row.fields.length ? (
    <dl className="m-0 mt-2 grid grid-cols-[auto_1fr] gap-x-2.5 gap-y-1.5 text-[13.5px] leading-snug">
      {row.fields.map((field, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a row's fields, in order
        <div key={i} className="contents">
          <dt className="pt-px text-[12.5px] text-ink-3">{label(field.key, row.verb)}</dt>
          <dd className="m-0 [overflow-wrap:anywhere]">
            {field.before ? (
              <>
                <span className="text-ink-2">
                  <ValueView v={field.before} />
                </span>
                <span aria-hidden="true" className="mx-1 text-ink-3">
                  →
                </span>
                <span className="sr-only">{t`to`} </span>
              </>
            ) : null}
            <b className="font-semibold">
              <ValueView v={field.after} />
            </b>
          </dd>
        </div>
      ))}
      <div className="contents">
        <dt className="pt-px text-[12.5px] text-ink-3">{t`Location`}</dt>
        <dd className="m-0 [overflow-wrap:anywhere]">
          <bdi>{row.location.from}</bdi>
          {row.location.to ? (
            <>
              <span aria-hidden="true" className="mx-1 text-ink-3">
                →
              </span>
              <span className="sr-only">{t`to`} </span>
              <bdi>{row.location.to}</bdi>
            </>
          ) : null}
        </dd>
      </div>
    </dl>
  ) : (
    <dl className="m-0 mt-2 grid grid-cols-[auto_1fr] gap-x-2.5 text-[13.5px]">
      <dt className="text-[12.5px] text-ink-3">{t`Location`}</dt>
      <dd className="m-0">
        <bdi>{row.location.from}</bdi>
      </dd>
    </dl>
  );

  return (
    <li
      data-card-row=""
      className={cn(
        'grid border-line border-t',
        locked ? 'px-3 py-2.5' : 'grid-cols-[44px_1fr] gap-x-0.5 py-1.5 pe-3 ps-0.5',
      )}
    >
      {locked ? null : (
        <Checkbox
          isSelected={ticked}
          onChange={onTick}
          aria-label={t`Include: ${verbs[row.verb]} ${isolate(row.target?.name ?? '')}`}
          className="group grid size-11 cursor-pointer place-items-center outline-none data-focus-visible:outline-2 data-focus-visible:outline-info"
        >
          {({ isSelected }) => (
            <span
              aria-hidden="true"
              className={cn(
                'grid size-[22px] place-items-center rounded-[5px] border-2 [&_svg]:size-[15px]',
                isSelected ? 'border-ink bg-ink text-paper' : 'border-ink-3 bg-surface',
              )}
            >
              {isSelected ? <CheckIcon strokeWidth="2.6" /> : null}
            </span>
          )}
        </Checkbox>
      )}
      <div className={cn('min-w-0', !locked && 'pt-2.5')}>
        {editing ? (
          <div className="grid gap-2">
            <TextField
              value={name}
              onChange={(v) => onEdit({ name: v, quantity: edit.quantity })}
              maxLength={200}
              isRequired
              className="grid gap-1"
            >
              <Label className="text-[12.5px] text-ink-3">{t`Name`}</Label>
              <Input
                dir="auto"
                className="min-h-11 rounded-lg border border-line bg-paper px-3 text-[15px] text-ink outline-none focus:border-ink"
              />
            </TextField>
            <TextField
              value={edit.quantity}
              onChange={(v) => onEdit({ name, quantity: v.replace(/[^0-9٠-٩]/g, '') })}
              inputMode="numeric"
              className="grid gap-1"
            >
              <Label className="text-[12.5px] text-ink-3">{t`How many`}</Label>
              <Input className="min-h-11 w-28 rounded-lg border border-line bg-paper px-3 font-mono text-[15px] text-ink outline-none focus:border-ink" />
            </TextField>
          </div>
        ) : (
          title
        )}
        {fieldList}
        {row.editable && !locked ? (
          <Button
            variant="ghost"
            className="-ms-2 mt-1"
            onPress={() =>
              onEdit(
                editing
                  ? null
                  : {
                      name: row.editable?.name ?? '',
                      quantity: String(row.editable?.quantity ?? 1),
                    },
              )
            }
          >
            {editing ? (
              <Trans>Done</Trans>
            ) : (
              <>
                <PencilIcon className="size-4" />
                <Trans>Edit</Trans>
              </>
            )}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

/** Digits as the reader reads them ("٩:٤٨" in Arabic with Eastern digits). */
function useClockText(): (seconds: number) => string {
  const { locale, digits } = usePrefs();
  return (s) => {
    const tag = formatLocale(locale, digits);
    const mm = new Intl.NumberFormat(tag).format(Math.floor(s / 60));
    const ss = new Intl.NumberFormat(tag, { minimumIntegerDigits: 2 }).format(s % 60);
    return `${mm}:${ss}`;
  };
}

const toNumber = (s: string): number =>
  Number(s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)));

function initialOutcome(proposals: readonly Proposal[]): Outcome {
  const statuses = new Set(proposals.map((p) => p.status));
  if (statuses.has('open')) return { kind: 'open' };
  if (statuses.has('conflict')) {
    const conflicts = proposals.flatMap((p) => {
      const c = (p.result as { conflict?: Conflict } | undefined)?.conflict;
      return c ? [c] : [];
    });
    return { kind: 'conflict', conflicts };
  }
  if (statuses.has('confirmed')) return { kind: 'done', title: '' };
  if (statuses.has('expired')) return { kind: 'expired' };
  if (statuses.has('cancelled')) return { kind: 'cancelled' };
  return { kind: 'failed' };
}

export function ConfirmCard({
  proposals,
  onAskAgain,
  onNavigate,
}: {
  /** One batch's proposals. */
  proposals: Proposal[];
  /** Ask the turn's question again (expired or changed since). */
  onAskAgain?: () => void;
  onNavigate?: () => void;
}) {
  const { t, i18n } = useLingui();
  const online = useOnline();
  const qc = useQueryClient();
  const offerUndo = useOfferUndo();
  const errorText = useErrorText();
  const f = useFormat();
  const clock = useClockText();
  const rows = useMemo(() => cardRows(proposals), [proposals]);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set(rows.map((r) => r.key)));
  const [edits, setEdits] = useState<Record<string, Edit | null>>({});
  const [outcome, setOutcome] = useState<Outcome>(() => initialOutcome(proposals));
  const batchId = proposals[0]?.batchId ?? '';
  const left = useSecondsLeft(outcome.kind === 'open' ? cardExpiry(proposals) : null);
  const expired = outcome.kind === 'expired' || (outcome.kind === 'open' && left === 0);
  const state: Outcome['kind'] = expired ? 'expired' : outcome.kind;
  const locked = state !== 'open';
  const count = rows.filter((r) => ticked.has(r.key)).length;
  const editsValid = Object.entries(edits).every(
    ([, e]) => !e || (e.name.trim() !== '' && toNumber(e.quantity) >= 1),
  );

  const invalidate = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: assistantKeys.all }),
      qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'assistant' }),
    ]);

  /** "Moved 2× HDMI cable to Garage › Box 3", "Added Drill, Ladder and 2× Paint can". */
  const summary = (done: CardRow[]): string => {
    const nameOf = (r: CardRow) => {
      const e = edits[r.key];
      const name = e?.name.trim() || (r.target?.name ?? '');
      const n = e ? toNumber(e.quantity) : (r.count?.n ?? 1);
      return n > 1 ? t`${f.num(n)}× ${isolate(name)}` : isolate(name);
    };
    if (done.length > 0 && done.every((r) => r.verb === 'add'))
      return t`Added ${new Intl.ListFormat(i18n.locale, { type: 'conjunction' }).format(done.map(nameOf))}`;
    const one = done[0];
    if (done.length === 1 && one?.verb === 'move') {
      const to = one.fields.find((x) => x.key === 'to')?.after;
      const where = to?.t === 'path' ? isolate(to.v.join(' › ')) : '';
      return where ? t`Moved ${nameOf(one)} to ${where}` : t`Moved ${nameOf(one)}`;
    }
    return plural(done.length, { one: 'Saved # change', other: 'Saved # changes' });
  };

  const confirm = useMutation({
    mutationFn: () => {
      const byProposal = new Map<string, CardRow[]>();
      for (const r of rows)
        if (ticked.has(r.key))
          byProposal.set(r.proposalId, [...(byProposal.get(r.proposalId) ?? []), r]);
      return assistantApi.confirm(
        {
          batchId,
          proposals: proposals
            .filter((p) => byProposal.has(p.id))
            .map((p) => {
              const kept = byProposal.get(p.id) ?? [];
              const all = rows.filter((r) => r.proposalId === p.id);
              const edited = kept.some((r) => edits[r.key]);
              if (p.tool !== 'add_thing' || (kept.length === all.length && !edited))
                return { id: p.id, argsHash: p.argsHash };
              const items: ConfirmItem[] = kept.map((r) => {
                const e = edits[r.key];
                return {
                  index: r.item ?? 0,
                  ...(e ? { name: e.name.trim(), quantity: toNumber(e.quantity) } : {}),
                };
              });
              return { id: p.id, argsHash: p.argsHash, items };
            }),
        },
        i18n.locale,
      );
    },
    onSuccess: async (res) => {
      const confirmed = res.results.filter((r) => r.status === 'confirmed');
      const conflicts = res.results.flatMap((r) => (r.conflict ? [r.conflict] : []));
      const done = rows.filter(
        (r) => ticked.has(r.key) && confirmed.some((c) => c.id === r.proposalId),
      );
      if (confirmed.length) {
        const title = summary(done);
        const events = confirmed.flatMap((r) =>
          r.audit ? (r.audit.eventIds ?? [r.audit.eventId]) : [],
        );
        const thing = done.find((r) => r.target?.kind === 'thing')?.target;
        offerUndo({ title }, events, thing && 'id' in thing ? { thingId: thing.id } : {});
        setOutcome({ kind: 'done', title });
      }
      if (conflicts.length) setOutcome({ kind: 'conflict', conflicts });
      else if (!confirmed.length && res.results.some((r) => r.status === 'expired'))
        setOutcome({ kind: 'expired' });
      else if (!confirmed.length) setOutcome({ kind: 'failed' });
      if (res.results.some((r) => r.status === 'failed'))
        toast({ title: t`Some changes couldn't be saved. Ask again.`, tone: 'danger' });
      await invalidate();
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });

  const cancel = useMutation({
    mutationFn: () => assistantApi.cancelProposals({ batchId }),
    onSuccess: async () => {
      setOutcome({ kind: 'cancelled' });
      await qc.invalidateQueries({ queryKey: assistantKeys.all });
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });

  const n = rows.length;
  const head: { icon: ReactNode; title: ReactNode; sub: ReactNode; tone: string } =
    state === 'expired'
      ? {
          icon: <ClockIcon />,
          title: <Trans>Expired · ask again</Trans>,
          sub: <Trans>Nothing was changed</Trans>,
          tone: 'border-line',
        }
      : state === 'conflict'
        ? {
            icon: <AlertIcon />,
            title: <Trans>Changed since you asked</Trans>,
            sub: <Trans>Nothing was changed</Trans>,
            tone: 'border-warn',
          }
        : state === 'done'
          ? {
              icon: <CheckCircleIcon />,
              title:
                outcome.kind === 'done' && outcome.title ? outcome.title : <Trans>Saved</Trans>,
              sub: <Trans>Undo it from Activity for 7 days</Trans>,
              tone: 'border-ok',
            }
          : state === 'cancelled'
            ? {
                icon: <CheckCircleIcon />,
                title: <Trans>Cancelled</Trans>,
                sub: <Trans>Nothing was changed</Trans>,
                tone: 'border-line',
              }
            : state === 'failed'
              ? {
                  icon: <AlertIcon />,
                  title: <Trans>Not saved</Trans>,
                  sub: <Trans>Ask again to try once more</Trans>,
                  tone: 'border-danger',
                }
              : {
                  icon: <ShieldCheckIcon />,
                  title: <Plural value={n} one="Confirm # change" other="Confirm # changes" />,
                  sub: <Trans>Only ticked rows are saved</Trans>,
                  tone: 'border-ink',
                };

  return (
    // A labelled group (fieldset), not a region: a thread holds several cards, and landmarks must have
    // names of their own (axe landmark-unique). A settled card isn't faded: its small grey text
    // would fall below 4.5:1 (UI review steps 6–8, M1–M2); its header says it's settled.
    <fieldset
      data-confirm-card=""
      aria-label={t`Changes for you to confirm, drawn by Kept`}
      className={cn(
        'grid overflow-hidden rounded-xl border-[1.5px] bg-surface text-ink',
        head.tone,
      )}
    >
      <header className="flex items-center gap-2 bg-sunken px-3 py-2.5 [&>svg]:size-5 [&>svg]:shrink-0">
        {head.icon}
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="font-semibold text-[14px] leading-snug [overflow-wrap:anywhere]">
            {head.title}
          </span>
          <span className="text-[11.5px] text-ink-3">{head.sub}</span>
        </span>
        {state === 'open' && left !== null ? (
          <span
            className="ms-auto inline-flex shrink-0 items-center gap-1 font-mono text-[12.5px] text-ink-2 tabular-nums [&_svg]:size-[15px]"
            role="timer"
            aria-label={t`Time left to confirm`}
          >
            <ClockIcon />
            <span dir="ltr">{clock(left)}</span>
          </span>
        ) : null}
      </header>

      {state === 'conflict' && outcome.kind === 'conflict' && outcome.conflicts.length ? (
        <div className="grid gap-2 border-line border-t px-3 py-2.5 text-[13.5px]">
          {outcome.conflicts.map((c, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: one per conflicted row
            <ConflictLine key={i} conflict={c} proposals={proposals} />
          ))}
        </div>
      ) : null}

      {state === 'done' ? null : (
        <ul className="m-0 grid list-none p-0">
          {rows.map((row) => (
            <Row
              key={row.key}
              row={row}
              ticked={ticked.has(row.key)}
              onTick={(v) =>
                setTicked((s) => {
                  const next = new Set(s);
                  if (v) next.add(row.key);
                  else next.delete(row.key);
                  return next;
                })
              }
              locked={locked}
              edit={edits[row.key] ?? null}
              onEdit={(e) => setEdits((all) => ({ ...all, [row.key]: e }))}
              {...(onNavigate ? { onNavigate } : {})}
            />
          ))}
        </ul>
      )}

      {state === 'open' ? (
        <footer className="grid gap-2 border-line border-t p-3">
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="primary"
              isDisabled={!online || count === 0 || !editsValid || cancel.isPending}
              isPending={confirm.isPending}
              onPress={() => confirm.mutate()}
            >
              <Plural value={count} one="Confirm #" other="Confirm #" />
            </Button>
            <Button
              variant="secondary"
              isDisabled={!online || confirm.isPending}
              isPending={cancel.isPending}
              onPress={() => cancel.mutate()}
            >
              <Trans>Cancel</Trans>
            </Button>
          </div>
          {!online ? (
            <p className="m-0 text-small text-ink-2">
              <Trans>Needs a connection</Trans>
            </p>
          ) : null}
        </footer>
      ) : state === 'expired' || state === 'conflict' || state === 'failed' ? (
        <footer
          className={cn(
            'grid gap-2 border-line border-t p-3',
            state === 'conflict' ? 'grid-cols-2' : 'grid-cols-1',
          )}
        >
          {onAskAgain ? (
            <Button variant="secondary" isDisabled={!online} onPress={onAskAgain}>
              <Trans>Ask again</Trans>
            </Button>
          ) : null}
          {state === 'conflict' ? (
            <Button
              variant="secondary"
              isDisabled={!online}
              isPending={cancel.isPending}
              onPress={() => cancel.mutate()}
            >
              <Trans>Cancel</Trans>
            </Button>
          ) : null}
        </footer>
      ) : null}
    </fieldset>
  );
}

/** "Bruce changed it: Cable box when you asked, Box 3 now" (frame 04 · 5b). */
function ConflictLine({ conflict, proposals }: { conflict: Conflict; proposals: Proposal[] }) {
  const refs = Object.assign({}, ...proposals.map((p) => p.refs ?? {})) as Proposal['refs'];
  const show = (v: unknown): Val => {
    if (typeof v === 'number') return { t: 'num', v };
    if (typeof v === 'string') {
      const r = refs[v];
      return r ? { t: 'path', v: [...r.path, r.name] } : { t: 'text', v };
    }
    return { t: 'text', v: v === null || v === undefined ? '' : JSON.stringify(v) };
  };
  // When the card's own fields still match and only the thing's version moved on, the server
  // sends `rowVersion` (or `thing`): the two numbers mean nothing to a person, so only who
  // changed it is said (UI review steps 6–8, M3).
  const internal = conflict.field === 'rowVersion' || conflict.field === 'thing';
  return (
    <div className="grid gap-1">
      {conflict.by ? (
        <p className="m-0 text-ink-2">
          <Trans>
            <bdi>{conflict.by}</bdi> changed it since
          </Trans>
        </p>
      ) : null}
      {internal ? null : (
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-2.5 gap-y-1">
          <dt className="text-[12.5px] text-ink-3">
            <Trans>When you asked</Trans>
          </dt>
          <dd className="m-0">
            <ValueView v={show(conflict.before)} />
          </dd>
          <dt className="text-[12.5px] text-ink-3">
            <Trans>Now</Trans>
          </dt>
          <dd className="m-0 font-semibold">
            <ValueView v={show(conflict.now)} />
          </dd>
        </dl>
      )}
    </div>
  );
}
