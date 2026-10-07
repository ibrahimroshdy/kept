/**
 * An account's brands, vendors, people or tags (screens §5 Settings → Account): the list standard
 * (search in the URL, cursor pages), an add box at the top, and per row Edit, Merge and Delete for
 * the owner and admins.
 *
 * Adding checks for duplicates the way D11 says: a similar name is a **hint**, never a block. The
 * new row is made, and a notice offers to merge it into the one that was already there. A brand or
 * tag whose normalised name already exists is refused (409 with `existingId`), and the notice
 * points at the existing one instead. Members may add people, vendors and tags; brands, and every
 * change after adding, are the owner's and admins'. Viewers only look.
 */
import { newId } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type FormEvent, type ReactNode, useState } from 'react';
import { Menu, MenuItem, MenuTrigger, Popover } from 'react-aria-components';
import { isApiError } from '@/api/client';
import type { RegistryPathKind } from '@/api/inventory/paths';
import { inventoryApi } from '@/api/inventory/queries';
import type { RegistryItem, Vendor } from '@/api/inventory/types';
import {
  BriefcaseIcon,
  LinkIcon,
  MenuIcon,
  PencilIcon,
  ShieldIcon,
  TrashIcon,
} from '@/components/icons';
import { ListSurface } from '@/components/list-surface';
import { Avatar, EmptyState, IconTile, Notice, Pill, useErrorText } from '@/components/page';
import { rowLink } from '@/components/places/rows';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { sep } from '@/lib/format';
import { useListState } from '@/lib/url-state';
import { cn } from '@/lib/utils';
import { type AccountScope, invalidateRegistry, registryApi, useRegistryList } from './api';
import { useRegistryWords, useVendorKindLabels } from './labels';
import { MergeSheet, type MergeSubject } from './merge-sheet';
import { RegistryEditSheet, registryName } from './registry-edit-sheet';

type Item = RegistryItem[RegistryPathKind];

const DETAIL = {
  brands: '/brands/$id',
  vendors: '/vendors/$id',
  people: '/people/$id',
} as const;

export function RegistryIcon({ kind, item }: { kind: RegistryPathKind; item: Item }) {
  if (kind === 'people') return <Avatar name={registryName(item)} />;
  return (
    <IconTile>
      {kind === 'brands' ? <ShieldIcon /> : kind === 'vendors' ? <BriefcaseIcon /> : <LinkIcon />}
    </IconTile>
  );
}

export function RegistryList({ kind, scope }: { kind: RegistryPathKind; scope: AccountScope }) {
  const words = useRegistryWords()[kind];
  const vendorKinds = useVendorKindLabels();
  const [list] = useListState();
  const query = useRegistryList(kind, scope.accountId, list.q);
  const [editing, setEditing] = useState<Item | null>(null);
  const [merging, setMerging] = useState<MergeSubject | null>(null);
  const canAdd = kind === 'brands' ? scope.canManage : scope.canAddInline;

  const subtitle = (item: Item): ReactNode => {
    if (kind === 'vendors') {
      const v = item as Vendor;
      return [vendorKinds[v.kind], v.address].filter(Boolean).join(sep());
    }
    if (kind === 'people' && (item as RegistryItem['people']).userId)
      return <Trans>Has a Kept account</Trans>;
    return null;
  };

  return (
    <div className="grid gap-4">
      {canAdd ? (
        <AddBox kind={kind} scope={scope} onMerge={(subject) => setMerging(subject)} />
      ) : scope.role === 'viewer' || scope.role === 'member' ? (
        <Notice tone="info">
          {kind === 'brands' ? (
            <Trans>Only the owner and admins add and change brands.</Trans>
          ) : (
            <Trans>Only the owner and admins change these. You can look them up here.</Trans>
          )}
        </Notice>
      ) : null}
      <ListSurface
        label={words.plural}
        search={{ label: words.search, placeholder: words.search }}
        query={query}
        getKey={(x) => x.id}
        empty={
          <EmptyState title={<Trans>Nothing here yet</Trans>}>
            {kind === 'people' ? (
              <Trans>Add the people things belong to, and who you lend to.</Trans>
            ) : kind === 'vendors' ? (
              <Trans>Shops and services are added here, or while you record a purchase.</Trans>
            ) : kind === 'tags' ? (
              <Trans>Tags are labels you filter and search by, like "winter" or "kids".</Trans>
            ) : (
              <Trans>Brands are added here, or while you add a thing.</Trans>
            )}
          </EmptyState>
        }
        renderRow={(item) => {
          const name = registryName(item);
          const builtin = item.ownerAccountId === null;
          const sub = subtitle(item);
          const body = (
            <>
              <RegistryIcon kind={kind} item={item} />
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="font-semibold text-[15px] leading-snug [overflow-wrap:anywhere]">
                  <bdi>{name}</bdi>
                </span>
                {sub ? (
                  <span className="text-small text-ink-2 [overflow-wrap:anywhere]">{sub}</span>
                ) : null}
              </span>
              {builtin ? (
                <Pill>
                  <Trans>Built in</Trans>
                </Pill>
              ) : null}
            </>
          );
          return (
            <div className="flex items-center">
              {kind === 'tags' ? (
                <div className={cn(rowLink, 'hover:bg-transparent')}>{body}</div>
              ) : (
                <Link to={DETAIL[kind]} params={{ id: item.id }} className={rowLink}>
                  {body}
                </Link>
              )}
              {scope.canManage && !builtin ? (
                <RowMenu
                  name={name}
                  kind={kind}
                  item={item}
                  onEdit={() => setEditing(item)}
                  onMerge={() => setMerging({ id: item.id, name, accountId: scope.accountId })}
                />
              ) : null}
            </div>
          );
        }}
      />
      <RegistryEditSheet kind={kind} item={editing} onClose={() => setEditing(null)} />
      <MergeSheet kind={kind} subject={merging} onClose={() => setMerging(null)} />
    </div>
  );
}

function RowMenu({
  name,
  kind,
  item,
  onEdit,
  onMerge,
}: {
  name: string;
  kind: RegistryPathKind;
  item: Item;
  onEdit: () => void;
  onMerge: () => void;
}) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const remove = useMutation({
    mutationFn: () => registryApi.remove(kind, item.id),
    onSuccess: async () => {
      await invalidateRegistry(qc, kind);
      toast({ title: t`Deleted ${name}`, tone: 'ok' });
    },
    onError: (e) =>
      toast({
        title:
          isApiError(e) && e.code === 'in_use'
            ? t`${name} is still used by some things. Merge it into another instead.`
            : errorText(e),
        tone: 'danger',
      }),
  });
  const item_ =
    'flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-[15px] outline-none data-focused:bg-sunken [&_svg]:size-[18px]';
  return (
    <div className="pe-2">
      <MenuTrigger>
        <Button variant="ghost" size="icon" aria-label={t`Actions for ${name}`}>
          <MenuIcon />
        </Button>
        <Popover
          placement="bottom end"
          offset={6}
          className="z-50 min-w-56 rounded-[10px] border border-line bg-surface shadow-[0_10px_30px_rgba(0,0,0,.14)] outline-none"
        >
          <Menu
            className="grid gap-px p-1 outline-none"
            onAction={async (key) => {
              if (key === 'edit') onEdit();
              if (key === 'merge') onMerge();
              if (key === 'delete') {
                const ok = await confirm({
                  title: t`Delete ${name}?`,
                  body: t`Only something nothing uses can be deleted. Otherwise, merge it into another.`,
                  confirmLabel: t`Delete`,
                  destructive: true,
                });
                if (ok) remove.mutate();
              }
            }}
          >
            <MenuItem id="edit" className={item_}>
              <PencilIcon />
              <Trans>Edit</Trans>
            </MenuItem>
            <MenuItem id="merge" className={item_}>
              <LinkIcon />
              <Trans>Merge into…</Trans>
            </MenuItem>
            <MenuItem id="delete" className={cn(item_, 'text-danger')}>
              <TrashIcon />
              <Trans>Delete</Trans>
            </MenuItem>
          </Menu>
        </Popover>
      </MenuTrigger>
    </div>
  );
}

type Outcome =
  | { kind: 'added'; name: string; id: string; duplicates: { id: string; name: string }[] }
  | { kind: 'exists'; name: string; existingId: string };

/** The add box: a name and Add; then the D11 hint (or the existing one, for brands and tags). */
function AddBox({
  kind,
  scope,
  onMerge,
}: {
  kind: RegistryPathKind;
  scope: AccountScope;
  onMerge: (subject: MergeSubject) => void;
}) {
  const { t } = useLingui();
  const words = useRegistryWords()[kind];
  const qc = useQueryClient();
  const errorText = useErrorText();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const add = useMutation({
    mutationFn: (value: string) => {
      const id = newId();
      const body = kind === 'people' ? { id, displayName: value } : { id, name: value };
      return inventoryApi.createRegistry(kind, scope.accountId, body as never);
    },
    onSuccess: async (res, value) => {
      await invalidateRegistry(qc, kind);
      const duplicates = res.possibleDuplicates.filter((d) => d.id !== res.item.id);
      setOutcome({ kind: 'added', name: value, id: res.item.id, duplicates });
      setName('');
      if (duplicates.length === 0) toast({ title: t`Added ${value}`, tone: 'ok' });
    },
    onError: (e, value) => {
      const existingId = isApiError(e) ? e.details.existingId : undefined;
      if (isApiError(e) && e.status === 409 && typeof existingId === 'string')
        setOutcome({ kind: 'exists', name: value, existingId });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = name.trim();
    const max = kind === 'tags' ? 60 : 120;
    if (!value) return setError(t`Type a name first.`);
    if (value.length > max) return setError(t`Keep the name to ${max} characters.`);
    setError(null);
    setOutcome(null);
    add.mutate(value);
  };
  const dup = outcome?.kind === 'added' ? outcome.duplicates[0] : undefined;
  return (
    <div className="grid gap-2.5">
      <form onSubmit={submit} noValidate className="flex flex-wrap items-end gap-2 md:max-w-xl">
        <TextField
          label={words.add}
          value={name}
          onChange={setName}
          inputProps={{ dir: 'auto' }}
          className="min-w-0 flex-1 basis-56"
          {...(error ? { errorMessage: error, isInvalid: true } : {})}
        />
        <Button type="submit" isPending={add.isPending}>
          <Trans>Add</Trans>
        </Button>
      </form>
      {add.error && outcome?.kind !== 'exists' ? (
        <Notice tone="danger">{errorText(add.error)}</Notice>
      ) : null}
      {outcome?.kind === 'exists' ? (
        <Notice
          tone="info"
          title={
            <Trans>
              <bdi>{outcome.name}</bdi> is already in this list
            </Trans>
          }
          action={
            kind === 'brands' ? (
              <Link
                to="/brands/$id"
                params={{ id: outcome.existingId }}
                className="font-semibold text-info underline-offset-2 hover:underline"
              >
                <Trans>Open it</Trans>
              </Link>
            ) : undefined
          }
        >
          <Trans>
            Names are matched ignoring case, accents and Arabic letter forms, so it wasn't added
            twice.
          </Trans>
        </Notice>
      ) : null}
      {outcome?.kind === 'added' && dup ? (
        <Notice
          tone="warn"
          title={
            <Trans>
              Added <bdi>{outcome.name}</bdi>. Is it <bdi>{dup.name}</bdi>, already here?
            </Trans>
          }
          action={
            <div className="flex flex-wrap gap-2">
              {scope.canManage ? (
                <Button
                  size="small"
                  onPress={() =>
                    onMerge({
                      id: outcome.id,
                      name: outcome.name,
                      accountId: scope.accountId,
                      targetId: dup.id,
                    })
                  }
                >
                  <Trans>Merge into {dup.name}</Trans>
                </Button>
              ) : null}
              <Button size="small" variant="secondary" onPress={() => setOutcome(null)}>
                <Trans>Keep both</Trans>
              </Button>
            </div>
          }
        >
          {scope.canManage ? (
            <Trans>A similar name was already here. If they're the same, merge them.</Trans>
          ) : (
            <Trans>
              A similar name was already here. An admin can merge them if they're the same.
            </Trans>
          )}
        </Notice>
      ) : null}
    </div>
  );
}
