/**
 * Who a loan is with (D57): members of the location first, then the account's contacts, then
 * "+ New person" for a name typed that isn't either (created with the loan, D11). A member is sent
 * as `{memberUserId}`, a contact as `{id}`, a new name as `{name}` (the T10 contract). Contact
 * details are never shown here, only names.
 */
import { useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import type { LoanPersonInput } from '@/api/household/types';
import { inventoryApi } from '@/api/inventory/queries';
import { useMe, useMembers } from '@/api/queries';
import { Combobox } from '@/components/ui/combobox';

export type PersonValue = { key: string | null; text: string };
export const emptyPerson: PersonValue = { key: null, text: '' };

type Option = { id: string; label: string; description?: string; input: LoanPersonInput };

/** The write's `person`, or null when nothing is chosen or typed. */
export function personInput(v: PersonValue, options: Option[]): LoanPersonInput | null {
  const picked = v.key ? options.find((o) => o.id === v.key) : undefined;
  if (picked) return picked.input;
  const name = v.text.trim();
  return name ? { name } : null;
}

export function usePersonOptions(locationId: string, accountId: string): Option[] {
  const { t } = useLingui();
  const me = useMe();
  const members = useMembers(locationId);
  const people = useQuery({
    queryKey: ['registry', 'people', accountId, { limit: 200 }],
    queryFn: () => inventoryApi.registry('people', accountId, { limit: 200 }),
    enabled: !!accountId,
  });
  const myId = me.data?.user.id;
  const memberIds = new Set<string>();
  const out: Option[] = [];
  for (const m of members.data?.members ?? []) {
    if (m.userId === myId) continue;
    memberIds.add(m.userId);
    out.push({
      id: `m:${m.userId}`,
      label: m.displayName,
      description: t`Member of this location`,
      input: { memberUserId: m.userId },
    });
  }
  for (const p of people.data?.items ?? []) {
    if (p.userId && memberIds.has(p.userId)) continue;
    out.push({
      id: `p:${p.id}`,
      label: p.displayName,
      description: p.userId ? t`Uses Kept` : t`Contact`,
      input: { id: p.id },
    });
  }
  return out;
}

export function PersonPicker({
  label,
  options,
  value,
  onChange,
  errorMessage,
}: {
  label: string;
  options: Option[];
  value: PersonValue;
  onChange: (v: PersonValue) => void;
  errorMessage?: string | undefined;
}) {
  const { t } = useLingui();
  const typed = value.text.trim();
  const exact = options.some((o) => o.label.toLowerCase() === typed.toLowerCase());
  const items =
    typed && !value.key && !exact
      ? [
          ...options,
          { id: 'new', label: t`+ New person: ${typed}`, input: { name: typed } } as Option,
        ]
      : options;
  return (
    <Combobox
      label={label}
      description={
        !value.key && typed
          ? t`A new person: added to your people when you save. Kept never contacts them.`
          : t`Kept never contacts them.`
      }
      items={items}
      allowsCustomValue
      menuTrigger="focus"
      selectedKey={value.key === 'new' ? null : value.key}
      inputValue={value.text}
      onInputChange={(text) =>
        onChange({
          key:
            value.key && options.find((o) => o.id === value.key)?.label === text ? value.key : null,
          text,
        })
      }
      onSelectionChange={(k) => {
        if (k === null) return;
        const id = String(k);
        if (id === 'new') onChange({ key: null, text: typed });
        else onChange({ key: id, text: options.find((o) => o.id === id)?.label ?? '' });
      }}
      placeholder={t`Search people`}
      {...(errorMessage ? { errorMessage, isInvalid: true } : {})}
    />
  );
}
