/**
 * Step-3 fetchers, query keys and hooks, over the contract in ./types.ts and the paths in
 * ./paths.ts. Keys are factories under one prefix per area (`captureKeys.inbox.*`,
 * `captureKeys.ai.*`, …) so a mutation invalidates by prefix. Lists follow the list standard
 * (L88): `useInfiniteQuery` over `next_cursor`.
 *
 * Writes are fetchers on `captureApi` for the screens to wrap in `useMutation`; an undoable one
 * answers `undo: {eventId, until}` for T31's `useUndo`. The undo route itself, hints and mark
 * seen are step 2's (`inventoryApi`, `inventoryPaths`).
 */
import {
  isErrorCode,
  type SnapshotPage,
  type SyncOpsRequest,
  type SyncOpsResponse,
} from '@kept/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ApiError, api, ifMatch, written } from '../client';
import { qs } from '../inventory/paths';
import { nextCursor } from '../inventory/queries';
import type { FileView } from '../inventory/types';
import { capturePaths as p } from './paths';
import type {
  AccountTemplate,
  AccountTemplatesResponse,
  AiCall,
  AiCallDetail,
  AiCallParams,
  AiCap,
  AiCapsParams,
  AiCapsResponse,
  AiExplain,
  AiModelListing,
  AiPrice,
  AiPricePrefill,
  AiPricesResponse,
  AiProvider,
  AiProvidersResponse,
  AiScope,
  AiStatus,
  AiTestResult,
  AiUsage,
  AiUsageParams,
  BarcodeLookup,
  BatchUndoResult,
  BoxCheckBody,
  BoxCheckResult,
  BoxCheckSummary,
  CaptureBatch,
  CaptureBatchParams,
  CaptureResult,
  ClaimBody,
  ClaimResult,
  CreateCaptureBody,
  CreateImportBody,
  CreateLabelBatchBody,
  CreateLabelBatchResult,
  CreateTemplateBody,
  DryRunResult,
  ExtractBody,
  ExtractionsResponse,
  ExtractResult,
  ImportRun,
  InboxAcceptBody,
  InboxActionResult,
  InboxBulkBody,
  InboxBulkResult,
  InboxCandidates,
  InboxCurrencyBody,
  InboxMergeBody,
  InboxPage,
  InboxParams,
  InboxReadingBody,
  InboxReceiptBody,
  InboxRestoreResult,
  LabelBatch,
  LabelBatchPreview,
  LabelSummary,
  Page,
  PauseAiBody,
  ProviderScope,
  PutAiCapBody,
  PutAiPriceBody,
  PutAiProviderBody,
  RecostBody,
  RecostResult,
  ResumeAiBody,
  ResumeAiResult,
  SaveAsTemplateBody,
  ScanOutcome,
  ScanResolveBody,
  SnapshotParams,
  TemplatesResponse,
  UndoableResponse,
  UpdateTemplateBody,
} from './types';

export const captureKeys = {
  captures: {
    all: ['captures'] as const,
    batches: (params: CaptureBatchParams = {}) => ['captures', 'batches', params] as const,
  },
  extractions: (thingId: string) => ['extractions', thingId] as const,
  inbox: {
    all: ['inbox'] as const,
    list: (params: InboxParams = {}) => ['inbox', 'list', params] as const,
    candidates: (id: string, line?: number) => ['inbox', 'candidates', id, line ?? null] as const,
  },
  labels: {
    all: ['labels'] as const,
    batches: (locationId?: string) => ['labels', 'batches', locationId ?? null] as const,
    batch: (id: string) => ['labels', 'batch', id] as const,
    summary: (locationId?: string) => ['labels', 'summary', locationId ?? null] as const,
  },
  barcode: (code: string) => ['barcode', code] as const,
  boxChecks: (thingId: string) => ['box-checks', thingId] as const,
  imports: {
    all: ['imports'] as const,
    list: (locationId?: string) => ['imports', 'list', locationId ?? null] as const,
    run: (id: string) => ['imports', 'run', id] as const,
  },
  templates: {
    all: ['templates'] as const,
    usable: (locationId: string) => ['templates', 'usable', locationId] as const,
    account: (accountId: string) => ['templates', 'account', accountId] as const,
  },
  undoable: (thingId: string) => ['undoable', thingId] as const,
  ai: {
    all: ['ai'] as const,
    status: (locationId: string | null) => ['ai', 'status', locationId] as const,
    providers: ['ai', 'providers'] as const,
    models: (providerId: string) => ['ai', 'models', providerId] as const,
    explain: (scope: AiScope, locationId?: string) =>
      ['ai', 'explain', scope, locationId ?? null] as const,
    caps: (params: AiCapsParams) => ['ai', 'caps', params] as const,
    prices: (history = false) => ['ai', 'prices', { history }] as const,
    usage: (params: AiUsageParams) => ['ai', 'usage', params] as const,
    calls: (params: AiCallParams) => ['ai', 'calls', params] as const,
    call: (id: string) => ['ai', 'call', id] as const,
  },
};
const k = captureKeys;

/** The error an upload that isn't JSON-in answers with (the client's own shape). */
async function uploadError(res: Response): Promise<ApiError> {
  let body: { error?: unknown; code?: unknown; hint?: unknown } = {};
  try {
    body = await res.json();
  } catch {
    // Not JSON: the status says enough.
  }
  const code = typeof body.code === 'string' && isErrorCode(body.code) ? body.code : 'internal';
  return new ApiError(
    res.status,
    code,
    typeof body.error === 'string' ? body.error : `HTTP ${res.status}`,
    typeof body.hint === 'string' ? { hint: body.hint } : {},
  );
}

// ----- fetchers --------------------------------------------------------------------------------

export const captureApi = {
  // sync (T12, T14)
  snapshot: (params: SnapshotParams = {}) => api.get<SnapshotPage>(p.syncSnapshot + qs(params)),
  syncOps: (body: SyncOpsRequest) => api.post<SyncOpsResponse>(p.syncOps, body),

  // capture (T13)
  capture: (body: CreateCaptureBody, idempotencyKey: string) =>
    api.post<CaptureResult>(p.captures, body, { 'idempotency-key': idempotencyKey }),
  batches: (params: CaptureBatchParams = {}) =>
    api.get<Page<CaptureBatch>>(
      p.captureBatches +
        qs({ ...params, mine: params.mine === undefined ? undefined : params.mine ? 1 : 0 }),
    ),
  undoBatch: (batchId: string) => api.post<BatchUndoResult>(p.captureBatchUndo(batchId)),
  /** The phone-made display JPEG (D34, D36): raw bytes with their SHA-256. */
  putDisplay: async (fileId: string, jpeg: Blob, sha256: string): Promise<FileView> => {
    let res: Response;
    try {
      res = await fetch(p.fileDisplay(fileId), {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'image/jpeg', 'x-kept-sha256': sha256 },
        body: jpeg,
      });
    } catch {
      throw new ApiError(0, 'offline', 'Needs a connection');
    }
    if (!res.ok) throw await uploadError(res);
    return (await res.json()) as FileView;
  },

  // extraction (T10)
  extract: (thingId: string, body: ExtractBody = {}) =>
    api.post<ExtractResult>(p.thingExtract(thingId), body),
  extractions: (thingId: string) => api.get<ExtractionsResponse>(p.thingExtractions(thingId)),

  // inbox (T15)
  inbox: (params: InboxParams = {}) =>
    api.get<InboxPage>(
      p.inbox +
        qs({ ...params, mine: params.mine === undefined ? undefined : params.mine ? 1 : 0 }),
    ),
  /** Undoable (D150): one bulk event, in X-Kept-Audit-Event and as `undo`. */
  inboxBulk: (body: InboxBulkBody) => written.post<InboxBulkResult>(p.inboxBulk, body),
  inboxCandidates: (id: string, line?: number) =>
    api.get<InboxCandidates>(p.inboxCandidates(id) + qs({ line })),
  inboxAccept: (id: string, body: InboxAcceptBody, rowVersion: number) =>
    api.post<InboxActionResult>(p.inboxAccept(id), body, ifMatch(rowVersion)),
  inboxReceipt: (id: string, body: InboxReceiptBody, rowVersion: number) =>
    api.post<InboxActionResult>(p.inboxReceipt(id), body, ifMatch(rowVersion)),
  inboxCurrency: (id: string, body: InboxCurrencyBody, rowVersion: number) =>
    api.post<InboxActionResult>(p.inboxCurrency(id), body, ifMatch(rowVersion)),
  inboxMerge: (id: string, body: InboxMergeBody, rowVersion: number) =>
    api.post<InboxActionResult>(p.inboxMerge(id), body, ifMatch(rowVersion)),
  inboxNotDuplicate: (id: string, rowVersion: number) =>
    api.post<InboxActionResult>(p.inboxNotDuplicate(id), {}, ifMatch(rowVersion)),
  inboxReading: (id: string, body: InboxReadingBody, rowVersion: number) =>
    api.post<InboxActionResult>(p.inboxReading(id), body, ifMatch(rowVersion)),
  inboxRestore: (id: string, rowVersion: number) =>
    api.post<InboxRestoreResult>(p.inboxRestore(id), {}, ifMatch(rowVersion)),
  inboxDismiss: (id: string, rowVersion: number) =>
    api.post<InboxActionResult>(p.inboxDismiss(id), {}, ifMatch(rowVersion)),
  /** Undoable (D150): the draft's trash, in X-Kept-Audit-Event and as `undo`. */
  inboxDiscard: (id: string, rowVersion: number) =>
    written.post<InboxActionResult>(p.inboxDiscard(id), {}, ifMatch(rowVersion)),

  // labels (T16)
  createLabelBatch: (body: CreateLabelBatchBody) =>
    api.post<CreateLabelBatchResult>(p.labelBatches, body),
  /** The builder's preview: the same call with `dryRun`, nothing saved or allocated. */
  previewLabelBatch: (body: CreateLabelBatchBody) =>
    api.post<LabelBatchPreview>(p.labelBatches, { ...body, dryRun: true }),
  labelBatches: (locationId?: string, cursor?: string) =>
    api.get<Page<LabelBatch>>(p.labelBatches + qs({ locationId, cursor })),
  labelBatch: (id: string) => api.get<LabelBatch>(p.labelBatch(id)),
  labelBatchPrinted: (id: string) => api.post<LabelBatch>(p.labelBatchPrinted(id)),
  labelSummary: (locationId?: string) => api.get<LabelSummary>(p.labelSummary + qs({ locationId })),
  claim: (code: string, body: ClaimBody) => api.post<ClaimResult>(p.codeClaim(code), body),

  // scan, barcodes, box checks (T17)
  resolveScan: (body: ScanResolveBody) => api.post<ScanOutcome>(p.scanResolve, body),
  barcode: (code: string) => api.get<BarcodeLookup>(p.barcode(code)),
  boxCheck: (containerId: string, body: BoxCheckBody) =>
    api.post<BoxCheckResult>(p.thingBoxCheck(containerId), body),
  boxChecks: (containerId: string, cursor?: string) =>
    api.get<Page<BoxCheckSummary>>(p.thingBoxChecks(containerId) + qs({ cursor })),

  // CSV import (T18)
  createImport: (body: CreateImportBody) => api.post<ImportRun>(p.importsCsv, body),
  dryRun: (id: string) => api.post<DryRunResult>(p.importDryRun(id)),
  runImport: (id: string) => api.post<ImportRun>(p.importStart(id)),
  cancelImport: (id: string) => api.post<ImportRun>(p.importCancel(id)),
  importRun: (id: string) => api.get<ImportRun>(p.importRun(id)),
  imports: (locationId?: string) => api.get<Page<ImportRun>>(p.imports + qs({ locationId })),

  // templates (T19)
  templates: (locationId: string) => api.get<TemplatesResponse>(p.templates + qs({ locationId })),
  accountTemplates: (accountId: string) =>
    api.get<AccountTemplatesResponse>(p.accountTemplates(accountId)),
  createTemplate: (accountId: string, body: CreateTemplateBody) =>
    api.post<AccountTemplate>(p.accountTemplates(accountId), body),
  updateTemplate: (id: string, body: UpdateTemplateBody, rowVersion: number) =>
    api.patch<AccountTemplate>(p.template(id), body, ifMatch(rowVersion)),
  deleteTemplate: (id: string) => api.del(p.template(id)),
  saveAsTemplate: (thingId: string, body: SaveAsTemplateBody) =>
    api.post<AccountTemplate>(p.thingSaveAsTemplate(thingId), body),

  // undo (T20); the undo itself is inventoryApi's POST /audit/:eventId/undo
  undoable: (thingId: string) => api.get<UndoableResponse>(p.thingUndoable(thingId)),

  // AI (T9, §7.15)
  aiStatus: (locationId: string | null) =>
    api.get<AiStatus>(p.aiStatus + qs({ locationId: locationId ?? undefined })),
  aiProviders: () => api.get<AiProvidersResponse>(p.aiProviders),
  putAiProvider: (scope: ProviderScope, body: PutAiProviderBody, rowVersion?: number) =>
    api.put<AiProvider>(p.aiProvider(scope), body, ifMatch(rowVersion)),
  testAiProvider: (id: string) => api.post<AiTestResult>(p.aiProviderTest(id)),
  aiModels: (id: string, refresh = false) =>
    api.get<AiModelListing>(p.aiProviderModels(id) + qs({ refresh: refresh ? 1 : undefined })),
  deleteAiProvider: (id: string) => api.del(p.aiProvider(id)),
  aiExplain: (scope: AiScope, locationId?: string) =>
    api.get<AiExplain>(p.aiExplain + qs({ scope, locationId })),
  aiCaps: (params: AiCapsParams) => api.get<AiCapsResponse>(p.aiCaps + qs(params)),
  putAiCap: (body: PutAiCapBody, rowVersion?: number) =>
    api.put<AiCap>(p.aiCaps, body, ifMatch(rowVersion)),
  deleteAiCap: (id: string) => api.del(p.aiCap(id)),
  resumeAi: (capId: string, body: ResumeAiBody = {}) =>
    api.post<ResumeAiResult>(p.aiCapResume(capId), body),
  pauseAi: (body: PauseAiBody) => api.post<AiCap>(p.aiPause, body),
  aiPrices: (history = false) =>
    api.get<AiPricesResponse>(p.aiPrices + qs({ history: history ? 1 : undefined })),
  addAiPrice: (body: PutAiPriceBody) => api.post<AiPrice>(p.adminAiPrices, body),
  prefillAiPrices: (providerId: string) =>
    api.post<AiPricePrefill>(p.adminAiPricesPrefill, { providerId }),
  deleteAiPrice: (providerKind: string, model: string) =>
    api.del(p.adminAiPrice(providerKind, model)),
  recostAi: (body: RecostBody) => api.post<RecostResult>(p.adminAiPricesRecost, body),
  aiUsage: (params: AiUsageParams) => api.get<AiUsage>(p.aiUsage + qs(params)),
  aiCalls: (params: AiCallParams) => api.get<Page<AiCall>>(p.aiCalls + qs(params)),
  aiCall: (id: string) => api.get<AiCallDetail>(p.aiCall(id)),
  /** The CSV download's URL for the same filters (a link, not a fetch: §7.15). */
  aiCallsCsvUrl: (params: AiCallParams) => p.aiCallsCsv + qs(params),
};

// ----- hooks -----------------------------------------------------------------------------------

export const useCaptureBatches = (params: CaptureBatchParams = {}) =>
  useInfiniteQuery({
    queryKey: k.captures.batches(params),
    queryFn: ({ pageParam }) =>
      captureApi.batches({ ...params, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });

export const useExtractions = (thingId: string) =>
  useQuery({
    queryKey: k.extractions(thingId),
    queryFn: () => captureApi.extractions(thingId),
    enabled: !!thingId,
  });

/** How often the inbox looks again while a photo on it is being named. */
export const INBOX_NAMING_POLL_MS = 3000;

/** Whether any item on these pages is being read now, so its name is about to arrive. */
export function inboxIsNaming(pages: readonly InboxPage[] | undefined): boolean {
  return (pages ?? []).some((pg) =>
    pg.items.some((i) => i.extraction?.status === 'queued' || i.extraction?.status === 'running'),
  );
}

export const useInbox = (params: InboxParams = {}) =>
  useInfiniteQuery({
    queryKey: k.inbox.list(params),
    queryFn: ({ pageParam }) =>
      captureApi.inbox({ ...params, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
    // "Naming…" turns into the name without leaving the page (the maintainer's phone, 2026-10-07:
    // photos named on the server still read "Unnamed" until the inbox was opened again).
    refetchInterval: (q) => (inboxIsNaming(q.state.data?.pages) ? INBOX_NAMING_POLL_MS : false),
  });
/** A receipt's candidates, ranked for one of its lines when `line` is given. */
export const useInboxCandidates = (
  id: string,
  { line, enabled = true }: { line?: number; enabled?: boolean } = {},
) =>
  useQuery({
    queryKey: k.inbox.candidates(id, line),
    queryFn: () => captureApi.inboxCandidates(id, line),
    enabled: enabled && !!id,
  });

export const useLabelBatches = (locationId?: string) =>
  useInfiniteQuery({
    queryKey: k.labels.batches(locationId),
    queryFn: ({ pageParam }) => captureApi.labelBatches(locationId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });
export const useLabelBatch = (id: string) =>
  useQuery({ queryKey: k.labels.batch(id), queryFn: () => captureApi.labelBatch(id) });
export const useLabelSummary = (locationId?: string) =>
  useQuery({
    queryKey: k.labels.summary(locationId),
    queryFn: () => captureApi.labelSummary(locationId),
  });

/** A barcode's lookup (D126): a separate call, only when the scan read a product barcode. */
export const useBarcode = (code: string | null) =>
  useQuery({
    queryKey: k.barcode(code ?? ''),
    queryFn: () => captureApi.barcode(code ?? ''),
    enabled: !!code,
  });
export const useBoxChecks = (containerId: string) =>
  useInfiniteQuery({
    queryKey: k.boxChecks(containerId),
    queryFn: ({ pageParam }) => captureApi.boxChecks(containerId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });

export const useImportRuns = (locationId?: string) =>
  useQuery({ queryKey: k.imports.list(locationId), queryFn: () => captureApi.imports(locationId) });
export const useImportRun = (id: string, refetchInterval: number | false = false) =>
  useQuery({
    queryKey: k.imports.run(id),
    queryFn: () => captureApi.importRun(id),
    enabled: !!id,
    refetchInterval,
  });

export const useTemplates = (locationId: string) =>
  useQuery({
    queryKey: k.templates.usable(locationId),
    queryFn: () => captureApi.templates(locationId),
    enabled: !!locationId,
  });
export const useAccountTemplates = (accountId: string) =>
  useQuery({
    queryKey: k.templates.account(accountId),
    queryFn: () => captureApi.accountTemplates(accountId),
    enabled: !!accountId,
  });

export const useUndoable = (thingId: string) =>
  useQuery({
    queryKey: k.undoable(thingId),
    queryFn: () => captureApi.undoable(thingId),
    enabled: !!thingId,
  });

/** `GET /ai/status` for a location, or with none (the account-wide line). */
export const useAiStatus = (locationId: string | null) =>
  useQuery({ queryKey: k.ai.status(locationId), queryFn: () => captureApi.aiStatus(locationId) });
export const useAiProviders = () =>
  useQuery({ queryKey: k.ai.providers, queryFn: captureApi.aiProviders });
export const useAiModels = (providerId: string | null) =>
  useQuery({
    queryKey: k.ai.models(providerId ?? ''),
    queryFn: () => captureApi.aiModels(providerId ?? ''),
    enabled: !!providerId,
  });
export const useAiExplain = (scope: AiScope, locationId?: string) =>
  useQuery({
    queryKey: k.ai.explain(scope, locationId),
    queryFn: () => captureApi.aiExplain(scope, locationId),
  });
export const useAiCaps = (params: AiCapsParams) =>
  useQuery({ queryKey: k.ai.caps(params), queryFn: () => captureApi.aiCaps(params) });
export const useAiPrices = (history = false) =>
  useQuery({ queryKey: k.ai.prices(history), queryFn: () => captureApi.aiPrices(history) });
export const useAiUsage = (params: AiUsageParams) =>
  useQuery({ queryKey: k.ai.usage(params), queryFn: () => captureApi.aiUsage(params) });
export const useAiCalls = (params: AiCallParams) =>
  useInfiniteQuery({
    queryKey: k.ai.calls(params),
    queryFn: ({ pageParam }) =>
      captureApi.aiCalls({ ...params, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });
export const useAiCall = (id: string) =>
  useQuery({ queryKey: k.ai.call(id), queryFn: () => captureApi.aiCall(id), enabled: !!id });
