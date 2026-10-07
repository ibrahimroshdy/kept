/**
 * Step-7 fetchers, query keys and hooks, over the contract in ./types.ts and the paths in
 * ./paths.ts. Keys are factories under one prefix per area, so a mutation invalidates by prefix.
 * Writes are fetchers on `portabilityApi` for the screens to wrap in `useMutation`; an undoable
 * write (a stock rule, an adjust) goes through `written`/`requestWritten` so its result carries
 * `auditEvents` for the Undo toast.
 *
 * A passphrase goes only into the body of `createExport` and `importPassphrase`: never into a
 * query key, never into browser storage.
 */
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, ifMatch, isApiError, request, requestWritten, type Written } from '../client';
import { qs } from '../inventory/paths';
import { nextCursor } from '../inventory/queries';
import type { ThingRow } from '../inventory/types';
import { portabilityPaths as p } from './paths';
import type {
  AdjustBody,
  ArchiveDryRunReport,
  ArchiveImportRun,
  ArchiveInspect,
  ConsumablesPage,
  ConsumablesParams,
  ConvertFieldBody,
  ConvertPreview,
  ConvertResult,
  CreateArchiveImportBody,
  CreateExportBody,
  EnrichEstimate,
  EnrichStarted,
  ExportRun,
  ExportsPage,
  ExportsParams,
  HomeboxConnectBody,
  HomeboxConnection,
  ImportChoicesBody,
  ImportTargetBody,
  PutStockRuleBody,
  StockRule,
} from './types';

export const portabilityKeys = {
  exports: {
    all: ['exports'] as const,
    list: (params: ExportsParams = {}) => ['exports', 'list', params] as const,
    one: (id: string) => ['exports', 'one', id] as const,
  },
  enrichEstimate: (runId: string) => ['imports', runId, 'enrich-estimate'] as const,
  consumables: {
    all: ['consumables'] as const,
    list: (params: ConsumablesParams) => ['consumables', 'list', params] as const,
    rule: (thingId: string) => ['consumables', 'rule', thingId] as const,
  },
};
const k = portabilityKeys;

// Step 3's run routes (GET /imports/:id, dry run, run, cancel) serve archive runs too; the
// fetchers here type their answers as archive runs.
const V1 = '/api/v1';
const runPath = (id: string) => `${V1}/imports/${encodeURIComponent(id)}`;

export const portabilityApi = {
  // archive imports (T8, T11, T14)
  createArchiveImport: (body: CreateArchiveImportBody) =>
    api.post<ArchiveImportRun>(p.importsArchive, body),
  /** The upload itself, without progress. The stepper (T19) uploads with XMLHttpRequest for its
   * progress bar, to the same path with the same headers. */
  putArchive: (id: string, file: Blob, sha256: string) =>
    fetch(p.importArchive(id), {
      method: 'PUT',
      credentials: 'include',
      headers: { 'content-type': 'application/zip', 'x-kept-sha256': sha256 },
      body: file,
    }),
  archiveRun: (id: string) => api.get<ArchiveImportRun>(runPath(id)),
  inspect: (id: string) => api.post<ArchiveInspect>(p.importInspect(id)),
  setTarget: (id: string, body: ImportTargetBody) =>
    api.post<ArchiveImportRun>(p.importTarget(id), body),
  setChoices: (id: string, body: ImportChoicesBody, rowVersion: number) =>
    api.post<ArchiveImportRun>(p.importChoices(id), body, ifMatch(rowVersion)),
  homeboxConnect: (id: string, body: HomeboxConnectBody) =>
    api.post<HomeboxConnection>(p.importHomeboxConnect(id), body),
  importPassphrase: (id: string, passphrase: string) =>
    api.post<ArchiveImportRun>(p.importPassphrase(id), { passphrase }),
  archiveDryRun: (id: string) =>
    api.post<{ report: ArchiveDryRunReport }>(`${runPath(id)}/dry-run`),

  // alias enrichment (T15)
  enrichEstimate: (id: string) => api.get<EnrichEstimate>(p.importEnrichEstimate(id)),
  enrich: (id: string) => api.post<EnrichStarted>(p.importEnrich(id)),

  // the Kept export (T12)
  createExport: (body: CreateExportBody) => api.post<ExportRun>(p.exports, body),
  exports: (params: ExportsParams = {}) => api.get<ExportsPage>(p.exports + qs(params)),
  /** Also how Download gets a fresh `fileUrl`: call it on each click. */
  exportRun: (id: string) => api.get<ExportRun>(p.exportRun(id)),
  cancelExport: (id: string) => api.post<ExportRun>(p.exportCancel(id)),

  // the list as a CSV (T16): the URL with the list's parameters, for a download link.
  thingsCsvUrl: (params: object) => p.thingsCsv + qs(params),

  // consumables (T17)
  consumables: (params: ConsumablesParams) => api.get<ConsumablesPage>(p.consumables + qs(params)),
  /** The thing's "Keep at least", or null when it has none (the server's 404). */
  stockRule: async (thingId: string): Promise<StockRule | null> => {
    try {
      return await api.get<StockRule>(p.thingStockRule(thingId));
    } catch (e) {
      if (isApiError(e) && e.status === 404) return null;
      throw e;
    }
  },
  putStockRule: (thingId: string, body: PutStockRuleBody, rowVersion?: number) =>
    requestWritten<StockRule>(p.thingStockRule(thingId), {
      method: 'PUT',
      body,
      headers: ifMatch(rowVersion) ?? {},
    }),
  deleteStockRule: (thingId: string, rowVersion: number) =>
    requestWritten<void>(p.thingStockRule(thingId), {
      method: 'DELETE',
      headers: ifMatch(rowVersion) ?? {},
    }),
  adjust: (thingId: string, body: AdjustBody, rowVersion: number): Promise<Written<ThingRow>> =>
    requestWritten<ThingRow>(p.thingAdjust(thingId), {
      method: 'POST',
      body,
      headers: ifMatch(rowVersion) ?? {},
    }),

  // field conversion (T18): the account owner only
  convertPreview: (fieldId: string, body: ConvertFieldBody) =>
    api.post<ConvertPreview>(p.typeFieldConvertPreview(fieldId), body),
  convert: (fieldId: string, body: ConvertFieldBody, rowVersion: number) =>
    request<ConvertResult>(p.typeFieldConvert(fieldId), {
      method: 'POST',
      body,
      headers: ifMatch(rowVersion) ?? {},
    }),
};

// ----- hooks -----------------------------------------------------------------------------------

/** The caller's exports, newest first (Settings → Import / export). */
export const useExports = (params: ExportsParams = {}) =>
  useInfiniteQuery({
    queryKey: k.exports.list(params),
    queryFn: ({ pageParam }) =>
      portabilityApi.exports({ ...params, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });

/** One export, polled while it is queued or running. */
export const useExportRun = (id: string | null) =>
  useQuery({
    queryKey: k.exports.one(id ?? ''),
    queryFn: () => portabilityApi.exportRun(id as string),
    enabled: id !== null,
    refetchInterval: (q) =>
      q.state.data?.status === 'queued' || q.state.data?.status === 'running' ? 2000 : false,
  });

export const useEnrichEstimate = (runId: string | null) =>
  useQuery({
    queryKey: k.enrichEstimate(runId ?? ''),
    queryFn: () => portabilityApi.enrichEstimate(runId as string),
    enabled: runId !== null,
  });

/** A thing's "Keep at least" (null: none), read where the module is on and the type is
 * consumable. */
export const useStockRule = (thingId: string, enabled = true) =>
  useQuery({
    queryKey: k.consumables.rule(thingId),
    queryFn: () => portabilityApi.stockRule(thingId),
    enabled,
  });

export const useConsumables = (params: ConsumablesParams, enabled = true) =>
  useInfiniteQuery({
    queryKey: k.consumables.list(params),
    enabled,
    queryFn: ({ pageParam }) =>
      portabilityApi.consumables({ ...params, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });
