/**
 * Edit a brand, vendor, person or tag (admin; PATCH with If-Match, D156). Brands carry their
 * support details for warranty claims later; vendors their kind and contact line; people and tags
 * only a name here (a person's contact card is separate and gated, D177).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { isApiError } from '@/api/client';
import type { RegistryPathKind } from '@/api/inventory/paths';
import type { Brand, RegistryItem, Vendor, VendorKind } from '@/api/inventory/types';
import { Notice, useErrorText } from '@/components/page';
import { Sheet } from '@/components/places/sheet';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { DialogFooter } from '@/components/ui/dialog';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { invalidateRegistry, registryApi, registryKeys } from './api';
import { useRegistryWords, useVendorKindLabels, VENDOR_KIND_ORDER } from './labels';

export const registryName = (item: RegistryItem[RegistryPathKind]) =>
  'displayName' in item ? item.displayName : item.name;

export function RegistryEditSheet<K extends RegistryPathKind>({
  kind,
  item,
  onClose,
}: {
  kind: K;
  item: RegistryItem[K] | null;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const name = item ? registryName(item) : '';
  return (
    <Sheet isOpen={item !== null} onOpenChange={(o) => !o && onClose()} title={t`Edit ${name}`}>
      {({ close }) => (item ? <EditForm kind={kind} item={item} onDone={close} /> : null)}
    </Sheet>
  );
}

type Values = Record<string, string>;

function valuesOf(kind: RegistryPathKind, item: RegistryItem[RegistryPathKind]): Values {
  if (kind === 'brands') {
    const b = item as Brand;
    return {
      name: b.name,
      website: b.website ?? '',
      supportPhone: b.supportPhone ?? '',
      claimUrl: b.claimUrl ?? '',
      defaultWarrantyMonths: b.defaultWarrantyMonths?.toString() ?? '',
    };
  }
  if (kind === 'vendors') {
    const v = item as Vendor;
    return {
      name: v.name,
      kind: v.kind,
      address: v.address ?? '',
      phone: v.phone ?? '',
      website: v.website ?? '',
    };
  }
  return { name: registryName(item) };
}

function EditForm({
  kind,
  item,
  onDone,
}: {
  kind: RegistryPathKind;
  item: RegistryItem[RegistryPathKind];
  onDone: () => void;
}) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const errorText = useErrorText();
  const vendorKinds = useVendorKindLabels();
  const words = useRegistryWords();
  const [v, setV] = useState<Values>(() => valuesOf(kind, item));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (k: string) => (value: string) => setV((x) => ({ ...x, [k]: value }));
  const nullable = (s: string | undefined) => (s?.trim() ? s.trim() : null);

  const save = useMutation({
    mutationFn: () => {
      const body =
        kind === 'people'
          ? { displayName: v.name?.trim() }
          : kind === 'tags'
            ? { name: v.name?.trim() }
            : kind === 'brands'
              ? {
                  name: v.name?.trim(),
                  website: nullable(v.website),
                  supportPhone: nullable(v.supportPhone),
                  claimUrl: nullable(v.claimUrl),
                  defaultWarrantyMonths: v.defaultWarrantyMonths?.trim()
                    ? Number(v.defaultWarrantyMonths)
                    : null,
                }
              : {
                  name: v.name?.trim(),
                  kind: v.kind as VendorKind,
                  address: nullable(v.address),
                  phone: nullable(v.phone),
                  website: nullable(v.website),
                };
      return registryApi.update(kind, item.id, body as never, item.rowVersion);
    },
    onSuccess: async (saved) => {
      qc.setQueryData(registryKeys.item(kind, item.id), saved);
      await invalidateRegistry(qc, kind);
      const n = registryName(saved);
      toast({ title: t`Saved ${n}`, tone: 'ok' });
      onDone();
    },
    onError: (e) => {
      if (isApiError(e) && e.status === 409 && e.details.existingId)
        setErrors({ name: t`That name is already in this list. Merge the two instead.` });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    const n = v.name?.trim() ?? '';
    const max = kind === 'tags' ? 60 : 120;
    if (!n) next.name = t`A name is needed.`;
    else if (n.length > max) next.name = t`Keep the name to ${max} characters.`;
    const months = v.defaultWarrantyMonths?.trim();
    if (months && !/^\d{1,3}$/.test(months))
      next.defaultWarrantyMonths = t`Months as a whole number, like 24.`;
    setErrors(next);
    if (Object.keys(next).length === 0) save.mutate();
  };

  const field = (
    key: string,
    label: string,
    opts: { ltr?: boolean; description?: string } = {},
  ) => (
    <TextField
      label={label}
      value={v[key] ?? ''}
      onChange={set(key)}
      {...(opts.description ? { description: opts.description } : {})}
      {...(opts.ltr
        ? { inputProps: { dir: 'ltr' as const } }
        : { inputProps: { dir: 'auto' as const } })}
      {...(errors[key] ? { errorMessage: errors[key], isInvalid: true } : {})}
    />
  );

  const stale = isApiError(save.error) && save.error.code === 'precondition_failed';
  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      {field('name', t`Name`)}
      {kind === 'brands' ? (
        <>
          {field('website', t`Website`, { ltr: true })}
          {field('supportPhone', t`Support phone`, { ltr: true })}
          {field('claimUrl', t`Warranty claim page`, { ltr: true })}
          {field('defaultWarrantyMonths', t`Usual warranty, in months`, {
            description: t`Offered when you add a warranty for this brand.`,
          })}
        </>
      ) : null}
      {kind === 'vendors' ? (
        <>
          <Combobox
            label={t`Kind`}
            items={VENDOR_KIND_ORDER.map((k) => ({ id: k, label: vendorKinds[k] }))}
            selectedKey={v.kind ?? 'store'}
            onSelectionChange={(k) => k && set('kind')(String(k))}
          />
          {field('address', t`Address`)}
          {field('phone', t`Phone`, { ltr: true })}
          {field('website', t`Website`, { ltr: true })}
        </>
      ) : null}
      {save.error && !errors.name ? (
        <Notice tone="danger">
          {stale ? (
            <Trans>
              Someone changed this {words[kind].one} since you opened it. Close and open it again to
              see their change.
            </Trans>
          ) : (
            errorText(save.error)
          )}
        </Notice>
      ) : null}
      <DialogFooter>
        <Button variant="secondary" onPress={onDone}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" isPending={save.isPending}>
          <Trans>Save</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
}
