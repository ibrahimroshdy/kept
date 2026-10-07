/**
 * The step-3 web contract: every request and response the capture, inbox, AI, labels, scan,
 * import, template, undo and sync screens exchange with the server. Written from the route
 * tables of the step-3 plan's Phase B (tasks 9, 10 and 12–22) and the engineering spec §7.15
 * (D206), field for field. The server tasks implement the same shapes; a difference is fixed in
 * both, in the same commit (plan T3, T20).
 *
 * The sync protocol's types (queue items, results, snapshot rows) live in @kept/shared's sync.ts,
 * because the server parses them too. Step-2 shapes (`ThingRow`, `FileView`, `PathStep`, …) come
 * from ../inventory/types.ts.
 *
 * Conventions (engineering spec §7.7): camelCase JSON; lists are `{items, next_cursor}`; money is
 * a decimal string plus `currency`, **omitted** where the money gate hides it, with
 * `moneyHidden: true`; a versioned write sends `If-Match`.
 */
import type {
  AiTask,
  BudgetTask,
  CaptureMode,
  CostSource,
  DateFormat,
  DocumentKind,
  EmbeddingsSource,
  ExtractionStatus,
  ImportIssue,
  InboxKind,
  LedgerOutcome,
  LedgerTask,
  MappableField,
  ProviderKind,
  ReasoningLevel,
} from '@kept/shared';
import { aliasSuggestionLanguage } from '@kept/shared';
import type {
  ActorRef,
  AttachmentRole,
  FileView,
  Money,
  Page,
  PathStep,
  ThingRow,
  ThingView,
  UpdateThingBody,
} from '../inventory/types';

export type { Page };

// ----- shared shapes ---------------------------------------------------------------------------

/**
 * What an undoable write answers (D150, plan T20): the Undo toast calls
 * `POST /api/v1/audit/:eventId/undo` (inventoryPaths.undo) until `until`.
 */
export type UndoRef = { eventId: string; until: string };

/** Where a capture lands: a place, a container, or the location's Unplaced place (D118). */
export type CaptureTarget = { placeId: string } | { containerId: string } | { unplaced: true };

/** A money amount per currency: never converted without rates (D76, plan Q8). */
export type CurrencyAmount = { currency: string; amount: string };

// ----- capture (T13) ---------------------------------------------------------------------------

/**
 * POST /api/v1/captures, with an `Idempotency-Key` header. The same fields as the `create_thing`
 * op (@kept/shared `CreateThingPayload`) plus `locationId`; the op and this route share one
 * service (T13).
 */
export type CreateCaptureBody = {
  id: string;
  locationId: string;
  target: CaptureTarget;
  mode: CaptureMode;
  name?: string;
  typeId?: string;
  /** A decimal string (D183). */
  quantity?: string;
  batchId: string;
  files: { fileId: string; role?: AttachmentRole }[];
  /** "+ photo to this thing" (D175). */
  attachToThingId?: string;
  /** RECEIPT mode's "+ photo": another page of the receipt captured with this capture id (Q13). */
  pageOf?: string;
  /** RECEIPT and READING modes' "Note (optional)" (1–500 characters). */
  note?: string;
  meterId?: string;
  /** READING with AI off: the value the person typed (a decimal string). */
  readingValue?: string;
  barcode?: string;
  templateId?: string;
  /** A scanned blank label to claim for the new container (D43). */
  claimCode?: string;
};

/** 201 from POST /api/v1/captures. `undo` is added by T20 (`thing.capture`, Q23). */
export type CaptureResult = {
  thing?: ThingRow;
  purchaseId?: string;
  extraction?: { id: string; status: ExtractionState };
  inboxItemId?: string;
  undo?: UndoRef;
};

/** GET /api/v1/captures/batches?locationId&mine&cursor: recent batches (inbox grouping). */
export type CaptureBatch = {
  batchId: string;
  locationId: string;
  /** The place the batch was captured into ("Garage › Shelf A"). */
  placePath: PathStep[];
  capturedAt: string;
  count: number;
  drafts: number;
  byMe: boolean;
};
export type CaptureBatchParams = {
  locationId?: string;
  mine?: boolean;
  cursor?: string;
};

/** POST /api/v1/captures/batches/:batchId/undo: your unreviewed drafts go to the trash. */
export type BatchUndoResult = { trashed: string[] };

/** PUT /api/v1/files/:fileId/display (raw JPEG, `X-Kept-Sha256`) → the file with new derivatives. */
export type DisplayUploadResult = FileView;

// ----- extraction (T10) and the AI line (T29a, D206) -------------------------------------------

/** `extractions.status`, with D206's `waiting_provider` (the provider's rate limit, not a cap). */
export type ExtractionState = ExtractionStatus | 'waiting_provider';

export type PayerScope = 'instance' | 'account' | 'user';

/**
 * The ledger row behind an AI-filled draft (§7.15 "Elsewhere"), for the AI line: "Read by
 * qwen/qwen3.8-27b (Groq) · 2,502 tokens · ≈ USD 0.0039 · paid by Home". `cost` is omitted where
 * the money gate hides it.
 */
export type AiCallSummary = {
  /**
   * The ledger row (`llm_calls.id`), so tapping the AI line opens its detail (T29a). Absent only
   * where the caller can't see the row.
   */
  id?: string;
  model: string;
  providerKind: ProviderKind;
  tokens: number;
  images: number;
  cost?: Money;
  costSource: CostSource;
  /** `mine`: the viewer paid, by their own key or their own account's: "paid by you". */
  paidBy: { scope: PayerScope; label: string; mine?: boolean };
  outcome: LedgerOutcome;
  /** `llm_calls.error_code` (`timeout`, `auth`, `http_5xx`, …), so a failed read says why. */
  errorCode?: string | null;
};

/** POST /api/v1/things/:id/extract: explicit re-extraction only (D19, L58). */
export type ExtractBody = { attachmentId?: string; mode?: CaptureMode };
/** 202. */
export type ExtractResult = { extractionId: string };

/** One attempt in GET /api/v1/things/:id/extractions. */
export type ExtractionAttempt = {
  id: string;
  attempt: number;
  mode: CaptureMode;
  status: ExtractionState;
  statusReason: string | null;
  pausedUntil: string | null;
  createdAt: string;
  model: string | null;
  /** The fields this attempt filled in. */
  applied: string[];
  call: AiCallSummary | null;
};
export type ExtractionsResponse = { items: ExtractionAttempt[] };

// ----- inbox (T15) -----------------------------------------------------------------------------

export type FieldState = 'manual' | 'extracted' | 'confirmed';

export type InboxPhoto = { fileId: string; thumbUrl: string | null };

/**
 * A value AI read that waits for a decision (T10: a serial, a quantity above 1; from a label, a
 * VIN, plate, expiry or manufacture date). `value` is a string: `expires_on` and
 * `manufactured_on` a `YYYY-MM-DD` day, `quantity` a decimal string.
 */
export type Suggestion = {
  field: string;
  value: unknown;
  confidence: number;
  source: { extractionId: string; attachmentId: string };
};

export type ReceiptLine = {
  index: number;
  description: string;
  quantity: string;
  unitPrice?: string;
};

/** GET /api/v1/inbox: one item. Exactly one of the kind-specific parts is set, by `kind`. */
export type InboxItem = {
  id: string;
  kind: InboxKind;
  locationId: string;
  createdAt: string;
  createdBy: ActorRef;
  rowVersion: number;
  /** `count`: the things captured in the batch ("12 captured · Garage › Shelf A"). */
  batch: { id: string; capturedAt: string; placePath: PathStep[]; count: number } | null;
  /**
   * The draft, with the values AI filled in and auto-accepted (D19: name, brand, model, type,
   * colour) so the reviewer sees what was accepted ("Bosch · GDR 18V · Power tool").
   */
  thing?: ThingRow &
    Pick<ThingView, 'brand' | 'model' | 'colour' | 'serial'> & {
      photos: InboxPhoto[];
      fieldStatus: Record<string, { state: FieldState; confidence?: number }>;
    };
  suggestions?: Suggestion[];
  /** "Naming…", "AI paused until 14:00", "Waiting for Groq". */
  extraction?: {
    id: string;
    status: ExtractionState;
    statusReason?: string;
    pausedUntil?: string;
    call?: AiCallSummary | null;
  };
  receipt?: {
    purchaseId: string;
    pages: InboxPhoto[];
    vendorSeen?: string;
    purchasedOn?: string;
    currency?: string;
    total?: string;
    tax?: string;
    lines: ReceiptLine[];
    /** The lines don't add up to the total within ±1%. */
    flagged: boolean;
    moneyHidden?: true;
  };
  reading?: {
    meter: { id: string; label: string | null; unit: string };
    value: string;
    takenAt: string;
    /** `lower_than_previous`, … (step-2's meters check). */
    reason: string;
    neighbours: {
      before?: { value: string; takenAt: string };
      after?: { value: string; takenAt: string };
    };
    proofThumbUrl: string | null;
  };
  duplicate?: { other: ThingRow; reason: 'serial' | 'brand_model_place' };
  claim?: { code: string; claimedFor: { kind: 'thing' | 'place'; id: string; name: string } };
  /** An ambiguous currency mark: the options in order, **no preselection** (D189). */
  currency?: { seen: string; options: string[] };
  /**
   * A queued op the server dropped (D35): the op as queued (`{op, payload}`), the drop reason,
   * what it was aimed at and who removed that. T14 writes it into the item's payload in this
   * shape; Restore brings `entity` back from the trash and applies `op` again.
   */
  syncDrop?: {
    op: unknown;
    reason: string;
    entity?: { type: string; id: string; name: string };
    by?: ActorRef;
  };
};

export type InboxCounts = {
  byKind: Record<InboxKind, number>;
  mine: number;
  everyone: number;
};

/** GET /api/v1/inbox?locationId&mine(default 1)&kind&batchId&q&cursor&limit. */
export type InboxPage = Page<InboxItem> & { counts: InboxCounts };
export type InboxParams = {
  /**
   * The list standard's search (L88): the draft's name, a receipt's vendor as seen, a reading's
   * meter, the batch's place (the shared normaliser, D42). The counts ignore it.
   */
  q?: string;
  locationId?: string;
  /** "Mine" (the default) or everyone's. */
  mine?: boolean;
  kind?: InboxKind;
  batchId?: string;
  cursor?: string;
  limit?: number;
};

/**
 * The suggested fields `accept` can write (T15's `suggestedEdit`, over T10's fields): the thing's
 * serial, quantity and expiry date, and VIN, plate and manufacture date as custom fields (name,
 * model and colour too, though T10 applies those itself), and an alias AI proposed in Arabic,
 * `alias_ar` (D214), which joins the thing's aliases. Step 5 (T10, Q15): a vehicle's card read in
 * LABEL mode suggests a `document` (`DocumentSuggestion`), which accepting makes the vehicle's
 * expiring document. Accepting any other field is 400 `validation` ("set on the thing's page");
 * rejecting one is fine.
 */
export const ACCEPTABLE_SUGGESTIONS = [
  'name',
  'model',
  'colour',
  'serial',
  'quantity',
  'expires_on',
  'vin',
  'plate',
  'manufactured_on',
  'document',
] as const;
/** A `document` suggestion's value (the server's extraction/apply.ts): the card's kind and expiry. */
export type DocumentSuggestion = { kind: DocumentKind; expiresOn: string };
export const isDocumentSuggestion = (v: unknown): v is DocumentSuggestion =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as DocumentSuggestion).kind === 'string' &&
  typeof (v as DocumentSuggestion).expiresOn === 'string';
export const canAcceptSuggestion = (field: string): boolean =>
  (ACCEPTABLE_SUGGESTIONS as readonly string[]).includes(field) ||
  aliasSuggestionLanguage(field) !== null;

/**
 * POST /api/v1/inbox/:id/accept (If-Match). A name is required: 400 without one. `accept` and
 * `reject` name fields the item suggests (400 otherwise, and for one in both); `accept` only
 * ACCEPTABLE_SUGGESTIONS.
 */
export type InboxAcceptBody = { accept?: string[]; reject?: string[]; set?: UpdateThingBody };

export type InboxBulkAction = 'accept_names' | 'set_type' | 'set_place' | 'set_tags' | 'discard';
/** POST /api/v1/inbox/bulk. */
export type InboxBulkBody = {
  ids: string[];
  action: InboxBulkAction;
  typeId?: string;
  to?: { placeId: string } | { containerId: string };
  tagIds?: string[];
};
/**
 * Each id's outcome (`error` is the error code: `not_found`, `validation`, `conflict`, …), and
 * the bulk event's undo. A selection spanning locations writes one undoable event per location:
 * `undo` names the first, and X-Kept-Audit-Event lists each. Absent when nothing was done.
 */
export type InboxBulkResult = {
  results: { id: string; ok: boolean; error?: string }[];
  undo?: UndoRef;
};

/** Why a thing is a candidate for a receipt line, best first (the J2 order, T15). */
export type CandidateMatch = 'brand_model' | 'name';
/**
 * GET /api/v1/inbox/:id/candidates?line=<index>: things a receipt (or one of its lines) may be,
 * in the same location, by brand and model, then by the line's name. `line` ranks for that line.
 */
export type InboxCandidates = { things: (ThingRow & { match?: CandidateMatch })[] };

export type ReceiptLineAction = 'new_thing' | 'link' | 'skip';
/** POST /api/v1/inbox/:id/receipt. */
export type InboxReceiptBody = {
  vendor: { id: string } | { name: string };
  purchasedOn: string;
  currency: string;
  total?: string;
  tax?: string;
  lines: (ReceiptLine & {
    action: ReceiptLineAction;
    thingId?: string;
    target?: CaptureTarget;
  })[];
};
/** POST /api/v1/inbox/:id/currency. */
export type InboxCurrencyBody = { currency: string };
/**
 * POST /api/v1/inbox/:id/merge: `into` names the survivor, either the item's own thing or
 * `duplicate.other`; the other one of the pair is merged into it (D36, "which one survives").
 */
export type InboxMergeBody = { into: string };
export type InboxReadingAction = 'keep' | 'edit' | 'discard' | 'meter_replaced';
/** POST /api/v1/inbox/:id/reading. */
export type InboxReadingBody = {
  action: InboxReadingAction;
  value?: string;
  takenAt?: string;
  offset?: string;
};
/**
 * What an inbox action answers: `item` when the item is still open after it (a reading edited to
 * a value that still waits; a receipt's currency), and `undo` where undoable (a discard). A
 * discarded draft's item stays open behind it in the trash, unlisted, so its Undo brings both
 * back.
 */
export type InboxActionResult = { item?: InboxItem; undo?: UndoRef };
/** POST /api/v1/inbox/:id/restore (a sync drop): the re-applied op's outcome. */
export type InboxRestoreResult = { outcome: 'applied' | 'needs_review' | 'dropped' };

// ----- labels (T16) ----------------------------------------------------------------------------

export type LabelBatchKind = 'things' | 'places' | 'blank';

/** POST /api/v1/labels/batches. */
export type CreateLabelBatchBody = {
  id?: string;
  locationId: string;
  kind: LabelBatchKind;
  thingIds?: string[];
  placeIds?: string[];
  /** Every thing or container under the place (or the location) whose code was never printed (Q28). */
  unprinted?: { placeId?: string };
  blankCount?: number;
  /** A `LABEL_STOCKS` key (@kept/shared). */
  stock: string;
  startCell?: number;
  /**
   * The builder's preview (T28, for T16): validate and answer what the batch would hold, with
   * nothing saved and no blank code allocated. 200 `LabelBatchPreview`; the same errors as a
   * real create (403, 404, 409 `module_off`, 409 `blank_cap_reached`).
   */
  dryRun?: boolean;
};

export type LabelCellContent = {
  code: string;
  /** `KEPT_PUBLIC_URL + '/l/' + code` (D120). */
  url: string;
  kind: 'thing' | 'place' | 'blank';
  name?: string;
  /** Where it lives, outermost first, joined with " › " (full stocks print it, D134). */
  path?: string;
  targetId?: string;
};

export type LabelBatch = {
  id: string;
  locationId: string;
  kind: LabelBatchKind;
  stock: string;
  startCell: number;
  createdAt: string;
  printedConfirmedAt: string | null;
  labels: LabelCellContent[];
};

/** What a batch left out: `pending` (not visible: an offline capture not synced yet, or no ID
 * yet), `other` (visible but can't be labelled here: trashed, in another location, past the cap). */
export type LabelExclusions = { pending: number; other: number };

/** 201: things with a pending ID can't be in a batch; they are counted (screens §6). */
export type CreateLabelBatchResult = {
  batch: LabelBatch;
  excluded: LabelExclusions;
};

/**
 * A real (not dry-run) create that has nothing left to label answers 400 `validation` with
 * `excluded` beside the error (T16): what the preview showed was printed or went pending since.
 */
export type LabelBatchNothingDetails = { excluded: LabelExclusions };

/**
 * 200 for a `dryRun` create: the labels in print order, as `LabelBatch.labels` would hold them.
 * A blank sheet has no codes yet, so its `labels` is empty and `blank` says how many.
 */
export type LabelBatchPreview = {
  labels: LabelCellContent[];
  blank: number;
  excluded: LabelExclusions;
};

/** GET /api/v1/labels/summary?locationId: Home's checklist and the labels screen. */
export type LabelSummary = { unprinted: number; blankUnclaimed: number };

/** POST /api/v1/codes/:code/claim (D43). */
export type ClaimBody =
  | { thingId: string }
  | { placeId: string }
  | {
      newContainer: {
        id: string;
        name: string;
        typeId?: string;
      } & ({ placeId: string } | { containerId: string });
    };
export type ClaimResult = { outcome: 'claimed'; target: { kind: 'thing' | 'place'; id: string } };
/** 409 `label_claimed`'s extra field ("This label was claimed on another phone for …"). */
export type LabelClaimedDetails = {
  claimedFor: { kind: 'thing' | 'place'; id: string; name: string };
};

// ----- scan, barcodes and box checks (T17) -----------------------------------------------------

/** POST /api/v1/scan/resolve. `format` is the BarcodeDetector's name for what it read. */
export type ScanResolveBody = { text: string; format?: string };

/**
 * Five of the scan's six outcomes (D137, §2.4). The sixth, "Not on this phone", is decided on
 * the phone (T26). `not_in_your_kept` is identical for a missing, forbidden or retired code.
 */
export type ScanOutcome =
  | { outcome: 'open'; target: { kind: 'thing' | 'place'; id: string; locationId: string } }
  | { outcome: 'claim'; locationId: string }
  | { outcome: 'not_in_your_kept' }
  | {
      outcome: 'legacy_ambiguous';
      /** `locationId` lets the phone queue `mark_seen` for a pick while offline. */
      candidates: {
        locationName: string;
        locationId: string;
        name: string;
        kind: 'thing' | 'place';
        id: string;
      }[];
    }
  | { outcome: 'barcode'; barcode: { code: string; lookupEnabled: boolean } }
  | { outcome: 'not_kept'; text: string };

/** GET /api/v1/barcodes/:code (D104, D126). Nothing is stored server-side (Q22). */
export type BarcodeLookup =
  | { enabled: false }
  | {
      enabled: true;
      found: boolean;
      product?: { name: string | null; brand: string | null; quantity: string | null };
      attribution: string;
    };

/** POST /api/v1/things/:id/box-check (the container's id). */
export type BoxCheckBody = {
  id: string;
  lines: { thingId: string; expectedQty: string; foundQty: string }[];
  foundElsewhereIds?: string[];
};
export type BoxCheckResult = {
  boxCheckId: string;
  seen: string[];
  notHere: string[];
  split: { originalId: string; newId: string }[];
  movedIn: string[];
  undo?: UndoRef;
};
/** GET /api/v1/things/:id/box-checks?cursor. */
export type BoxCheckSummary = {
  id: string;
  at: string;
  by: ActorRef;
  seen: number;
  notHere: number;
  split: number;
  movedIn: number;
};

// ----- CSV import (T18) ------------------------------------------------------------------------

export type ImportStatus = 'draft' | 'checked' | 'running' | 'done' | 'failed' | 'cancelled';

export type ImportChoices = {
  placeSeparator: '>' | '/' | '\\';
  createPlaces: boolean;
  dateFormat: DateFormat;
  currency?: string;
  defaultTarget: { placeId: string } | { unplaced: true };
  typeByName: boolean;
};

/** POST /api/v1/imports/csv (≤ 10,000 rows, body ≤ 8 MB). */
export type CreateImportBody = {
  id?: string;
  locationId: string;
  columns: string[];
  rows: string[][];
  mapping: Record<string, MappableField>;
  choices: ImportChoices;
};

export type ImportRowStatus = 'ok' | 'text' | 'skipped';
/** POST /api/v1/imports/:id/dry-run: "mapped, as text, skipped, why" (§5). */
export type DryRunReport = {
  summary: {
    things: number;
    places: number;
    purchases: number;
    legacyCodes: number;
    skipped: number;
    asText: number;
  };
  /** Each issue has a stable `code` (with `params`) to translate, and the server's English
   * `message` as the fallback for a code this client doesn't know. */
  rows: { row: number; status: ImportRowStatus; issues: ImportIssue[] }[];
};
export type DryRunResult = { report: DryRunReport };

export type ImportRun = {
  id: string;
  locationId: string;
  source: 'csv';
  status: ImportStatus;
  mapping: Record<string, MappableField>;
  choices: ImportChoices;
  progress: number;
  total: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  /** When the run last changed; a `running` run still for IMPORT_STALE_MINUTES can be resumed. */
  updatedAt: string;
  /** The last dry run's report (GET …/:id only); absent before one, and for a report stored
   * before issues carried codes. */
  report?: DryRunReport;
  rowVersion: number;
};

// ----- templates and quick add (T19) -----------------------------------------------------------

/** `templateSchema`: never money or secrets (D177). */
export type TemplatePayload = {
  name?: string;
  brandId?: string;
  model?: string;
  colour?: string;
  quantity?: string;
  tagIds?: string[];
  aliases?: Record<string, string[]>;
  notes?: string;
  custom?: Record<string, unknown>;
};

/** GET /api/v1/templates?locationId: the templates usable there (members and above). */
export type Template = {
  id: string;
  name: string;
  typeId: string | null;
  typeIcon: string | null;
  payload: TemplatePayload;
};
export type TemplatesResponse = { items: Template[] };

/** GET /api/v1/accounts/:accountId/templates: the admin view. */
export type AccountTemplate = Template & {
  locations: { id: string; name: string }[];
  rowVersion: number;
};
export type AccountTemplatesResponse = { items: AccountTemplate[] };

/** POST /api/v1/accounts/:accountId/templates. */
/** A template's name: 1–80 characters (the server's `Text(80)` and `templates_name_chk`). */
export const TEMPLATE_NAME_MAX = 80;

export type CreateTemplateBody = {
  id?: string;
  /** At most TEMPLATE_NAME_MAX characters, or 400 `validation`. */
  name: string;
  typeId?: string;
  payload: TemplatePayload;
  locationIds: string[];
};
/** PATCH /api/v1/templates/:id (If-Match). */
export type UpdateTemplateBody = Partial<Omit<CreateTemplateBody, 'id'>>;
/** POST /api/v1/things/:id/save-as-template. */
export type SaveAsTemplateBody = { name: string; locationIds: string[] };

// ----- undo (T20) ------------------------------------------------------------------------------

/** GET /api/v1/things/:id/undoable: the timeline's "Undo" for 7 days (D150). */
export type UndoableEvent = { eventId: string; action: string; at: string; until: string };
export type UndoableResponse = { items: UndoableEvent[] };

/** 409 `undo_refused`'s extra fields: "Can't undo: Bruce changed the location since" (§5). */
export type UndoRefusedDetails = {
  reason: 'changed_since' | 'already_undone' | 'expired' | 'not_undoable';
  field?: string;
  changedBy?: ActorRef;
};

// ----- AI (T9, §7.15; D191, D202, D206) ---------------------------------------------------------

export type ProviderScope = 'instance' | 'account' | 'me';

export type AiPauseReason = 'manual' | 'cap_money' | 'cap_tokens' | 'tokens_day';
export type AiWaitReason = 'rate_limited' | 'limits' | 'provider_down' | 'auth';

/** GET /api/v1/ai/status?locationId (`kept.ai_status`). Viewers may call it. */
export type AiStatus = {
  resolved: boolean;
  source: 'instance' | 'account' | 'user' | null;
  providerKind: ProviderKind | null;
  model: string | null;
  pausedUntil: string | null;
  reason: AiPauseReason | null;
  pausedBy: { scope: string; label: string } | null;
  waitingProvider: { until: string; reason: AiWaitReason } | null;
  capPercent: number | null;
  canResume: boolean;
  canManage: boolean;
  /**
   * Who can resume or fix AI here (the cap's setter, the key's owner), for everyone else's
   * "Ask Alfred to resume" and "AI isn't working here · ask Alfred" (§3, D206). Null when that
   * is the caller, or nobody can.
   */
  manager: ActorRef | null;
  /** A chosen model the provider no longer lists (D202). */
  modelMissing: boolean;
  /**
   * Where this server's search embeddings come from (step 6 T14, D207), for AI settings' "Search"
   * line: `local` and `off` override the provider's embeddings model. Absent before step 6.
   */
  embeddingsSource?: EmbeddingsSource;
};

export type AiModels = { vision?: string; chat?: string; embeddings?: string };

/** GET /api/v1/ai/providers: those the caller manages. **Never a key.** */
export type AiProvider = {
  id: string;
  scope: 'instance' | 'account' | 'user';
  kind: ProviderKind;
  label: string | null;
  baseUrl: string | null;
  /** The key's last 4 characters: "••••abcd". */
  keyHint: string | null;
  models: AiModels;
  capabilities: { vision?: boolean; structured?: boolean };
  reasoning: ReasoningLevel;
  disabled: boolean;
  rowVersion: number;
};
export type AiProvidersResponse = { providers: AiProvider[] };

/**
 * PUT /api/v1/ai/providers/:scope (If-Match when one exists). The simple box sends `{apiKey}`
 * only; the kind comes from `detectKind` (400 "choose a provider" when it can't tell). The first
 * AI key anywhere answers 409 `recovery_kit_required` until the kit is acknowledged (D193).
 */
export type PutAiProviderBody = {
  apiKey?: string;
  kind?: ProviderKind;
  baseUrl?: string;
  models?: AiModels;
  reasoning?: ReasoningLevel;
  label?: string;
};

/** POST /api/v1/ai/providers/:id/test: one vision and one structured request (D188, L50). */
export type AiTestResult = {
  vision: { ok: boolean; latencyMs: number; error?: string };
  structured: { ok: boolean; error?: string };
  model: string;
  tokens: number;
  cost?: Money & { source: CostSource };
};

/** GET /api/v1/ai/providers/:id/models?refresh=1 (D202). Ids verbatim; nothing inferred. */
export type AiModelListing = {
  models: {
    id: string;
    vision: boolean | null;
    text: boolean;
    embeddings: boolean;
    visionSource: 'listing' | 'test' | null;
  }[];
  fetchedAt: string | null;
  chosenMissing: ('vision' | 'chat' | 'embeddings')[];
};

export type AiScope = 'me' | 'location' | 'account' | 'instance';

/** GET /api/v1/ai/explain?scope&locationId: "What uses AI in Kept" (§7.15). */
export type AiExplain = {
  actions: {
    task: LedgerTask;
    callsPerAction: number;
    tokensTypical: number;
    costTypical?: Money;
    basis: 'history' | 'reference';
    referenceDate?: string;
  }[];
  projection: {
    days: number;
    calls: number;
    tokens: number;
    cost: CurrencyAmount[];
    unknownCostCalls: number;
  };
};

export type AiCapScope =
  | 'instance'
  | 'instance_account'
  | 'account'
  | 'location'
  | 'member'
  | 'user';

/** One cap or per-task budget in GET /api/v1/ai/caps. */
export type AiCap = {
  id: string;
  scope: AiCapScope;
  /** Whose cap it is, in words and ids: the account, location or person. */
  target: { id: string | null; label: string };
  task: AiTask | null;
  tokensPerMinute?: number;
  tokensPerDay?: number;
  tokensPerMonth?: number;
  monthlyCap?: Money;
  used: { tokens: number; cost: CurrencyAmount[]; unknownCostCalls: number };
  percent: number | null;
  state: 'active' | 'warned' | 'paused';
  pausedUntil?: string;
  reason?: AiPauseReason;
  /** Lower than a location cap after the account cap was lowered: the tightest wins. */
  cappedByAccount: boolean;
  rowVersion: number;
  canEdit: boolean;
};
export type SuggestedAiCap = { monthlyCap?: Money; tokensPerMonth?: number };
/** `suggested` is filled while no cap exists (§3.5). */
export type AiCapsResponse = { caps: AiCap[]; suggested?: SuggestedAiCap };
export type AiCapsParams = { scope: AiScope; locationId?: string };

/** PUT /api/v1/ai/caps (If-Match when it exists). */
export type PutAiCapBody = {
  scope: AiCapScope;
  accountId?: string;
  locationId?: string;
  userId?: string;
  task?: AiTask;
  monthlyCap?: Money | null;
  tokensPerMonth?: number;
  tokensPerDay?: number;
  tokensPerMinute?: number;
};
/** POST /api/v1/ai/caps/:id/resume: "Resume now". */
export type ResumeAiBody = { raiseTo?: Money | { tokens: number }; remove?: true };
export type ResumeAiResult = { cap: AiCap; resumed: number };
/** POST /api/v1/ai/pause. */
export type PauseAiBody = {
  scope: AiCapScope;
  accountId?: string;
  locationId?: string;
  userId?: string;
};

/** A price version (versioned; nothing seeded, Q8). Rates per million tokens. */
export type AiPrice = {
  providerKind: ProviderKind;
  model: string;
  version: number;
  rates: {
    inputPerMtok: string;
    outputPerMtok: string;
    reasoningPerMtok: string | null;
    cachedInputPerMtok: string | null;
    perImage: string | null;
  };
  currency: string;
  effectiveFrom: string;
  supersededAt: string | null;
  source: 'admin' | 'provider_listing';
  listingFetchedAt: string | null;
};
/** GET /api/v1/ai/prices?history. */
export type AiPricesResponse = { prices: AiPrice[] };
/**
 * POST /api/v1/admin/ai/prices: adds version n + 1. `listingFetchedAt` when the rates came from
 * the provider's listing (the prefill's rows): the version's source is then `provider_listing`.
 */
export type PutAiPriceBody = {
  providerKind: ProviderKind;
  model: string;
  inputPerMtok: string;
  outputPerMtok: string;
  reasoningPerMtok?: string;
  cachedInputPerMtok?: string;
  perImage?: string;
  currency: string;
  listingFetchedAt?: string;
};
/** POST /api/v1/admin/ai/prices/prefill {providerId}: proposed rows, **not saved**. */
export type AiPricePrefill = {
  prices: (PutAiPriceBody & { listingFetchedAt: string })[];
};
/** POST /api/v1/admin/ai/prices/recost. */
export type RecostBody = { providerKind: ProviderKind; model: string; since: string };
export type RecostResult = { recosted: number };

export type AiUsageGroupBy = 'day' | 'task' | 'model' | 'person' | 'location' | 'account';
export type AiUsageParams = {
  scope: AiScope;
  locationId?: string;
  from?: string;
  to?: string;
  groupBy?: AiUsageGroupBy;
};
export type AiTokenCounts = { input: number; output: number; reasoning: number; cached: number };
export type AiUsageGroup = {
  key: string;
  label: string;
  calls: number;
  sentCalls: number;
  tokens: AiTokenCounts;
  images: number;
  cost: CurrencyAmount[];
  unknownCostCalls: number;
  outcomes: Partial<Record<LedgerOutcome, number>>;
  /**
   * Calls and tokens per budget task (extraction, assistant, embeddings, test), so the usage
   * page can stack each day's bar by task (screens §5 AI usage). Sent with `groupBy=day`.
   */
  tasks?: Partial<Record<BudgetTask, { calls: number; tokens: number }>>;
};
/** GET /api/v1/ai/usage (`kept.ai_usage`). `soFar` when the period includes today (D188). */
export type AiUsage = {
  scope: AiScope;
  from: string;
  to: string;
  soFar: boolean;
  groups: AiUsageGroup[];
  totals: Omit<AiUsageGroup, 'key' | 'label'>;
  caps: AiCap[];
};

/** One row of the call list (§7.15). `threadId` only for its owner; `cost` per the gate. */
export type AiCall = {
  id: string;
  at: string;
  requestId: string;
  attempt: number;
  task: LedgerTask;
  providerKind: ProviderKind;
  model: string;
  location?: { id: string; name: string };
  person?: { id: string; name: string } | 'background';
  paidBy: { scope: PayerScope; label: string; fellBack: boolean };
  sent: boolean;
  tokens: {
    estimate: number | null;
    input: number | null;
    output: number | null;
    reasoning: number | null;
    cached: number | null;
  };
  images: { count: number; tokensEach: number | null; bytes: number | null };
  latencyMs: number | null;
  finishReason: string | null;
  outcome: LedgerOutcome;
  errorCode: string | null;
  cost?: { amount: string; currency: string; source: CostSource; priceVersion: number | null };
  moneyHidden?: true;
  links: { extractionId?: string; thingId?: string; threadId?: string };
};
/** GET /api/v1/ai/calls/:id: one row, with the other attempts of the same request id. */
export type AiCallDetail = AiCall & { attempts: AiCall[] };

/** The call list's filters, in the D205 registry's URL form (§7.15). */
export type AiCallParams = {
  scope: AiScope;
  locationId?: string;
  cursor?: string;
  limit?: number;
  /**
   * When, as the date filter's URL value: a preset (`today`, `week`, `month`, `year`, counted in
   * the caller's `x-kept-timezone`) or `YYYY-MM-DD..YYYY-MM-DD` (either end may be empty).
   */
  at?: string;
  /** Person ids; `background` for "Kept (background)". */
  person?: string | string[];
  location?: string | string[];
  task?: LedgerTask | LedgerTask[];
  model?: string | string[];
  provider?: ProviderKind | ProviderKind[];
  outcome?: LedgerOutcome | LedgerOutcome[];
  /** The paying scope: `instance`, `account` or `user`. */
  paidBy?: PayerScope | PayerScope[];
  /** `true` (sent as the string) for calls that sent at least one image. */
  hasImage?: boolean;
  /** Total tokens, `min..max` (either end may be empty), like a custom date range. */
  tokens?: string;
  /** The cost, `min..max`, in `currency`; only where money shows (§7.15). */
  cost?: string;
  currency?: string;
  thing?: string | string[];
  q?: string;
  /** The filters that are "is none of" (D205), by parameter name: `not=task`. */
  not?: string[];
  /** Oldest first with `asc` (D211's direction switch); newest first by default. */
  dir?: 'asc' | 'desc';
};

// ----- sync (T12, T14): the envelope; the rows are @kept/shared's -----------------------------

/** GET /api/v1/sync/snapshot?cursor&limit&typesHash. */
export type SnapshotParams = { cursor?: string; limit?: number; typesHash?: string };
