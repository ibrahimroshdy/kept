/** A service line's kind in words (@kept/shared SERVICE_LINE_KINDS; screens §5 Log a service). */
import type { ServiceLineKind } from '@kept/shared';
import { useLingui } from '@lingui/react/macro';

export function useServiceLineLabels(): Record<ServiceLineKind, string> {
  const { t } = useLingui();
  return { part: t`Part`, labour: t`Labour`, fluid: t`Fluid`, other: t`Other` };
}
