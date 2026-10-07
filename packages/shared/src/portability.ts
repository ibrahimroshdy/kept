/**
 * Portability (step 7; D68, D69, D146, D157, D159; engineering spec §3.1b, §3.3): the limits and
 * names the export, the archive importers and the web share. The archive rules themselves live in
 * one server module (apps/server/src/portability/zip/); these are the numbers it enforces.
 */

/**
 * Archives (D157, §3.1b; plan Q18). Counted on the bytes actually inflated, not on the headers.
 * The 100 : 1 ratio is judged only once an entry has inflated more than `ratioFloorBytes`
 * (spike Z1, docs/spikes/2026-09-30-step7-archive.md): an empty JSON array or a run of spaces in
 * a CSV is normal. `archiveBytes` is the upload cap for the compressed file.
 */
export const ZIP_LIMITS = Object.freeze({
  entries: 200_000,
  uncompressedBytes: 5 * 1024 ** 3,
  ratio: 100,
  ratioFloorBytes: 1024 ** 2,
  archiveBytes: 5 * 1024 ** 3,
});

/** Why an archive was refused (plan T7), sent as `reason` beside 400 `archive_invalid` or 413
 * `archive_too_large`, and translated by the web. `unsupported_version` is a manifest newer
 * than this server reads (T9, T14). `encrypted`: an entry with a ZIP password, which Kept
 * can't read (a Kept export's secrets are encrypted inside its data, never with ZIP
 * encryption). `entry_too_large`: a JSON entry or an NDJSON line over the reader's cap. */
export const ARCHIVE_REFUSALS = [
  'too_many_entries',
  'too_large',
  'ratio',
  'symlink',
  'bad_name',
  'duplicate_name',
  'truncated',
  'unsupported_version',
  'encrypted',
  'entry_too_large',
] as const;
export type ArchiveRefusal = (typeof ARCHIVE_REFUSALS)[number];

/** Issues on one archive entry (a file), listed in the dry run and the summary. */
export const ARCHIVE_ISSUE_CODES = [
  'file_type_refused',
  'file_missing',
  'file_too_large',
  'entry_ignored',
] as const;
export type ArchiveIssueCode = (typeof ARCHIVE_ISSUE_CODES)[number];

/** The Kept export's format (plan Q5): API-shaped, versioned, one location per archive. */
export const EXPORT_FORMAT = 'kept-export';
export const EXPORT_VERSION = 1;

/**
 * The data files of a Kept export (`data/<entity>.ndjson`), in the order they are written and
 * applied. Entities steps 4–6 add are appended by the export registry (T12), never renamed.
 */
export const EXPORT_ENTITIES = [
  'location',
  'places',
  'things',
  'codes',
  'legacy-codes',
  'types',
  'place-kinds',
  'brands',
  'vendors',
  'people',
  'tags',
  'purchases',
  'purchase-lines',
  'files',
  'attachments',
  'meters',
  'readings',
  'meter-events',
  'templates',
  'box-checks',
  'stock-rules',
  'own-code-settings',
  // Appended by the export registry (T12): the join rows and registries the list above didn't
  // name, then steps 4–6. `history` stays last: it is applied after every row it names.
  'own-code-counters',
  'type-fields',
  'person-contacts',
  'thing-tags',
  'thing-links',
  'box-check-lines',
  'template-locations',
  'secret-field-policies',
  'fx-rates',
  'warranties',
  'claims',
  'loans',
  'valuations',
  'incidents',
  'incident-things',
  'expiring-documents',
  'schedules',
  'service-records',
  'service-lines',
  'service-completions',
  'fuel-entries',
  'history',
] as const;
export type ExportEntity = (typeof EXPORT_ENTITIES)[number];

/** The archive entry of an original: `files/<uuid>.<ext>` (lower-case, 1–5 letters or digits). */
export const EXPORT_FILE_PATH =
  /^files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[a-z0-9]{1,5}$/;

/**
 * The entries of a Kept export (`kept-export` v1, plan T12, Q5). Read only by these exact names
 * (plus the originals, `files/<fileId>.<ext>`); anything else in an archive is ignored.
 *
 * - `manifest.json`: ExportManifest.
 * - `data/<entity>.ndjson`: one object per line, camelCase, ids as on the exporting server. Each
 *   entity's fields are the export registry's (apps/server/src/exports/registry.ts), whose zod
 *   schemas the Kept importer reads them with (exports/format.ts `entitySchema()`). A row whose
 *   money the exporter couldn't see carries `moneyHidden: true` and no money fields.
 * - `files/<fileId>.<ext>`: each original an attachment (or a thing's cover) references,
 *   byte-identical (D117), the extension from its sniffed type (so a browser opens it from the
 *   readable copy). The manifest lists each with its `path`, SHA-256, size and type; an importer
 *   reads only the paths the manifest names, and only in this form.
 * - `secrets.json`: only with "Include secrets" (D68): ExportSecretsFile.
 * - `ai-calls.csv`: the location's AI call ledger (§7.15), formula-safe (D169).
 * - `me.json`, `my-ai-calls.csv`: "Export my data" only (Q14).
 * - `readable/…`: the readable copy (T13): `index.html`, CSVs, `thumbs/`, `inventory.pdf`. Its
 *   pages link to the originals at `../files/<fileId>.<ext>`.
 */
export const EXPORT_PATHS = Object.freeze({
  manifest: 'manifest.json',
  secrets: 'secrets.json',
  aiCalls: 'ai-calls.csv',
  me: 'me.json',
  myAiCalls: 'my-ai-calls.csv',
  readableDir: 'readable',
  data: (entity: ExportEntity) => `data/${entity}.ndjson`,
  file: (fileId: string, ext: string) => `files/${fileId}.${ext}`,
});

/** What an export holds besides its data (plan T12): ended things (on), trashed things (off),
 * history (on), AI calls (on), the readable copy (on) and its inventory PDF (on); the readable
 * copy's language and digits. */
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

export const DEFAULT_EXPORT_OPTIONS: Readonly<ExportOptions> = Object.freeze({
  ended: true,
  trashed: false,
  history: true,
  aiCalls: true,
  readable: true,
  pdf: true,
  locale: 'en',
  digits: 'western',
});

/** Why the readable copy has no inventory PDF: turned off, past the report's 2,000 things, or
 * the render failed (the export still completes). */
export type ExportPdfOutcome = 'included' | 'off' | 'too_many_things' | 'failed';

/** `manifest.json` of a Kept export. */
export type ExportManifest = {
  format: typeof EXPORT_FORMAT;
  version: number;
  /** The exporting server's version (`KEPT_VERSION`, or `dev`). */
  keptVersion: string;
  exportId: string;
  createdAt: string;
  createdBy: { displayName: string };
  scope: ExportScope;
  location: {
    id: string;
    name: string;
    kind: string;
    timezone: string;
    currency: string;
    languages: string[];
    modules: string[];
  };
  options: ExportOptions;
  /** Rows per data file written (every entity in EXPORT_ENTITIES, 0 when empty or left out). */
  counts: Record<ExportEntity, number>;
  /** Whether money was hidden from the exporter (the Money module off there): money fields are
   * then absent, and the rows that had them say `moneyHidden: true`. */
  moneyHidden: boolean;
  includesSecrets: boolean;
  /** How many values `secrets.json` holds (0 without it). */
  secretsCount: number;
  /** Names and roles only, "people to invite" on import (Q23); never an email. */
  members: { name: string; role: string }[];
  files: { id: string; path: string; sha256: string; bytes: number; mime: string }[];
  readable: { included: boolean; pdf: ExportPdfOutcome };
};

/** One line of `data/history.ndjson`: an audit event rendered for the exporter (D110: a secret is
 * only `{changed: true}`, money per their gate, no custom-field labels). Ids as on this server. */
export type ExportHistoryEvent = {
  id: string;
  at: string;
  action: string;
  actor: { type: string; id: string | null; name: string | null };
  entity: { type: string; id: string | null };
  rootThingId: string | null;
  /** The things the event is about (audit_event_subjects). */
  subjects: string[];
  diff: Record<
    string,
    | { before: unknown; after: unknown; class: 'plain' | 'money' }
    | { changed: true; class: 'money'; hidden: true }
    | { changed: true; class: 'secret' }
  > | null;
  undoOf: string | null;
};

/** `secrets.json` (D68): the secret values, encrypted with a key derived from the owner's
 * passphrase. `data` is AES-256-GCM over NDJSON of ExportSecretRecord, with the AAD
 * `exportSecretsAad(exportId)`. Every binary field (salt, iv, tag, data) is base64url. */
export const EXPORT_SECRETS_FORMAT = 'kept-secrets';
export type ExportSecretsFile = {
  format: typeof EXPORT_SECRETS_FORMAT;
  version: 1;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  cipher: 'aes-256-gcm';
  iv: string;
  tag: string;
  data: string;
};
export type ExportSecretRecord = {
  subject: { kind: 'thing' | 'place'; id: string };
  fieldKey: string;
  /** The field's id on the exporting server (an account field's, or a built-in's). */
  typeFieldId: string | null;
  value: string;
  updatedAt: string;
};
export const exportSecretsAad = (exportId: string): string => `kept-export|${exportId}|secrets`;

/** What an export covers (plan T12, Q14): one location, or "Export my data". */
export const EXPORT_SCOPES = ['location', 'me'] as const;
export type ExportScope = (typeof EXPORT_SCOPES)[number];

/** Five an hour per person, one running per location, kept seven days after it is ready (§3.3,
 * plan Q17). */
export const EXPORT_LIMITS = Object.freeze({ perHour: 5, runningPerLocation: 1, keepDays: 7 });

/** A passphrase is at least this long, with no composition rules (plan Q7). */
export const PASSPHRASE_MIN = 12;

/**
 * The passphrase KDF (D68; spike P1, docs/spikes/2026-09-30-step7-passphrase.md): scrypt at
 * 2^16 (64 MiB). The V5 run on a 2 GB, 2-vCPU VM may lower N to 2^15; every export records its
 * own parameters, so a changed default never breaks an old export.
 */
export const PASSPHRASE_KDF = Object.freeze({
  name: 'scrypt',
  N: 65_536,
  r: 8,
  p: 1,
  keyBytes: 32,
  saltBytes: 16,
});

/** What an importer accepts from an export's recorded KDF: N a power of two from 2^14 to 2^20,
 * r 8, p 1. Anything else is `archive_invalid` (spike P1). */
export function kdfParamsAccepted(kdf: { name: string; N: number; r: number; p: number }): boolean {
  return (
    kdf.name === 'scrypt' &&
    Number.isInteger(kdf.N) &&
    kdf.N >= 2 ** 14 &&
    kdf.N <= 2 ** 20 &&
    (kdf.N & (kdf.N - 1)) === 0 &&
    kdf.r === 8 &&
    kdf.p === 1
  );
}

/** `import_runs.source` (engineering spec §1.10): the path an import took. */
export const IMPORT_SOURCES = [
  'csv',
  'homebox_zip',
  'homebox_api',
  'kept_zip',
  'lubelogger_csv',
] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

/** `import_source_ids.source` (plan Q2): the import paths, plus `homebox`, which both Homebox
 * paths write so one Homebox entity is made once whichever way it came (D146). */
export const IMPORT_SOURCE_ID_SOURCES = [...IMPORT_SOURCES, 'homebox'] as const;
export type ImportSourceIdSource = (typeof IMPORT_SOURCE_ID_SOURCES)[number];

/** `import_source_ids.entity_type`: what a source's id became. `warranty`, `service_record` and
 * `schedule` are written once the Homebox mappings to them land (plan T9, T10); the step 4–6
 * entities after them by the Kept import (0097). */
export const IMPORT_ENTITY_TYPES = [
  'thing',
  'place',
  'purchase',
  'attachment',
  'file',
  'tag',
  'type',
  'type_field',
  'brand',
  'vendor',
  'person',
  'template',
  'meter',
  'reading',
  'box_check',
  'stock_rule',
  'warranty',
  'service_record',
  'schedule',
  'loan',
  'claim',
  'incident',
  'valuation',
  'expiring_document',
  'fuel_entry',
  'service_line',
] as const;
export type ImportEntityType = (typeof IMPORT_ENTITY_TYPES)[number];

/** The sources an archive upload takes (`POST /imports/archive`, plan T8). */
export const ARCHIVE_SOURCES = ['homebox_zip', 'kept_zip'] as const;
export type ArchiveSource = (typeof ARCHIVE_SOURCES)[number];

/** `import_runs.status`. An archive run is a `draft` with no location until its target is set
 * (`kept.set_import_target`); one refused on inspection is `failed`, and a pruned one
 * `cancelled`, still without one. */
export const IMPORT_STATUSES = [
  'draft',
  'checked',
  'running',
  'done',
  'failed',
  'cancelled',
] as const;
export type ImportRunStatus = (typeof IMPORT_STATUSES)[number];

/** Abandoned import runs and their archives are pruned after this many days (plan Q18). */
export const IMPORT_PRUNE_DAYS = 7;
