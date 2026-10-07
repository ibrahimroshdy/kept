/**
 * The three preset cards (D191): outcomes, not module names. Shared by the new-location wizard's
 * last step and Location settings → What to track. "Readings" is on no card: meters are core
 * (D113). The AI modules follow the provider in every preset, so they're never a chip.
 */
import { MODULE_IDS, MODULES, type ModuleId, type Preset, presetModules } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { ChoiceCards } from '@/components/ui/segmented';
import { useModuleLabels, usePresetCopy } from '@/lib/labels';

const PREVIOUS: Record<Preset, Preset | null> = {
  essentials: null,
  household: 'essentials',
  complete: 'household',
};

/** What a preset adds over the one before it, as chips. Money sits under receipts. */
function added(preset: Preset): ModuleId[] {
  const prev = PREVIOUS[preset];
  const before = prev ? presetModules(prev) : new Set<ModuleId>();
  return MODULE_IDS.filter(
    (id) =>
      presetModules(preset).has(id) &&
      !before.has(id) &&
      !MODULES[id].requiresProvider &&
      id !== 'money',
  );
}

function Chip({ children, muted = false }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <span
      className={
        muted
          ? 'rounded-md bg-sunken px-2 py-1 text-[12.5px] leading-tight text-ink-3'
          : 'rounded-md border border-line px-2 py-1 text-[12.5px] leading-tight text-ink-2'
      }
    >
      {children}
    </span>
  );
}

export function PresetPicker({
  value,
  onChange,
  label,
}: {
  value: Preset;
  onChange: (p: Preset) => void;
  label?: string;
}) {
  const { t } = useLingui();
  const copy = usePresetCopy();
  const modules = useModuleLabels();
  const chips = (preset: Preset) => {
    const prev = PREVIOUS[preset];
    const list = preset === 'essentials' ? [] : added(preset);
    if (list.length === 0) return undefined;
    return (
      <span className="flex flex-wrap gap-1.5 pt-1.5">
        {prev ? (
          <Chip muted>
            {prev === 'essentials' ? (
              <Trans>Everything in Essentials</Trans>
            ) : (
              <Trans>Everything in Household</Trans>
            )}
          </Chip>
        ) : null}
        {list.map((id) => (
          <Chip key={id}>{modules[id]}</Chip>
        ))}
      </span>
    );
  };
  return (
    <ChoiceCards<Preset>
      aria-label={label ?? t`What to track`}
      value={value}
      onChange={onChange}
      options={(['essentials', 'household', 'complete'] as const).map((p) => ({
        id: p,
        title: copy[p].name,
        body: copy[p].outcome,
        extra: chips(p),
      }))}
    />
  );
}
