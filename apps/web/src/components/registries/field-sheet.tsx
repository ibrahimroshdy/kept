/**
 * Add or edit a field of a type or a place kind (screens §5 Type editor, §7 "Type field"; D92,
 * D160, D172, D177). A bottom sheet on phones with an explicit Save.
 *
 * - The key is made from the label until you edit it, and must be unique within the type, its
 *   ancestors, its groups and its descendants: checked here against what the editor knows, and
 *   by the server, whose 409 lands on the key field ("field redefinition", D92).
 * - Kind, repeatable and secret are set at creation only; converting a kind or a field to or
 *   from secret is step 7's "convert with preview" (Q3).
 * - Secret is offered to the account owner only, on a text field (D177).
 * - "Required" applies to new edits only (D172): things saved before aren't flagged.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { isApiError } from '@/api/client';
import type { CreateTypeFieldBody, FieldKind, ResolvedField } from '@/api/inventory/types';
import { Notice, useErrorText } from '@/components/page';
import { Sheet } from '@/components/places/sheet';
import { useFieldLabel } from '@/components/things/names';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { DialogFooter } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { conflictKey, conflictReason, registryApi } from './api';
import { FIELD_KEY, FIELD_KIND_ORDER, keyFromLabel, useFieldKindLabels } from './labels';

export type FieldSheetTarget =
  | { mode: 'create'; holder: 'type' | 'placeKind'; holderId: string; takenKeys: Set<string> }
  | { mode: 'edit'; field: ResolvedField };

export function FieldSheet({
  target,
  onClose,
  isOwner,
  onSaved,
}: {
  target: FieldSheetTarget | null;
  onClose: () => void;
  isOwner: boolean;
  onSaved: () => unknown;
}) {
  const { t } = useLingui();
  const labelOf = useFieldLabel();
  const title = target?.mode === 'edit' ? t`Edit ${labelOf(target.field)}` : t`Add a field`;
  return (
    <Sheet isOpen={target !== null} onOpenChange={(o) => !o && onClose()} title={title}>
      {({ close }) =>
        target ? (
          <FieldForm target={target} isOwner={isOwner} onCancel={close} onSaved={onSaved} />
        ) : null
      }
    </Sheet>
  );
}

type Errors = Partial<Record<'label' | 'key' | 'unit' | 'options', string>>;

const WITH_UNIT: readonly FieldKind[] = ['number'];
const WITH_OPTIONS: readonly FieldKind[] = ['select', 'multi_select'];
const REPEATABLE: readonly FieldKind[] = ['text', 'url', 'number', 'date'];

function FieldForm({
  target,
  isOwner,
  onCancel,
  onSaved,
}: {
  target: FieldSheetTarget;
  isOwner: boolean;
  onCancel: () => void;
  onSaved: () => unknown;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const kindLabels = useFieldKindLabels();
  const labelOf = useFieldLabel();
  const editing = target.mode === 'edit' ? target.field : null;
  const [label, setLabel] = useState(editing ? labelOf(editing) : '');
  const [key, setKey] = useState(editing?.key ?? '');
  const [keyTouched, setKeyTouched] = useState(false);
  const [kind, setKind] = useState<FieldKind>(editing?.kind ?? 'text');
  const [unit, setUnit] = useState(editing?.unit ?? '');
  const [options, setOptions] = useState((editing?.options ?? []).join(', '));
  const [repeatable, setRepeatable] = useState(editing?.repeatable ?? false);
  const [required, setRequired] = useState(editing?.required ?? false);
  const [secret, setSecret] = useState(editing?.secret ?? false);
  const [errors, setErrors] = useState<Errors>({});

  const effectiveKey = editing ? editing.key : keyTouched ? key : keyFromLabel(label);

  const save = useMutation({
    mutationFn: async () => {
      const opts = options
        .split(/[,،\n]/)
        .map((o) => o.trim())
        .filter(Boolean);
      if (editing) {
        return registryApi.updateField(
          editing.id,
          {
            label: label.trim(),
            ...(WITH_UNIT.includes(editing.kind) ? { unit: unit.trim() || null } : {}),
            ...(WITH_OPTIONS.includes(editing.kind) ? { options: opts } : {}),
            required,
          },
          editing.rowVersion,
        );
      }
      if (target.mode !== 'create') return undefined;
      const body: CreateTypeFieldBody = {
        key: effectiveKey,
        label: label.trim(),
        kind: secret ? 'text' : kind,
        ...(WITH_UNIT.includes(kind) && unit.trim() ? { unit: unit.trim() } : {}),
        ...(WITH_OPTIONS.includes(kind) ? { options: opts } : {}),
        ...(repeatable && REPEATABLE.includes(kind) && !secret ? { repeatable: true } : {}),
        ...(required ? { required: true } : {}),
        ...(secret ? { secret: true } : {}),
      };
      return target.holder === 'type'
        ? registryApi.createField(target.holderId, body)
        : registryApi.createPlaceKindField(target.holderId, body);
    },
    onSuccess: async () => {
      await onSaved();
      const name = label.trim();
      toast({ title: editing ? t`Saved ${name}` : t`Added ${name}`, tone: 'ok' });
      onCancel();
    },
    onError: (e) => {
      const reason = conflictReason(e, 'field_redefined');
      if (reason === 'field_redefined') {
        const clash = conflictKey(e);
        setErrors({
          key: clash
            ? t`“${clash}” is already a field of this type, one it inherits from, or one below it. Pick another key.`
            : t`That key is already a field of this type, one it inherits from, or one below it. Pick another key.`,
        });
      } else if (reason === 'builtin')
        setErrors({
          key: t`Built-in types are customised first: use Customise to make an editable copy.`,
        });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: Errors = {};
    const l = label.trim();
    if (!l) next.label = t`Give the field a label, like Screen size.`;
    else if (l.length > 80) next.label = t`Keep the label to 80 characters.`;
    if (!editing) {
      if (!FIELD_KEY.test(effectiveKey))
        next.key = t`A key is a lower-case word in English letters, digits and _, starting with a letter.`;
      else if (target.mode === 'create' && target.takenKeys.has(effectiveKey))
        next.key = t`That key is already a field of this type, one it inherits from, or one below it. Pick another key.`;
    }
    if (unit.trim().length > 12) next.unit = t`Keep the unit short, like cm or W.`;
    if (
      WITH_OPTIONS.includes(editing?.kind ?? kind) &&
      options.split(/[,،\n]/).filter((o) => o.trim()).length === 0
    )
      next.options = t`List the choices, separated by commas.`;
    setErrors(next);
    if (Object.keys(next).length === 0) save.mutate();
  };

  const kindNow = editing?.kind ?? kind;
  const serverError =
    save.error && !(isApiError(save.error) && save.error.status === 409 && errors.key) ? (
      <Notice tone="danger">{errorText(save.error)}</Notice>
    ) : null;

  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      <TextField
        label={t({ message: 'Label', context: 'field name' })}
        value={label}
        onChange={setLabel}
        isRequired
        autoFocus
        {...(errors.label ? { errorMessage: errors.label, isInvalid: true } : {})}
      />
      {editing ? (
        <div className="grid gap-1 text-small text-ink-2">
          <span>
            <Trans>
              Key <span className="font-mono text-ink">{editing.key}</span> ·{' '}
              {kindLabels[editing.kind]}
            </Trans>
          </span>
          <span>
            <Trans>
              The key and kind stay as they are. Changing a kind comes with a preview, later.
            </Trans>
          </span>
        </div>
      ) : (
        <>
          <TextField
            label={t`Key`}
            description={t`Used by imports and the API. Made from the label; English letters, digits and _.`}
            value={effectiveKey}
            onChange={(v) => {
              setKeyTouched(true);
              setKey(v);
            }}
            inputProps={{ dir: 'ltr', spellCheck: false, autoCapitalize: 'off' }}
            {...(errors.key ? { errorMessage: errors.key, isInvalid: true } : {})}
          />
          <Combobox
            label={t`Kind`}
            items={FIELD_KIND_ORDER.map((k) => ({ id: k, label: kindLabels[k] }))}
            selectedKey={secret ? 'text' : kind}
            isDisabled={secret}
            onSelectionChange={(k) => k && setKind(String(k) as FieldKind)}
          />
        </>
      )}
      {WITH_UNIT.includes(kindNow) ? (
        <TextField
          label={t`Unit`}
          description={t`Shown next to the number, never converted: in, cm, W.`}
          value={unit}
          onChange={setUnit}
          {...(errors.unit ? { errorMessage: errors.unit, isInvalid: true } : {})}
        />
      ) : null}
      {WITH_OPTIONS.includes(kindNow) ? (
        <TextField
          label={t`Choices`}
          description={t`Separate the choices with commas.`}
          value={options}
          onChange={setOptions}
          {...(errors.options ? { errorMessage: errors.options, isInvalid: true } : {})}
        />
      ) : null}
      {!editing && REPEATABLE.includes(kind) && !secret ? (
        <Switch isSelected={repeatable} onChange={setRepeatable}>
          <span className="grid gap-0.5">
            <Trans>Can hold several values</Trans>
            <span className="text-small text-ink-2">
              <Trans>Like a MAC address for Wi-Fi and one for Ethernet.</Trans>
            </span>
          </span>
        </Switch>
      ) : null}
      <Switch isSelected={required} onChange={setRequired}>
        <span className="grid gap-0.5">
          <Trans>Required</Trans>
          <span className="text-small text-ink-2">
            <Trans>Asked for on new edits only; things saved before aren't flagged.</Trans>
          </span>
        </span>
      </Switch>
      {!editing && isOwner ? (
        <Switch
          isSelected={secret}
          onChange={(on) => {
            setSecret(on);
            if (on) setKind('text');
          }}
        >
          <span className="grid gap-0.5">
            <Trans>Secret</Trans>
            <span className="text-small text-ink-2">
              <Trans>
                Kept apart and encrypted, and revealed only per its policy. Only you, the account
                owner, can make a field secret, and only now.
              </Trans>
            </span>
          </span>
        </Switch>
      ) : null}
      {serverError}
      <DialogFooter>
        <Button variant="secondary" onPress={onCancel}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" isPending={save.isPending}>
          <Trans>Save</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
}
