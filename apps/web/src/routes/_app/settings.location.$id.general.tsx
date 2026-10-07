/**
 * Location settings → General (screens §5, D41, D204). Its name first (an owner or admin renames
 * it; the server checks). Its languages: the ones AI writes search aliases in when it fills in a
 * thing here, chosen in a multi-select with flags. Then the location's own codes: numbering and
 * the format rule (D208, T17a). Last, for the owner, Delete with "Export first" (D149, step-7
 * T21). Timezone and currency join this page later.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { updateLocation } from '@/api/locations';
import { keys } from '@/api/queries';
import type { LocationDetail } from '@/api/types';
import { OwnCodeSettingsSection } from '@/components/codes/code-settings';
import { DeleteLocationSection } from '@/components/export/delete-location-sheet';
import { LanguagesMultiSelect } from '@/components/languages';
import { LocationSettingsPage } from '@/components/location-settings';
import { SettingsRouteError } from '@/components/on-demand-route-error';
import { Section, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';

export const Route = createFileRoute('/_app/settings/location/$id/general')({
  component: GeneralPage,
  errorComponent: SettingsRouteError,
});

function GeneralPage() {
  const { id } = Route.useParams();
  const { t } = useLingui();
  return (
    <LocationSettingsPage id={id} section="general" title={() => t`General`}>
      {(loc) => (
        <div className="grid gap-8">
          <NameForm key={`${loc.id}:${loc.name}`} location={loc} />
          <LanguagesForm key={`${loc.id}:${(loc.languages ?? []).join()}`} location={loc} />
          <OwnCodeSettingsSection locationId={loc.id} />
          <DeleteLocationSection location={loc} />
        </div>
      )}
    </LocationSettingsPage>
  );
}

/** The location's name: the sidebar, the breadcrumbs and every share link show it. */
function NameForm({ location }: { location: LocationDetail }) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const errorText = useErrorText();
  const [name, setName] = useState(location.name);
  const trimmed = name.trim();
  const dirty = trimmed !== location.name;

  const save = useMutation({
    mutationFn: () => updateLocation(location.id, { name: trimmed }, location.rowVersion),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.location(location.id) });
      await qc.invalidateQueries({ queryKey: keys.locations });
      toast({ title: t`Renamed to ${trimmed}`, tone: 'ok' });
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });

  return (
    <div className="grid gap-5">
      <Section title={<Trans>Name</Trans>}>
        <div className="grid gap-3 rounded-[10px] border border-line bg-surface p-3.5">
          <TextField
            label={t`Location name`}
            value={name}
            onChange={setName}
            isInvalid={trimmed === ''}
            errorMessage={trimmed === '' ? t`Give it a name.` : undefined}
            maxLength={100}
          />
        </div>
      </Section>
      <Button
        className="w-full md:w-auto md:justify-self-start"
        isDisabled={!dirty || trimmed === ''}
        isPending={save.isPending}
        onPress={() => save.mutate()}
      >
        <Trans>Rename</Trans>
      </Button>
    </div>
  );
}

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

function LanguagesForm({ location }: { location: LocationDetail }) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const errorText = useErrorText();
  const saved = location.languages ?? [];
  const [languages, setLanguages] = useState<string[]>(saved);
  const dirty = !same(languages, saved);

  const save = useMutation({
    mutationFn: () => updateLocation(location.id, { languages }, location.rowVersion),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.location(location.id) });
      await qc.invalidateQueries({ queryKey: keys.locations });
      toast({ title: t`Saved`, tone: 'ok' });
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });

  return (
    <div className="grid gap-5">
      <Section title={<Trans>Languages</Trans>}>
        <div className="grid gap-3 rounded-[10px] border border-line bg-surface p-3.5">
          <LanguagesMultiSelect
            label={t`Languages spoken here`}
            description={t`When AI fills in a thing here, it adds search words in each of these languages, so anyone can find it in their own.`}
            value={languages}
            onChange={setLanguages}
          />
        </div>
      </Section>
      <Button
        className="w-full md:w-auto md:justify-self-start"
        isDisabled={!dirty}
        isPending={save.isPending}
        onPress={() => save.mutate()}
      >
        <Trans>Save</Trans>
      </Button>
    </div>
  );
}
