/**
 * Edit in place (screens §5: an explicit Edit opens the fields; Save or Cancel) with D156's
 * field-level conflicts. Save sends only what changed, with `If-Match` of the version the edit
 * started from. On a 412 the editor reads the latest version and runs a three-way merge
 * (lib/three-way.ts) of where the edit started, the form, and the latest:
 *   - a field only the other person changed is taken from theirs, silently;
 *   - a field only I changed keeps mine;
 *   - a field we both changed, differently, opens the conflict sheet ("Alfred changed this since
 *     you opened it": Keep mine, Keep theirs, or Edit).
 * With no conflict left, it saves again on top of the latest version.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { type ReactNode, useCallback, useState } from 'react';
import { TextArea, TextField as TextFieldPrimitive } from 'react-aria-components';
import { isApiError } from '@/api/client';
import { inventoryApi } from '@/api/inventory/queries';
import { useTypeDetail } from '@/api/inventory/thing-api';
import type { ResolvedField, ThingView } from '@/api/inventory/types';
import { useOfferUndo } from '@/components/history/undo';
import { useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { DatePicker } from '@/components/ui/date-picker';
import { FieldError, inputClass, Label } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { type Conflict, merge } from '@/lib/three-way';
import { ConflictSheet, type Resolution } from './conflict-sheet';
import { useThingCtx } from './context';
import {
  editableFields,
  type FieldErrors,
  type FormValue,
  type FormValues,
  formValues,
  isEmptyPatch,
  type Money,
  mergeFields,
  toPatch,
  validate,
} from './form-model';
import { useConditionLabels } from './labels';
import { useFieldLabel } from './names';
import { CurrencyPicker, RegistryPicker, useLocationAccountId } from './pickers';

type Session = { base: ThingView; baseValues: FormValues; draft: FormValues };
type Pending = { conflicts: Conflict[]; changedBy: string | null };

function setPath(v: FormValues, path: string, value: FormValue): FormValues {
  if (path.startsWith('custom.')) return { ...v, custom: { ...v.custom, [path.slice(7)]: value } };
  return { ...v, [path]: value };
}

/** The edit session: start, change, save (with the 412 merge), cancel. */
export function useThingEditor() {
  const { thing, refresh } = useThingCtx();
  const offerUndo = useOfferUndo();
  const { t } = useLingui();
  const errorText = useErrorText();
  const [session, setSession] = useState<Session | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [focusField, setFocusField] = useState<string | null>(null);

  const messages = {
    nameRequired: t`This needs a value.`,
    tooLong: (max: number) => t`At most ${max} characters.`,
    number: t`Enter a number.`,
    quantity: t`Enter a whole number, 0 or more.`,
    url: t`Enter a web address starting with https://.`,
    amount: t`Enter an amount, like 1250 or 1250.50.`,
  };

  const start = useCallback(() => {
    setSession({ base: thing, baseValues: formValues(thing), draft: formValues(thing) });
    setErrors({});
  }, [thing]);
  const cancel = () => {
    setSession(null);
    setPending(null);
    setErrors({});
  };
  const change = (path: string, value: FormValue) =>
    setSession((s) => (s ? { ...s, draft: setPath(s.draft, path, value) } : s));

  const attempt = async (s: Session, tries: number, mergedFrom: string | null): Promise<void> => {
    const patch = toPatch(s.baseValues, s.draft, s.base.fields);
    if (isEmptyPatch(patch)) {
      setSession(null);
      setPending(null);
      // Nothing of mine left to send, but a merge may have read a newer version: show it.
      if (s.base.rowVersion !== thing.rowVersion) await refresh();
      return;
    }
    try {
      const { auditEvents } = await inventoryApi.updateThing(s.base.id, patch, s.base.rowVersion);
      setSession(null);
      setPending(null);
      await refresh();
      offerUndo(
        {
          title: t`Saved`,
          ...(mergedFrom ? { description: t`${mergedFrom}'s other changes were kept too.` } : {}),
        },
        auditEvents,
      );
    } catch (e) {
      if (!(isApiError(e) && e.status === 412) || tries >= 3) throw e;
      const changedBy =
        (e.details.changedBy as { displayName?: string } | undefined)?.displayName ?? null;
      const latest = await inventoryApi.thing(s.base.id);
      const theirs = formValues(latest);
      const fields = [...new Set([...mergeFields(s.base.fields), ...mergeFields(latest.fields)])];
      const { merged, conflicts } = merge(s.baseValues, s.draft, theirs, fields);
      const next: Session = { base: latest, baseValues: theirs, draft: merged };
      setSession(next);
      if (conflicts.length) {
        setPending({ conflicts, changedBy });
        return;
      }
      await attempt(next, tries + 1, changedBy ?? mergedFrom ?? t`Someone`);
    }
  };

  const save = async () => {
    if (!session) return;
    const errs = validate(session.baseValues, session.draft, session.base.fields, messages);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setSaving(true);
    try {
      await attempt(session, 0, null);
    } catch (e) {
      toast({ title: t`Couldn't save`, description: errorText(e), tone: 'danger' });
    } finally {
      setSaving(false);
    }
  };

  const resolve = async (choices: Record<string, Resolution>) => {
    if (!session || !pending) return;
    let draft = session.draft;
    for (const c of pending.conflicts)
      if (choices[c.field] === 'theirs') draft = setPath(draft, c.field, c.theirs as FormValue);
    const next = { ...session, draft };
    setSession(next);
    setPending(null);
    const editing = pending.conflicts.find((c) => choices[c.field] === 'edit');
    if (editing) {
      setFocusField(editing.field);
      return;
    }
    setSaving(true);
    try {
      await attempt(next, 0, pending.changedBy);
    } catch (e) {
      toast({ title: t`Couldn't save`, description: errorText(e), tone: 'danger' });
    } finally {
      setSaving(false);
    }
  };

  return {
    session,
    pending,
    errors,
    saving,
    focusField,
    start,
    cancel,
    change,
    save,
    resolve,
    dismissConflict: () => setPending(null),
  };
}

export type ThingEditor = ReturnType<typeof useThingEditor>;

function TextAreaField({
  id,
  label,
  value,
  onChange,
  errorMessage,
}: {
  id: string;
  label: ReactNode;
  value: string;
  onChange: (v: string) => void;
  errorMessage?: string;
}) {
  return (
    <TextFieldPrimitive
      id={id}
      value={value}
      onChange={onChange}
      isInvalid={!!errorMessage}
      className="grid gap-1"
    >
      <Label>{label}</Label>
      <TextArea dir="auto" rows={4} className={inputClass} />
      <FieldError>{errorMessage}</FieldError>
    </TextFieldPrimitive>
  );
}

/** The form itself: the thing's own fields, then its type's (secrets have their own section). */
export function EditForm({ editor }: { editor: ThingEditor }) {
  const { thing, location } = useThingCtx();
  const { t } = useLingui();
  const conditions = useConditionLabels();
  const fieldLabel = useFieldLabel();
  const accountId = useLocationAccountId(location);
  const type = useTypeDetail(thing.type?.id ?? null);
  const caps = type.data?.resolvedCapabilities ?? [];
  const session = editor.session;
  if (!session) return null;
  const v = session.draft;
  const err = (path: string) => editor.errors[path];
  const common = (path: string) => ({
    id: `edit-${path}`,
    autoFocus: editor.focusField === path,
    ...(err(path) ? { errorMessage: err(path), isInvalid: true } : {}),
  });
  // D10 (Q11): serialized or metered types, or a thing with a meter, are always one.
  const quantityForced =
    caps.includes('serialized') || caps.includes('metered') || thing.meters.length > 0;

  return (
    <form
      noValidate
      aria-label={t`Edit ${thing.name ?? ''}`}
      className="grid gap-3.5 rounded-[10px] border border-line bg-surface p-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        void editor.save();
      }}
    >
      <TextField
        label={t`Name`}
        value={v.name}
        onChange={(x) => editor.change('name', x)}
        inputProps={{ dir: 'auto' }}
        {...common('name')}
      />
      {quantityForced ? null : (
        <TextField
          label={t`Quantity`}
          value={v.quantity}
          onChange={(x) => editor.change('quantity', x)}
          inputProps={{ inputMode: 'numeric' }}
          {...common('quantity')}
        />
      )}
      <RegistryPicker
        kind="brands"
        accountId={accountId}
        label={t`Brand`}
        value={v.brandId}
        onChange={(id) => editor.change('brandId', id)}
      />
      <div className="grid gap-3.5 md:grid-cols-2">
        <TextField
          label={t`Model`}
          value={v.model}
          onChange={(x) => editor.change('model', x)}
          inputProps={{ dir: 'auto' }}
          {...common('model')}
        />
        <TextField
          label={t`Serial number`}
          value={v.serial}
          onChange={(x) => editor.change('serial', x)}
          inputProps={{ dir: 'ltr' }}
          {...common('serial')}
        />
        <TextField
          label={t`Barcode`}
          value={v.barcode}
          onChange={(x) => editor.change('barcode', x)}
          inputProps={{ dir: 'ltr', inputMode: 'numeric' }}
          {...common('barcode')}
        />
        <TextField
          label={t`Colour`}
          value={v.colour}
          onChange={(x) => editor.change('colour', x)}
          inputProps={{ dir: 'auto' }}
          {...common('colour')}
        />
      </div>
      <Combobox
        label={t`Condition`}
        items={(Object.keys(conditions) as (keyof typeof conditions)[]).map((c) => ({
          id: c,
          label: conditions[c],
        }))}
        selectedKey={v.condition}
        onSelectionChange={(k) => editor.change('condition', k ? String(k) : null)}
      />
      {caps.includes('expires') || v.expiresOn ? (
        <DatePicker
          label={t`Expires on`}
          value={v.expiresOn}
          onChange={(d) => editor.change('expiresOn', d)}
        />
      ) : null}
      <TextField
        label={t`Manual (web address)`}
        value={v.manualUrl}
        onChange={(x) => editor.change('manualUrl', x)}
        inputProps={{ dir: 'ltr', inputMode: 'url' }}
        {...common('manualUrl')}
      />
      {editableFields(session.base.fields).map((f) => (
        <CustomInput
          key={f.id}
          field={f}
          label={fieldLabel(f)}
          value={v.custom[f.key] ?? null}
          onChange={(x) => editor.change(`custom.${f.key}`, x)}
          id={`edit-custom.${f.key}`}
          autoFocus={editor.focusField === `custom.${f.key}`}
          {...(err(`custom.${f.key}`) ? { errorMessage: err(`custom.${f.key}`) as string } : {})}
        />
      ))}
      <TextAreaField
        id="edit-notes"
        label={t`Notes`}
        value={v.notes}
        onChange={(x) => editor.change('notes', x)}
        {...(err('notes') ? { errorMessage: err('notes') as string } : {})}
      />
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onPress={editor.cancel} isDisabled={editor.saving}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" isPending={editor.saving}>
          <Trans>Save</Trans>
        </Button>
      </div>
      <ConflictSheet
        pending={editor.pending}
        session={editor.session}
        onResolve={(c) => void editor.resolve(c)}
        onDismiss={editor.dismissConflict}
        display={(path, value) => (
          <FormValueText path={path} value={value} fields={session.base.fields} />
        )}
        label={(path) => labelOf(path, session.base.fields, fieldLabel, t)}
      />
    </form>
  );
}

function labelOf(
  path: string,
  fields: readonly ResolvedField[],
  fieldLabel: (f: ResolvedField) => string,
  t: ReturnType<typeof useLingui>['t'],
): string {
  if (path.startsWith('custom.')) {
    const f = fields.find((x) => x.key === path.slice(7));
    return f ? fieldLabel(f) : path.slice(7);
  }
  const names: Record<string, string> = {
    name: t`Name`,
    quantity: t`Quantity`,
    brandId: t`Brand`,
    model: t`Model`,
    serial: t`Serial number`,
    barcode: t`Barcode`,
    colour: t`Colour`,
    condition: t`Condition`,
    notes: t`Notes`,
    manualUrl: t`Manual`,
    expiresOn: t`Expires on`,
  };
  return names[path] ?? path;
}

/** A form value as text, for the conflict sheet. */
function FormValueText({
  path,
  value,
}: {
  path: string;
  value: unknown;
  fields: readonly ResolvedField[];
}) {
  const { thing } = useThingCtx();
  const conditions = useConditionLabels();
  const { t } = useLingui();
  if (value === null || value === '' || (Array.isArray(value) && value.length === 0))
    return <span className="text-ink-3">{t`(empty)`}</span>;
  if (path === 'brandId')
    return <bdi>{thing.brand && thing.brand.id === value ? thing.brand.name : String(value)}</bdi>;
  if (path === 'condition')
    return <>{conditions[value as keyof typeof conditions] ?? String(value)}</>;
  if (typeof value === 'boolean') return <>{value ? t`Yes` : t`No`}</>;
  if (Array.isArray(value)) return <bdi dir="auto">{value.join(', ')}</bdi>;
  if (typeof value === 'object') {
    const m = value as Money;
    return <bdi dir="ltr">{`${m.amount} ${m.currency}`}</bdi>;
  }
  return <bdi dir="auto">{String(value)}</bdi>;
}

function CustomInput({
  field,
  label,
  value,
  onChange,
  id,
  autoFocus,
  errorMessage,
}: {
  field: ResolvedField;
  label: string;
  value: FormValue;
  onChange: (v: FormValue) => void;
  id: string;
  autoFocus: boolean;
  errorMessage?: string;
}) {
  const { t } = useLingui();
  const invalid = errorMessage ? { errorMessage, isInvalid: true } : {};
  const withUnit = field.unit ? `${label} (${field.unit})` : label;
  if (field.kind === 'boolean')
    return (
      <Switch isSelected={value === true} onChange={onChange} id={id} autoFocus={autoFocus}>
        {label}
      </Switch>
    );
  if (field.kind === 'date')
    return (
      <DatePicker
        label={label}
        value={typeof value === 'string' ? value : null}
        onChange={onChange}
        {...(errorMessage ? { errorMessage } : {})}
      />
    );
  if (field.kind === 'select')
    return (
      <Combobox
        label={label}
        items={(field.options ?? []).map((o) => ({ id: o, label: o }))}
        selectedKey={typeof value === 'string' ? value : null}
        onSelectionChange={(k) => onChange(k ? String(k) : null)}
        {...invalid}
      />
    );
  if (field.kind === 'money') {
    const m = (
      value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : { amount: '', currency: '' }
    ) as Money;
    return (
      <fieldset className="m-0 grid gap-2 border-0 p-0 md:grid-cols-[1fr_10rem]">
        <legend className="sr-only">{label}</legend>
        <TextField
          label={label}
          value={m.amount}
          onChange={(x) => onChange({ amount: x, currency: m.currency })}
          inputProps={{ inputMode: 'decimal', dir: 'ltr' }}
          id={id}
          autoFocus={autoFocus}
          {...invalid}
        />
        <CurrencyPicker
          label={t`Currency`}
          value={m.currency || null}
          onChange={(c) => onChange({ amount: m.amount, currency: c ?? '' })}
        />
      </fieldset>
    );
  }
  if (field.kind === 'multi_select' || field.repeatable) {
    const list = Array.isArray(value) ? value : [];
    return (
      <TextField
        label={withUnit}
        description={t`Separate several with commas.`}
        value={list.join(', ')}
        onChange={(x) =>
          onChange(
            x
              .split(/[,،]/)
              .map((s) => s.trim())
              .filter(Boolean),
          )
        }
        inputProps={{ dir: 'auto' }}
        id={id}
        autoFocus={autoFocus}
        {...invalid}
      />
    );
  }
  return (
    <TextField
      label={withUnit}
      value={typeof value === 'string' ? value : ''}
      onChange={onChange}
      inputProps={{
        dir: field.kind === 'url' || field.kind === 'number' ? 'ltr' : 'auto',
        ...(field.kind === 'number' ? { inputMode: 'decimal' as const } : {}),
        ...(field.kind === 'url' ? { inputMode: 'url' as const } : {}),
      }}
      id={id}
      autoFocus={autoFocus}
      {...invalid}
    />
  );
}
