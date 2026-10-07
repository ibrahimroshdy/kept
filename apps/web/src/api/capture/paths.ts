/**
 * Every step-3 server path the web app calls, in one place. Each comes from the route tables of
 * the step-3 plan's Phase B (tasks 9, 10 and 12–20) and the engineering spec §7.15, and lands in
 * the matching `apps/server/src/<area>/routes.ts` (task 2's stubs). A path the server names
 * differently is fixed here and nowhere else. Task 32's contract check reads `CAPTURE_METHODS`
 * against the server's openapi.json, as step 2's does with `METHODS`.
 *
 * Paths that already exist from step 2 are not repeated: the undo route (`inventoryPaths.undo`),
 * hints (`inventoryPaths.hints`/`hint`), mark seen (`inventoryPaths.thingSeen`), uploads
 * (`inventoryPaths.file`) and a code's lookup (`inventoryPaths.code`).
 */

const V1 = '/api/v1';
const seg = (value: string) => encodeURIComponent(value);

export const capturePaths = {
  // ----- sync (T12, T14) -----
  syncSnapshot: `${V1}/sync/snapshot`,
  syncOps: `${V1}/sync/ops`,

  // ----- capture (T13) -----
  captures: `${V1}/captures`,
  captureBatches: `${V1}/captures/batches`,
  captureBatchUndo: (batchId: string) => `${V1}/captures/batches/${seg(batchId)}/undo`,
  fileDisplay: (fileId: string) => `${V1}/files/${seg(fileId)}/display`,

  // ----- extraction (T10) -----
  thingExtract: (id: string) => `${V1}/things/${seg(id)}/extract`,
  thingExtractions: (id: string) => `${V1}/things/${seg(id)}/extractions`,

  // ----- inbox (T15) -----
  inbox: `${V1}/inbox`,
  inboxBulk: `${V1}/inbox/bulk`,
  inboxAccept: (id: string) => `${V1}/inbox/${seg(id)}/accept`,
  inboxCandidates: (id: string) => `${V1}/inbox/${seg(id)}/candidates`,
  inboxReceipt: (id: string) => `${V1}/inbox/${seg(id)}/receipt`,
  inboxCurrency: (id: string) => `${V1}/inbox/${seg(id)}/currency`,
  inboxMerge: (id: string) => `${V1}/inbox/${seg(id)}/merge`,
  inboxNotDuplicate: (id: string) => `${V1}/inbox/${seg(id)}/not-duplicate`,
  inboxReading: (id: string) => `${V1}/inbox/${seg(id)}/reading`,
  inboxRestore: (id: string) => `${V1}/inbox/${seg(id)}/restore`,
  inboxDismiss: (id: string) => `${V1}/inbox/${seg(id)}/dismiss`,
  inboxDiscard: (id: string) => `${V1}/inbox/${seg(id)}/discard`,

  // ----- labels (T16) -----
  labelBatches: `${V1}/labels/batches`,
  labelBatch: (id: string) => `${V1}/labels/batches/${seg(id)}`,
  labelBatchPrinted: (id: string) => `${V1}/labels/batches/${seg(id)}/printed`,
  labelSummary: `${V1}/labels/summary`,
  codeClaim: (code: string) => `${V1}/codes/${seg(code)}/claim`,

  // ----- scan, barcodes, box checks (T17) -----
  scanResolve: `${V1}/scan/resolve`,
  barcode: (code: string) => `${V1}/barcodes/${seg(code)}`,
  thingBoxCheck: (id: string) => `${V1}/things/${seg(id)}/box-check`,
  thingBoxChecks: (id: string) => `${V1}/things/${seg(id)}/box-checks`,

  // ----- CSV import (T18) -----
  importsCsv: `${V1}/imports/csv`,
  imports: `${V1}/imports`,
  importRun: (id: string) => `${V1}/imports/${seg(id)}`,
  importDryRun: (id: string) => `${V1}/imports/${seg(id)}/dry-run`,
  importStart: (id: string) => `${V1}/imports/${seg(id)}/run`,
  importCancel: (id: string) => `${V1}/imports/${seg(id)}/cancel`,

  // ----- templates (T19) -----
  templates: `${V1}/templates`,
  template: (id: string) => `${V1}/templates/${seg(id)}`,
  accountTemplates: (accountId: string) => `${V1}/accounts/${seg(accountId)}/templates`,
  thingSaveAsTemplate: (id: string) => `${V1}/things/${seg(id)}/save-as-template`,

  // ----- undo (T20) -----
  thingUndoable: (id: string) => `${V1}/things/${seg(id)}/undoable`,

  // ----- AI (T9, §7.15) -----
  aiStatus: `${V1}/ai/status`,
  aiProviders: `${V1}/ai/providers`,
  /** PUT by scope (`instance`, `account`, `me`); DELETE by id. */
  aiProvider: (scopeOrId: string) => `${V1}/ai/providers/${seg(scopeOrId)}`,
  aiProviderTest: (id: string) => `${V1}/ai/providers/${seg(id)}/test`,
  aiProviderModels: (id: string) => `${V1}/ai/providers/${seg(id)}/models`,
  aiExplain: `${V1}/ai/explain`,
  aiCaps: `${V1}/ai/caps`,
  aiCap: (id: string) => `${V1}/ai/caps/${seg(id)}`,
  aiCapResume: (id: string) => `${V1}/ai/caps/${seg(id)}/resume`,
  aiPause: `${V1}/ai/pause`,
  aiPrices: `${V1}/ai/prices`,
  adminAiPrices: `${V1}/admin/ai/prices`,
  adminAiPricesPrefill: `${V1}/admin/ai/prices/prefill`,
  adminAiPrice: (providerKind: string, model: string) =>
    `${V1}/admin/ai/prices/${seg(providerKind)}/${seg(model)}`,
  adminAiPricesRecost: `${V1}/admin/ai/prices/recost`,
  aiUsage: `${V1}/ai/usage`,
  aiCalls: `${V1}/ai/calls`,
  aiCall: (id: string) => `${V1}/ai/calls/${seg(id)}`,
  aiCallsCsv: `${V1}/ai/calls.csv`,
} as const;

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** The methods the web app uses on each path (the contract check, task 32). */
export const CAPTURE_METHODS: Record<keyof typeof capturePaths, readonly Method[]> = {
  syncSnapshot: ['GET'],
  syncOps: ['POST'],
  captures: ['POST'],
  captureBatches: ['GET'],
  captureBatchUndo: ['POST'],
  fileDisplay: ['PUT'],
  thingExtract: ['POST'],
  thingExtractions: ['GET'],
  inbox: ['GET'],
  inboxBulk: ['POST'],
  inboxAccept: ['POST'],
  inboxCandidates: ['GET'],
  inboxReceipt: ['POST'],
  inboxCurrency: ['POST'],
  inboxMerge: ['POST'],
  inboxNotDuplicate: ['POST'],
  inboxReading: ['POST'],
  inboxRestore: ['POST'],
  inboxDismiss: ['POST'],
  inboxDiscard: ['POST'],
  labelBatches: ['GET', 'POST'],
  labelBatch: ['GET'],
  labelBatchPrinted: ['POST'],
  labelSummary: ['GET'],
  codeClaim: ['POST'],
  scanResolve: ['POST'],
  barcode: ['GET'],
  thingBoxCheck: ['POST'],
  thingBoxChecks: ['GET'],
  importsCsv: ['POST'],
  imports: ['GET'],
  importRun: ['GET'],
  importDryRun: ['POST'],
  importStart: ['POST'],
  importCancel: ['POST'],
  templates: ['GET'],
  template: ['PATCH', 'DELETE'],
  accountTemplates: ['GET', 'POST'],
  thingSaveAsTemplate: ['POST'],
  thingUndoable: ['GET'],
  aiStatus: ['GET'],
  aiProviders: ['GET'],
  aiProvider: ['PUT', 'DELETE'],
  aiProviderTest: ['POST'],
  aiProviderModels: ['GET'],
  aiExplain: ['GET'],
  aiCaps: ['GET', 'PUT'],
  aiCap: ['DELETE'],
  aiCapResume: ['POST'],
  aiPause: ['POST'],
  aiPrices: ['GET'],
  adminAiPrices: ['POST'],
  adminAiPricesPrefill: ['POST'],
  adminAiPrice: ['DELETE'],
  adminAiPricesRecost: ['POST'],
  aiUsage: ['GET'],
  aiCalls: ['GET'],
  aiCall: ['GET'],
  aiCallsCsv: ['GET'],
};
