/**
 * "Your codes" on a thing or a place (D208, plan T17a; engineering spec §7.16): the household's own
 * identifiers, as an extra way to find it, never a replacement for its short ID. Several per thing
 * or place; each unique in the location; scanned, searched and typed in the jump box like any
 * code. Codes that came with an import (CSV, Homebox) are listed too, read-only.
 *
 * Adding, renaming and removing are `things.edit` (hidden for a viewer, screens §3), and each
 * offers Undo (D150). A code the location already has says what has it, with a link; one the
 * location's format rule refuses says the owner's own words and example. When the location numbers
 * its codes, "Next number" adds the next one.
 *
 * Codes are shown as stored and printed: upper case, Western digits, left to right in any language
 * (D143).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { Form } from 'react-aria-components';
import { isApiError } from '@/api/client';
import {
  type CodeRefusal,
  type CodeTargetKind,
  codeApi,
  codeKeys,
  type TargetCode,
  useOwnCodeSettings,
  useTargetCodes,
} from '@/api/inventory/codes';
import { useOfferUndo } from '@/components/history/undo';
import { PencilIcon, PlusIcon, TrashIcon } from '@/components/icons';
import { ErrorState, LoadingRows, Section, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';

/** A code as printed: left to right, never translated, never cut. */
export function CodeText({ code }: { code: string }) {
  return (
    <bdi dir="ltr" translate="no" className="font-mono text-[14px] [overflow-wrap:anywhere]">
      {code}
    </bdi>
  );
}

type Refused = { text: string; example?: string; taken?: { kind: CodeTargetKind; id: string } };

/** Why a code was refused, in words, with what the person can do about it. */
function useRefusal() {
  const { t } = useLingui();
  const errorText = useErrorText();
  return (e: unknown): Refused => {
    if (!isApiError(e)) return { text: errorText(e) };
    const d = e.details as CodeRefusal;
    if (e.status === 409 && d.taken)
      return { text: t`This code is already on something else here.`, taken: d.taken };
    if (e.status === 409) return { text: t`This location doesn't number its codes.` };
    if (e.status === 400 && d.rule)
      return d.reason === 'slow'
        ? { text: t`The format rule took too long to check this code.` }
        : { text: e.hint ?? d.rule.message, example: d.rule.example };
    if (e.status === 400) return { text: t`Check the code: 1 to 100 characters.` };
    return { text: errorText(e) };
  };
}

/** What goes with a refusal under the field: the rule's example, or a link to what has the code. */
function RefusalExtras({ refused }: { refused: Refused }) {
  const { example, taken } = refused;
  if (!example && !taken) return null;
  return (
    <span className="grid gap-0.5 text-small text-ink-2">
      {example ? (
        <span>
          <Trans>
            For example: <CodeText code={example} />
          </Trans>
        </span>
      ) : null}
      {taken ? (
        <Link
          to={taken.kind === 'thing' ? '/t/$id' : '/p/$id'}
          params={{ id: taken.id }}
          className="text-info underline underline-offset-2"
        >
          <Trans>Open what has it</Trans>
        </Link>
      ) : null}
    </span>
  );
}

export function OwnCodesSection({
  kind,
  id,
  locationId,
  canEdit,
}: {
  kind: CodeTargetKind;
  id: string;
  locationId: string;
  canEdit: boolean;
}) {
  const codes = useTargetCodes(kind, id);
  const list = codes.data?.codes ?? [];
  // A viewer sees the codes there are, and nothing when there are none.
  if (!canEdit && codes.isSuccess && list.length === 0) return null;
  return (
    <Section title={<Trans>Your codes</Trans>}>
      <div className="grid gap-3 rounded-[10px] border border-line bg-surface p-3.5">
        {codes.isError ? (
          <ErrorState error={codes.error} onRetry={() => void codes.refetch()} />
        ) : codes.isPending ? (
          <LoadingRows rows={1} />
        ) : (
          <CodeList kind={kind} id={id} locationId={locationId} codes={list} canEdit={canEdit} />
        )}
        {canEdit && codes.isSuccess ? (
          <AddCode kind={kind} id={id} locationId={locationId} />
        ) : null}
      </div>
    </Section>
  );
}

function useRefresh(kind: CodeTargetKind, id: string, locationId: string) {
  const qc = useQueryClient();
  return async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: codeKeys.target(kind, id) }),
      qc.invalidateQueries({ queryKey: codeKeys.settings(locationId) }),
      qc.invalidateQueries({ queryKey: codeKeys.mismatches(locationId) }),
    ]);
  };
}

function CodeList({
  kind,
  id,
  locationId,
  codes,
  canEdit,
}: {
  kind: CodeTargetKind;
  id: string;
  locationId: string;
  codes: TargetCode[];
  canEdit: boolean;
}) {
  const { t } = useLingui();
  if (codes.length === 0)
    return (
      <p className="m-0 text-small text-ink-2">
        <Trans>
          None yet. Add a code you already use, like the number on an asset sticker, to find this by
          it too.
        </Trans>
      </p>
    );
  return (
    <ul aria-label={t`Your codes`} className="m-0 grid list-none gap-2 p-0">
      {codes.map((c) => (
        <CodeRow
          key={`${c.source}:${c.sourceCollection}:${c.code}`}
          kind={kind}
          id={id}
          locationId={locationId}
          code={c}
          canEdit={canEdit && c.source === 'own'}
        />
      ))}
    </ul>
  );
}

function CodeRow({
  kind,
  id,
  locationId,
  code,
  canEdit,
}: {
  kind: CodeTargetKind;
  id: string;
  locationId: string;
  code: TargetCode;
  canEdit: boolean;
}) {
  const { t } = useLingui();
  const refresh = useRefresh(kind, id, locationId);
  const offerUndo = useOfferUndo();
  const errorText = useErrorText();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const value = code.code;

  const remove = async () => {
    setBusy(true);
    try {
      const done = await codeApi.remove(kind, id, value);
      await refresh();
      offerUndo({ title: t`Removed ${value}` }, done.auditEvents, {
        ...(kind === 'thing' ? { thingId: id } : {}),
      });
    } catch (e) {
      toast({ title: errorText(e), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  if (editing)
    return (
      <li>
        <RenameCode
          kind={kind}
          id={id}
          locationId={locationId}
          code={value}
          onDone={() => setEditing(false)}
        />
      </li>
    );
  return (
    <li className="flex flex-wrap items-center justify-between gap-2">
      <span className="grid min-w-0 gap-0.5">
        <CodeText code={value} />
        {code.source !== 'own' ? (
          <span className="text-small text-ink-3">
            {code.source === 'homebox' ? (
              <Trans>From Homebox</Trans>
            ) : (
              <Trans>From an import</Trans>
            )}
          </span>
        ) : null}
      </span>
      {canEdit ? (
        <span className="flex gap-1">
          <Button
            variant="ghost"
            size="small"
            aria-label={t`Change ${value}`}
            onPress={() => setEditing(true)}
          >
            <PencilIcon className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="small"
            aria-label={t`Remove ${value}`}
            isPending={busy}
            onPress={() => void remove()}
          >
            <TrashIcon className="size-4" />
          </Button>
        </span>
      ) : null}
    </li>
  );
}

function RenameCode({
  kind,
  id,
  locationId,
  code,
  onDone,
}: {
  kind: CodeTargetKind;
  id: string;
  locationId: string;
  code: string;
  onDone: () => void;
}) {
  const { t } = useLingui();
  const refresh = useRefresh(kind, id, locationId);
  const offerUndo = useOfferUndo();
  const refusal = useRefusal();
  const [value, setValue] = useState(code);
  const [refused, setRefused] = useState<Refused | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setRefused(null);
    try {
      const done = await codeApi.rename(kind, id, code, value);
      await refresh();
      onDone();
      const to = done.body.code;
      offerUndo({ title: t`Changed ${code} to ${to}` }, done.auditEvents, {
        ...(kind === 'thing' ? { thingId: id } : {}),
      });
    } catch (err) {
      setRefused(refusal(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Form onSubmit={(e) => void submit(e)} className="grid gap-2" aria-label={t`Change ${code}`}>
      <TextField
        label={t`Code`}
        value={value}
        onChange={setValue}
        isRequired
        maxLength={100}
        autoFocus
        isInvalid={refused !== null}
        errorMessage={refused?.text}
        inputProps={{ dir: 'ltr', autoCapitalize: 'characters', spellCheck: false }}
      />
      {refused ? <RefusalExtras refused={refused} /> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="small" isPending={busy}>
          <Trans>Save</Trans>
        </Button>
        <Button variant="secondary" size="small" onPress={onDone}>
          <Trans>Cancel</Trans>
        </Button>
      </div>
    </Form>
  );
}

function AddCode({
  kind,
  id,
  locationId,
}: {
  kind: CodeTargetKind;
  id: string;
  locationId: string;
}) {
  const { t } = useLingui();
  const refresh = useRefresh(kind, id, locationId);
  const offerUndo = useOfferUndo();
  const refusal = useRefusal();
  const settings = useOwnCodeSettings(locationId);
  const [value, setValue] = useState('');
  const [refused, setRefused] = useState<Refused | null>(null);
  const [busy, setBusy] = useState<'typed' | 'next' | null>(null);
  const rule = settings.data?.rule ?? null;
  const numbering = settings.data?.numbering;

  const add = async (body: { code: string } | { next: true }) => {
    setBusy('code' in body ? 'typed' : 'next');
    setRefused(null);
    try {
      const done = await codeApi.add(kind, id, body);
      await refresh();
      setValue('');
      const added = done.body.code;
      offerUndo({ title: t`Added ${added}` }, done.auditEvents, {
        ...(kind === 'thing' ? { thingId: id } : {}),
      });
    } catch (err) {
      setRefused(refusal(err));
    } finally {
      setBusy(null);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value.trim()) void add({ code: value });
  };

  return (
    <Form onSubmit={submit} className="grid gap-2" aria-label={t`Add a code`}>
      <TextField
        label={t`Add a code`}
        description={
          rule ? (
            <Trans>
              {rule.message} For example: <CodeText code={rule.example} />
            </Trans>
          ) : undefined
        }
        value={value}
        onChange={(v) => {
          setValue(v);
          setRefused(null);
        }}
        maxLength={100}
        isInvalid={refused !== null}
        errorMessage={refused?.text}
        inputProps={{ dir: 'ltr', autoCapitalize: 'characters', spellCheck: false }}
      />
      {refused ? <RefusalExtras refused={refused} /> : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          size="small"
          variant="secondary"
          isDisabled={!value.trim()}
          isPending={busy === 'typed'}
        >
          <PlusIcon className="size-4" />
          <Trans>Add</Trans>
        </Button>
        {numbering?.enabled ? (
          <Button
            size="small"
            variant="secondary"
            isPending={busy === 'next'}
            onPress={() => void add({ next: true })}
          >
            <Trans>
              Next number: <CodeText code={numbering.next} />
            </Trans>
          </Button>
        ) : null}
      </div>
    </Form>
  );
}
