/**
 * Account settings → Place kinds (D33, D160; screens §5 "Place kinds reuse the same field
 * editor"). The built-in floor, room, spot and closet, and the account's own kinds (a shelf, a
 * bay), each with fields a place of that kind can carry: a filter size, dimensions.
 *
 * A list (the list standard, `?q=`) and the selected kind (`?kind=`), edited with the same field
 * list and field sheet as types. Built-in kinds are shared by everyone and read-only: Customise
 * makes the account's own copy of one (T28 decision 7), which keeps the built-in's name in every
 * language until renamed, stands in for it in every location of the account, and takes fields.
 *
 * A built-in has no `ownerAccountId`; the account's copy of one keeps its `builtinKey` but has the
 * account as its owner, so Customise is offered on built-ins only.
 */
import { newId } from '@kept/shared';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { inventoryApi, inventoryKeys } from '@/api/inventory/queries';
import type { PlaceKindNode, ResolvedField } from '@/api/inventory/types';
import { ChevronEndIcon, ChevronStartIcon, PlusIcon } from '@/components/icons';
import { ListSurface } from '@/components/list-surface';
import { EmptyState, Notice, useErrorText } from '@/components/page';
import { usePlaceKindName } from '@/components/places/labels';
import { rowLink, Tile } from '@/components/places/rows';
import { Sheet } from '@/components/places/sheet';
import { TypeIcon } from '@/components/type-icon';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { sep } from '@/lib/format';
import { useListState } from '@/lib/url-state';
import { type AccountScope, registryApi, useWholeList } from './api';
import { FieldList } from './field-list';
import { FieldSheet, type FieldSheetTarget } from './field-sheet';
import { IconChoice } from './icon-choice';
import { FIELD_KEY, keyFromLabel } from './labels';
import { SecretPolicySheet } from './secret-policy-sheet';

export function usePlaceKindLabel() {
  const kindName = usePlaceKindName();
  return (k: PlaceKindNode) => k.name ?? kindName(k.builtinKey ?? k.key);
}

export function PlaceKinds({ scope, selected }: { scope: AccountScope; selected?: string }) {
  const { t } = useLingui();
  const [list] = useListState();
  const label = usePlaceKindLabel();
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const query = useWholeList(
    inventoryKeys.placeKinds(scope.accountId),
    () => inventoryApi.placeKinds(scope.accountId).then((r) => r.placeKinds),
    list.q,
    label,
    !!scope.accountId,
  );
  const kinds = query.data?.pages.flatMap((p) => p.items) ?? [];
  const current = kinds.find((k) => k.id === selected);
  const select = (id: string | undefined) =>
    void navigate({
      to: '.',
      search: ((prev: Record<string, unknown>) => ({ ...prev, kind: id })) as never,
    });

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
      <div className={current ? 'hidden lg:grid lg:gap-3' : 'grid gap-3'}>
        <ListSurface
          label={t`Place kinds`}
          search={{ label: t`Search place kinds`, placeholder: t`Search place kinds` }}
          query={query}
          getKey={(k) => k.id}
          empty={<EmptyState title={<Trans>No place kinds</Trans>} />}
          renderRow={(k) => (
            <Link
              to="."
              search={((prev: Record<string, unknown>) => ({ ...prev, kind: k.id })) as never}
              aria-current={k.id === selected ? 'page' : undefined}
              className={`${rowLink} aria-[current=page]:bg-sunken`}
            >
              <Tile>
                <TypeIcon icon={k.icon} />
              </Tile>
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="font-semibold text-[15px] [overflow-wrap:anywhere]">
                  <bdi>{label(k)}</bdi>
                </span>
                <span className="text-small text-ink-2">
                  {k.ownerAccountId === null ? <Trans>Built in</Trans> : <Trans>Your own</Trans>}
                  {sep()}
                  <Plural value={k.fields.length} _0="no fields" one="# field" other="# fields" />
                </span>
              </span>
              <ChevronEndIcon className="size-5 shrink-0 text-ink-3" />
            </Link>
          )}
        />
        {scope.canManage ? (
          <Button
            variant="secondary"
            className="justify-self-start"
            onPress={() => setCreating(true)}
          >
            <PlusIcon className="size-4" />
            <Trans>New kind</Trans>
          </Button>
        ) : null}
      </div>
      {current ? (
        <div className="grid min-w-0 gap-3 rounded-[10px] border border-line bg-surface p-3.5 md:p-5">
          <Link
            to="."
            search={((prev: Record<string, unknown>) => ({ ...prev, kind: undefined })) as never}
            className="inline-flex min-h-11 items-center gap-1 justify-self-start rounded-md pe-2 text-small font-semibold text-ink-2 outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-info lg:hidden"
          >
            <ChevronStartIcon className="size-4" />
            <Trans>All place kinds</Trans>
          </Link>
          <PlaceKindEditor
            key={`${current.id}:${current.rowVersion}`}
            kind={current}
            scope={scope}
            onSelect={select}
          />
        </div>
      ) : (
        <div className="hidden lg:block">
          <EmptyState title={<Trans>Pick a kind</Trans>}>
            <Trans>
              Every room or spot has a kind. Give your own kinds fields, like a shelf's width or an
              air filter's size, and every place of that kind can record them.
            </Trans>
          </EmptyState>
        </div>
      )}
      <NewKindSheet
        isOpen={creating}
        onClose={() => setCreating(false)}
        accountId={scope.accountId}
        taken={new Set(kinds.map((k) => k.key))}
        onCreated={(id) => select(id)}
      />
    </div>
  );
}

function PlaceKindEditor({
  kind,
  scope,
  onSelect,
}: {
  kind: PlaceKindNode;
  scope: AccountScope;
  /** Show another kind (the copy Customise made). */
  onSelect: (id: string) => void;
}) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const errorText = useErrorText();
  const label = usePlaceKindLabel();
  const name = label(kind);
  const isOriginal = kind.ownerAccountId === null;
  const editable = scope.canManage && !isOriginal;
  const customise = useMutation({
    mutationFn: () => registryApi.customisePlaceKind(scope.accountId, kind.builtinKey ?? kind.key),
    onSuccess: async ({ placeKindId }) => {
      await refresh();
      if (placeKindId !== kind.id) onSelect(placeKindId);
      toast({ title: t`${name} is now your account's own`, tone: 'ok' });
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });
  const [draftName, setDraftName] = useState(name);
  const [icon, setIcon] = useState(kind.icon);
  const [nameError, setNameError] = useState<string | null>(null);
  const [fieldTarget, setFieldTarget] = useState<FieldSheetTarget | null>(null);
  const [policyField, setPolicyField] = useState<ResolvedField | null>(null);
  const refresh = () =>
    qc.invalidateQueries({ queryKey: inventoryKeys.placeKinds(scope.accountId) });
  const dirty = draftName.trim() !== name || icon !== kind.icon;
  const save = useMutation({
    mutationFn: () =>
      registryApi.updatePlaceKind(
        kind.id,
        {
          ...(draftName.trim() !== name ? { name: draftName.trim() } : {}),
          ...(icon !== kind.icon ? { icon } : {}),
        },
        kind.rowVersion,
      ),
    onSuccess: async () => {
      await refresh();
      toast({ title: t`Saved ${name}`, tone: 'ok' });
    },
  });
  const fieldOp = useMutation({
    mutationFn: ({ op, field }: { op: 'archive' | 'restore'; field: ResolvedField }) =>
      op === 'archive' ? registryApi.archiveField(field.id) : registryApi.restoreField(field.id),
    onSuccess: async (_r, { op }) => {
      await refresh();
      toast({ title: op === 'archive' ? t`Field archived` : t`Field restored`, tone: 'ok' });
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });

  return (
    <article className="grid content-start gap-5" aria-label={name}>
      <header className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="grid size-12 shrink-0 place-items-center rounded-[10px] bg-sunken text-ink [&_svg]:size-6"
        >
          <TypeIcon icon={icon} />
        </span>
        <div className="grid min-w-0 gap-0.5">
          <h2 className="m-0 font-semibold text-[20px] leading-tight [overflow-wrap:anywhere]">
            <bdi>{name}</bdi>
          </h2>
          <p className="m-0 text-small text-ink-2">
            {isOriginal ? (
              <Trans>Built in · Customise it to rename it or give it fields</Trans>
            ) : (
              <Trans>Your account's own kind</Trans>
            )}
          </p>
        </div>
      </header>
      {editable ? (
        <section className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
          <TextField
            label={t`Name`}
            value={draftName}
            onChange={(v) => {
              setNameError(null);
              setDraftName(v);
            }}
            {...(nameError ? { errorMessage: nameError, isInvalid: true } : {})}
          />
          <IconChoice value={icon} onChange={setIcon} />
        </section>
      ) : null}
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
                  holder: 'placeKind',
                  holderId: kind.id,
                  takenKeys: new Set(kind.fields.map((f) => f.key)),
                })
              }
            >
              <PlusIcon className="size-4" />
              <Trans>Add a field</Trans>
            </Button>
          ) : null}
        </div>
        <FieldList
          fields={kind.fields}
          ownerId={kind.id}
          ownerName={name}
          sourceName={() => name}
          canEdit={editable}
          isOwner={scope.isOwner}
          onEdit={(field) => setFieldTarget({ mode: 'edit', field })}
          onArchive={(field) => fieldOp.mutate({ op: 'archive', field })}
          onRestore={(field) => fieldOp.mutate({ op: 'restore', field })}
          onPolicy={setPolicyField}
          pendingId={fieldOp.isPending ? (fieldOp.variables?.field.id ?? null) : null}
          emptyText={
            <Trans>No fields yet. Places of this kind have a name and what's in them.</Trans>
          }
        />
        {isOriginal && scope.canManage ? (
          <div className="grid gap-2 justify-items-start">
            <p className="m-0 text-small text-ink-2">
              <Trans>
                Customise makes this account's own copy: every place of this kind uses it, and you
                can rename it and give it fields.
              </Trans>
            </p>
            <Button
              size="small"
              variant="secondary"
              isPending={customise.isPending}
              onPress={() => customise.mutate()}
            >
              <Trans>Customise</Trans>
            </Button>
          </div>
        ) : null}
      </section>
      {save.error ? <Notice tone="danger">{errorText(save.error)}</Notice> : null}
      {editable && dirty ? (
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="secondary"
            onPress={() => {
              setDraftName(name);
              setIcon(kind.icon);
            }}
          >
            <Trans>Cancel</Trans>
          </Button>
          <Button
            isPending={save.isPending}
            onPress={() => {
              const n = draftName.trim();
              if (!n) return setNameError(t`A kind needs a name.`);
              if (n.length > 80) return setNameError(t`Keep the name to 80 characters.`);
              save.mutate();
            }}
          >
            <Trans>Save</Trans>
          </Button>
        </div>
      ) : null}
      <FieldSheet
        target={fieldTarget}
        isOwner={scope.isOwner}
        onClose={() => setFieldTarget(null)}
        onSaved={refresh}
      />
      <SecretPolicySheet field={policyField} onClose={() => setPolicyField(null)} />
    </article>
  );
}

function NewKindSheet({
  isOpen,
  onClose,
  accountId,
  taken,
  onCreated,
}: {
  isOpen: boolean;
  onClose: () => void;
  accountId: string;
  taken: Set<string>;
  onCreated: (id: string) => void;
}) {
  const { t } = useLingui();
  return (
    <Sheet isOpen={isOpen} onOpenChange={(o) => !o && onClose()} title={t`New place kind`}>
      {({ close }) => (
        <NewKindForm accountId={accountId} taken={taken} onCancel={close} onCreated={onCreated} />
      )}
    </Sheet>
  );
}

function NewKindForm({
  accountId,
  taken,
  onCancel,
  onCreated,
}: {
  accountId: string;
  taken: Set<string>;
  onCancel: () => void;
  onCreated: (id: string) => void;
}) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const errorText = useErrorText();
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('lucide:square-dashed');
  const [error, setError] = useState<string | null>(null);
  const [id] = useState(() => newId());
  const key = keyFromLabel(name) || `kind_${id.slice(-6).replace(/[^a-z0-9]/g, '')}`;
  const create = useMutation({
    mutationFn: () => registryApi.createPlaceKind(accountId, { id, key, name: name.trim(), icon }),
    onSuccess: async (created) => {
      await qc.invalidateQueries({ queryKey: inventoryKeys.placeKinds(accountId) });
      const n = name.trim();
      toast({ title: t`Made ${n}`, tone: 'ok' });
      onCreated(created.id);
      onCancel();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return setError(t`Give the kind a name, like Shelf or Bay.`);
    if (n.length > 80) return setError(t`Keep the name to 80 characters.`);
    if (!FIELD_KEY.test(key) || taken.has(key))
      return setError(t`There's already a kind with that name.`);
    setError(null);
    create.mutate();
  };
  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      <TextField
        label={t`Name`}
        value={name}
        onChange={setName}
        autoFocus
        isRequired
        inputProps={{ dir: 'auto' }}
        {...(error ? { errorMessage: error, isInvalid: true } : {})}
      />
      <IconChoice value={icon} onChange={setIcon} />
      {create.error ? <Notice tone="danger">{errorText(create.error)}</Notice> : null}
      <DialogFooter>
        <Button variant="secondary" onPress={onCancel}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" isPending={create.isPending}>
          <Trans>Make the kind</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
}
