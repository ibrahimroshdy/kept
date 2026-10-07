/**
 * Who did the work (screens §5 Log a service: "Vendor (from the registry, created inline, D11)"):
 * pick a vendor from the account's list, or type a new name, which the server creates with the
 * record. The value is what the write sends: `{id}`, `{name}`, or nothing.
 */
import { useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import type { ByIdOrName } from '@/api/household/types';
import { inventoryApi } from '@/api/inventory/queries';
import { Combobox } from '@/components/ui/combobox';

export type VendorValue = { id: string | null; text: string };

export const emptyVendor: VendorValue = { id: null, text: '' };

/** The write's `vendor`: the chosen one, a new one by name, or undefined. */
export function vendorInput(v: VendorValue): ByIdOrName | undefined {
  if (v.id) return { id: v.id };
  const name = v.text.trim();
  return name ? { name } : undefined;
}

export function VendorField({
  accountId,
  value,
  onChange,
}: {
  accountId: string;
  value: VendorValue;
  onChange: (v: VendorValue) => void;
}) {
  const { t } = useLingui();
  const vendors = useQuery({
    queryKey: ['registry', 'vendors', accountId, { limit: 200 }],
    queryFn: () => inventoryApi.registry('vendors', accountId, { limit: 200 }),
    enabled: !!accountId,
  });
  const items = (vendors.data?.items ?? []).map((x) => ({ id: x.id, label: x.name }));
  const isNew = !value.id && value.text.trim() !== '';
  return (
    <Combobox
      label={t`Vendor`}
      description={
        isNew
          ? t`A new vendor: it's added to your list when you save.`
          : t`Optional. Pick one, or type a new name.`
      }
      items={items}
      allowsCustomValue
      menuTrigger="focus"
      selectedKey={value.id}
      inputValue={value.text}
      onInputChange={(text) =>
        onChange({
          id: value.id && items.find((i) => i.id === value.id)?.label === text ? value.id : null,
          text,
        })
      }
      onSelectionChange={(k) => {
        if (k === null) return;
        const id = String(k);
        onChange({ id, text: items.find((i) => i.id === id)?.label ?? '' });
      }}
      placeholder={t`Search shops`}
      emptyText={t`No match: this name is added as a new vendor`}
    />
  );
}
