/**
 * Whether a thing is a vehicle (step 5; the server's `kept.is_vehicle_type()`): its type, or a
 * type it descends from or copies, is the built-in `vehicle` (car, motorbike, generator, …). A
 * built-in type answers from the shared library; an account's own type needs the account's types.
 * Small and precached: the thing page asks it before its vehicle tabs load.
 */
import { builtinTypeChain, VEHICLE_TYPE_KEY } from '@kept/shared';
import { useTypes } from '@/api/inventory/queries';
import type { ThingView, TypeNode } from '@/api/inventory/types';

const builtinIsVehicle = (key: string) => {
  try {
    return builtinTypeChain(key).some((b) => b.key === VEHICLE_TYPE_KEY);
  } catch {
    return false;
  }
};

export function isVehicleType(typeId: string | null | undefined, types: readonly TypeNode[]) {
  const byId = new Map(types.map((ty) => [ty.id, ty]));
  let cur = typeId ? byId.get(typeId) : undefined;
  for (let depth = 0; cur && depth < 64; depth++) {
    if (cur.builtinKey && builtinIsVehicle(cur.builtinKey)) return true;
    const next = cur.parentId ?? cur.copiedFromId;
    cur = next ? byId.get(next) : undefined;
  }
  return false;
}

/** The thing's odometer: its first distance meter, else its first meter (the server's rule). */
export function mainMeterOf<M extends { kind: string }>(meters: readonly M[]): M | null {
  return meters.find((m) => m.kind === 'distance') ?? meters[0] ?? null;
}

/** Whether this thing is a vehicle; false while an account type's ancestry is still loading. */
export function useIsVehicle(thing: Pick<ThingView, 'type'>, accountId: string): boolean {
  const builtin = thing.type?.builtinKey ? builtinIsVehicle(thing.type.builtinKey) : false;
  const needTypes = !builtin && !!thing.type && !thing.type.builtinKey;
  const types = useTypes(needTypes ? accountId : '');
  if (builtin) return true;
  if (!needTypes) return false;
  return isVehicleType(thing.type?.id, types.data?.types ?? []);
}
