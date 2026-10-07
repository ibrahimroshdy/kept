/**
 * Words for incidents (D158, plan T26): the kinds, the lifecycle an incident can end its things
 * with, and the incident's own name ("Burglary on 12 Sep 2026"), which the list, the page, the
 * insurance report's scope and the claim pack all use.
 */
import type { IncidentKind } from '@kept/shared';
import { useLingui } from '@lingui/react/macro';
import { useCallback } from 'react';
import type { IncidentLifecycle } from '@/api/household/types';
import { useFormat } from '@/lib/format';

export function useIncidentKindLabels(): Record<IncidentKind, string> {
  const { t } = useLingui();
  return {
    burglary: t`Burglary`,
    fire: t`Fire`,
    flood: t`Flood`,
    loss: t({ message: 'Loss', context: 'incident kind' }),
    other: t({ message: 'Other', context: 'incident kind' }),
  };
}

/** "Mark these stolen", by the lifecycle it sets. */
export function useMarkLabels(): Record<IncidentLifecycle, string> {
  const { t } = useLingui();
  return {
    stolen: t`Mark these stolen`,
    destroyed: t`Mark these destroyed`,
    lost: t`Mark these lost`,
  };
}

/** What an incident usually did to its things: a burglary stole them, a fire destroyed them. */
export function lifecycleFor(kind: IncidentKind): IncidentLifecycle {
  if (kind === 'fire' || kind === 'flood') return 'destroyed';
  if (kind === 'loss') return 'lost';
  return 'stolen';
}

/** "Burglary on 12 Sep 2026". */
export function useIncidentName() {
  const { t } = useLingui();
  const kinds = useIncidentKindLabels();
  const f = useFormat();
  return useCallback(
    (i: { kind: IncidentKind; occurredOn: string }) => {
      const kind = kinds[i.kind];
      const day = f.day(i.occurredOn);
      return t`${kind} on ${day}`;
    },
    [t, kinds, f],
  );
}
