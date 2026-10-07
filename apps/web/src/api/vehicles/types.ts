/**
 * The step-5 web contract: every request and response the vehicle screens exchange with the
 * server (the Vehicles list, a vehicle's tabs, Log a reading, Log a service from an invoice, fuel
 * and charging, vehicle documents, the history report). Written from the route tables of the
 * step-5 plan's Phase B (T8, T9, T11–T13, T15), field for field; the server tasks implement the
 * same shapes. A difference is fixed in both, in the same commit (plan T3).
 *
 * Step 4's shapes stay step 4's (../household/types.ts): a service record, a schedule and an
 * expiring document keep their contract, and what step 5 adds to them is an extension here
 * (`ServiceRecordV5`, `ExpiringDocumentV5`, …), never a redefinition. Step 2's meters, readings
 * and Home (../inventory/types.ts) are extended the same way.
 *
 * Where the plan names a shape without spelling it out, the shape here is T3's proposal, marked
 * "(proposed)"; the server task adopts it or fixes both sides.
 *
 * Conventions (engineering spec §7.7), as steps 2–4: camelCase JSON; lists are
 * `{items, next_cursor}`; money is a decimal string plus `currency`, **omitted** where the money
 * gate hides it, with `moneyHidden: true`; a versioned write sends `If-Match`; an undoable write
 * answers `undo: {eventId, until}` (and names its event in `X-Kept-Audit-Event`, D150). List
 * filters travel as the plan's route tables write them: `f.<key>` (the surface's keys in
 * @kept/shared SURFACE_FILTER_KEYS), plus `q`, `sort`, `dir`, `cursor` and `limit`.
 */
import type {
  AgendaState,
  ConsumptionWhyNone,
  CostCategory,
  DocumentKind,
  FuelUnit,
  ReadingAdvice,
  ServiceLineKind,
  StarterKey,
} from '@kept/shared';
import type {
  DocumentState,
  ExpiringDocument,
  RenewDocumentBody,
  Schedule,
  ServiceRecord,
  CreateDocumentBody as Step4CreateDocumentBody,
  CreateServiceRecordBody as Step4CreateServiceRecordBody,
  DocumentsParams as Step4DocumentsParams,
  UpdateDocumentBody as Step4UpdateDocumentBody,
} from '../household/types';
import type {
  ActorRef,
  CreateReadingBody,
  HomeResponse,
  Many,
  Page,
  Reading,
  ReadingSource,
  ReadingState,
  ReportCreated,
  ReviewReason,
  ThingMeter,
  ThingRow,
  UpdateMeterBody,
} from '../inventory/types';

export type { Page };

// ----- shared shapes ----------------------------------------------------------------------------

/** An undoable write's event (D150): Undo is offered until `until`. */
export type Undo = { eventId: string; until: string };

/** A list's sort direction (D211). Absent: the sort's own order. */
export type SortDir = 'asc' | 'desc';

/** A date filter (`f.when`): a preset (`today`, `week`, `month`, `year`) or `YYYY-MM-DD..YYYY-MM-DD`. */
export type WhenFilter = string;

/** A photo that proves something: the attachment, its file, and a thumbnail to show (null while
 * the server hasn't made it yet, or for a file that has none: show the file's icon). */
export type ProofRef = { attachmentId: string; fileId: string; thumbUrl: string | null };

/** Who owns a reading made by a fill or a service (Q11): it is changed through its owner. */
export type ReadingOwner = { type: 'fuel' | 'service'; id: string };

// ----- meters and readings, finished (T8) -------------------------------------------------------

/**
 * `kept.meter_estimate()` (T7, Q8): the rate over the 90 days before the latest reading, when two
 * readings span 7 days or more; `advice` at 30 days (`stale`) and 60 (`unknown`, `perDay` null).
 */
export type Estimate = {
  /** Units a day, a decimal string; null without a rate, and always null when `unknown`. */
  perDay: string | null;
  basisDays: number | null;
  /** Whole days since the latest reading; null with none. */
  ageDays: number | null;
  advice: ReadingAdvice;
};

/** GET /api/v1/things/:id: each `meters[]` entry gains its estimate and nudge interval. */
export type ThingMeterV5 = ThingMeter & { estimate: Estimate; nudgeDays: number | null };

/** PATCH /api/v1/meters/:id (If-Match): gains the stale-reading nudge (`meters.manage`, Q19). */
export type UpdateMeterBodyV5 = UpdateMeterBody & {
  /** 7–365 days, or null for no nudge. */
  nudgeDays?: number | null;
};

/**
 * POST /api/v1/meters/:id/readings. `confirmJump` stores an implausible jump as accepted ("It's
 * right", Q9); a backwards reading is still 409 `conflict`. `proofFileId` attaches the photo to
 * the reading (D195, Q10).
 */
export type CreateReadingBodyV5 = CreateReadingBody & { confirmJump?: true; proofFileId?: string };
export type CreateReadingResultV5 = {
  reading: ReadingRow;
  state: ReadingState;
  reason?: ReviewReason;
  undo: Undo;
};

/** GET /api/v1/meters/:id/readings: an item gains its proof photo and its owner. */
export type ReadingRow = Reading & { proof?: ProofRef; ownedBy?: ReadingOwner };

/** GET /api/v1/meters/:id/readings (the `readings` surface). Sorted by `takenAt`. */
export type ReadingsParams = {
  'f.when'?: WhenFilter;
  'f.source'?: Many<ReadingSource>;
  'f.state'?: Many<ReadingState>;
  /** Filters that exclude their values instead ("is none of", D205). */
  not?: ('when' | 'source' | 'state')[];
  sort?: 'takenAt';
  dir?: SortDir;
  cursor?: string;
  limit?: number;
};

/** PATCH or DELETE /api/v1/readings/:id on an owned reading: 409 `reading_owned` with this. */
export type ReadingOwnedDetails = { ownedBy: ReadingOwner };

/** One photo on the odometer proof strip (D195): a reading's, or a step-3 proof still on the
 * thing (no reading, no value; dated by its attachment, Q10). */
export type ProofItem = {
  readingId: string | null;
  value: string | null;
  takenAt: string;
  fileId: string;
  thumbUrl: string | null;
  by: ActorRef;
};
/** GET /api/v1/meters/:id/proofs?cursor&limit, newest first. */
export type ProofsPage = Page<ProofItem>;

// ----- service drafts from an invoice (T9) ------------------------------------------------------

/** A suggestion read from the invoice (drafts only; violet and dashed until confirmed, D131). */
export type ServiceSuggestion = {
  field: 'line' | 'vendor' | 'servicedOn' | 'total' | 'currency';
  /** A line: `{description, kind?, quantity?, unitCost?}`; the rest: the field's value. Money in a
   * suggestion is withheld from a reader the gate hides it from. */
  value: unknown;
  confidence: number;
  source: { extractionId: string; attachmentId: string };
};

/** A line suggestion's value (proposed: the step-4 line input's fields, all read by AI). */
export type SuggestedLine = {
  description: string;
  kind?: ServiceLineKind;
  quantity?: string;
  unitCost?: string;
};

/** Step 4's service record, with step 5's fields (GET /api/v1/service-records/:id and lists). */
export type ServiceRecordV5 = ServiceRecord & {
  reviewState: 'draft' | 'confirmed';
  /** `total_mismatch`: the lines and the total disagree by more than 1% (reconcileTotal). */
  flags: string[];
  suggestions?: ServiceSuggestion[];
  extraction?: { id: string; status: string; statusReason?: string; pausedUntil?: string };
};

/** POST /api/v1/service-records/drafts (`logs.add`; `Idempotency-Key` required). */
export type CreateServiceDraftBody = {
  id: string;
  subject: { thingId: string } | { placeId: string };
  /** 1–10. */
  invoiceFileIds: string[];
};
export type CreateServiceDraftResult = {
  serviceRecord: ServiceRecordV5;
  extraction?: { id: string; status: string };
};

/** POST /api/v1/service-records/:id/confirm (If-Match): step 4's create body; 200 as its POST.
 * 409 `conflict` with `reason` and the neighbour when the reading doesn't fit, nothing written. */
export type ConfirmServiceBody = Omit<Step4CreateServiceRecordBody, 'id' | 'subject'>;

/** GET /api/v1/things/:id/service-records (the `services` surface): step 4's list, filtered. */
export type ServiceRecordsParams = {
  q?: string;
  'f.when'?: WhenFilter;
  'f.vendor'?: Many;
  'f.kind'?: Many<ServiceLineKind>;
  /** `1`: drafts only; `0`: confirmed only. */
  'f.draft'?: '0' | '1';
  /** Filters that exclude their values instead ("is none of", D205). */
  not?: ('when' | 'vendor' | 'kind' | 'draft')[];
  sort?: 'servicedOn' | 'total';
  dir?: SortDir;
  cursor?: string;
  limit?: number;
};
export type ServiceRecordsPageV5 = Page<ServiceRecordV5>;

// ----- fuel and charging (T11) ------------------------------------------------------------------

export type FuelRow = {
  id: string;
  takenAt: string;
  amount: string;
  unit: FuelUnit;
  isFull: boolean;
  missedBefore: boolean;
  /** Omitted with `moneyHidden`, or when none was entered. */
  cost?: string;
  currency?: string;
  moneyHidden?: true;
  /** The cost over the amount, in `currency`. */
  pricePerUnit?: string;
  /** The station (a vendor, D11). */
  vendor?: { id: string; name: string };
  reading?: { id: string; value: string; state: ReadingState };
  /** The pump receipt photo. */
  receipt?: ProofRef;
  loggedBy: ActorRef;
  rowVersion: number;
};

/** GET /api/v1/things/:id/fuel (the `fuel` surface). */
export type FuelParams = {
  'f.when'?: WhenFilter;
  'f.unit'?: Many<FuelUnit>;
  'f.vendor'?: Many;
  /** `1`: full fills; `0`: partial. */
  'f.full'?: '0' | '1';
  sort?: 'takenAt' | 'amount' | 'cost';
  dir?: SortDir;
  cursor?: string;
  limit?: number;
};
export type FuelPage = Page<FuelRow>;

/** POST /api/v1/things/:id/fuel (module `fuel`, `logs.add`; `Idempotency-Key` required). */
export type CreateFuelBody = {
  id: string;
  takenAt: string;
  amount: string;
  unit: FuelUnit;
  cost?: string;
  /** The location's by default. */
  currency?: string;
  isFull: boolean;
  missedBefore?: boolean;
  vendor?: { id: string } | { name: string };
  /** The odometer: the thing's distance meter unless `meterId` names another. */
  reading?: { meterId?: string; value: string; proofFileId?: string };
  receiptFileId?: string;
  note?: string;
};
export type CreateFuelResult = {
  entry: FuelRow;
  reading?: { id: string; state: ReadingState; reason?: ReviewReason };
  undo: Undo;
};
/** PATCH /api/v1/fuel/:id (If-Match): the POST's fields but `id` (a changed odometer re-places
 * its reading) → FuelRow. */
export type UpdateFuelBody = Partial<Omit<CreateFuelBody, 'id'>>;
/** DELETE /api/v1/fuel/:id (If-Match): its reading goes with it. */
export type DeleteFuelResult = { undo: Undo };

/** GET /api/v1/things/:id/fuel/summary?window=5&months=6. */
export type FuelSummaryParams = { window?: number; months?: number };
export type FuelSummary = {
  byUnit: Array<{
    unit: FuelUnit;
    consumption: {
      perHundred: string;
      /** The odometer's unit (`km`, `mi`, or `h` for a generator). */
      distanceUnit: string;
      fills: number;
      from: string;
      to: string;
    } | null;
    whyNone?: ConsumptionWhyNone;
    trend: Array<{ at: string; perHundred: string }>;
  }>;
  pricePerUnit?: Array<{
    unit: FuelUnit;
    currency: string;
    latest: string;
    trend: Array<{ at: string; price: string }>;
  }>;
  perDistance?: Array<{
    currency: string;
    amount: string;
    distanceUnit: string;
    from: string;
    to: string;
  }>;
  monthlyAverage?: Array<{ currency: string; amount: string; months: number }>;
  moneyHidden?: true;
};

// ----- vehicle documents (T12) ------------------------------------------------------------------

/** Step 4's expiring document with its issue date and cost (Q5). */
export type ExpiringDocumentV5 = ExpiringDocument & {
  issuedOn: string | null;
  cost?: string;
  currency?: string;
  moneyHidden?: true;
};
/** GET /api/v1/documents gains `thingId` (a vehicle's Documents tab). */
export type DocumentsParamsV5 = Step4DocumentsParams & { thingId?: string };
/** POST /documents, PATCH /documents/:id and POST /documents/:id/renew gain these. */
export type DocumentCostFields = {
  issuedOn?: string | null;
  cost?: string | null;
  currency?: string | null;
};
export type CreateDocumentBodyV5 = Step4CreateDocumentBody & DocumentCostFields;
export type UpdateDocumentBodyV5 = Step4UpdateDocumentBody & DocumentCostFields;
export type RenewDocumentBodyV5 = RenewDocumentBody & DocumentCostFields;

// ----- vehicles, costs, series and starter schedules (T13) --------------------------------------

export type VehicleReadingFilter = 'fresh' | 'stale' | 'unknown' | 'none';
export type VehicleDueFilter = 'overdue' | 'soon';

export type VehicleRow = {
  /** Short code, name, type, path, cover photo. */
  thing: ThingRow;
  meter?: {
    id: string;
    unit: string;
    latest?: { value: string; takenAt: string; source: ReadingSource; by: ActorRef };
    estimate: Estimate;
  };
  /** From `agenda_items`; `estimated` when the date comes from the usage estimate (D52). */
  nextDue?: {
    name: string;
    dueOn?: string;
    dueValue?: string;
    estimated: boolean;
    state: AgendaState;
  };
  documentsDue: Array<{ id: string; kind: DocumentKind; expiresOn: string; state: DocumentState }>;
  /** When the `fuel` module is on and there is a consumption. */
  fuel?: { perHundred: string; unit: FuelUnit; distanceUnit: string };
};

/** GET /api/v1/vehicles (module `vehicles`; global across the caller's locations with it on).
 * `f.state` defaults to `in_use` (Q24). */
export type VehiclesParams = {
  q?: string;
  'f.location'?: Many;
  'f.type'?: Many;
  'f.state'?: Many;
  'f.reading'?: Many<VehicleReadingFilter>;
  'f.due'?: Many<VehicleDueFilter>;
  /** Filters that exclude their values instead ("is none of", D205) (proposed). */
  not?: ('location' | 'type' | 'state' | 'reading' | 'due')[];
  sort?: 'name' | 'lastReading' | 'nextDue' | 'location';
  dir?: SortDir;
  cursor?: string;
  limit?: number;
};
export type VehiclesPage = Page<VehicleRow>;

/** One month's costs in one currency, by category (fuel · service and parts · fees and
 * insurance, `COST_CATEGORIES`), and the month's total. */
export type CostAmounts = Record<CostCategory, string> & { total: string };

/** GET /api/v1/things/:id/costs?from&to. Default: the last 6 full months and the current month
 * "so far" (D188). Per currency, never added across currencies (Q22). */
export type CostReport = {
  period: { from: string; to: string };
  distance: { value: string; unit: string; basis: 'readings' } | null;
  months: Array<{
    /** YYYY-MM. */
    month: string;
    soFar: boolean;
    byCurrency: Array<CostAmounts & { currency: string }>;
    /** A service's summary, for the chart's direct labels. */
    notes: string[];
  }>;
  totals: Array<CostAmounts & { currency: string; perDistance?: string; monthlyAverage: string }>;
  /** Then months carry no amounts, only notes. */
  moneyHidden?: true;
};
export type CostsParams = { from?: string; to?: string };

/** GET /api/v1/meters/:id/series?from&to: the chart's points, the estimate to the next
 * threshold, and step 4's schedules' thresholds with their estimated dates (T7). */
export type MeterSeries = {
  unit: string;
  points: Array<{ takenAt: string; value: string; source: ReadingSource }>;
  estimate?: { perDay: string; through: Array<{ at: string; value: string }> };
  thresholds: Array<{
    scheduleId: string;
    name: string;
    value: string;
    estimatedOn: string | null;
  }>;
};
export type SeriesParams = { from?: string; to?: string };

/** POST /api/v1/things/:id/starter-schedules (modules `vehicles` and `schedules`,
 * `schedules-claims.manage`): all four by default; a name the vehicle already has is skipped. */
export type StarterSchedulesBody = { keys?: StarterKey[] };
/** `undo` is absent when nothing was made (every name was there already): no event is written
 * for a request that changed nothing (the server's T13). */
export type StarterSchedulesResult = { schedules: Schedule[]; undo?: Undo };

/** Step 4's schedule with its estimated due date (T7): a unit schedule's `estimatedOn` is when
 * the meter reaches the due value at its usage; labelled estimated everywhere (D52). */
export type ScheduleV5 = Schedule & {
  next: Schedule['next'] & { estimatedOn?: string | null; estimated?: boolean };
};

/** GET /api/v1/home gains how many metered things the caller can log a reading on (T13), so Home
 * shows "Log a reading" only when there is one. */
export type HomeResponseV5 = HomeResponse & { meteredThings: number };

// ----- the vehicle history report (T15) ---------------------------------------------------------

/** POST /api/v1/reports/vehicle-history → 202 `ReportCreated` (module `vehicles`; the reports'
 * shared hourly limit). Viewers may make one; costs appear only if they see money. */
export type VehicleHistoryReportBody = {
  thingId: string;
  from?: string;
  to?: string;
  include?: { costs?: boolean; proofPhotos?: boolean; fuel?: boolean; documents?: boolean };
  locale?: 'en' | 'ar';
  digits?: 'western' | 'eastern';
};
export type VehicleHistoryReportCreated = ReportCreated;
