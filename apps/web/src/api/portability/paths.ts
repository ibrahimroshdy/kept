/**
 * Every step-7 server path the web app calls, in one place. Each comes from the route tables of
 * the step-7 plan's Phase B (tasks 8, 11, 12, 14–18) and lands in the matching server file (task
 * 2's stubs: `imports/archive.ts`, `exports/routes.ts`, `enrich/routes.ts`,
 * `consumables/routes.ts`; `types/routes.ts` and `things/routes.ts` for T18 and T16). A path the
 * server names differently is fixed here and nowhere else. The contract check (T25) reads
 * `PORTABILITY_METHODS` against the server's openapi.json, as steps 2–4 do.
 *
 * Paths that already exist are not repeated: an archive run's view, list, dry run, run and cancel
 * are step 3's (`capturePaths.importRun`, `imports`, `importDryRun`, `importStart`,
 * `importCancel`), and a scanned label's resolution is `capturePaths.scanResolve`.
 */

const V1 = '/api/v1';
const seg = (value: string) => encodeURIComponent(value);

export const portabilityPaths = {
  // ----- archive imports (T8, T11, T14) -----
  importsArchive: `${V1}/imports/archive`,
  /** The raw `application/zip` body, with Content-Length and X-Kept-Sha256. */
  importArchive: (id: string) => `${V1}/imports/${seg(id)}/archive`,
  importInspect: (id: string) => `${V1}/imports/${seg(id)}/inspect`,
  importTarget: (id: string) => `${V1}/imports/${seg(id)}/target`,
  importChoices: (id: string) => `${V1}/imports/${seg(id)}/choices`,
  importHomeboxConnect: (id: string) => `${V1}/imports/${seg(id)}/homebox-connect`,
  importPassphrase: (id: string) => `${V1}/imports/${seg(id)}/passphrase`,

  // ----- alias enrichment (T15) -----
  importEnrichEstimate: (id: string) => `${V1}/imports/${seg(id)}/enrich/estimate`,
  importEnrich: (id: string) => `${V1}/imports/${seg(id)}/enrich`,

  // ----- the Kept export (T12) -----
  exports: `${V1}/exports`,
  exportRun: (id: string) => `${V1}/exports/${seg(id)}`,
  exportCancel: (id: string) => `${V1}/exports/${seg(id)}/cancel`,

  // ----- the list you're looking at, as a CSV (T16) -----
  /** Takes every GET /things parameter, `importRunId` included. */
  thingsCsv: `${V1}/things.csv`,

  // ----- consumables (T17) -----
  consumables: `${V1}/consumables`,
  /** GET (step-7 T23's addition: the thing page's "Keep at least" and the rule's rowVersion for
   * PUT's If-Match; 404 when the thing has none), PUT and DELETE. */
  thingStockRule: (id: string) => `${V1}/things/${seg(id)}/stock-rule`,
  thingAdjust: (id: string) => `${V1}/things/${seg(id)}/adjust`,

  // ----- field conversion (T18) -----
  typeFieldConvertPreview: (id: string) => `${V1}/type-fields/${seg(id)}/convert/preview`,
  typeFieldConvert: (id: string) => `${V1}/type-fields/${seg(id)}/convert`,
} as const;

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** The methods the web app uses on each path (the contract check, T25). */
export const PORTABILITY_METHODS: Record<keyof typeof portabilityPaths, readonly Method[]> = {
  importsArchive: ['POST'],
  importArchive: ['PUT'],
  importInspect: ['POST'],
  importTarget: ['POST'],
  importChoices: ['POST'],
  importHomeboxConnect: ['POST'],
  importPassphrase: ['POST'],
  importEnrichEstimate: ['GET'],
  importEnrich: ['POST'],
  exports: ['GET', 'POST'],
  exportRun: ['GET'],
  exportCancel: ['POST'],
  thingsCsv: ['GET'],
  consumables: ['GET'],
  thingStockRule: ['GET', 'PUT', 'DELETE'],
  thingAdjust: ['POST'],
  typeFieldConvertPreview: ['POST'],
  typeFieldConvert: ['POST'],
};
