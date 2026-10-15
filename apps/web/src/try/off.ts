/**
 * Try Kept (D246): what the demo won't do says so in a toast instead of leaving the page or
 * asking the browser for a device.
 */
import { t } from '@lingui/core/macro';
import { toast } from '@/components/ui/toast';

/** Kept would leave for another site here (a sign-in provider's page). */
export function leavingIsOff(): void {
  toast({ title: t`Off in this demo: this would open another site.` });
}
