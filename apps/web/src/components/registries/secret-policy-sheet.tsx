/**
 * A secret field's policy, per location (D116, D177): who may reveal it beyond the owner, and
 * whether the assistant may read it. Owner only: the editor shows the Policy button to the
 * account owner alone, and the server refuses anyone else. Converting a field to or from secret
 * is step 7's (Q3); this only widens or narrows who may reveal.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { ResolvedField, SecretPolicy } from '@/api/inventory/types';
import { useLocations } from '@/api/queries';
import { ErrorState, LoadingRows, Notice, useErrorText } from '@/components/page';
import { Sheet } from '@/components/places/sheet';
import { useFieldLabel } from '@/components/things/names';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { DialogFooter } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { useLocationName, useRoleLabels } from '@/lib/labels';
import { registryApi, registryKeys } from './api';

type RevealRole = SecretPolicy['revealRoles'][number];
const WIDENABLE: readonly RevealRole[] = ['admin', 'member', 'viewer'];

export function SecretPolicySheet({
  field,
  onClose,
}: {
  field: ResolvedField | null;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const labelOf = useFieldLabel();
  const name = field ? labelOf(field) : '';
  return (
    <Sheet
      isOpen={field !== null}
      onOpenChange={(o) => !o && onClose()}
      title={t`Who can reveal ${name}`}
    >
      {({ close }) => (field ? <PolicyForm field={field} onDone={close} /> : null)}
    </Sheet>
  );
}

function PolicyForm({ field, onDone }: { field: ResolvedField; onDone: () => void }) {
  const { t } = useLingui();
  const locations = useLocations();
  const locationName = useLocationName();
  const owned = (locations.data ?? []).filter((l) => l.role === 'owner');
  const [locationId, setLocationId] = useState<string>('');
  useEffect(() => {
    if (!locationId && owned[0]) setLocationId(owned[0].id);
  }, [locationId, owned]);

  if (locations.isPending) return <LoadingRows rows={2} />;
  if (owned.length === 0)
    return (
      <Notice tone="info">
        <Trans>Only the owner of a location sets its secret policies.</Trans>
      </Notice>
    );
  return (
    <div className="grid gap-4">
      {owned.length > 1 ? (
        <Combobox
          label={t`Location`}
          items={owned.map((l) => ({ id: l.id, label: locationName(l) }))}
          selectedKey={locationId || null}
          onSelectionChange={(k) => k && setLocationId(String(k))}
        />
      ) : null}
      {locationId ? (
        <PolicyEditor key={locationId} locationId={locationId} field={field} onDone={onDone} />
      ) : null}
    </div>
  );
}

function PolicyEditor({
  locationId,
  field,
  onDone,
}: {
  locationId: string;
  field: ResolvedField;
  onDone: () => void;
}) {
  const { t } = useLingui();
  const roleLabels = useRoleLabels().group;
  const errorText = useErrorText();
  const qc = useQueryClient();
  const policy = useQuery({
    queryKey: registryKeys.policy(locationId, field.id),
    queryFn: () => registryApi.secretPolicy(locationId, field.id),
  });
  const [draft, setDraft] = useState<SecretPolicy | null>(null);
  const current = draft ?? policy.data ?? null;
  const save = useMutation({
    mutationFn: (body: SecretPolicy) => registryApi.putSecretPolicy(locationId, field.id, body),
    onSuccess: async (next) => {
      qc.setQueryData(registryKeys.policy(locationId, field.id), next);
      toast({ title: t`Policy saved`, tone: 'ok' });
      onDone();
    },
  });

  if (policy.isPending) return <LoadingRows rows={2} />;
  if (policy.error || !current)
    return <ErrorState error={policy.error} onRetry={() => void policy.refetch()} />;
  const toggle = (role: RevealRole, on: boolean) =>
    setDraft({
      ...current,
      revealRoles: on
        ? [...new Set([...current.revealRoles, role])]
        : current.revealRoles.filter((r) => r !== role),
    });
  return (
    <div className="grid gap-3">
      <p className="m-0 text-ink-2">
        <Trans>You, the owner, can always reveal it. Each reveal is recorded in the history.</Trans>
      </p>
      {WIDENABLE.map((role) => (
        <Switch
          key={role}
          isSelected={current.revealRoles.includes(role)}
          onChange={(on) => toggle(role, on)}
        >
          {roleLabels[role]}
        </Switch>
      ))}
      <Switch
        isSelected={current.aiAllowed}
        onChange={(on) => setDraft({ ...current, aiAllowed: on })}
      >
        <span className="grid gap-0.5">
          <Trans>The assistant may read it</Trans>
          <span className="text-small text-ink-2">
            <Trans>Off by default. When on, the assistant can use it to answer you.</Trans>
          </span>
        </span>
      </Switch>
      {save.error ? <Notice tone="danger">{errorText(save.error)}</Notice> : null}
      <DialogFooter>
        <Button variant="secondary" onPress={onDone}>
          <Trans>Cancel</Trans>
        </Button>
        <Button isPending={save.isPending} onPress={() => save.mutate(current)}>
          <Trans>Save</Trans>
        </Button>
      </DialogFooter>
    </div>
  );
}
