/**
 * Which account Account settings edits (Q21): yours, or the account of a home you are an admin
 * in. The choice is `?account=` in the URL, so every tab and every link keeps it. With one
 * account there is nothing to switch, and the line just says whose registries these are.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useNavigate } from '@tanstack/react-router';
import type { AccountSummary } from '@/api/inventory/types';
import { Combobox } from '@/components/ui/combobox';
import { type AccountScope, switchableAccounts } from './api';

export function useAccountLabel() {
  const { t } = useLingui();
  return (a: AccountSummary) => (a.isOwn ? t`Your account` : t`${a.ownerDisplayName}'s account`);
}

export function AccountSwitcher({ scope }: { scope: AccountScope }) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const label = useAccountLabel();
  const options = switchableAccounts(scope);
  const current = scope.account;
  if (!current) return null;
  if (options.length <= 1)
    return (
      <p className="m-0 text-small text-ink-2">
        {current.isOwn ? (
          <Trans>Types, place kinds and lists here are shared by every location you own.</Trans>
        ) : (
          <Trans>
            Types, place kinds and lists here are shared by every location in{' '}
            <bdi>{label(current)}</bdi>.
          </Trans>
        )}
      </p>
    );
  return (
    <div className="grid gap-1.5 md:max-w-sm">
      <Combobox
        label={t`Account`}
        description={t`Each owner's locations share one set of types and lists.`}
        items={options.map((a) => ({
          id: a.id,
          label: label(a),
          ...(a.canManage || a.isOwn ? {} : { description: t`You can look, not change` }),
        }))}
        selectedKey={current.id}
        onSelectionChange={(k) => {
          if (!k || k === current.id) return;
          void navigate({
            to: '.',
            search: { account: String(k) } as never,
          });
        }}
      />
    </div>
  );
}
