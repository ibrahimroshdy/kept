/**
 * Instance admin → Currencies (D168): a switch per ISO currency, for everyone on this server.
 * The five defaults (USD, CAD, GBP, EUR, EGP) and any currency a location uses stay on, so their
 * switches are shown on and can't be turned off, with the reason. The list standard: search in
 * the URL, and a filter for what is on.
 */
import { SUPPORTED_DEFAULT } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { isApiError } from '@/api/client';
import type { Currency } from '@/api/inventory/types';
import { useMe } from '@/api/queries';
import { ListSurface } from '@/components/list-surface';
import { EmptyState, useErrorText } from '@/components/page';
import {
  allCurrencies,
  invalidateCurrencies,
  registryApi,
  useWholeList,
} from '@/components/registries/api';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { firstOf, listSearch, useListState } from '@/lib/url-state';

export const Route = createFileRoute('/_app/admin/currencies')({
  validateSearch: listSearch(['state']),
  component: CurrenciesTab,
});

const DEFAULTS = new Set<string>(SUPPORTED_DEFAULT);

function CurrenciesTab() {
  const { t } = useLingui();
  const me = useMe();
  const [list] = useListState();
  const state = firstOf(list, 'state');
  const query = useWholeList(
    ['currencies', { all: true }, state ?? 'all'],
    async () => {
      const all = await allCurrencies();
      return state === 'on'
        ? all.filter((c) => c.enabled)
        : state === 'off'
          ? all.filter((c) => !c.enabled)
          : all;
    },
    list.q,
    (c: Currency) => `${c.code} ${c.name}`,
    me.data?.user.instanceAdmin ?? false,
  );
  return (
    <div className="grid gap-3">
      <p className="m-0 text-ink-2">
        <Trans>
          Currencies people can pick for locations and prices. The five defaults, and any currency a
          location uses, stay on.
        </Trans>
      </p>
      <ListSurface
        label={t`Currencies`}
        search={{ label: t`Search currencies`, placeholder: t`Search by code or name` }}
        filters={[
          {
            key: 'state',
            label: t`Show`,
            kind: 'single',
            values: {
              from: 'static',
              options: [
                { value: 'on', label: t`On` },
                { value: 'off', label: t`Off` },
              ],
            },
          },
        ]}
        query={query}
        getKey={(c) => c.code}
        renderRow={(c) => <CurrencyRow currency={c} />}
        empty={<EmptyState title={<Trans>No currencies</Trans>} />}
      />
    </div>
  );
}

function CurrencyRow({ currency: c }: { currency: Currency }) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const errorText = useErrorText();
  const isDefault = DEFAULTS.has(c.code);
  const locked = isDefault || c.inUse === true;
  const set = useMutation({
    mutationFn: (enabled: boolean) => registryApi.setCurrency(c.code, enabled),
    onSuccess: async (next) => {
      await invalidateCurrencies(qc);
      const code = next.code;
      toast({ title: next.enabled ? t`${code} is on` : t`${code} is off`, tone: 'ok' });
    },
    onError: async (e) => {
      await invalidateCurrencies(qc);
      toast({
        title:
          isApiError(e) && e.status === 409
            ? e.details.reason === 'default'
              ? t`${c.code} stays on: it's one of the five defaults.`
              : t`${c.code} stays on: a location uses it.`
            : errorText(e),
        tone: 'danger',
      });
    },
  });
  const reason = isDefault
    ? t`Always on: one of the five defaults`
    : c.inUse
      ? t`On: a location uses it`
      : null;
  return (
    <div className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5">
      <span className="w-12 shrink-0 font-mono font-semibold text-[15px]" dir="ltr">
        {c.code}
      </span>
      <span className="grid min-w-0 flex-1 basis-40 gap-0.5">
        <span className="[overflow-wrap:anywhere]">
          {c.name}{' '}
          <span className="text-ink-3" dir="ltr">
            {c.symbol}
          </span>
        </span>
        {reason ? <span className="text-small text-ink-2">{reason}</span> : null}
      </span>
      <Switch
        isSelected={c.enabled || locked}
        isDisabled={locked || set.isPending}
        onChange={(on) => set.mutate(on)}
        aria-label={t`${c.code} on`}
      />
    </div>
  );
}
