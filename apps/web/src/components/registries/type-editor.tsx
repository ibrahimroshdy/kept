/**
 * The type editor (screens §5 Type editor, frame 06 · 5; D12, D92, D123, D154, D172, D177, D192),
 * the right-hand side of Account → Types and the whole of /types/<id>. In order:
 *
 * 1. Identity: name and icon (the picker is lazy, ./icon-choice), and where it sits in the tree.
 * 2. Capabilities: its own, and those it inherits (on, and not changeable here).
 * 3. Fields: inherited first with their source, its own, then its groups' (./field-list).
 * 4. Field groups: the built-in Device group is shown read-only (D192).
 *
 * A built-in is read-only until Customise, which copies it (and the built-ins below it, Q13b)
 * into the account and moves the account's things onto the copy. Saving opens the impact preview
 * first (D92, D123). A cycle, a key defined twice and a stale version each get their own message.
 * Members and viewers see the same page read-only; only the owner sees secret-field controls,
 * and converts a field to or from secret or to another kind (step-7 T24, ./convert-field-sheet).
 */
import { plural } from '@lingui/core/macro';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useMutation } from '@tanstack/react-query';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { isApiError } from '@/api/client';
import { inventoryApi, useType } from '@/api/inventory/queries';
import type {
  Capability,
  ResolvedField,
  TypeDetail,
  TypeNode,
  UpdateTypeBody,
} from '@/api/inventory/types';
import { CheckIcon, LockIcon, PlusIcon, XIcon } from '@/components/icons';
import { ErrorState, LoadingRows, Notice, useErrorText } from '@/components/page';
import { Sheet } from '@/components/places/sheet';
import { useTypeName } from '@/components/things/names';
import { TypeIcon } from '@/components/type-icon';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { useConfirm } from '@/components/ui/confirm';
import { DialogFooter } from '@/components/ui/dialog';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { sep } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  type AccountScope,
  conflictKey,
  conflictReason,
  descendantIds,
  isBuiltinOriginal,
  registryApi,
  useInvalidateTypes,
} from './api';
import { ConvertFieldSheet, type ConvertMode } from './convert-field-sheet';
import { FieldList } from './field-list';
import { FieldSheet, type FieldSheetTarget } from './field-sheet';
import { IconChoice } from './icon-choice';
import { ImpactPreview } from './impact-preview';
import { CAPABILITY_ORDER, useCapabilityHelp, useCapabilityLabels } from './labels';
import { SecretPolicySheet } from './secret-policy-sheet';

type Draft = {
  name: string;
  icon: string;
  parentId: string | null;
  capabilities: Capability[];
  fieldGroups: string[];
};

const draftOf = (t: TypeDetail, name: string): Draft => ({
  name,
  icon: t.icon,
  parentId: t.parentId,
  capabilities: [...t.capabilities],
  fieldGroups: [...t.fieldGroups],
});

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

/** What changed, as the PATCH (and preview) body. */
function changes(t: TypeDetail, name: string, d: Draft): UpdateTypeBody {
  const out: UpdateTypeBody = {};
  if (d.name.trim() !== name) out.name = d.name.trim();
  if (d.icon !== t.icon) out.icon = d.icon;
  if (d.parentId !== t.parentId) out.parentId = d.parentId;
  if (!same(d.capabilities, t.capabilities)) out.capabilities = d.capabilities;
  if (!same(d.fieldGroups, t.fieldGroups)) out.fieldGroups = d.fieldGroups;
  return out;
}

export function TypeEditor({
  typeId,
  scope,
  types,
  onNavigate,
}: {
  typeId: string;
  scope: AccountScope;
  /** The account's types (the tree's list), for names, the parent picker and groups. */
  types: readonly TypeNode[];
  /** Show another type: after Customise, a merge, or a delete. */
  onNavigate: (typeId: string | null) => void;
}) {
  const { t } = useLingui();
  const detail = useType(typeId);
  if (detail.isPending) return <LoadingRows rows={4} label={t`Loading the type`} />;
  if (detail.error)
    return <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />;
  return (
    <Editor
      key={`${detail.data.id}:${detail.data.rowVersion}`}
      type={detail.data}
      scope={scope}
      types={types}
      onNavigate={onNavigate}
      reload={() => void detail.refetch()}
    />
  );
}

function Editor({
  type,
  scope,
  types,
  onNavigate,
  reload,
}: {
  type: TypeDetail;
  scope: AccountScope;
  types: readonly TypeNode[];
  onNavigate: (typeId: string | null) => void;
  reload: () => void;
}) {
  const { t } = useLingui();
  const typeName = useTypeName();
  const capLabels = useCapabilityLabels();
  const capHelp = useCapabilityHelp();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const invalidate = useInvalidateTypes();
  const name = typeName(type);
  const builtin = isBuiltinOriginal(type);
  const editable = scope.canManage && !builtin && !type.isFieldGroup;
  const [draft, setDraft] = useState<Draft>(() => draftOf(type, name));
  const [preview, setPreview] = useState<UpdateTypeBody | null>(null);
  const [saveError, setSaveError] = useState<ReactNode>(null);
  const [fieldTarget, setFieldTarget] = useState<FieldSheetTarget | null>(null);
  const [policyField, setPolicyField] = useState<ResolvedField | null>(null);
  const [converting, setConverting] = useState<{
    field: ResolvedField;
    mode: ConvertMode;
  } | null>(null);
  const [merging, setMerging] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  const byId = useMemo(() => new Map(types.map((x) => [x.id, x])), [types]);
  const nameById = (id: string) => {
    const x = byId.get(id);
    return x ? typeName(x) : undefined;
  };
  const below = useMemo(() => descendantIds(types, type.id), [types, type.id]);
  const body = changes(type, name, draft);
  const dirty = Object.keys(body).length > 0;

  // A group's users, for "Device group · shared by TV / display, Phone and Tablet".
  const groupSharedBy = (groupId: string) =>
    types.filter((x) => x.fieldGroups.includes(groupId)).map((x) => typeName(x));

  const parent = type.parentId ? byId.get(type.parentId) : undefined;
  const inheritedCaps = new Set(
    type.resolvedCapabilities.filter((c) => !type.capabilities.includes(c)),
  );

  const customise = useMutation({
    mutationFn: () => registryApi.customise(type.id, scope.accountId),
    onSuccess: async ({ typeId }) => {
      await invalidate(type.id);
      toast({
        title: t`${name} is now your account's own type`,
        description: t`Your things of this type use the copy, and you can change it.`,
        tone: 'ok',
      });
      onNavigate(typeId);
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });

  const fieldOp = useMutation({
    mutationFn: ({ op, field }: { op: 'archive' | 'restore'; field: ResolvedField }) =>
      op === 'archive' ? registryApi.archiveField(field.id) : registryApi.restoreField(field.id),
    onSuccess: async (_r, { op }) => {
      await invalidate(type.id);
      toast({ title: op === 'archive' ? t`Field archived` : t`Field restored`, tone: 'ok' });
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });

  const remove = useMutation({
    mutationFn: () => registryApi.deleteType(type.id),
    onSuccess: async () => {
      await invalidate();
      toast({ title: t`Deleted ${name}`, tone: 'ok' });
      onNavigate(type.parentId);
    },
    onError: (e) =>
      toast({
        title:
          isApiError(e) && e.code === 'in_use'
            ? t`${name} is in use: things or types below it still use it. Merge it into another type instead.`
            : errorText(e),
        tone: 'danger',
      }),
  });

  const save = async () => {
    setSaveError(null);
    try {
      await inventoryApi.updateType(type.id, body, type.rowVersion);
    } catch (e) {
      setSaveError(<Notice tone="danger">{saveMessage(e, body)}</Notice>);
      throw e;
    }
    setPreview(null);
    await invalidate(type.id);
    toast({ title: t`Saved ${name}`, tone: 'ok' });
  };

  function saveMessage(e: unknown, sent: UpdateTypeBody): ReactNode {
    const reason = conflictReason(e, sent.parentId !== undefined ? 'cycle' : 'field_redefined');
    if (reason === 'cycle')
      return t`A type can't sit inside itself or a type below it. Pick a parent outside this branch.`;
    if (reason === 'field_redefined') {
      const clash = conflictKey(e);
      return clash
        ? t`That would give the field “${clash}” twice: a group or parent already has it. Remove the clash first.`
        : t`That would give a field key twice: a group or parent already has a field this type defines. Remove the clash first.`;
    }
    if (reason === 'builtin')
      return t`Built-in types are customised first: use Customise to make an editable copy.`;
    if (isApiError(e) && e.code === 'precondition_failed') {
      const who =
        (e.details.changedBy as { displayName?: string } | undefined)?.displayName ?? t`Someone`;
      return (
        <span className="grid gap-2">
          <span>
            <Trans>
              {who} changed this type since you opened it. Reload to see their change, then make
              yours again.
            </Trans>
          </span>
          <Button size="small" variant="secondary" onPress={reload} className="justify-self-start">
            <Trans>Reload</Trans>
          </Button>
        </span>
      );
    }
    return errorText(e);
  }

  const takenKeys = new Set([
    ...type.fields.map((f) => f.key),
    // A key used below this type would be redefined there too.
  ]);

  const groupOptions = types
    .filter((x) => x.isFieldGroup && !draft.fieldGroups.includes(x.id))
    .map((x) => ({ id: x.id, label: typeName(x) }));
  const parentOptions = [
    { id: '__top__', label: t`Top level`, description: t`Not inside another type` },
    ...types
      .filter((x) => !x.isFieldGroup && x.id !== type.id && !below.has(x.id))
      .map((x) => {
        const p = x.parentId ? byId.get(x.parentId) : undefined;
        return {
          id: x.id,
          label: typeName(x),
          ...(p ? { description: typeName(p) } : {}),
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label)),
  ];

  return (
    <article className="grid content-start gap-5" aria-label={name}>
      <header className="flex flex-wrap items-start gap-3">
        <span
          aria-hidden="true"
          className="grid size-12 shrink-0 place-items-center rounded-[10px] bg-sunken text-ink [&_svg]:size-6"
        >
          <TypeIcon icon={draft.icon} />
        </span>
        <div className="grid min-w-0 flex-1 basis-48 gap-1">
          <h2 className="m-0 font-semibold text-[20px] leading-tight [overflow-wrap:anywhere]">
            <bdi>{name}</bdi>
          </h2>
          <p className="m-0 text-small text-ink-2">
            {type.isFieldGroup ? (
              <Trans>Built-in field group · read-only</Trans>
            ) : builtin ? (
              <Trans>Built in · read-only until you customise it</Trans>
            ) : type.copiedFromId ? (
              <Trans>Customised from the built-in type</Trans>
            ) : (
              <Trans>Your account's own type</Trans>
            )}
            {type.inUse > 0 ? (
              <>
                {sep()}
                <Plural value={type.inUse} one="# thing uses it" other="# things use it" />
              </>
            ) : null}
          </p>
        </div>
        {scope.canManage ? (
          <div className="flex flex-wrap gap-2">
            {builtin && !type.isFieldGroup ? (
              <Button isPending={customise.isPending} onPress={() => customise.mutate()}>
                <Trans>Customise</Trans>
              </Button>
            ) : null}
            {editable ? (
              <>
                <Button variant="secondary" onPress={() => setMerging(true)}>
                  <Trans>Merge into…</Trans>
                </Button>
                <Button
                  variant="secondary"
                  isPending={remove.isPending}
                  onPress={async () => {
                    const ok = await confirm({
                      title: t`Delete ${name}?`,
                      body: t`Only a type nothing uses can be deleted. To move its things to another type, merge it instead.`,
                      confirmLabel: t`Delete`,
                      destructive: true,
                    });
                    if (ok) remove.mutate();
                  }}
                >
                  <Trans>Delete</Trans>
                </Button>
              </>
            ) : null}
          </div>
        ) : null}
      </header>

      {builtin && !type.isFieldGroup && scope.canManage ? (
        <Notice tone="info">
          <Trans>
            Built-in types are shared by everyone on this server. Customise makes your account's own
            copy: your things of this type move to it, the built-in types below it come along, and
            then you can change its name, icon, capabilities and fields.
          </Trans>
        </Notice>
      ) : null}
      {!scope.canManage ? (
        <Notice tone="info">
          <Trans>Only the owner and admins change types. You can see how they're set up.</Trans>
        </Notice>
      ) : null}

      {/* 1. Identity */}
      {type.isFieldGroup ? null : (
        <section className="grid gap-3" aria-label={t`Identity`}>
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
            {editable ? (
              <TextField
                label={t`Name`}
                value={draft.name}
                onChange={(v) => {
                  setNameError(null);
                  setDraft({ ...draft, name: v });
                }}
                {...(nameError ? { errorMessage: nameError, isInvalid: true } : {})}
              />
            ) : null}
            <IconChoice
              value={draft.icon}
              isDisabled={!editable}
              onChange={(icon) => setDraft({ ...draft, icon })}
            />
          </div>
          {editable ? (
            <Combobox
              label={t`Inside`}
              description={t`A type inherits the capabilities and fields of the types it sits inside.`}
              items={parentOptions}
              selectedKey={draft.parentId ?? '__top__'}
              onSelectionChange={(k) =>
                k && setDraft({ ...draft, parentId: k === '__top__' ? null : String(k) })
              }
            />
          ) : parent ? (
            <p className="m-0 text-small text-ink-2">
              <Trans>
                Inside <bdi>{typeName(parent)}</bdi>
              </Trans>
            </p>
          ) : null}
        </section>
      )}

      {/* 2. Capabilities */}
      {type.isFieldGroup ? null : (
        <section className="grid gap-2">
          <h3 className="eyebrow m-0" id={`caps-${type.id}`}>
            <Trans>Capabilities</Trans>
          </h3>
          {/* biome-ignore lint/a11y/useSemanticElements: a group of toggle buttons, not a fieldset */}
          <div role="group" aria-labelledby={`caps-${type.id}`} className="flex flex-wrap gap-1.5">
            {CAPABILITY_ORDER.map((c) => {
              const inherited = inheritedCaps.has(c) && !draft.capabilities.includes(c);
              const label = capLabels[c];
              const on = inherited || draft.capabilities.includes(c);
              return (
                <button
                  key={c}
                  type="button"
                  aria-pressed={on}
                  aria-label={inherited ? t`${label}, inherited` : label}
                  aria-disabled={!editable || inherited}
                  title={inherited ? t`Inherited` : capHelp[c]}
                  onClick={() => {
                    if (!editable || inherited) return;
                    setDraft({
                      ...draft,
                      capabilities: on
                        ? draft.capabilities.filter((x) => x !== c)
                        : [...draft.capabilities, c],
                    });
                  }}
                  className={cn(
                    'inline-flex min-h-9 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 py-1 font-medium text-[13px] text-ink-3 outline-none focus-visible:outline-2 focus-visible:outline-info [&_svg]:size-3.5',
                    on && 'border-ink-2 text-ink',
                    (!editable || inherited) && 'cursor-default',
                  )}
                >
                  {on ? <CheckIcon /> : null}
                  {capLabels[c]}
                  {inherited ? (
                    <span className="font-normal text-ink-3">
                      <Trans>· inherited</Trans>
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* 3. Fields */}
      <section className="grid gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="eyebrow m-0">
            <Trans>Fields</Trans>
          </h3>
          {editable ? (
            <Button
              size="small"
              variant="secondary"
              onPress={() =>
                setFieldTarget({
                  mode: 'create',
                  holder: 'type',
                  holderId: type.id,
                  takenKeys,
                })
              }
            >
              <PlusIcon className="size-4" />
              <Trans>Add a field</Trans>
            </Button>
          ) : null}
        </div>
        <FieldList
          fields={type.fields}
          ownerId={type.id}
          ownerName={name}
          sourceName={(id) => nameById(id) ?? name}
          groupSharedBy={groupSharedBy}
          canEdit={editable}
          isOwner={scope.isOwner}
          onEdit={(field) => setFieldTarget({ mode: 'edit', field })}
          onArchive={(field) => fieldOp.mutate({ op: 'archive', field })}
          onRestore={(field) => fieldOp.mutate({ op: 'restore', field })}
          onPolicy={setPolicyField}
          onConvert={(field, mode) => setConverting({ field, mode })}
          pendingId={fieldOp.isPending ? (fieldOp.variables?.field.id ?? null) : null}
        />
        {type.isFieldGroup ? (
          <p className="m-0 text-small text-ink-2">
            {groupSharedBy(type.id).length ? (
              <Trans>Used by {groupSharedBy(type.id).join(', ')}.</Trans>
            ) : null}{' '}
            <Trans>Its fields show on every type that uses the group.</Trans>
          </p>
        ) : null}
      </section>

      {/* 4. Field groups */}
      {type.isFieldGroup ? null : (
        <section className="grid gap-2">
          <h3 className="eyebrow m-0">
            <Trans>Field groups</Trans>
          </h3>
          {draft.fieldGroups.length ? (
            <ul className="m-0 grid list-none gap-1.5 p-0">
              {draft.fieldGroups.map((gid) => {
                const g = byId.get(gid);
                const gname = g ? typeName(g) : t`A field group`;
                return (
                  <li
                    key={gid}
                    className="flex items-center gap-2.5 rounded-[10px] border border-line bg-surface px-3 py-2"
                  >
                    <TypeIcon icon={g?.icon} className="size-[18px] text-ink-2" />
                    <span className="grid min-w-0 flex-1">
                      <span className="font-semibold">
                        <bdi>{gname}</bdi>
                      </span>
                      <span className="inline-flex items-center gap-1 text-small text-ink-2">
                        <LockIcon className="size-3" aria-hidden="true" />
                        <Trans>Built in · read-only · its fields are listed above</Trans>
                      </span>
                    </span>
                    {editable ? (
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={t`Remove the ${gname} group`}
                        onPress={() =>
                          setDraft({
                            ...draft,
                            fieldGroups: draft.fieldGroups.filter((x) => x !== gid),
                          })
                        }
                      >
                        <XIcon className="size-4" />
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="m-0 text-small text-ink-2">
              <Trans>No field groups.</Trans>
            </p>
          )}
          {editable && groupOptions.length ? (
            <Combobox
              label={t`Add a group`}
              items={groupOptions}
              selectedKey={null}
              placeholder={t`Pick a field group`}
              onSelectionChange={(k) =>
                k && setDraft({ ...draft, fieldGroups: [...draft.fieldGroups, String(k)] })
              }
            />
          ) : null}
        </section>
      )}

      {editable && dirty ? (
        <div className="sticky bottom-20 z-10 flex flex-wrap items-center gap-2 rounded-[10px] border border-line bg-surface p-3 shadow-[0_6px_20px_rgba(0,0,0,.08)] md:bottom-4">
          <span className="min-w-0 flex-1 basis-56 text-small text-ink-2">
            <Trans>
              Saving shows what it changes first: the things affected in each location, and the
              types below it.
            </Trans>
          </span>
          <Button variant="secondary" onPress={() => setDraft(draftOf(type, name))}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            onPress={() => {
              const n = draft.name.trim();
              if (!n) return setNameError(t`A type needs a name.`);
              if (n.length > 80) return setNameError(t`Keep the name to 80 characters.`);
              setSaveError(null);
              setPreview(body);
            }}
          >
            <Trans>Review and save</Trans>
          </Button>
        </div>
      ) : null}

      <ImpactPreview
        typeId={type.id}
        body={preview}
        typeNameById={nameById}
        title={t`Save changes to ${name}?`}
        confirmLabel={t`Save`}
        onConfirm={save}
        onClose={() => setPreview(null)}
        error={saveError}
      />
      <FieldSheet
        target={fieldTarget}
        isOwner={scope.isOwner}
        onClose={() => setFieldTarget(null)}
        onSaved={() => invalidate(type.id)}
      />
      <SecretPolicySheet field={policyField} onClose={() => setPolicyField(null)} />
      <ConvertFieldSheet
        target={converting}
        onClose={() => setConverting(null)}
        onConverted={() => invalidate(type.id)}
      />
      <MergeTypeSheet
        isOpen={merging}
        type={type}
        name={name}
        types={types}
        below={below}
        nameById={nameById}
        onClose={() => setMerging(false)}
        onMerged={(targetId) => {
          setMerging(false);
          onNavigate(targetId);
        }}
      />
    </article>
  );
}

/** Merge a type into another (D92): its things move there, then it's gone. Same preview. */
function MergeTypeSheet({
  isOpen,
  type,
  name,
  types,
  below,
  nameById,
  onClose,
  onMerged,
}: {
  isOpen: boolean;
  type: TypeDetail;
  name: string;
  types: readonly TypeNode[];
  below: Set<string>;
  nameById: (id: string) => string | undefined;
  onClose: () => void;
  onMerged: (targetId: string) => void;
}) {
  const { t } = useLingui();
  const typeName = useTypeName();
  const errorText = useErrorText();
  const invalidate = useInvalidateTypes();
  const [target, setTarget] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<ReactNode>(null);
  useEffect(() => {
    if (!isOpen) {
      setTarget(null);
      setPreviewing(false);
      setError(null);
    }
  }, [isOpen]);
  const options = types
    // Never into a built-in original (the server answers 404, T11): into the account's own types.
    .filter((x) => !x.isFieldGroup && x.id !== type.id && !below.has(x.id) && !isBuiltinOriginal(x))
    .map((x) => ({ id: x.id, label: typeName(x) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const into = target ? (nameById(target) ?? '') : '';
  const merge = async () => {
    if (!target) return;
    setError(null);
    try {
      const { repointed } = await registryApi.mergeType(type.id, target);
      await invalidate(target);
      toast({
        title: t`Merged ${name} into ${into}`,
        description: plural(repointed, {
          one: '# thing changed type.',
          other: '# things changed type.',
        }),
        tone: 'ok',
      });
      onMerged(target);
    } catch (e) {
      setError(<Notice tone="danger">{errorText(e)}</Notice>);
      throw e;
    }
  };
  return (
    <>
      <Sheet
        isOpen={isOpen && !previewing}
        onOpenChange={(o) => !o && onClose()}
        title={t`Merge ${name} into…`}
      >
        {({ close }) => (
          <div className="grid gap-4">
            <p className="m-0 text-ink-2">
              <Trans>
                Its things move to the type you choose and take its fields; values the other type
                doesn't have are archived, not lost. Then <bdi>{name}</bdi> is gone.
              </Trans>
            </p>
            <Combobox
              label={t`Merge into`}
              items={options}
              selectedKey={target}
              onSelectionChange={(k) => setTarget(k ? String(k) : null)}
            />
            <DialogFooter>
              <Button variant="secondary" onPress={close}>
                <Trans>Cancel</Trans>
              </Button>
              <Button isDisabled={!target} onPress={() => setPreviewing(true)}>
                <Trans>Review</Trans>
              </Button>
            </DialogFooter>
          </div>
        )}
      </Sheet>
      <ImpactPreview
        typeId={type.id}
        body={isOpen && previewing ? {} : null}
        typeNameById={nameById}
        title={t`Merge ${name} into ${into}?`}
        lead={<Trans>These things change type:</Trans>}
        confirmLabel={t`Merge`}
        onConfirm={merge}
        onClose={onClose}
        error={error}
      />
    </>
  );
}
