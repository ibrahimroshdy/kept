/**
 * Needs a currency (screens §8, D189): "$" alone can mean US or Canadian dollars, so the receipt
 * waits with **no preselection**, even in a USD or CAD location. One button per option; the
 * person's press is the answer.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { captureApi } from '@/api/capture/queries';
import { Pill } from '@/components/page';
import { Button } from '@/components/ui/button';
import { sep } from '@/lib/format';
import { useInboxRun } from './actions';
import type { ItemProps } from './item-card';
import { BlockedReason, ItemShell } from './shell';

/** "US dollar · USD", in the reader's language. */
function useCurrencyName() {
  const { i18n } = useLingui();
  return (code: string) => {
    try {
      const name = new Intl.DisplayNames(i18n.locale, { type: 'currency' }).of(code);
      return name && name !== code ? `${name}${sep()}${code}` : code;
    } catch {
      return code;
    }
  };
}

export function CurrencyItem({ item, current, blocked }: ItemProps) {
  const { t } = useLingui();
  const currencyName = useCurrencyName();
  const { run, busy } = useInboxRun();
  const c = item.currency;
  const r = item.receipt;
  if (!c) return null;
  const vendor = r?.vendorSeen;
  // Named apart from the same receipt's review item, which sits beside it in the list.
  const label = `${vendor ? t`${vendor} receipt` : t`Receipt`}${sep()}${t`Needs a currency`}`;
  const choose = (currency: string) =>
    void run(() => captureApi.inboxCurrency(item.id, { currency }, item.rowVersion), {
      done: t`Set the currency to ${currency}`,
    });
  return (
    <ItemShell
      item={item}
      label={label}
      current={current}
      photo={r?.pages[0]}
      title={
        vendor ? (
          <Trans>
            <bdi>{vendor}</bdi> receipt
          </Trans>
        ) : (
          <Trans>Receipt</Trans>
        )
      }
      meta={
        <>
          {r?.total && !r.moneyHidden ? (
            <span>
              <Trans>
                Total{' '}
                <bdi dir="ltr" className="font-mono">
                  {c.seen} {r.total}
                </bdi>
              </Trans>
            </span>
          ) : null}
          <Pill tone="warn">
            <Trans>Needs a currency</Trans>
          </Pill>
        </>
      }
    >
      <p className="m-0 text-small text-ink-2">
        {c.seen === '$' ? (
          <Trans>“$” alone can mean US or Canadian dollars. Which was it?</Trans>
        ) : (
          <Trans>
            “<bdi>{c.seen}</bdi>” can mean more than one currency. Which was it?
          </Trans>
        )}
      </p>
      {/* biome-ignore lint/a11y/useSemanticElements: a labelled row of buttons, none chosen */}
      <div role="group" aria-label={t`Currency`} className="grid gap-2 @md:grid-cols-2">
        {c.options.map((code) => (
          <Button
            key={code}
            variant="secondary"
            className="max-sm:min-h-11"
            isDisabled={!!blocked}
            isPending={busy}
            onPress={() => choose(code)}
          >
            {currencyName(code)}
          </Button>
        ))}
      </div>
      <BlockedReason reason={blocked} />
    </ItemShell>
  );
}
