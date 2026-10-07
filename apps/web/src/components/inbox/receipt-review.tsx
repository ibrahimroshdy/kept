/**
 * Receipt review (D11, D19, D36; screens §5 "Inbox", the 7a frame): the pages, the shop (one you
 * have, or a new one made here, with a hint when the name is close to one you have), the date,
 * the currency (no preselection when the mark was ambiguous, D189), the total and tax (money
 * hidden → "Prices hidden"), and each line: link it to a thing already captured (the J2 order:
 * the photo came first), make a new thing from it, or skip it. "Lines don't add up" when they
 * miss the total by more than 1%. Everything was read by AI, so nothing is written until Accept.
 */
import { normalize } from '@kept/shared';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Radio, RadioGroup } from 'react-aria-components';
import { captureApi, useInboxCandidates } from '@/api/capture/queries';
import type {
  InboxItem,
  InboxReceiptBody,
  ReceiptLine,
  ReceiptLineAction,
} from '@/api/capture/types';
import { inventoryApi } from '@/api/inventory/queries';
import { IdChip } from '@/components/id-chip';
import { Notice, Pill } from '@/components/page';
import { CurrencyPicker, RegistryPicker } from '@/components/things/pickers';
import { useMoney } from '@/components/things/values';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { TextField } from '@/components/ui/text-field';
import { sep, useFormat } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useInboxRun } from './actions';
import type { ItemProps } from './item-card';
import { type Blocked, BlockedReason, batchTarget, ItemShell, Thumb, useItemKeys } from './shell';
import { SuggestedMark } from './suggested-field';

type LineChoice = { action: ReceiptLineAction; thingId?: string };
const AMOUNT = /^\d+(\.\d{1,4})?$/;

export function ReceiptReview({ item, location, current, blocked }: ItemProps) {
  const { t } = useLingui();
  const money = useMoney();
  const { run, busy } = useInboxRun();
  const r = item.receipt;
  const accountId = location?.ownerAccountId ?? '';
  const vendors = useQuery({
    queryKey: ['registry', 'vendors', accountId, { limit: 200 }],
    queryFn: () => inventoryApi.registry('vendors', accountId, { limit: 200 }),
    enabled: !!accountId,
  });
  const seen = r?.vendorSeen ?? '';
  const known = (vendors.data?.items ?? []).find(
    (v) => !!seen && normalize(v.name) === normalize(seen),
  );
  const [vendorId, setVendorId] = useState<string | null>(null);
  const [newVendor, setNewVendor] = useState(seen);
  const [vendorMode, setVendorMode] = useState<'existing' | 'new' | null>(null);
  const mode = vendorMode ?? (known ? 'existing' : 'new');
  const chosenVendor = vendorId ?? (mode === 'existing' ? (known?.id ?? null) : null);
  const [purchasedOn, setPurchasedOn] = useState<string | null>(r?.purchasedOn ?? null);
  const [currency, setCurrency] = useState<string | null>(r?.currency ?? null);
  const [total, setTotal] = useState(r?.total ?? '');
  const [tax, setTax] = useState(r?.tax ?? '');
  const [lines, setLines] = useState<Record<number, LineChoice>>({});
  const linesRef = useRef<HTMLDivElement>(null);
  // Answered in its "Needs a currency" item (D189): the purchase now has the currency, and the
  // amounts that waited for it. Fill what the person hasn't set here; never overwrite it.
  const answeredCurrency = r?.currency ?? null;
  const answeredTotal = r?.total ?? '';
  const answeredTax = r?.tax ?? '';
  useEffect(() => {
    if (answeredCurrency) setCurrency((c) => c ?? answeredCurrency);
  }, [answeredCurrency]);
  useEffect(() => {
    if (answeredTotal) setTotal((v) => v || answeredTotal);
  }, [answeredTotal]);
  useEffect(() => {
    if (answeredTax) setTax((v) => v || answeredTax);
  }, [answeredTax]);

  // A new shop whose name is close to one you have: offer that one instead (D11).
  const typed = normalize(newVendor.trim());
  const nearby =
    mode === 'new' && typed
      ? (vendors.data?.items ?? []).find((v) => {
          const n = normalize(v.name);
          return n === typed || n.includes(typed) || typed.includes(n);
        })
      : undefined;

  const hidden = !!r?.moneyHidden;
  const links = Object.values(lines).filter((l) => l.action === 'link').length;
  const blockedReason: Blocked =
    blocked ??
    (mode === 'existing' && !chosenVendor
      ? t`Choose the shop.`
      : mode === 'new' && !newVendor.trim()
        ? t`Type the shop's name.`
        : !purchasedOn
          ? t`Choose the date on the receipt.`
          : !currency
            ? t`Choose the currency.`
            : !hidden && total && !AMOUNT.test(total)
              ? t`The total is a number, like 5800.00.`
              : Object.values(lines).some((l) => l.action === 'link' && !l.thingId)
                ? t`Choose the thing each linked line is.`
                : undefined);

  const accept = () => {
    if (blockedReason || !r || !purchasedOn || !currency) return;
    const target = batchTarget(item) ?? { unplaced: true as const };
    const body: InboxReceiptBody = {
      vendor:
        mode === 'existing' && chosenVendor ? { id: chosenVendor } : { name: newVendor.trim() },
      purchasedOn,
      currency,
      ...(!hidden && total ? { total } : {}),
      ...(!hidden && tax ? { tax } : {}),
      lines: r.lines.map((l) => {
        const c = lines[l.index] ?? { action: 'new_thing' as const };
        const { unitPrice, ...rest } = l;
        return {
          ...rest,
          ...(!hidden && unitPrice ? { unitPrice } : {}),
          action: c.action,
          ...(c.action === 'link' && c.thingId ? { thingId: c.thingId } : {}),
          ...(c.action === 'new_thing' ? { target } : {}),
        };
      }),
    };
    void run(() => captureApi.inboxReceipt(item.id, body, item.rowVersion), {
      done: t`Accepted the receipt`,
    });
  };
  useItemKeys(item.id, {
    accept,
    link_receipt_line: () => {
      const radio =
        linesRef.current?.querySelector<HTMLInputElement>('input[type="radio"]:checked') ??
        linesRef.current?.querySelector<HTMLInputElement>('input[type="radio"]');
      radio?.focus();
    },
  });
  if (!r) return null;

  const label = seen ? t`${seen} receipt` : t`Receipt`;
  return (
    <ItemShell
      item={item}
      label={label}
      current={current}
      photo={r.pages[0]}
      title={
        seen ? (
          <Trans>
            <bdi>{seen}</bdi> receipt
          </Trans>
        ) : (
          <Trans>Receipt</Trans>
        )
      }
      meta={
        <>
          <span>
            <Plural value={r.lines.length} one="# line" other="# lines" />
          </span>
          {!hidden && r.total && r.currency ? (
            <span className="tabular-nums">{money(r.total, r.currency)}</span>
          ) : null}
          {r.flagged ? (
            <Pill tone="warn">
              <Trans>Lines don't add up</Trans>
            </Pill>
          ) : null}
        </>
      }
      actions={
        <>
          <Button
            size="small"
            isDisabled={!!blockedReason}
            isPending={busy}
            aria-keyshortcuts="A"
            onPress={accept}
          >
            {links > 0 ? (
              <Plural
                value={links}
                one="Accept the receipt and # link"
                other="Accept the receipt and # links"
              />
            ) : (
              <Trans>Accept the receipt</Trans>
            )}
          </Button>
          <BlockedReason reason={blockedReason} />
        </>
      }
    >
      {r.pages.length > 1 ? (
        <ul aria-label={t`Pages`} className="m-0 flex list-none flex-wrap gap-2 p-0">
          {r.pages.map((pg, i) => (
            <li key={pg.fileId}>
              <Thumb photo={pg} label={t`Page ${i + 1}`} />
            </li>
          ))}
        </ul>
      ) : null}
      <p className="m-0 inline-flex items-center gap-1.5 text-small text-violet">
        <SuggestedMark className="size-3.5" />
        <Trans>Suggested · read from the receipt. Check it before you accept.</Trans>
      </p>
      <div className="grid gap-3 @lg:grid-cols-2">
        <div className="grid gap-2">
          {mode === 'existing' ? (
            <>
              <RegistryPicker
                kind="vendors"
                accountId={accountId}
                value={chosenVendor}
                onChange={setVendorId}
                label={t`Shop`}
              />
              <button
                type="button"
                className="justify-self-start text-small text-ink-2 underline underline-offset-2 outline-none focus-visible:outline-2 focus-visible:outline-info"
                onClick={() => setVendorMode('new')}
              >
                <Trans>A new shop instead</Trans>
              </button>
            </>
          ) : (
            <>
              <TextField
                label={t`Shop (new)`}
                value={newVendor}
                onChange={setNewVendor}
                description={t`Added to your shops when you accept.`}
              />
              {nearby ? (
                <p className="m-0 text-small text-ink-2">
                  <Trans>
                    You already have <bdi>{nearby.name}</bdi>.
                  </Trans>{' '}
                  <button
                    type="button"
                    className="font-semibold text-ink underline underline-offset-2 outline-none focus-visible:outline-2 focus-visible:outline-info"
                    onClick={() => {
                      setVendorId(nearby.id);
                      setVendorMode('existing');
                    }}
                  >
                    <Trans>Use it</Trans>
                  </button>
                </p>
              ) : (
                <button
                  type="button"
                  className="justify-self-start text-small text-ink-2 underline underline-offset-2 outline-none focus-visible:outline-2 focus-visible:outline-info"
                  onClick={() => setVendorMode('existing')}
                >
                  <Trans>Choose one of your shops</Trans>
                </button>
              )}
            </>
          )}
        </div>
        <DatePicker label={t`Date on the receipt`} value={purchasedOn} onChange={setPurchasedOn} />
        <CurrencyPicker label={t`Currency`} value={currency} onChange={setCurrency} />
        {hidden ? (
          <p className="m-0 self-end text-small text-ink-3">
            <Trans>Prices hidden</Trans>
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <TextField
              label={t`Total`}
              value={total}
              onChange={setTotal}
              inputMode="decimal"
              {...(total && !AMOUNT.test(total)
                ? { errorMessage: t`A number, like 5800.00.` }
                : {})}
            />
            <TextField label={t`Tax`} value={tax} onChange={setTax} inputMode="decimal" />
          </div>
        )}
      </div>
      {r.flagged ? (
        <Notice tone="warn">
          <Trans>The lines don't add up to the total (more than 1% apart). Check them.</Trans>
        </Notice>
      ) : null}
      <div ref={linesRef} className="grid gap-2">
        <h3 className="m-0 font-semibold text-[14px] text-ink">
          <Trans>Link to an existing thing</Trans>
        </h3>
        <p className="m-0 text-small text-ink-3">
          <Trans>Things in the same location, by brand and model or by name.</Trans>
        </p>
        {r.lines.map((line) => (
          <LineReview
            key={line.index}
            item={item}
            line={line}
            currency={hidden ? null : currency}
            choice={lines[line.index]}
            onChange={(c) => setLines((prev) => ({ ...prev, [line.index]: c }))}
            blocked={blocked}
          />
        ))}
      </div>
    </ItemShell>
  );
}

function LineReview({
  item,
  line,
  currency,
  choice,
  onChange,
  blocked,
}: {
  item: InboxItem;
  line: ReceiptLine;
  /** Null where money is hidden. */
  currency: string | null;
  choice: LineChoice | undefined;
  onChange: (c: LineChoice) => void;
  blocked: Blocked;
}) {
  const { t } = useLingui();
  const fmt = useFormat();
  const money = useMoney();
  const candidates = useInboxCandidates(item.id, { line: line.index });
  const things = (candidates.data?.things ?? []).slice(0, 3);
  const top = things[0];
  // Until the person chooses: the best match, else a new thing from the line.
  useEffect(() => {
    if (choice || !candidates.isSuccess) return;
    onChange(top?.match ? { action: 'link', thingId: top.id } : { action: 'new_thing' });
  }, [choice, candidates.isSuccess, top, onChange]);
  const value = choice
    ? choice.action === 'link'
      ? `link:${choice.thingId ?? ''}`
      : choice.action
    : null;
  const qty = fmt.num(Number(line.quantity));
  return (
    <div className="grid gap-2 rounded-[10px] border border-line p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-[14px]">
        <span className="min-w-0 font-mono text-[13px] [overflow-wrap:anywhere]">
          <bdi dir="auto">{line.description}</bdi>
          {sep()}
          {qty} ×
        </span>
        {currency && line.unitPrice ? (
          <span className="tabular-nums text-ink-2">{money(line.unitPrice, currency)}</span>
        ) : null}
      </div>
      <RadioGroup
        aria-label={t`What ${line.description} is`}
        value={value}
        isDisabled={!!blocked}
        onChange={(v) =>
          onChange(
            v.startsWith('link:')
              ? { action: 'link', thingId: v.slice(5) }
              : { action: v as ReceiptLineAction },
          )
        }
        className="grid gap-1.5"
      >
        {things.map((th) => (
          <LineOption key={th.id} value={`link:${th.id}`}>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <bdi className="[overflow-wrap:anywhere]">{th.name}</bdi>
              <IdChip code={th.shortCode} pending />
            </span>
            <small className="block text-small text-ink-3">
              {th.match === 'brand_model' ? (
                <Trans>brand and model match</Trans>
              ) : th.match === 'name' ? (
                <Trans>name matches</Trans>
              ) : (
                <Trans>same location</Trans>
              )}
              {th.derivedState.includes('draft') ? (
                <>
                  {sep()}
                  <Trans>still a draft</Trans>
                </>
              ) : null}
            </small>
          </LineOption>
        ))}
        <LineOption value="new_thing">
          <Trans>Create a new thing from this line</Trans>
        </LineOption>
        <LineOption value="skip">
          <Trans>Skip this line</Trans>
        </LineOption>
      </RadioGroup>
    </div>
  );
}

function LineOption({ value, children }: { value: string; children: ReactNode }) {
  return (
    <Radio
      value={value}
      className={({ isSelected, isFocusVisible, isDisabled }) =>
        cn(
          'flex min-h-11 cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 text-[14px] text-ink',
          isSelected ? 'border-ink bg-sunken' : 'border-line',
          isFocusVisible && 'outline-2 outline-offset-2 outline-info',
          isDisabled && 'cursor-not-allowed opacity-60',
        )
      }
    >
      {({ isSelected }) => (
        <>
          <span
            aria-hidden="true"
            className={cn(
              'mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border-2',
              isSelected ? 'border-ink' : 'border-ink-3',
            )}
          >
            {isSelected ? <span className="size-2 rounded-full bg-ink" /> : null}
          </span>
          <span className="min-w-0 flex-1">{children}</span>
        </>
      )}
    </Radio>
  );
}
