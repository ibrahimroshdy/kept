/**
 * Names the server leaves to the client: a built-in type arrives as `name: null` with a
 * `builtinKey`, and a built-in field as `label: null` with a `labelKey` (plan task 3's contract).
 * Both are translated from @kept/shared's built-in library (D154, D192), in the reader's
 * language. An account's own types and fields carry their name as typed.
 */
import { builtinFieldName, builtinTypeName } from '@kept/shared';
import { useLingui } from '@lingui/react/macro';
import { useCallback } from 'react';
import type { ResolvedField, TypeRef } from '@/api/inventory/types';
import { usePrefs } from '@/lib/prefs';

export function useTypeName() {
  const { locale } = usePrefs();
  const { t } = useLingui();
  return useCallback(
    (type: Pick<TypeRef, 'name' | 'builtinKey'> | null | undefined): string => {
      if (!type) return t`No type`;
      if (type.name) return type.name;
      const name = type.builtinKey ? builtinTypeName(type.builtinKey, locale) : undefined;
      return name ?? type.builtinKey ?? t`No type`;
    },
    [locale, t],
  );
}

export function useFieldLabel() {
  const { locale } = usePrefs();
  return useCallback(
    (field: Pick<ResolvedField, 'label' | 'labelKey' | 'key'>): string => {
      if (field.label) return field.label;
      return builtinFieldName(field.labelKey ?? field.key, locale) ?? field.labelKey ?? field.key;
    },
    [locale],
  );
}
