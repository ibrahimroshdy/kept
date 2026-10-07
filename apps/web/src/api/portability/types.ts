/**
 * Step 7's API contract (portability): archive imports (Homebox and Kept exports), the Kept
 * export, alias enrichment after an import, consumables and field conversion. Written from the
 * route tables of the step-7 plan's Phase B (tasks 8, 9, 11, 12, 14, 15, 17 and 18); the server's
 * routes land in `apps/server/src/{imports/archive,exports,enrich,consumables,types}/…`.
 *
 * Conventions as steps 2–4: camelCase JSON; lists are `{items, next_cursor}`; a PATCH and every
 * POST that changes a versioned row sends `If-Match: <rowVersion>`; money is a decimal string plus
 * its currency, left out when hidden. A passphrase is sent only in the body of the two routes that
 * take it, and never stored by the web (not in browser storage, not in the query cache).
 */
import type {
  ArchiveRefusal,
  ArchiveSource,
  ConvertFieldBody,
  ConvertPreview,
  ConvertResult,
  CostSource,
  ExportRunStatus,
  ExportScope,
  HomeboxChoices,
  HomeboxFieldKind,
  ImportIssue,
  ImportIssueRef,
  ImportRunStatus,
  ProviderKind,
  Role,
} from '@kept/shared';
import type { PayerScope } from '../capture/types';
import type { ThingRow } from '../inventory/types';
import type { LocationKind } from '../types';

export type { ConvertFieldBody, ConvertPreview, ConvertResult, HomeboxChoices };

// ----- archive imports (T8, T9, T11, T14) --------------------------------------------------------

/** POST /api/v1/imports/archive: the archive is declared first, then uploaded. `bytes` over
 * ZIP_LIMITS.archiveBytes is 413 `archive_too_large` before anything is stored. */
export type CreateArchiveImportBody = {
  id: string;
  source: ArchiveSource;
  bytes: number;
  /** The archive's SHA-256, hex, computed in the browser before the upload. */
  sha256: string;
};

/**
 * An archive import run: step 3's `ImportRun` for a Homebox or Kept export. It starts as a `draft`
 * with no location (read before the person picks where it goes, screens §6); the upload sets
 * `archiveReadyAt`, inspect sets `inspect`, the target sets `locationId`. GET /imports/:id,
 * GET /imports, /dry-run, /run and /cancel are step 3's routes, which serve these runs too.
 */
export type ArchiveImportRun = {
  id: string;
  /** Null until the target is set (POST …/target); never changes after. */
  locationId: string | null;
  source: ArchiveSource;
  /** Homebox's version when a connection told it (the ZIP doesn't), or the export's Kept version. */
  sourceVersion: string | null;
  status: ImportRunStatus;
  bytes: number;
  sha256: string;
  /** When the upload finished and the bytes matched; null until then. */
  archiveReadyAt: string | null;
  inspect: ArchiveInspect | null;
  /** The Homebox dry-run choices (POST …/choices); null until set, and for a Kept export. */
  choices: HomeboxChoices | null;
  /** A Kept export with secrets: whether the passphrase was given and checked (POST …/passphrase). */
  secrets: { present: boolean; unlocked: boolean } | null;
  progress: number;
  total: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** A short machine code (`archive_invalid`, `not_permitted`, …), never a sentence with data. */
  error: string | null;
  /** With `error = 'archive_invalid'`: why (ARCHIVE_REFUSALS). */
  reason?: ArchiveRefusal;
  updatedAt: string;
  /** The last dry run's report (GET …/:id only). */
  report?: ArchiveDryRunReport;
  rowVersion: number;
};

export type HomeboxCollectionCounts = {
  entities: number;
  locations: number;
  attachments: number;
  maintenance: number;
  tags: number;
  types: number;
};

/**
 * What the Homebox choices step needs to offer (screens §6 "dry-run choices", D146; plan T19):
 * the collection's entity types with how many items use each, its custom fields by name with
 * their Homebox kind and how many items carry them, how many items are insured, and the seeded
 * places and tags that are empty and unused (what `seeded: 'skip_unused'` leaves out). Read from
 * `entity_types`, `entity_fields`, `entities` and `tags` (T9's read.ts), names only, no values.
 * Optional: without it the web offers the other choices, and the check matches types by name.
 */
export type HomeboxMappingHints = {
  types: { id: string; name: string; items: number }[];
  fields: { name: string; kind: HomeboxFieldKind; items: number }[];
  insuredItems: number;
  seededUnused: { places: string[]; tags: string[] };
};

/** POST /api/v1/imports/:id/inspect: what the archive holds, read from its manifest and row
 * counts only. A bad archive is 400 `archive_invalid` with its `reason`, and the run `failed`. */
export type ArchiveInspect =
  | {
      source: 'homebox_zip';
      sourceVersion: string | null;
      /** One ZIP holds exactly one collection (spike H1); its id is the manifest's `groupId`. */
      collections: {
        id?: string;
        name?: string;
        counts: HomeboxCollectionCounts;
        /** The manifest's export time, when it has one. */
        exportedAt?: string;
        mapping?: HomeboxMappingHints;
      }[];
    }
  | {
      source: 'kept_zip';
      sourceVersion: string | null;
      kept: {
        locationName: string;
        kind: LocationKind;
        exportedAt: string;
        keptVersion: string;
        counts: Record<string, number>;
        includesSecrets: boolean;
        /** Names and roles only (plan Q23): people to invite. */
        members: { name: string; role: Role }[];
      };
    };

/** POST /api/v1/imports/:id/target. An existing location (Homebox only, one the caller
 * administers) or a new one, created in the caller's account. A Kept export takes only a new
 * location (plan Q8). */
export type ImportTargetBody =
  | { locationId: string }
  | {
      newLocation: {
        name: string;
        kind: Exclude<LocationKind, 'personal'>;
        timezone: string;
        currency: string;
        languages?: string[];
      };
    };

/** POST /api/v1/imports/:id/choices (If-Match on the run). */
export type ImportChoicesBody = { choices: HomeboxChoices };

/** POST /api/v1/imports/:id/homebox-connect: used once during the request, never stored, logged
 * or audited (D146). */
export type HomeboxConnectBody =
  | { baseUrl: string; apiKey: string }
  | { baseUrl: string; username: string; password: string };

/** What the connection read (spike H3): the version, each collection's currency (upper case),
 * and the members with their emails (Homebox has no roles; the report asks for one). */
export type HomeboxConnection = {
  version: string;
  collections: { id: string; name: string; currency: string }[];
  members?: { name: string; email: string }[];
};

/** POST /api/v1/imports/:id/passphrase: checked by decrypting (400 `passphrase_wrong`, 10 tries an
 * hour per run); answers the run with `secrets.unlocked`. */
export type ImportPassphraseBody = { passphrase: string };

export type ArchiveRowStatus = 'ok' | 'text' | 'skipped';

/** One row of an archive dry run: only rows with issues are kept (plan Q27). */
export type ArchiveReportRow = {
  status: ArchiveRowStatus;
  ref: ImportIssueRef;
  issues: ImportIssue[];
};

export type HomeboxDryRunSummary = {
  places: number;
  things: number;
  containers: number;
  purchases: number;
  warranties: number;
  services: number;
  schedules: number;
  attachments: number;
  links: number;
  tags: number;
  types: number;
  fieldsAdded: number;
  legacyCodes: number;
  skipped: number;
  asText: number;
  refusedFiles: number;
};

export type KeptDryRunSummary = {
  places: number;
  things: number;
  attachments: number;
  files: number;
  /** Printed labels kept as they are, and those re-issued with the old code kept (plan Q9). */
  codesAdopted: number;
  codesReissued: number;
  /** History events carried (within the 2-year retention), and those too old to carry. */
  history: number;
  historyDropped: number;
  /** Secret values in the export; imported only with the passphrase. */
  secrets: number;
  skipped: number;
  asText: number;
  /** People to invite (names and roles, Q23). */
  members: { name: string; role: Role }[];
};

/** POST /api/v1/imports/:id/dry-run for an archive run: writes nothing; status `checked`. */
export type ArchiveDryRunReport =
  | { source: 'homebox_zip'; summary: HomeboxDryRunSummary; rows: ArchiveReportRow[] }
  | { source: 'kept_zip'; summary: KeptDryRunSummary; rows: ArchiveReportRow[] };

// ----- alias enrichment after an import (T15) ----------------------------------------------------

/** GET /api/v1/imports/:id/enrich/estimate: the token cost shown before anything runs (D69).
 * `cost` is left out without a price, or for a reader whose money is hidden. */
export type EnrichEstimate = {
  things: number;
  calls: number;
  tokens: { input: number; output: number };
  cost?: { amount: string; currency: string };
  costSource: CostSource;
  payer: { scope: PayerScope; label: string };
  provider: { kind: ProviderKind; model: string };
};

/** POST /api/v1/imports/:id/enrich → 202. */
export type EnrichStarted = { jobId: string };

// ----- the Kept export (T12) ---------------------------------------------------------------------

/** What an export holds besides the data: history, AI calls, the readable copy and its PDF,
 * ended and trashed things; the readable copy's language and digits. */
export type ExportOptions = {
  ended: boolean;
  trashed: boolean;
  history: boolean;
  aiCalls: boolean;
  readable: boolean;
  pdf: boolean;
  locale: string;
  digits: 'western' | 'eastern';
};

/** POST /api/v1/exports → 202. "Include secrets" is the owner's (403 otherwise), needs the
 * recovery kit acknowledged (409 `recovery_kit_required`) and the passphrase twice (400
 * `passphrase_weak`). 429 past five an hour; 409 `export_running` while one runs there. */
export type CreateExportBody = {
  id?: string;
  scope: { locationId: string } | { me: true };
  options?: Partial<ExportOptions>;
  includeSecrets?: boolean;
  passphrase?: string;
  passphraseAgain?: string;
};

/** An export's state, as `export_runs` stores it (step 4's claim packs too): `expired` once the
 * hourly purge has removed its archive, and already for a `done` run past `expiresAt` that the
 * purge hasn't reached. The web shows it as "Expired · Export again". */
export type ExportStatus = ExportRunStatus;

/** GET /api/v1/exports/:id. `fileUrl` is a 5-minute signed URL, given only while `done` and
 * unexpired, after the role is checked again (D180); fetch it on each Download, never keep it. */
export type ExportRun = {
  id: string;
  scope: ExportScope;
  locationId?: string;
  status: ExportStatus;
  progress: { done: number; total: number };
  bytes?: number;
  sha256?: string;
  includesSecrets: boolean;
  options: ExportOptions;
  createdAt: string;
  finishedAt?: string;
  expiresAt?: string;
  /** A short machine code when `failed` (`no_space`, `not_permitted`, …). */
  error?: string;
  fileUrl?: string;
};

/** GET /api/v1/exports?locationId&cursor: the caller's own runs, newest first. */
export type ExportsParams = { locationId?: string; cursor?: string };
export type ExportsPage = { items: ExportRun[]; next_cursor: string | null };

// ----- consumables (T17) -------------------------------------------------------------------------

/** GET /api/v1/consumables?locationId&state&placeId&cursor&limit (module `consumables`). */
export type ConsumablesParams = {
  locationId: string;
  state?: 'low' | 'all';
  placeId?: string;
  cursor?: string;
  limit?: number;
};

/** Low first, then by name. `low` is quantity < minQuantity (isLow, plan Q19). */
export type ConsumableRow = { thing: ThingRow; minQuantity: number; low: boolean };
export type ConsumablesPage = { items: ConsumableRow[]; next_cursor: string | null };

/** "Keep at least N" on one thing (`stock_rules`). */
export type StockRule = {
  thingId: string;
  locationId: string;
  minQuantity: number;
  updatedAt: string;
  rowVersion: number;
};

/** PUT /api/v1/things/:id/stock-rule (If-Match when it exists): undoable. A type that isn't
 * consumable is 409 `not_consumable`. */
export type PutStockRuleBody = { minQuantity: number };

/** POST /api/v1/things/:id/adjust (If-Match: the thing's rowVersion): by a delta or to a quantity,
 * never below 0 (D183). Undoable. */
export type AdjustBody = { delta: number } | { quantity: number };
