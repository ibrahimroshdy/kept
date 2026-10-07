/**
 * Names the server leaves to the client: built-in place kinds (D33) and built-in types (D154)
 * arrive with `name: null` and a key, and are shown in the reader's language.
 */
import { builtinTypeName } from '@kept/shared';
import { useLingui } from '@lingui/react/macro';
import type { BuiltinPlaceKind, PlaceNode, TypeRef } from '@/api/inventory/types';
import { usePrefs } from '@/lib/prefs';

/** The four built-in kinds, in the order the "Room or spot" sheet offers them. */
export const PLACE_KINDS: readonly BuiltinPlaceKind[] = ['room', 'zone', 'closet', 'floor'];

/** Their icons (the static set in components/type-icon.tsx, as the server seeds them). */
export const PLACE_KIND_ICONS: Record<string, string> = {
  floor: 'lucide:layers',
  room: 'lucide:door-open',
  zone: 'lucide:square-dashed',
  closet: 'tabler:hanger',
};

/** The icon a place shows: its own, its kind's, or the Unplaced area's dashed circle (D118). */
export function placeIcon(place: Pick<PlaceNode, 'icon' | 'kindKey' | 'isUnplaced'>): string {
  if (place.isUnplaced) return 'lucide:circle-dashed';
  return place.icon ?? PLACE_KIND_ICONS[place.kindKey] ?? 'lucide:map-pin';
}

export function usePlaceKindLabels(): Record<BuiltinPlaceKind, string> {
  const { t } = useLingui();
  return { floor: t`Floor`, room: t`Room`, zone: t`Spot`, closet: t`Closet` };
}

/** A place's kind as a word; an account's own kind key is shown as it is. */
export function usePlaceKindName() {
  const labels = usePlaceKindLabels();
  return (kindKey: string) => labels[kindKey as BuiltinPlaceKind] ?? kindKey;
}

/** A place's display name: the Unplaced area is a system place, named in the reader's language. */
export function usePlaceName() {
  const { t } = useLingui();
  return (place: { name: string; isUnplaced?: boolean }) =>
    place.isUnplaced ? t`Unplaced` : place.name;
}

/** A type's display name: its own, or the built-in's name in the reader's language. */
export function useTypeName() {
  const { locale } = usePrefs();
  return (type: Pick<TypeRef, 'name' | 'builtinKey'> | null) => {
    if (!type) return null;
    if (type.name) return type.name;
    return (type.builtinKey ? builtinTypeName(type.builtinKey, locale) : undefined) ?? null;
  };
}
