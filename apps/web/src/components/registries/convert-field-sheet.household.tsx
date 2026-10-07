/**
 * Converting a type's field (D172, D177, D193; screens "Type editor"; frame 08 "Convert a field";
 * step-7 plan T24, Q20): **Make secret** or **Make plain** on a text field, or **Change kind**
 * to one `CONVERSIONS` allows. The account owner only, for every location that uses the type.
 * Loaded on demand (./convert-field-sheet.tsx): it reads and writes the server.
 *
 * The sheet previews per location, counts only, never a value (`POST
 * /type-fields/:id/convert/preview`): "12 values move to secrets", or for a kind "9 convert ·
 * 3 go to the notes"; a location the owner can't see is named as such (D123). To secret it warns
 * that past history keeps only that the value changed and that exports already made still hold
 * it. Nothing here is undoable, so the field's name is typed to confirm. To secret needs the
 * recovery kit saved first (409 `recovery_kit_required`, D193): the sheet says so, with the
 * status page for an instance admin, as the first AI key does (step 3).
 */
import { CONVERSIONS, type ConvertFieldBody, type FieldKind } from '@kept/shared';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type ReactElement, useState } from 'react';
import { isApiError } from '@/api/client';
import type { ResolvedField } from '@/api/inventory/types';
import { portabilityApi } from '@/api/portability/queries';
import type { ConvertPreview } from '@/api/portability/types';
import { useMe } from '@/api/queries';
import { LoadingRows, Notice, useErrorText } from '@/components/page';
import { Sheet } from '@/components/places/sheet';
import { useFieldLabel } from '@/components/things/names';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { DialogFooter } from '@/components/ui/dialog';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { isolate } from '@/lib/bidi';
import { sep, useFormat } from '@/lib/format';
import { useOnline } from '@/lib/online';
import { useFieldKindLabels } from './labels';

export type ConvertMode = 'secret' | 'plain' | 'kind';

export type ConvertFieldSheetProps = {
  /** The field and what to do with it; null keeps the sheet closed. */
  target: { field: ResolvedField; mode: ConvertMode } | null;
  onClose: () => void;
  /** After a conversion: refetch the type. */
  onConverted: () => void;
};

/** The kinds that take choices, and the one that takes a unit (as the field sheet asks). */
const WITH_OPTIONS: readonly FieldKind[] = ['select', 'multi_select'];

/** Choices as typed, split on commas (Arabic ones too). */
const choicesOf = (s: string) =>
  s
    .split(/[,،]/)
    .map((x) => x.trim())
    .filter(Boolean);

export function ConvertFieldSheet({
  target,
  onClose,
  onConverted,
}: ConvertFieldSheetProps): ReactElement | null {
  const { t } = useLingui();
  const labelOf = useFieldLabel();
  const label = target ? labelOf(target.field) : '';
  const title = !target
    ? ''
    : target.mode === 'secret'
      ? t`Make ${isolate(label)} secret?`
      : target.mode === 'plain'
        ? t`Make ${isolate(label)} plain?`
        : t`Change the kind of ${isolate(label)}`;
  return (
    <Sheet isOpen={target !== null} onOpenChange={(open) => !open && onClose()} title={title}>
      {({ close }) =>
        target ? (
          <ConvertForm
            key={`${target.field.id}:${target.mode}`}
            field={target.field}
            mode={target.mode}
            label={label}
            onDone={close}
            onConverted={onConverted}
          />
        ) : null
      }
    </Sheet>
  );
}

function ConvertForm({
  field,
  mode,
  label,
  onDone,
  onConverted,
}: {
  field: ResolvedField;
  mode: ConvertMode;
  label: string;
  onDone: () => void;
  onConverted: () => void;
}) {
  const { t } = useLingui();
  const kinds = useFieldKindLabels();
  const online = useOnline();
  const errorText = useErrorText();
  const fmt = useFormat();
  const me = useMe();
  const targets = CONVERSIONS[field.kind];
  const [kind, setKind] = useState<FieldKind | null>(
    targets.length === 1 ? (targets[0] ?? null) : null,
  );
  const [options, setOptions] = useState('');
  const [unit, setUnit] = useState('');
  const [typed, setTyped] = useState('');
  const [kitNeeded, setKitNeeded] = useState(false);

  // The body, once it's complete enough to preview.
  const body: ConvertFieldBody | null =
    mode === 'secret'
      ? { toSecret: true }
      : mode === 'plain'
        ? { toSecret: false }
        : !kind
          ? null
          : WITH_OPTIONS.includes(kind)
            ? choicesOf(options).length
              ? { kind, options: choicesOf(options) }
              : null
            : kind === 'number' && unit.trim()
              ? { kind, unit: unit.trim() }
              : { kind };

  const preview = useQuery({
    queryKey: ['type-fields', field.id, 'convert-preview', body],
    queryFn: () => portabilityApi.convertPreview(field.id, body as ConvertFieldBody),
    enabled: body !== null && online,
    staleTime: 0,
  });

  const convert = useMutation({
    mutationFn: () => portabilityApi.convert(field.id, body as ConvertFieldBody, field.rowVersion),
    onSuccess: (r) => {
      toast({
        tone: 'ok',
        title:
          mode === 'secret'
            ? t`${isolate(label)} is secret now`
            : mode === 'plain'
              ? t`${isolate(label)} is plain text now`
              : t`${isolate(label)} changed kind`,
        ...(r.toNotes > 0
          ? {
              description: t`${fmt.num(r.converted)} converted, ${fmt.num(r.toNotes)} moved to the things' notes.`,
            }
          : {}),
      });
      onConverted();
      onDone();
    },
    onError: (e) => {
      if (
        isApiError(e) &&
        (e.code === 'recovery_kit_required' || e.serverCode === 'recovery_kit_required')
      )
        setKitNeeded(true);
    },
  });

  const confirmed = typed.trim().normalize('NFC') === label.trim().normalize('NFC');
  const ready = body !== null && preview.isSuccess && confirmed && online;
  const action =
    mode === 'secret' ? t`Make secret` : mode === 'plain' ? t`Make plain` : t`Change kind`;

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) convert.mutate();
      }}
    >
      {mode === 'kind' ? (
        <>
          <Combobox
            label={t`New kind`}
            items={targets.map((k) => ({ id: k, label: kinds[k] }))}
            selectedKey={kind}
            onSelectionChange={(k) => setKind(k ? (String(k) as FieldKind) : null)}
            description={t`Now: ${kinds[field.kind]}`}
          />
          {kind && WITH_OPTIONS.includes(kind) ? (
            <TextField
              label={t`Choices`}
              description={t`Separate the choices with commas. A value that isn't one of them goes to the notes.`}
              value={options}
              onChange={setOptions}
            />
          ) : null}
          {kind === 'number' ? (
            <TextField
              label={t`Unit`}
              description={t`Shown next to the number, never converted: in, cm, W.`}
              value={unit}
              onChange={setUnit}
            />
          ) : null}
        </>
      ) : null}

      {!online ? (
        <Notice tone="warn" title={t`Needs a connection`} />
      ) : body === null ? null : preview.isPending ? (
        <LoadingRows rows={2} />
      ) : preview.isError ? (
        <Notice tone="danger">{errorText(preview.error)}</Notice>
      ) : (
        <PreviewList preview={preview.data} mode={mode} />
      )}

      {mode === 'secret' ? (
        <Notice
          tone="warn"
          title={<Trans>Past history keeps that the value changed, but no longer the value.</Trans>}
        >
          <Trans>Exports made before now still hold it.</Trans>
        </Notice>
      ) : mode === 'plain' ? (
        <Notice tone="warn">
          <Trans>
            Its values show to everyone who can see the thing, and history keeps them from now on.
          </Trans>
        </Notice>
      ) : null}

      {kitNeeded ? (
        <Notice
          tone="warn"
          title={<Trans>Download the recovery kit first</Trans>}
          action={
            me.data?.user.instanceAdmin ? (
              <Link
                to="/admin/status"
                className="font-semibold text-ink underline underline-offset-2 outline-none focus-visible:outline-2 focus-visible:outline-info"
              >
                <Trans>Open the status page</Trans>
              </Link>
            ) : undefined
          }
        >
          {me.data?.user.instanceAdmin ? (
            <Trans>
              Secrets are values Kept must be able to recover. Save the recovery kit on the status
              page, then make the field secret again.
            </Trans>
          ) : (
            <Trans>
              The person who runs this server needs to save the recovery kit before secrets can be
              kept. Ask them, then make the field secret again.
            </Trans>
          )}
        </Notice>
      ) : convert.isError ? (
        <Notice tone="danger">{errorText(convert.error)}</Notice>
      ) : null}

      <TextField
        label={t`Type ${isolate(label)} to confirm`}
        description={t`This can't be undone.`}
        value={typed}
        onChange={setTyped}
        inputProps={{ dir: 'auto', autoComplete: 'off', spellCheck: false }}
      />

      <DialogFooter>
        <Button variant="secondary" onPress={onDone}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" isDisabled={!ready} isPending={convert.isPending}>
          {action}
        </Button>
      </DialogFooter>
    </form>
  );
}

function PreviewList({ preview, mode }: { preview: ConvertPreview; mode: ConvertMode }) {
  const { t } = useLingui();
  if (preview.total === 0)
    return (
      <p className="m-0 text-ink-2">
        <Trans>Nothing holds a value yet: only the field changes.</Trans>
      </p>
    );
  return (
    <ul
      aria-label={t`What changes, by location`}
      className="m-0 grid list-none overflow-hidden rounded-[10px] border border-line bg-surface p-0 [&>li+li]:border-t [&>li+li]:border-line"
    >
      {preview.locations.map((l) => (
        <li key={l.id} className="grid gap-0.5 px-3.5 py-2.5">
          <span className="font-semibold text-[15px]">
            {l.name ? <bdi>{l.name}</bdi> : <Trans>A location you can't see</Trans>}
          </span>
          <span className="text-small text-ink-2">
            {mode === 'secret' ? (
              <Plural
                value={l.values}
                one="# value moves to secrets"
                other="# values move to secrets"
              />
            ) : mode === 'plain' ? (
              <Plural
                value={l.values}
                one="# value becomes plain text"
                other="# values become plain text"
              />
            ) : (
              <>
                <Plural value={l.convertible} one="# converts" other="# convert" />
                {l.toNotes > 0 ? (
                  <>
                    {sep()}
                    <Plural value={l.toNotes} one="# goes to the notes" other="# go to the notes" />
                  </>
                ) : null}
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
