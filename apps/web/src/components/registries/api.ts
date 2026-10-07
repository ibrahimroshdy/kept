/**
 * Types, place kinds and the account registries (brands, vendors, people, tags) as fetchers and
 * hooks, for Account settings and the registry pages (task 28). The shared fetchers live in
 * api/inventory/queries.ts; the writes and the few reads it lacks are here, beside the screens
 * that use them, so parallel web tasks never edit the same file.
 *
 * Which account: `/api/v1/accounts` lists the accounts you can see. Your role in one is your
 * highest role across its locations (Q21): owner of your own account; admin where
 * `canManage`; otherwise member or viewer from your location roles there.
 */
import {
  type QueryClient,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { api, ifMatch, isApiError } from '@/api/client';
import { inventoryPaths as p, qs, type RegistryPathKind } from '@/api/inventory/paths';
import {
  inventoryApi,
  inventoryKeys as k,
  nextCursor,
  useAccounts,
  useTypes,
} from '@/api/inventory/queries';
import type {
  AccountSummary,
  CreatePlaceKindBody,
  CreateTypeFieldBody,
  CurrenciesResponse,
  Currency,
  CustomisePlaceKindResult,
  CustomiseTypeResult,
  MergeRegistryResult,
  MergeTypeResult,
  Page,
  PersonContact,
  PlaceKindNode,
  RegistryConflictReason,
  RegistryItem,
  ResolvedField,
  SecretPolicy,
  TypeNode,
  UpdatePlaceKindBody,
  UpdateRegistryBody,
  UpdateTypeFieldBody,
} from '@/api/inventory/types';
import { useLocations } from '@/api/queries';
import type { LocationSummary } from '@/api/types';

export type AccountRole = 'owner' | 'admin' | 'member' | 'viewer';

export const registryApi = {
  item: <K extends RegistryPathKind>(kind: K, id: string) =>
    api.get<RegistryItem[K]>(p.registryItem(kind, id)),
  update: <K extends RegistryPathKind>(
    kind: K,
    id: string,
    body: UpdateRegistryBody[K],
    rowVersion: number,
  ) => api.patch<RegistryItem[K]>(p.registryItem(kind, id), body, ifMatch(rowVersion)),
  remove: (kind: RegistryPathKind, id: string) => api.del(p.registryItem(kind, id)),
  mergeInto: (kind: RegistryPathKind, id: string, targetId: string) =>
    api.post<MergeRegistryResult>(p.registryMergeInto(kind, id), { targetId }),
  contact: (id: string) => api.get<PersonContact>(p.personContact(id)),
  putContact: (id: string, body: PersonContact) =>
    api.put<PersonContact>(p.personContact(id), body),

  createField: (typeId: string, body: CreateTypeFieldBody) =>
    api.post<ResolvedField>(p.typeFields(typeId), body),
  updateField: (id: string, body: UpdateTypeFieldBody, rowVersion: number) =>
    api.patch<ResolvedField>(p.typeField(id), body, ifMatch(rowVersion)),
  archiveField: (id: string) => api.post<void>(p.typeFieldArchive(id)),
  restoreField: (id: string) => api.post<void>(p.typeFieldRestore(id)),
  customise: (typeId: string, accountId: string) =>
    api.post<CustomiseTypeResult>(p.typeCustomise(typeId), { accountId }),
  mergeType: (id: string, targetId: string) =>
    api.post<MergeTypeResult>(p.typeMergeInto(id), { targetId }),
  deleteType: (id: string) => api.del(p.type(id)),

  createPlaceKind: (accountId: string, body: CreatePlaceKindBody) =>
    api.post<PlaceKindNode>(p.accountPlaceKinds(accountId), body),
  updatePlaceKind: (id: string, body: UpdatePlaceKindBody, rowVersion: number) =>
    api.patch<PlaceKindNode>(p.placeKind(id), body, ifMatch(rowVersion)),
  /** Idempotent: the account's copy of a built-in kind, made if missing (T28 decision 7). */
  customisePlaceKind: (accountId: string, builtinKey: string) =>
    api.post<CustomisePlaceKindResult>(p.placeKindCustomise(accountId, builtinKey)),
  createPlaceKindField: (id: string, body: CreateTypeFieldBody) =>
    api.post<ResolvedField>(p.placeKindFields(id), body),

  secretPolicy: (locationId: string, fieldId: string) =>
    api.get<SecretPolicy>(p.secretPolicy(locationId, fieldId)),
  putSecretPolicy: (locationId: string, fieldId: string, body: SecretPolicy) =>
    api.put<SecretPolicy>(p.secretPolicy(locationId, fieldId), body),

  setCurrency: (code: string, enabled: boolean) =>
    api.patch<Currency>(p.adminCurrency(code), { enabled }),
};

export const registryKeys = {
  item: (kind: RegistryPathKind, id: string) => ['registry', kind, 'item', id] as const,
  contact: (id: string) => ['registry', 'people', 'contact', id] as const,
  policy: (locationId: string, fieldId: string) => ['secret-policy', locationId, fieldId] as const,
};

// ----- accounts and roles ----------------------------------------------------------------------

/** Your role in an account: the highest across its locations you can see (Q21). */
export function roleInAccount(
  account: AccountSummary | undefined,
  locations: readonly LocationSummary[],
  accountOfLocation: (l: LocationSummary) => string | undefined,
): AccountRole | null {
  if (!account) return null;
  if (account.isOwn) return 'owner';
  if (account.canManage) return 'admin';
  const roles = locations.filter((l) => accountOfLocation(l) === account.id).map((l) => l.role);
  return roles.some((r) => r !== 'viewer') ? 'member' : 'viewer';
}

/**
 * Which account a location belongs to. The server adds `ownerAccountId` (T25 decision 1); until
 * it does, a location you own (and your Personal one) is your own account, and any other is the
 * one other account you can see (the same fallback as the thing pickers).
 */
function accountOfLocation(accounts: readonly AccountSummary[]) {
  const own = accounts.find((a) => a.isOwn);
  const others = accounts.filter((a) => !a.isOwn);
  return (l: LocationSummary) => {
    const explicit = (l as { ownerAccountId?: string }).ownerAccountId;
    if (explicit) return explicit;
    if (l.role === 'owner' || l.kind === 'personal') return own?.id;
    return others.length === 1 ? others[0]?.id : undefined;
  };
}

export type AccountScope = {
  accounts: AccountSummary[];
  account: AccountSummary | undefined;
  accountId: string;
  role: AccountRole | null;
  /** Types, place kinds, rename, merge and delete (registries-types.manage). */
  canManage: boolean;
  /** Secret fields and their policies (D177). */
  isOwner: boolean;
  /** People, vendors and tags inline (people-vendors.create-inline, tags.create). */
  canAddInline: boolean;
  isPending: boolean;
};

/** The account `requested` names, or your own; with your role in it. */
export function useAccountScope(requested?: string): AccountScope {
  const accounts = useAccounts();
  const locations = useLocations();
  const list = accounts.data?.accounts ?? [];
  const account =
    list.find((a) => a.id === requested) ?? list.find((a) => a.isOwn) ?? list[0] ?? undefined;
  const role = roleInAccount(account, locations.data ?? [], accountOfLocation(list));
  return {
    accounts: list,
    account,
    accountId: account?.id ?? '',
    role,
    canManage: role === 'owner' || role === 'admin',
    isOwner: role === 'owner',
    canAddInline: role !== null && role !== 'viewer',
    isPending: accounts.isPending || locations.isPending,
  };
}

/** The account Account settings (and a registry page) is showing: `?account=`, else yours. */
export function useRequestedAccountScope(): AccountScope {
  const search = useSearch({ strict: false }) as { account?: unknown };
  return useAccountScope(typeof search.account === 'string' ? search.account : undefined);
}

/** The accounts the switcher offers: those you manage, plus the one you are looking at. */
export function switchableAccounts(scope: AccountScope): AccountSummary[] {
  return scope.accounts.filter((a) => a.canManage || a.isOwn || a.id === scope.accountId);
}

// ----- types -----------------------------------------------------------------------------------

/**
 * An account's types, with each built-in hidden where the account has customised it: the copy
 * stands in its place in the tree (Q13b), so the tree never shows both.
 */
export function useAccountTypes(accountId: string) {
  const q = useTypes(accountId);
  const all = q.data?.types ?? [];
  const replaced = new Set(all.map((t) => t.copiedFromId).filter((x): x is string => !!x));
  const types = all.filter((t) => !replaced.has(t.id));
  return { ...q, types, all };
}

export type TypeTreeNode = { type: TypeNode; depth: number };

/** Types in tree order (parents before children, siblings by name), with their depth. */
export function treeOrder(
  types: readonly TypeNode[],
  nameOf: (t: TypeNode) => string,
): TypeTreeNode[] {
  const byParent = new Map<string | null, TypeNode[]>();
  const ids = new Set(types.map((t) => t.id));
  for (const t of types) {
    const parent = t.parentId && ids.has(t.parentId) ? t.parentId : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), t]);
  }
  const out: TypeTreeNode[] = [];
  const walk = (parent: string | null, depth: number) => {
    const kids = [...(byParent.get(parent) ?? [])].sort((a, b) =>
      nameOf(a).localeCompare(nameOf(b)),
    );
    for (const t of kids) {
      out.push({ type: t, depth });
      walk(t.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** Every type below `id`. */
export function descendantIds(types: readonly TypeNode[], id: string): Set<string> {
  const out = new Set<string>();
  const walk = (pid: string) => {
    for (const t of types)
      if (t.parentId === pid && !out.has(t.id)) {
        out.add(t.id);
        walk(t.id);
      }
  };
  walk(id);
  return out;
}

/** A built-in the account hasn't customised: read-only until Customise (D92). */
export const isBuiltinOriginal = (t: Pick<TypeNode, 'builtinKey' | 'copiedFromId'>) =>
  t.builtinKey !== null && t.copiedFromId === null;

export function invalidateTypes(qc: QueryClient, id?: string): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: k.types.all }),
    qc.invalidateQueries({ queryKey: k.things.all }),
    ...(id ? [qc.invalidateQueries({ queryKey: k.types.detail(id) })] : []),
  ]);
}

export function useInvalidateTypes() {
  const qc = useQueryClient();
  return (id?: string) => invalidateTypes(qc, id);
}

/**
 * A 409's reason from its body (`reason`, T28 contract decision 2): a cycle, a field key given
 * twice, a built-in that must be customised first, or in use. A 409 without one (an older
 * server, a database refusal) falls back to `guess`.
 */
export function conflictReason(
  error: unknown,
  guess: 'cycle' | 'field_redefined',
): RegistryConflictReason | null {
  if (!isApiError(error) || error.status !== 409) return null;
  const reason = error.details.reason;
  if (
    reason === 'cycle' ||
    reason === 'field_redefined' ||
    reason === 'builtin' ||
    reason === 'in_use'
  )
    return reason;
  return error.code === 'in_use' ? 'in_use' : guess;
}

/** The field key a `field_redefined` 409 names, when it does. */
export function conflictKey(error: unknown): string | null {
  if (!isApiError(error)) return null;
  const key = error.details.key;
  return typeof key === 'string' ? key : null;
}

// ----- registries ------------------------------------------------------------------------------

/** A registry as a list-standard infinite query (search `q` in the URL). */
export function useRegistryList<K extends RegistryPathKind>(kind: K, accountId: string, q: string) {
  return useInfiniteQuery({
    queryKey: k.registry.list(kind, accountId, { q }),
    queryFn: ({ pageParam }) =>
      inventoryApi.registry(kind, accountId, { q, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
    enabled: !!accountId,
  });
}

export const useRegistryItem = <K extends RegistryPathKind>(kind: K, id: string) =>
  useQuery({ queryKey: registryKeys.item(kind, id), queryFn: () => registryApi.item(kind, id) });

/** Everything of one registry in an account (for merge targets): up to 200, like the pickers. */
export const useRegistryAll = <K extends RegistryPathKind>(kind: K, accountId: string) =>
  useQuery({
    queryKey: ['registry', kind, accountId, { limit: 200 }],
    queryFn: () => inventoryApi.registry(kind, accountId, { limit: 200 }),
    enabled: !!accountId,
  });

export function invalidateRegistry(qc: QueryClient, kind: RegistryPathKind): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: k.registry.all(kind) }),
    qc.invalidateQueries({ queryKey: k.things.all }),
    qc.invalidateQueries({ queryKey: ['search'] }),
  ]);
}

/**
 * A person's contact card (D177): the server answers 404 unless you may see it, and a 404 here
 * means "show nothing", never an error.
 */
export const useContact = (id: string, enabled = true) =>
  useQuery({
    queryKey: registryKeys.contact(id),
    enabled,
    queryFn: async () => {
      try {
        return await registryApi.contact(id);
      } catch (e) {
        if (isApiError(e) && e.status === 404) return null;
        throw e;
      }
    },
  });

// ----- lists the list surface shows in one page ------------------------------------------------

/**
 * A list the server sends whole (place kinds, currencies) as the list standard's infinite query:
 * one page, filtered by `q` here, so it gets the same search box, URL state and states.
 */
export function useWholeList<T>(
  key: readonly unknown[],
  fetch: () => Promise<T[]>,
  q: string,
  text: (item: T) => string,
  enabled = true,
) {
  return useInfiniteQuery({
    queryKey: [...key, 'whole', { q }],
    queryFn: async (): Promise<Page<T>> => {
      const all = await fetch();
      const needle = q.trim().toLocaleLowerCase();
      return {
        items: needle ? all.filter((x) => text(x).toLocaleLowerCase().includes(needle)) : all,
        next_cursor: null,
      };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: () => undefined,
    enabled,
  });
}

export const allCurrencies = () =>
  api.get<CurrenciesResponse>(p.currencies + qs({ all: 1 })).then((r) => r.currencies);

export const invalidateCurrencies = (qc: QueryClient) =>
  qc.invalidateQueries({ queryKey: ['currencies'] });
