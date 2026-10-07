/**
 * The words Account settings shows for the registry enums: capabilities (D154), field kinds,
 * vendor kinds, and a registry's own name. Localised through Lingui; task 30 writes the Arabic.
 */
import { useLingui } from '@lingui/react/macro';
import type { RegistryPathKind } from '@/api/inventory/paths';
import type { Capability, FieldKind, VendorKind } from '@/api/inventory/types';

export const CAPABILITY_ORDER: readonly Capability[] = [
  'container',
  'metered',
  'warranty',
  'serialized',
  'consumable',
  'expires',
];

export function useCapabilityLabels(): Record<Capability, string> {
  const { t } = useLingui();
  return {
    container: t`Container`,
    metered: t`Metered`,
    warranty: t`Warranty`,
    serialized: t`Serialized`,
    consumable: t`Consumable`,
    expires: t`Expires on`,
  };
}

/** What each capability means, for the chip's description. */
export function useCapabilityHelp(): Record<Capability, string> {
  const { t } = useLingui();
  return {
    container: t`Can hold other things, like a box or a car.`,
    metered: t`Has a reading that grows, like kilometres or hours.`,
    warranty: t`Can carry warranties.`,
    serialized: t`One of a kind, with a serial number: always quantity 1.`,
    consumable: t`Used up and restocked, like batteries.`,
    expires: t`Has an expiry date to be reminded about.`,
  };
}

export const FIELD_KIND_ORDER: readonly FieldKind[] = [
  'text',
  'number',
  'date',
  'boolean',
  'select',
  'multi_select',
  'url',
  'money',
  'person',
  'vendor',
  'file',
];

export function useFieldKindLabels(): Record<FieldKind, string> {
  const { t } = useLingui();
  return {
    text: t`Text`,
    number: t`Number`,
    date: t`Date`,
    select: t`One choice`,
    multi_select: t`Several choices`,
    boolean: t`Yes or no`,
    url: t`Web link`,
    money: t`Money`,
    person: t`Person`,
    vendor: t`Shop or service`,
    file: t`File`,
  };
}

export const VENDOR_KIND_ORDER: readonly VendorKind[] = [
  'store',
  'online',
  'service_centre',
  'station',
  'other',
];

export function useVendorKindLabels(): Record<VendorKind, string> {
  const { t } = useLingui();
  return {
    store: t`Shop`,
    online: t`Online shop`,
    service_centre: t`Service centre`,
    station: t`Fuel station`,
    other: t`Other`,
  };
}

/** A registry's name, as a list heading ("People") and as one of it ("person"). */
export function useRegistryWords(): Record<
  RegistryPathKind,
  { plural: string; one: string; add: string; search: string }
> {
  const { t } = useLingui();
  return {
    brands: { plural: t`Brands`, one: t`brand`, add: t`Add a brand`, search: t`Search brands` },
    vendors: {
      plural: t`Vendors`,
      one: t`vendor`,
      add: t`Add a shop or service`,
      search: t`Search vendors`,
    },
    people: { plural: t`People`, one: t`person`, add: t`Add a person`, search: t`Search people` },
    tags: { plural: t`Tags`, one: t`tag`, add: t`Add a tag`, search: t`Search tags` },
  };
}

/** A lower-case key from a label: "Screen size" → `screen_size` (the server's key rule). */
export function keyFromLabel(label: string): string {
  const ascii = label
    .normalize('NFKD')
    .replace(/\p{Mn}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^[0-9_]+/, '')
    .slice(0, 40);
  return ascii;
}

export const FIELD_KEY = /^[a-z][a-z0-9_]{0,39}$/;
