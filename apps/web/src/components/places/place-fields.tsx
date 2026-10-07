/**
 * A place's fields (D160): what its kind asks for (a closet's filter size, a room's dimensions),
 * shown as a definition list with Edit and an explicit Save.
 *
 * Saving sends only the keys that changed, with If-Match. When someone else saved first (412),
 * the three-way merge (D156) re-applies what only one of you changed without asking; a field you
 * both changed is listed with "keep mine" or "keep theirs", and nothing is lost.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { isApiError } from '@/api/client';
import { inventoryApi } from '@/api/inventory/queries';
import type { ConflictDetails, PlaceView, ResolvedField } from '@/api/inventory/types';
import { PencilIcon } from '@/components/icons';
import { Notice, Section, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Switch } from '@/components/ui/switch';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { useFormat } from '@/lib/format';
import { type Conflict, merge, same } from '@/lib/three-way';
import { useInvalidateBrowse } from './api';

type Values = Record<string, unknown>;

const EDITABLE = new Set(['text', 'number', 'date', 'url', 'boolean', 'select']);

export function fieldLabel(f: ResolvedField): string {
  return f.label ?? f.labelKey ?? f.key;
}

export function PlaceFields({ place, canEdit }: { place: PlaceView; canEdit: boolean }) {
  const fields = place.fields.filter((f) => !f.archivedAt && !f.secret);
  const [editing, setEditing] = useState(false);
  if (fields.length === 0 && place.secrets.length === 0) return null;
  return (
    <Section
      title={<Trans>Details</Trans>}
      action={
        canEdit && !editing && fields.some((f) => EDITABLE.has(f.kind)) ? (
          <Button size="small" variant="ghost" onPress={() => setEditing(true)}>
            <PencilIcon className="size-4" />
            <Trans>Edit</Trans>
          </Button>
        ) : null
      }
    >
      {editing ? (
        <FieldsForm place={place} fields={fields} onDone={() => setEditing(false)} />
      ) : (
        <FieldsView place={place} fields={fields} />
      )}
    </Section>
  );
}

function useShow() {
  const f = useFormat();
  const { t } = useLingui();
  return (field: ResolvedField, value: unknown): string | null => {
    if (value === undefined || value === null || value === '') return null;
    if (field.kind === 'boolean') return value ? t`Yes` : t`No`;
    if (field.kind === 'number' && typeof value === 'number')
      return field.unit ? `${f.num(value)} ${field.unit}` : f.num(value);
    if (field.kind === 'date' && typeof value === 'string') return f.day(value);
    if (Array.isArray(value)) return value.join(', ');
    return String(value);
  };
}

function FieldsView({ place, fields }: { place: PlaceView; fields: ResolvedField[] }) {
  const show = useShow();
  return (
    <dl className="m-0 grid overflow-hidden rounded-[10px] border border-line bg-surface">
      {fields.map((f) => {
        const text = show(f, place.custom[f.key]);
        return (
          <div
            key={f.key}
            className="grid gap-0.5 border-line px-3.5 py-2.5 not-first:border-t sm:grid-cols-[12rem_1fr] sm:gap-3"
          >
            <dt className="text-small text-ink-2">{fieldLabel(f)}</dt>
            <dd className="m-0 text-[15px] text-ink [overflow-wrap:anywhere]">
              {text === null ? <span className="text-ink-3">—</span> : <bdi>{text}</bdi>}
            </dd>
          </div>
        );
      })}
      {place.secrets.map((s) => (
        <div
          key={s.fieldKey}
          className="grid gap-0.5 border-line px-3.5 py-2.5 not-first:border-t sm:grid-cols-[12rem_1fr] sm:gap-3"
        >
          <dt className="text-small text-ink-2">{s.label ?? s.fieldKey}</dt>
          <dd className="m-0 text-[15px] text-ink-3">
            {s.set ? <Trans>Hidden</Trans> : <Trans>Not set</Trans>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The edit form's value for a field ('' for empty; numbers stay text while typing). */
const draftOf = (v: unknown) => (v === undefined || v === null ? '' : v);

/** What a draft means to the server: '' is "remove" (null), a number field parses. */
function wireOf(field: ResolvedField, v: unknown): unknown {
  if (v === '' || v === undefined) return null;
  if (field.kind === 'number' && typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
  }
  return v;
}

function FieldsForm({
  place,
  fields,
  onDone,
}: {
  place: PlaceView;
  fields: ResolvedField[];
  onDone: () => void;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const invalidate = useInvalidateBrowse();
  const editable = fields.filter((f) => EDITABLE.has(f.kind));
  const [base, setBase] = useState<{ values: Values; rowVersion: number }>({
    values: Object.fromEntries(editable.map((f) => [f.key, place.custom[f.key] ?? null])),
    rowVersion: place.rowVersion,
  });
  const [draft, setDraft] = useState<Values>(() =>
    Object.fromEntries(editable.map((f) => [f.key, draftOf(place.custom[f.key])])),
  );
  const [conflicts, setConflicts] = useState<(Conflict & { by: string | null })[]>([]);
  const [numberErrors, setNumberErrors] = useState<Record<string, string>>({});

  const changes = (against: Values) => {
    const out: Values = {};
    for (const f of editable) {
      const v = wireOf(f, draft[f.key]);
      if (!same(v, against[f.key] ?? null)) out[f.key] = v;
    }
    return out;
  };

  const save = useMutation({
    mutationFn: async () => {
      const body = changes(base.values);
      if (Object.keys(body).length === 0) return 'unchanged' as const;
      try {
        await inventoryApi.updatePlace(place.id, { custom: body }, base.rowVersion);
        return 'saved' as const;
      } catch (e) {
        if (!isApiError(e) || e.status !== 412) throw e;
        // Someone saved first: merge field by field (D156).
        const fresh = await inventoryApi.place(place.id);
        const by = (e.details as Partial<ConflictDetails>).changedBy?.displayName ?? null;
        const keys = editable.map((f) => `custom.${f.key}`);
        const mine = Object.fromEntries(editable.map((f) => [f.key, wireOf(f, draft[f.key])]));
        const theirs = Object.fromEntries(
          editable.map((f) => [f.key, fresh.custom[f.key] ?? null]),
        );
        const result = merge({ custom: base.values }, { custom: mine }, { custom: theirs }, keys);
        const found = result.conflicts.map((c) => ({
          ...c,
          field: c.field.replace(/^custom\./, ''),
          by,
        }));
        // What only one of us changed is settled; the form now shows the merged values.
        const merged = result.merged.custom as Values;
        setBase({ values: theirs, rowVersion: fresh.rowVersion });
        setDraft(Object.fromEntries(editable.map((f) => [f.key, draftOf(merged[f.key])])));
        if (found.length) {
          setConflicts(found);
          return 'conflict' as const;
        }
        const retry: Values = {};
        for (const f of editable)
          if (!same(merged[f.key], theirs[f.key])) retry[f.key] = merged[f.key] ?? null;
        if (Object.keys(retry).length)
          await inventoryApi.updatePlace(place.id, { custom: retry }, fresh.rowVersion);
        return 'saved' as const;
      }
    },
    onSuccess: async (outcome) => {
      if (outcome === 'conflict') return;
      await invalidate();
      if (outcome === 'saved') toast({ title: t`Saved`, tone: 'ok' });
      onDone();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errors: Record<string, string> = {};
    for (const f of editable)
      if (f.kind === 'number' && draft[f.key] !== '' && !Number.isFinite(Number(draft[f.key])))
        errors[f.key] = t`Enter a number.`;
    setNumberErrors(errors);
    if (Object.keys(errors).length) return;
    setConflicts([]);
    save.mutate();
  };

  const set = (key: string, v: unknown) => setDraft((d) => ({ ...d, [key]: v }));
  const show = useShow();

  return (
    <form
      onSubmit={submit}
      noValidate
      className="grid gap-3.5 rounded-[10px] border border-line bg-surface p-3.5"
    >
      {editable.map((f) => {
        const label = fieldLabel(f) + (f.unit ? ` (${f.unit})` : '');
        const v = draft[f.key];
        if (f.kind === 'boolean')
          return (
            <Switch key={f.key} isSelected={v === true} onChange={(on) => set(f.key, on)}>
              {label}
            </Switch>
          );
        if (f.kind === 'select')
          return (
            <Combobox
              key={f.key}
              label={label}
              items={(f.options ?? []).map((o) => ({ id: o, label: o }))}
              selectedKey={typeof v === 'string' && v ? v : null}
              onSelectionChange={(k) => set(f.key, k === null ? '' : String(k))}
            />
          );
        return (
          <TextField
            key={f.key}
            label={label}
            value={String(v ?? '')}
            onChange={(x) => set(f.key, x)}
            isInvalid={!!numberErrors[f.key]}
            errorMessage={numberErrors[f.key]}
            {...(f.kind === 'date' ? { placeholder: 'YYYY-MM-DD' } : {})}
            inputProps={{
              dir: f.kind === 'url' || f.kind === 'date' ? 'ltr' : 'auto',
              inputMode: f.kind === 'number' ? 'decimal' : f.kind === 'url' ? 'url' : undefined,
            }}
          />
        );
      })}

      {conflicts.length ? (
        <Notice tone="warn" title={<Trans>Changed since you opened it</Trans>}>
          <ul className="m-0 grid list-none gap-3 p-0">
            {conflicts.map((c) => {
              const f = editable.find((x) => x.key === c.field);
              if (!f) return null;
              const who = c.by ?? t`Someone`;
              const theirs = show(f, c.theirs) ?? t`(empty)`;
              const mine = show(f, c.mine) ?? t`(empty)`;
              return (
                <li key={c.field} className="grid gap-1.5">
                  <span className="font-semibold text-ink">{fieldLabel(f)}</span>
                  <span>
                    <Trans>
                      {who} changed it to <bdi>{theirs}</bdi>; you have <bdi>{mine}</bdi>.
                    </Trans>
                  </span>
                  <span className="flex flex-wrap gap-2">
                    <Button
                      size="small"
                      variant="secondary"
                      onPress={() => setConflicts((cs) => cs.filter((x) => x.field !== c.field))}
                    >
                      <Trans>Keep mine</Trans>
                    </Button>
                    <Button
                      size="small"
                      variant="secondary"
                      onPress={() => {
                        set(c.field, draftOf(c.theirs));
                        setConflicts((cs) => cs.filter((x) => x.field !== c.field));
                      }}
                    >
                      <Trans>Keep theirs</Trans>
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        </Notice>
      ) : null}
      {save.error ? <Notice tone="danger">{errorText(save.error)}</Notice> : null}

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onPress={onDone}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" isPending={save.isPending} isDisabled={conflicts.length > 0}>
          <Trans>Save</Trans>
        </Button>
      </div>
    </form>
  );
}
