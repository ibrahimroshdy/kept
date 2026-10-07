/**
 * Step-2 fetchers, query keys and hooks. Keys are factories under one prefix per area
 * (`keys.places.*`, `keys.things.*`, `keys.search(params)`, …) so a mutation invalidates by
 * prefix: `invalidateQueries({queryKey: keys.things.all})`. `inventoryKeys` is spread into the
 * app-wide `keys` in ../queries.ts; import either.
 *
 * Lists follow the list standard (L88): `useInfiniteQuery` over `next_cursor`, with the list's
 * URL state (lib/url-state.ts) as part of the key.
 */
import type { ListSurface } from '@kept/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, ifMatch, written } from '../client';
import { inventoryPaths as p, qs, type RegistryPathKind } from './paths';
import type {
  AccountsResponse,
  ActivityParams,
  AttachmentView,
  CodeLookup,
  ContentsChoiceDetails,
  CreateAttachmentBody,
  CreateLinkBody,
  CreatePlaceBody,
  CreateReadingBody,
  CreateReadingResult,
  CreateRegistryBody,
  CreateRegistryResult,
  CreateThingBody,
  CreateTypeBody,
  CurrenciesResponse,
  FileUrl,
  FileVariant,
  HistoryEvent,
  HomeResponse,
  LifecycleBody,
  Many,
  MoveBody,
  MovePreview,
  MovePreviewBody,
  MoveResult,
  Page,
  PlaceContents,
  PlaceKindsResponse,
  PlacesResponse,
  PlaceView,
  PurchaseView,
  Reading,
  RegistryItem,
  RestoreResult,
  SavedViewsResponse,
  SearchParams,
  SearchResponse,
  SeenResult,
  SplitBody,
  SplitResult,
  ThingListParams,
  ThingRow,
  ThingView,
  TrashBody,
  TrashItem,
  TrashResult,
  TypeDetail,
  TypeImpact,
  TypesResponse,
  UpdatePlaceBody,
  UpdateThingBody,
  UpdateTypeBody,
} from './types';

export type { ContentsChoiceDetails };

/** Contents of a place, as list-standard params. */
export type ContentsParams = {
  q?: string;
  type?: Many;
  tag?: Many;
  state?: Many;
  brand?: Many;
  belongsTo?: Many;
  /** Which of the filters above are "is none of" (D205). */
  not?: ('type' | 'tag' | 'state' | 'brand' | 'belongsTo')[];
  group?: string;
  sort?: string;
  /** The sort turned around (D211). Absent: A to Z for the name, newest first for dates. */
  dir?: 'asc' | 'desc';
  limit?: number;
  cursor?: string;
};
export type TrashParams = {
  locationId?: Many;
  kind?: Many<'thing' | 'place'>;
  /** Who trashed it (D205). */
  deletedById?: Many;
  /** Trashed on or after (ISO). */
  from?: string;
  /** Trashed before (ISO). */
  to?: string;
  q?: string;
  /** Which of the filters above are "is none of" (D205). */
  not?: ('locationId' | 'deletedById')[];
};
export type RegistryParams = { q?: string; limit?: number };

export const inventoryKeys = {
  accounts: ['accounts'] as const,
  types: {
    all: ['types'] as const,
    list: (accountId: string, includeArchived = false) =>
      ['types', 'list', accountId, { includeArchived }] as const,
    detail: (id: string) => ['types', 'detail', id] as const,
  },
  placeKinds: (accountId: string) => ['place-kinds', accountId] as const,
  registry: {
    all: (kind: RegistryPathKind) => ['registry', kind] as const,
    list: (kind: RegistryPathKind, accountId: string, params: RegistryParams = {}) =>
      ['registry', kind, accountId, params] as const,
  },
  currencies: (all = false) => ['currencies', { all }] as const,
  purchases: { all: ['purchases'] as const, detail: (id: string) => ['purchases', id] as const },
  places: {
    all: ['places'] as const,
    tree: (locationId: string) => ['places', 'tree', locationId] as const,
    detail: (id: string) => ['places', 'detail', id] as const,
    contents: (id: string, params: ContentsParams = {}) =>
      ['places', 'contents', id, params] as const,
    history: (id: string) => ['places', 'history', id] as const,
  },
  things: {
    all: ['things'] as const,
    list: (params: ThingListParams = {}) => ['things', 'list', params] as const,
    detail: (id: string) => ['things', 'detail', id] as const,
    history: (id: string) => ['things', 'history', id] as const,
    attachments: (id: string) => ['things', 'attachments', id] as const,
  },
  meters: { readings: (meterId: string) => ['meters', meterId, 'readings'] as const },
  search: (params: SearchParams = {}) => ['search', params] as const,
  savedViews: ['saved-views'] as const,
  trash: (params: TrashParams = {}) => ['trash', params] as const,
  activity: (params: ActivityParams = {}) => ['activity', params] as const,
  home: ['home'] as const,
  hints: ['hints'] as const,
};
const k = inventoryKeys;

// ----- fetchers --------------------------------------------------------------------------------

export const inventoryApi = {
  accounts: () => api.get<AccountsResponse>(p.accounts),
  types: (accountId: string, includeArchived = false) =>
    api.get<TypesResponse>(
      p.accountTypes(accountId) + qs({ includeArchived: includeArchived || undefined }),
    ),
  type: (id: string) => api.get<TypeDetail>(p.type(id)),
  createType: (accountId: string, body: CreateTypeBody) =>
    api.post<TypeDetail>(p.accountTypes(accountId), body),
  updateType: (id: string, body: UpdateTypeBody, rowVersion: number) =>
    api.patch<TypeDetail>(p.type(id), body, ifMatch(rowVersion)),
  previewType: (id: string, body: UpdateTypeBody) => api.post<TypeImpact>(p.typePreview(id), body),
  placeKinds: (accountId: string) => api.get<PlaceKindsResponse>(p.accountPlaceKinds(accountId)),
  registry: <K extends RegistryPathKind>(
    kind: K,
    accountId: string,
    params: RegistryParams & { cursor?: string } = {},
  ) => api.get<Page<RegistryItem[K]>>(p.accountRegistry(accountId, kind) + qs(params)),
  createRegistry: <K extends RegistryPathKind>(
    kind: K,
    accountId: string,
    body: CreateRegistryBody[K],
  ) => api.post<CreateRegistryResult<K>>(p.accountRegistry(accountId, kind), body),
  currencies: (all = false) =>
    api.get<CurrenciesResponse>(p.currencies + qs({ all: all ? 1 : undefined })),
  purchase: (id: string) => api.get<PurchaseView>(p.purchase(id)),

  places: (locationId: string) => api.get<PlacesResponse>(p.locationPlaces(locationId)),
  place: (id: string) => api.get<PlaceView>(p.place(id)),
  placeContents: (id: string, params: ContentsParams = {}) =>
    api.get<PlaceContents>(p.placeContents(id) + qs(params)),
  createPlace: (locationId: string, body: CreatePlaceBody) =>
    api.post<PlaceView>(p.locationPlaces(locationId), body),
  /** Undoable (D150): the answer carries the audit event ids for the Undo toast. */
  updatePlace: (id: string, body: UpdatePlaceBody, rowVersion: number) =>
    written.patch<PlaceView>(p.place(id), body, ifMatch(rowVersion)),
  /** Undoable (D150): `place.trash`'s event id, for the Undo toast. */
  trashPlace: (id: string, body: TrashBody = {}) =>
    written.post<TrashResult>(p.placeTrash(id), body),
  restorePlace: (id: string) => api.post<RestoreResult>(p.placeRestore(id)),

  things: (params: ThingListParams = {}) => api.get<Page<ThingRow>>(p.things + qs(params)),
  thing: (id: string) => api.get<ThingView>(p.thing(id)),
  createThing: (body: CreateThingBody) => api.post<ThingView>(p.things, body),
  /** Undoable (D150): the answer carries the audit event ids for the Undo toast. */
  updateThing: (id: string, body: UpdateThingBody, rowVersion: number) =>
    written.patch<ThingView>(p.thing(id), body, ifMatch(rowVersion)),
  /** Undoable (D150): `thing.lifecycle`'s event id, for the Undo toast. */
  lifecycle: (id: string, body: LifecycleBody, rowVersion: number) =>
    written.post<ThingView>(p.thingLifecycle(id), body, ifMatch(rowVersion)),
  seen: (id: string) => api.post<SeenResult>(p.thingSeen(id)),
  notHere: (id: string, rowVersion?: number) =>
    api.post<ThingView>(p.thingNotHere(id), {}, ifMatch(rowVersion)),
  split: (id: string, body: SplitBody) => api.post<SplitResult>(p.thingSplit(id), body),
  link: (id: string, body: CreateLinkBody) => api.post<unknown>(p.thingLinks(id), body),
  code: (code: string) => api.get<CodeLookup>(p.code(code)),
  trashThing: (id: string, body: TrashBody = {}) => api.post<TrashResult>(p.thingTrash(id), body),
  restoreThing: (id: string) => api.post<RestoreResult>(p.thingRestore(id)),
  movePreview: (body: MovePreviewBody) => api.post<MovePreview>(p.movePreview, body),
  /** Undoable (D150): one audit event id per moved thing, for the Undo toast. */
  move: (body: MoveBody) => written.post<MoveResult>(p.move, body),
  readings: (meterId: string, cursor?: string) =>
    api.get<Page<Reading>>(p.meterReadings(meterId) + qs({ cursor })),
  logReading: (meterId: string, body: CreateReadingBody) =>
    api.post<CreateReadingResult>(p.meterReadings(meterId), body),

  fileUrl: (fileId: string, variant: FileVariant, thingId?: string) =>
    api.post<FileUrl>(p.fileUrl(fileId) + qs({ thingId }), { variant }),
  createAttachment: (body: CreateAttachmentBody) => api.post<AttachmentView>(p.attachments, body),
  thingAttachments: (id: string, role?: string, cursor?: string) =>
    api.get<Page<AttachmentView>>(p.thingAttachments(id) + qs({ role, cursor })),

  search: (params: SearchParams) => api.get<SearchResponse>(p.search + qs(params)),
  /**
   * Every page of one list's saved views (a person has at most 100 of their own), with your
   * default and pinned views there (D205).
   */
  savedViews: async (surface: ListSurface): Promise<SavedViewsResponse> => {
    const views: SavedViewsResponse['views'] = [];
    let cursor: string | undefined;
    let prefs: SavedViewsResponse['prefs'] = null;
    for (let i = 0; i < 20; i++) {
      const page = await api.get<SavedViewsResponse>(p.savedViews + qs({ surface, cursor }));
      views.push(...page.views);
      prefs ??= page.prefs;
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
    return { views, next_cursor: null, prefs };
  },
  trash: (params: TrashParams & { cursor?: string } = {}) =>
    api.get<Page<TrashItem>>(p.trash + qs(params)),
  thingHistory: (id: string, cursor?: string) =>
    api.get<Page<HistoryEvent>>(p.thingHistory(id) + qs({ cursor })),
  placeHistory: (id: string, cursor?: string) =>
    api.get<Page<HistoryEvent>>(p.placeHistory(id) + qs({ cursor })),
  activity: (params: ActivityParams = {}) => api.get<Page<HistoryEvent>>(p.activity + qs(params)),
  home: () => api.get<HomeResponse>(p.home),
};

// ----- hooks -----------------------------------------------------------------------------------

/** The `getNextPageParam` every list-standard query uses. */
export const nextCursor = <T>(last: Page<T>) => last.next_cursor ?? undefined;

export const useAccounts = () => useQuery({ queryKey: k.accounts, queryFn: inventoryApi.accounts });
export const useTypes = (accountId: string, includeArchived = false) =>
  useQuery({
    queryKey: k.types.list(accountId, includeArchived),
    queryFn: () => inventoryApi.types(accountId, includeArchived),
    enabled: !!accountId,
  });
export const useType = (id: string) =>
  useQuery({ queryKey: k.types.detail(id), queryFn: () => inventoryApi.type(id) });
export const usePlaceKinds = (accountId: string) =>
  useQuery({
    queryKey: k.placeKinds(accountId),
    queryFn: () => inventoryApi.placeKinds(accountId),
    enabled: !!accountId,
  });
export const useCurrencies = (all = false) =>
  useQuery({ queryKey: k.currencies(all), queryFn: () => inventoryApi.currencies(all) });

export const usePlaces = (locationId: string) =>
  useQuery({ queryKey: k.places.tree(locationId), queryFn: () => inventoryApi.places(locationId) });
export const usePlace = (id: string) =>
  useQuery({ queryKey: k.places.detail(id), queryFn: () => inventoryApi.place(id) });
export const usePlaceContents = (id: string, params: ContentsParams = {}) =>
  useInfiniteQuery({
    queryKey: k.places.contents(id, params),
    queryFn: ({ pageParam }) =>
      inventoryApi.placeContents(id, { ...params, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.things.next_cursor ?? undefined,
  });

export const useThings = (params: ThingListParams = {}) =>
  useInfiniteQuery({
    queryKey: k.things.list(params),
    queryFn: ({ pageParam }) =>
      inventoryApi.things({ ...params, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });
export const useThing = (id: string) =>
  useQuery({ queryKey: k.things.detail(id), queryFn: () => inventoryApi.thing(id) });
export const useThingHistory = (id: string) =>
  useInfiniteQuery({
    queryKey: k.things.history(id),
    queryFn: ({ pageParam }) => inventoryApi.thingHistory(id, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });

export const useSearch = (params: SearchParams) =>
  useQuery({ queryKey: k.search(params), queryFn: () => inventoryApi.search(params) });
export const useSavedViews = (surface: ListSurface, enabled = true) =>
  useQuery({
    queryKey: [...k.savedViews, surface],
    queryFn: () => inventoryApi.savedViews(surface),
    enabled,
  });
export const useTrash = (params: TrashParams = {}) =>
  useInfiniteQuery({
    queryKey: k.trash(params),
    queryFn: ({ pageParam }) =>
      inventoryApi.trash({ ...params, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });
export const useActivity = (params: ActivityParams = {}) =>
  useInfiniteQuery({
    queryKey: k.activity(params),
    queryFn: ({ pageParam }) =>
      inventoryApi.activity({ ...params, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });
/** GET /home; `enabled` false holds it back (the shell asks only once someone is signed in). */
export const useHome = (enabled = true) =>
  useQuery({ queryKey: k.home, queryFn: inventoryApi.home, enabled });
