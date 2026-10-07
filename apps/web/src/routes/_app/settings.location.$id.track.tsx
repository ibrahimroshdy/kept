/**
 * Location settings → What to track (screens §5, D61, D113, D191). Preset cards describe
 * outcomes; Fine-tune has one switch per module with its dependency shown; AI capture and the
 * assistant follow the provider with a per-location off switch. Before saving, the page lists
 * what turns on and off. Turning a module off hides it and never deletes data (D61).
 */
import { MODULE_IDS, MODULES, type ModuleId, type Preset, presetModules } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { setModules } from '@/api/locations';
import { keys } from '@/api/queries';
import type { LocationDetail } from '@/api/types';
import { AiHere } from '@/components/ai/ai-here';
import { LocationSettingsPage } from '@/components/location-settings';
import { SettingsRouteError } from '@/components/on-demand-route-error';
import { List, Notice, Section, useErrorText } from '@/components/page';
import { PresetPicker } from '@/components/preset-picker';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { useLocationName, useModuleLabels } from '@/lib/labels';

export const Route = createFileRoute('/_app/settings/location/$id/track')({
  component: TrackPage,
  errorComponent: SettingsRouteError,
});

const AI: readonly ModuleId[] = ['ai_capture', 'ai_assistant'];
const TUNABLE = MODULE_IDS.filter((id) => !MODULES[id].requiresProvider);

function TrackPage() {
  const { id } = Route.useParams();
  const { t } = useLingui();
  return (
    <LocationSettingsPage id={id} section="track" title={() => t`What to track`}>
      {(loc) => <TrackForm key={loc.id + loc.modules.join()} location={loc} />}
    </LocationSettingsPage>
  );
}

function TrackForm({ location }: { location: LocationDetail }) {
  const { t } = useLingui();
  const labels = useModuleLabels();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const [preset, setPreset] = useState<Preset>(location.preset);
  const [on, setOn] = useState<Set<ModuleId>>(() => new Set(location.modules));
  const saved = new Set(location.modules);
  const name = useLocationName()(location);

  const choosePreset = (p: Preset) => {
    setPreset(p);
    // A preset sets every module; the AI switch keeps its own state (D191).
    const next = presetModules(p);
    for (const id of AI) {
      if (on.has(id)) next.add(id);
      else next.delete(id);
    }
    setOn(next);
  };
  const toggle = (id: ModuleId, value: boolean) => {
    const next = new Set(on);
    if (value) next.add(id);
    else {
      next.delete(id);
      // Anything that needs it goes too (Fuel needs Vehicles).
      for (const other of MODULE_IDS) if (MODULES[other].deps.includes(id)) next.delete(other);
    }
    setOn(next);
  };
  const aiOn = AI.every((id) => on.has(id));
  const setAi = (value: boolean) => {
    const next = new Set(on);
    for (const id of AI) {
      if (value) next.add(id);
      else next.delete(id);
    }
    setOn(next);
  };

  const turningOn = MODULE_IDS.filter((id) => on.has(id) && !saved.has(id));
  const turningOff = MODULE_IDS.filter((id) => !on.has(id) && saved.has(id));
  const dirty = preset !== location.preset || turningOn.length > 0 || turningOff.length > 0;

  const save = useMutation({
    mutationFn: () =>
      setModules(location.id, { preset, modules: MODULE_IDS.filter((id) => on.has(id)) }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.location(location.id) });
      await qc.invalidateQueries({ queryKey: keys.locations });
      toast({ title: t`Saved`, tone: 'ok' });
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });

  const list = (ids: ModuleId[]) => ids.map((id) => labels[id]).join(t`, `);
  const onList = list(turningOn);
  const offList = list(turningOff);

  return (
    <div className="grid gap-5">
      <PresetPicker value={preset} onChange={choosePreset} label={t`Preset for ${name}`} />

      <Section title={<Trans>Fine-tune</Trans>}>
        <List>
          {TUNABLE.map((id) => {
            const missing = MODULES[id].deps.filter((d) => !on.has(d));
            const needs = MODULES[id].deps.map((d) => labels[d]).join(t`, `);
            return (
              <li key={id} className="px-3.5 py-1">
                <Switch
                  isSelected={on.has(id)}
                  isDisabled={missing.length > 0}
                  onChange={(v) => toggle(id, v)}
                  className="w-full flex-row-reverse justify-between"
                >
                  <span className="grid gap-0.5 py-1">
                    <span className="font-semibold">{labels[id]}</span>
                    {needs ? (
                      <span className="text-small text-ink-3">
                        {missing.length > 0 ? (
                          <Trans>Needs {needs} · off in this location</Trans>
                        ) : (
                          <Trans>Needs {needs}</Trans>
                        )}
                      </span>
                    ) : null}
                  </span>
                </Switch>
              </li>
            );
          })}
        </List>
      </Section>

      <Section title={<Trans>AI in this location</Trans>}>
        <List>
          <li className="px-3.5 py-1">
            <Switch
              isSelected={aiOn}
              onChange={setAi}
              className="w-full flex-row-reverse justify-between"
            >
              <span className="grid gap-0.5 py-1">
                <span className="font-semibold">
                  <Trans>AI capture and the assistant</Trans>
                </span>
                <span className="text-small text-ink-3">
                  {location.providerResolved ? (
                    <Trans>Uses the AI provider connected for {name}.</Trans>
                  ) : (
                    <Trans>
                      On once an AI provider is connected. Turn off to keep {name} out of AI.
                    </Trans>
                  )}
                </span>
              </span>
            </Switch>
          </li>
        </List>
        <AiHere location={location} />
      </Section>

      {dirty && (turningOn.length > 0 || turningOff.length > 0) ? (
        <Notice tone="info" title={<Trans>When you save</Trans>}>
          <div className="grid gap-1">
            {onList ? (
              <span>
                <Trans>Turns on: {onList}.</Trans>
              </span>
            ) : null}
            {offList ? (
              <span>
                <Trans>Turns off: {offList}. Hidden, not deleted.</Trans>
              </span>
            ) : null}
          </div>
        </Notice>
      ) : null}

      <div className="grid gap-2">
        <Button
          className="w-full"
          isDisabled={!dirty}
          isPending={save.isPending}
          onPress={() => save.mutate()}
        >
          <Trans>Save</Trans>
        </Button>
        <p className="m-0 text-center text-small text-ink-3">
          <Trans>Turning something off hides it here. Nothing is deleted.</Trans>
        </p>
      </div>
    </div>
  );
}
