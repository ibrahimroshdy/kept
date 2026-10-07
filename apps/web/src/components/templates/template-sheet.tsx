/**
 * The template sheet (plan T30; D76, D177; T19's `templateSchema`): a name, a type, the details a
 * new thing starts with (brand, model, colour, quantity, notes, and the type's own fields), and
 * the locations it is shared with. Never money or secrets: the type's money and secret fields
 * aren't offered, and the payload has no key for them.
 *
 * A new template is POST /accounts/:accountId/templates; an existing one is PATCH /templates/:id
 * with If-Match. Only locations you administer can be chosen (editing needs admin of every one,
 * Q17).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { captureApi, captureKeys } from '@/api/capture/queries';
import { type AccountTemplate, TEMPLATE_NAME_MAX, type TemplatePayload } from '@/api/capture/types';
import { inventoryApi, inventoryKeys } from '@/api/inventory/queries';
import type { ResolvedField } from '@/api/inventory/types';
import { useLocations } from '@/api/queries';
import { useErrorText } from '@/components/page';
import { Sheet } from '@/components/places/sheet';
import { useFieldLabel } from '@/components/things/names';
import { RegistryPicker, TypePicker } from '@/components/things/pickers';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { Select, SelectItem } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { useLocationName } from '@/lib/labels';

/** Field kinds the sheet can hold as a template value (D177: never money or secrets). */
const TEMPLATE_KINDS = new Set(['text', 'number', 'url', 'select', 'boolean']);

/** The type's fields a template may carry: not money, not secret, not archived. */
export const templateFields = (fields: readonly ResolvedField[]) =>
  fields.filter(
    (f) => !f.secret && f.kind !== 'money' && !f.archivedAt && TEMPLATE_KINDS.has(f.kind),
  );

type Draft = {
  name: string;
  typeId: string | null;
  brandId: string | null;
  model: string;
  colour: string;
  quantity: string;
  notes: string;
  custom: Record<string, unknown>;
  locationIds: string[];
};

const draftOf = (t: AccountTemplate | null): Draft => ({
  name: t?.name ?? '',
  typeId: t?.typeId ?? null,
  brandId: t?.payload.brandId ?? null,
  model: t?.payload.model ?? '',
  colour: t?.payload.colour ?? '',
  quantity: t?.payload.quantity ?? '',
  notes: t?.payload.notes ?? '',
  custom: t?.payload.custom ?? {},
  locationIds: t?.locations.map((l) => l.id) ?? [],
});

export function TemplateSheet({
  isOpen,
  onClose,
  accountId,
  template,
}: {
  isOpen: boolean;
  onClose: () => void;
  accountId: string;
  /** The template to edit; null for a new one. */
  template: AccountTemplate | null;
}) {
  return (
    <Sheet
      isOpen={isOpen}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={template ? <Trans>Edit template</Trans> : <Trans>New template</Trans>}
      wide
    >
      <TemplateForm
        key={template ? `${template.id}:${template.rowVersion}` : 'new'}
        accountId={accountId}
        template={template}
        onDone={onClose}
      />
    </Sheet>
  );
}

function TemplateForm({
  accountId,
  template,
  onDone,
}: {
  accountId: string;
  template: AccountTemplate | null;
  onDone: () => void;
}) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const errorText = useErrorText();
  const fieldLabel = useFieldLabel();
  const locationName = useLocationName();
  const locations = useLocations();
  const [d, setD] = useState<Draft>(() => draftOf(template));
  const [errors, setErrors] = useState<{ name?: string; locations?: string }>({});
  const set = (patch: Partial<Draft>) => setD((prev) => ({ ...prev, ...patch }));

  // Shared only with locations of this account you administer (the policy, Q17).
  const shareable = (locations.data ?? []).filter(
    (l) => l.ownerAccountId === accountId && (l.role === 'owner' || l.role === 'admin'),
  );
  const type = useQuery({
    queryKey: inventoryKeys.types.detail(d.typeId ?? ''),
    queryFn: () => inventoryApi.type(d.typeId ?? ''),
    enabled: !!d.typeId,
  });
  const fields = d.typeId ? templateFields(type.data?.fields ?? []) : [];

  const save = useMutation({
    mutationFn: () => {
      const custom = Object.fromEntries(
        Object.entries(d.custom).filter(
          ([k, v]) => fields.some((f) => f.key === k) && v !== '' && v !== undefined,
        ),
      );
      const payload: TemplatePayload = {
        ...(d.brandId ? { brandId: d.brandId } : {}),
        ...(d.model.trim() ? { model: d.model.trim() } : {}),
        ...(d.colour.trim() ? { colour: d.colour.trim() } : {}),
        ...(d.quantity.trim() ? { quantity: d.quantity.trim() } : {}),
        ...(d.notes.trim() ? { notes: d.notes.trim() } : {}),
        ...(Object.keys(custom).length ? { custom } : {}),
      };
      const body = {
        name: d.name.trim(),
        ...(d.typeId ? { typeId: d.typeId } : {}),
        payload,
        locationIds: d.locationIds,
      };
      return template
        ? captureApi.updateTemplate(template.id, body, template.rowVersion)
        : captureApi.createTemplate(accountId, body);
    },
    onSuccess: async (saved) => {
      await qc.invalidateQueries({ queryKey: captureKeys.templates.all });
      const name = saved.name;
      toast({ title: template ? t`Saved ${name}` : t`Added ${name}`, tone: 'ok' });
      onDone();
    },
    onError: (e) =>
      toast({ title: t`Couldn't save it`, description: errorText(e), tone: 'danger' }),
  });

  const submit = () => {
    const e: typeof errors = {};
    const name = d.name.trim();
    if (!name) e.name = t`Give it a name.`;
    else if (name.length > TEMPLATE_NAME_MAX) e.name = t`At most 80 characters.`;
    if (d.locationIds.length === 0) e.locations = t`Share it with at least one location.`;
    setErrors(e);
    if (Object.keys(e).length === 0) save.mutate();
  };

  const locationItems = shareable.map((l) => ({ id: l.id, name: locationName(l) }));

  return (
    <form
      noValidate
      aria-label={template ? t`Edit template` : t`New template`}
      className="grid gap-3.5"
      onSubmit={(ev) => {
        ev.preventDefault();
        submit();
      }}
    >
      <TextField
        label={t`Template name`}
        value={d.name}
        onChange={(name) => set({ name })}
        autoFocus
        inputProps={{ dir: 'auto' }}
        description={t`Also the new thing's name, until you type one.`}
        {...(errors.name ? { errorMessage: errors.name, isInvalid: true } : {})}
      />
      <TypePicker
        accountId={accountId}
        label={t`Type`}
        value={d.typeId}
        onChange={(typeId) => set({ typeId, custom: {} })}
      />
      <RegistryPicker
        kind="brands"
        accountId={accountId}
        label={t`Brand`}
        value={d.brandId}
        onChange={(brandId) => set({ brandId })}
      />
      <div className="grid gap-3.5 md:grid-cols-2">
        <TextField
          label={t`Model`}
          value={d.model}
          onChange={(model) => set({ model })}
          inputProps={{ dir: 'auto' }}
        />
        <TextField
          label={t`Colour`}
          value={d.colour}
          onChange={(colour) => set({ colour })}
          inputProps={{ dir: 'auto' }}
        />
      </div>
      <TextField
        label={t`Quantity`}
        value={d.quantity}
        onChange={(quantity) => set({ quantity })}
        inputProps={{ inputMode: 'decimal', dir: 'ltr' }}
      />
      <TextField
        label={t`Notes`}
        value={d.notes}
        onChange={(notes) => set({ notes })}
        inputProps={{ dir: 'auto' }}
      />
      {fields.length > 0 ? (
        <fieldset className="m-0 grid gap-3 rounded-[10px] border border-line p-3">
          <legend className="px-1 text-small font-semibold text-ink-3">
            <Trans>The type's fields</Trans>
          </legend>
          {fields.map((f) =>
            f.kind === 'boolean' ? (
              <Switch
                key={f.key}
                isSelected={d.custom[f.key] === true}
                onChange={(v) => set({ custom: { ...d.custom, [f.key]: v } })}
              >
                {fieldLabel(f)}
              </Switch>
            ) : (
              <TextField
                key={f.key}
                label={fieldLabel(f)}
                value={String(d.custom[f.key] ?? '')}
                onChange={(v) =>
                  set({
                    custom: {
                      ...d.custom,
                      [f.key]: f.kind === 'number' && v.trim() !== '' ? Number(v) : v,
                    },
                  })
                }
                inputProps={{
                  dir: f.kind === 'text' ? 'auto' : 'ltr',
                  ...(f.kind === 'number' ? { inputMode: 'decimal' as const } : {}),
                }}
              />
            ),
          )}
          <p className="m-0 text-small text-ink-3">
            <Trans>Prices and secret fields are never part of a template.</Trans>
          </p>
        </fieldset>
      ) : null}
      <Select<(typeof locationItems)[number], 'multiple'>
        label={t`Share with`}
        selectionMode="multiple"
        items={locationItems}
        value={d.locationIds}
        onChange={(keys) => set({ locationIds: [...keys].map(String) })}
        description={t`Members of these locations can start new things from it.`}
        {...(errors.locations ? { errorMessage: errors.locations, isInvalid: true } : {})}
      >
        {(item) => (
          <SelectItem id={item.id} textValue={item.name}>
            <bdi>{item.name}</bdi>
          </SelectItem>
        )}
      </Select>
      <DialogFooter>
        <Button variant="secondary" onPress={onDone}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" isPending={save.isPending}>
          <Trans>Save</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * "Save as template" from a thing's action menu (D76; T19's POST /things/:id/save-as-template): a
 * name and the locations to share it with; the server builds the payload from the thing's
 * non-money, non-secret details.
 */
export function SaveAsTemplateSheet({
  isOpen,
  onClose,
  thingId,
  thingName,
  accountId,
  locationId,
}: {
  isOpen: boolean;
  onClose: () => void;
  thingId: string;
  thingName: string;
  accountId: string;
  locationId: string;
}) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const errorText = useErrorText();
  const locationName = useLocationName();
  const locations = useLocations();
  const [name, setName] = useState(thingName);
  const [locationIds, setLocationIds] = useState<string[]>([locationId]);
  const [error, setError] = useState<string | null>(null);
  const shareable = (locations.data ?? [])
    .filter((l) => l.ownerAccountId === accountId && (l.role === 'owner' || l.role === 'admin'))
    .map((l) => ({ id: l.id, name: locationName(l) }));
  const save = useMutation({
    mutationFn: () => captureApi.saveAsTemplate(thingId, { name: name.trim(), locationIds }),
    onSuccess: async (saved) => {
      await qc.invalidateQueries({ queryKey: captureKeys.templates.all });
      const n = saved.name;
      toast({ title: t`Saved ${n} as a template`, tone: 'ok' });
      onClose();
    },
    onError: (e) =>
      toast({ title: t`Couldn't save it`, description: errorText(e), tone: 'danger' }),
  });
  return (
    <Sheet
      isOpen={isOpen}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={t`Save as template`}
    >
      <form
        noValidate
        aria-label={t`Save as template`}
        className="grid gap-3.5"
        onSubmit={(ev) => {
          ev.preventDefault();
          const n = name.trim();
          if (!n) return setError(t`Give it a name.`);
          if (n.length > TEMPLATE_NAME_MAX) return setError(t`At most 80 characters.`);
          if (locationIds.length === 0) return setError(t`Share it with at least one location.`);
          setError(null);
          save.mutate();
        }}
      >
        <p className="m-0 text-small text-ink-2">
          <Trans>
            New things can start from this one's details. Prices and secret fields stay behind.
          </Trans>
        </p>
        <TextField
          label={t`Template name`}
          value={name}
          onChange={setName}
          autoFocus
          inputProps={{ dir: 'auto' }}
        />
        <Select<(typeof shareable)[number], 'multiple'>
          label={t`Share with`}
          selectionMode="multiple"
          items={shareable}
          value={locationIds}
          onChange={(keys) => setLocationIds([...keys].map(String))}
        >
          {(item) => (
            <SelectItem id={item.id} textValue={item.name}>
              <bdi>{item.name}</bdi>
            </SelectItem>
          )}
        </Select>
        {error ? (
          <span role="alert" className="text-small font-medium text-danger">
            {error}
          </span>
        ) : null}
        <DialogFooter>
          <Button variant="secondary" onPress={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" isPending={save.isPending}>
            <Trans>Save</Trans>
          </Button>
        </DialogFooter>
      </form>
    </Sheet>
  );
}
