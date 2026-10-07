/**
 * The assistant button in the page header (screens §1: "the assistant button" on every screen,
 * beside the notification bell). It opens and closes the sheet (phone) or the docked panel (768 px
 * and up) through ./store.ts, as ⌘K's hand-off and ⌘J do. Offline it stays, disabled with the
 * reason (screens §3, frame 04 · 3: "Assistant, needs a connection"); with the AI assistant module
 * off in every location you belong to it isn't shown (D191: the module switch turns it off).
 */
import { useLingui } from '@lingui/react/macro';
import { Button } from 'react-aria-components';
import { useLocations } from '@/api/queries';
import { AssistantIcon } from '@/components/icons';
import { shortcutLabel, TipWithKeys } from '@/components/page';
import { Tip } from '@/components/ui/tooltip';
import { useOnline } from '@/lib/online';
import { cn } from '@/lib/utils';
import { toggleAssistant, useAssistantUi } from './store';

export const ASSISTANT_PANEL_ID = 'kept-assistant';

/**
 * The AI assistant module is switched off in this location (D191): what the server says after
 * gating (`effectiveModules`), or, where only the switches are known, off with a provider that
 * would otherwise answer. A location without a provider isn't "off": the composer says AI isn't
 * set up instead.
 */
export function assistantOff(l: {
  modules: readonly string[];
  effectiveModules?: readonly string[] | undefined;
  providerResolved?: boolean | undefined;
}): boolean {
  if (l.effectiveModules)
    return !l.effectiveModules.includes('ai_assistant') && !!l.providerResolved;
  return !l.modules.includes('ai_assistant') && !!l.providerResolved;
}

export function AssistantButton() {
  const { t } = useLingui();
  const online = useOnline();
  const { open } = useAssistantUi();
  const locations = useLocations();
  const on = !locations.data?.length || locations.data.some((l) => !assistantOff(l));
  if (!on) return null;
  const label = online ? t`Assistant` : t`Assistant, needs a connection`;
  return (
    <Tip content={<TipWithKeys label={label} keys={shortcutLabel('J')} />} placement="bottom">
      <Button
        aria-label={label}
        aria-expanded={online ? open : undefined}
        aria-controls={open ? ASSISTANT_PANEL_ID : undefined}
        aria-keyshortcuts="Meta+J Control+J"
        isDisabled={!online && !open}
        data-slot="assistant-button"
        onPress={toggleAssistant}
        className={cn(
          'grid size-11 shrink-0 cursor-pointer place-items-center rounded-[10px] text-ink-2 outline-none data-hovered:bg-sunken data-hovered:text-ink data-focus-visible:outline-2 data-focus-visible:outline-info data-disabled:cursor-default data-disabled:opacity-50 [&_svg]:size-[22px]',
          open && 'bg-sunken text-ink',
        )}
      >
        <AssistantIcon />
      </Button>
    </Tip>
  );
}
