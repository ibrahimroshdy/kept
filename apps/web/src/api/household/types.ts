/**
 * The step-4 web contract: every request and response the money, warranty, lending, schedule,
 * paperwork, agenda, notification, calendar and incident screens exchange with the server.
 * Written from the route tables of the step-4 plan's Phase B (tasks 8–18), field for field. The
 * server tasks implement the same shapes in each area's `view.ts`; a difference is fixed in both,
 * in the same commit (plan T3).
 *
 * Where the plan names a response without spelling it out (`IncidentRow`, `Incident`, the claim
 * pack's run, a calendar feed, the body of a PATCH), the shape here is T3's proposal, marked
 * "(proposed)"; the server task adopts it or fixes both sides.
 *
 * Value lists (warranty kinds, claim statuses, source types, channel kinds, …) come from
 * @kept/shared (household.ts, reminders.ts, plan T1), because the server checks them too. Step-2
 * shapes (`ThingRow`, `AttachmentView`, `Brand`, …) come from ../inventory/types.ts.
 *
 * Conventions (engineering spec §7.7): camelCase JSON; lists are `{items, next_cursor}`, 20 a page
 * and 200 at most; money is a canonical decimal string plus `currency`, **omitted** where the
 * money gate hides it, with `moneyHidden: true`; a versioned write sends `If-Match`; an undoable
 * write names its audit event in `X-Kept-Audit-Event` (D150).
 */
import type {
  ActiveSourceType,
  AgendaState,
  ClaimStatus,
  DocumentKind,
  ExportRunStatus,
  IncidentKind,
  LoanDirection,
  NotificationKind,
  NotifyKind,
  OccurrenceKind,
  OccurrenceState,
  PreferenceChannel,
  Role,
  ScheduleState,
  ServiceLineKind,
  ValuationSource,
  WarrantyKind,
} from '@kept/shared';
import type { AiScope } from '../capture/types';
import type {
  ActorRef,
  AttachmentView,
  Page,
  ReportCreated,
  ThingCurrentValue,
  ThingRow,
  VendorKind,
} from '../inventory/types';

export type { Page };

// ----- shared shapes (plan Phase B, "Shared shapes") -------------------------------------------

/** What a record is about: a thing, a place, or a whole location (D39, D155). */
export type SubjectRef = {
  type: 'thing' | 'place' | 'location';
  id: string;
  name: string;
  /** "Home › Kitchen", in the reader's order; empty for a location. */
  path: string;
  shortCode?: string | null;
};

/** A person in the account's registry: a name and whether they use Kept. Never contact details. */
export type PersonRef = { id: string; name: string; isMember: boolean };

/**
 * An amount, or nothing but the fact that it's hidden from this reader (the money gate, step 2's
 * `serialize/gates.ts`). Named `Money` in the plan; ../inventory/types.ts's `Money` is the
 * ungated pair.
 */
export type GatedMoney = { amount: string; currency: string } | { moneyHidden: true };

/** An attachment on a step-4 record (warranty document, condition photo, invoice, …). */
export type AttachmentRef = AttachmentView;

/** A subject a create names: one of a thing, a place, or (documents only) a location. */
export type SubjectInput = { thingId: string } | { placeId: string } | { locationId: string };

/** An existing registry row, or a new one created inline by name (D11). */
export type ByIdOrName = { id: string } | { name: string };

// ----- money: exchange rates and valuations (T8) -----------------------------------------------

/** One rate, per account, per pair and date (D76). `rate` is a decimal string, > 0. */
export type FxRate = {
  fromCcy: string;
  toCcy: string;
  rate: string;
  /** YYYY-MM-DD: the rate applies from this day until a newer one. */
  validFrom: string;
  rowVersion: number;
  updatedBy: ActorRef;
  updatedAt: string;
};
/** GET /api/v1/accounts/:accountId/fx-rates?from&to. */
export type FxRatesResponse = { items: FxRate[] };
export type FxRatesParams = { from?: string; to?: string };
/** PUT /api/v1/accounts/:accountId/fx-rates: an upsert on the key; replacing needs If-Match. */
export type PutFxRateBody = { fromCcy: string; toCcy: string; rate: string; validFrom: string };

export type Valuation = {
  id: string;
  value: GatedMoney;
  valuedOn: string;
  source: ValuationSource;
  notes: string | null;
  documents: AttachmentRef[];
  rowVersion: number;
  createdBy: ActorRef;
};
/** GET /api/v1/things/:id/valuations. `current`: the latest `valuedOn`, then the latest made. */
export type ValuationsResponse = { items: Valuation[]; current: Valuation | null };
/** POST /api/v1/things/:id/valuations. `valuedOn` is never in the future. */
export type CreateValuationBody = {
  id?: string;
  value: string;
  currency: string;
  valuedOn: string;
  source: ValuationSource;
  notes?: string;
};
/** PATCH /api/v1/valuations/:id (proposed: the create's fields, each optional). */
export type UpdateValuationBody = Partial<Omit<CreateValuationBody, 'id'>>;

/** The thing view's `currentValue` (T8; D158), declared with the view in ../inventory/types.ts. */
export type CurrentValue = ThingCurrentValue;

// ----- warranties and claims (T9) --------------------------------------------------------------

export type WarrantyState = 'active' | 'expiring' | 'ended';

export type Warranty = {
  id: string;
  thingId: string;
  kind: WarrantyKind;
  provider: string | null;
  startsOn: string;
  endsOn: string | null;
  termMonths: number | null;
  lifetime: boolean;
  /** The last covered day (a term ends the day before its anniversary, L2), or null for lifetime. */
  effectiveEndsOn: string | null;
  leadDays: number;
  claimContact: string | null;
  registered: boolean;
  registrationDeadline: string | null;
  state: WarrantyState;
  documents: AttachmentRef[];
  rowVersion: number;
  createdBy: ActorRef;
};
/** The coverage bar (D195): bought → today → covered until. */
export type WarrantyCoverage = {
  longestId: string | null;
  boughtOn: string | null;
  coveredUntil: string | 'lifetime' | null;
};
/** GET /api/v1/things/:id/warranties: the longest cover first (D53). */
export type WarrantiesResponse = { items: Warranty[]; coverage: WarrantyCoverage };
/** GET /api/v1/things/:id/warranty-defaults (D55, D92). Never an AI guess. */
export type WarrantyDefaults = {
  termMonths: number | null;
  from: { kind: 'brand' | 'type'; id: string; name: string } | null;
  startsOn: string | null;
};
/** POST /api/v1/things/:id/warranties: one of `endsOn`, `termMonths` or `lifetime: true`. */
export type CreateWarrantyBody = {
  id?: string;
  kind: WarrantyKind;
  provider?: string;
  startsOn: string;
  endsOn?: string;
  termMonths?: number;
  lifetime?: true;
  leadDays?: number;
  claimContact?: string;
  registered?: boolean;
  registrationDeadline?: string;
};
/** PATCH /api/v1/warranties/:id (proposed: the create's fields, each optional, nullable to clear). */
export type UpdateWarrantyBody = {
  kind?: WarrantyKind;
  provider?: string | null;
  startsOn?: string;
  endsOn?: string | null;
  termMonths?: number | null;
  lifetime?: boolean;
  leadDays?: number;
  claimContact?: string | null;
  registered?: boolean;
  registrationDeadline?: string | null;
};

export type Claim = {
  id: string;
  thingId: string;
  warranty: { id: string; kind: WarrantyKind; provider: string | null } | null;
  incident: { id: string; kind: IncidentKind; occurredOn: string } | null;
  openedOn: string;
  reference: string | null;
  vendor: { id: string; name: string; kind: VendorKind } | null;
  status: ClaimStatus;
  cost: GatedMoney | null;
  /** "What it would have cost" (Q18). */
  coveredAmount: GatedMoney | null;
  notes: string | null;
  closedOn: string | null;
  /** `coveredAmount` when the claim resolved at no cost (D195, Q18). */
  savedYou: GatedMoney | null;
  documents: AttachmentRef[];
  rowVersion: number;
};
/** GET /api/v1/things/:id/claims. */
export type ClaimsResponse = { items: Claim[] };
/** GET /api/v1/things/:id/claim-prefill: the longest active warranty and its brand's contacts. */
export type ClaimPrefill = {
  warrantyId: string | null;
  claimUrl: string | null;
  supportPhone: string | null;
  claimContact: string | null;
};
/** POST /api/v1/things/:id/claims. 409 `thing_in_repair` when another claim is in repair. */
export type CreateClaimBody = {
  id?: string;
  warrantyId?: string;
  incidentId?: string;
  openedOn: string;
  reference?: string;
  vendor?: ByIdOrName;
  status?: 'open' | 'in_repair';
  notes?: string;
};
/** PATCH /api/v1/claims/:id. A status outside CLAIM_TRANSITIONS → 409 `invalid_transition`. */
export type UpdateClaimBody = {
  status?: ClaimStatus;
  reference?: string | null;
  vendor?: ByIdOrName | null;
  cost?: string | null;
  currency?: string;
  coveredAmount?: string | null;
  closedOn?: string | null;
  notes?: string | null;
};

/**
 * PUT /api/v1/brands/:id/logo (the image as the body) → the PNG Kept keeps of it (step-2 Q9,
 * Q33). GET on the same path is that PNG, 404 when the brand has none; DELETE → 204.
 */
export type BrandLogo = {
  brandId: string;
  width: number;
  height: number;
  sha256: string;
  updatedAt: string;
};

// ----- lending and borrowing (T10) -------------------------------------------------------------

export type Loan = {
  id: string;
  thingId: string;
  direction: LoanDirection;
  person: PersonRef;
  startedAt: string;
  dueOn: string | null;
  returnedAt: string | null;
  overdue: boolean;
  /** A decimal string (D183). */
  quantity: string;
  splitFromThingId: string | null;
  returnPlace: SubjectRef | null;
  previousPlace: SubjectRef | null;
  notes: string | null;
  conditionOut: AttachmentRef[];
  conditionIn: AttachmentRef[];
  rowVersion: number;
  createdBy: ActorRef;
};
export type LoanRow = Loan & { thing: ThingRow };

/** Who a loan is with: a person in the registry, a new one by name, or a member (D57). */
export type LoanPersonInput = { id: string } | { name: string } | { memberUserId: string };

/** POST /api/v1/things/:id/lend. A partial quantity splits the thing (D10, D57). */
export type LendBody = {
  loanId?: string;
  person: LoanPersonInput;
  startedAt?: string;
  dueOn?: string;
  quantity?: string;
  notes?: string;
};
export type LendResult = { loan: Loan; thing: ThingRow; splitFrom?: ThingRow };

/** POST /api/v1/locations/:id/borrow: a new thing that belongs to the person, and a loan in. */
export type BorrowBody = {
  thingId?: string;
  loanId?: string;
  name: string;
  typeId?: string;
  target: { placeId: string } | { containerId: string };
  person: LoanPersonInput;
  dueOn?: string;
  notes?: string;
};
export type BorrowResult = { loan: Loan; thing: ThingRow };

/** POST /api/v1/loans/:id/return. */
export type ReturnBody = {
  returnedAt?: string;
  to?: 'previous' | { placeId: string } | { containerId: string };
  /** Default true: a split-off part merges back into the row it came from (D172, Q14). */
  mergeBack?: boolean;
  notes?: string;
};
export type ReturnResult = { loan: Loan; thing: ThingRow; mergedInto?: ThingRow };

/** PATCH /api/v1/loans/:id. */
export type UpdateLoanBody = {
  dueOn?: string | null;
  notes?: string | null;
  person?: LoanPersonInput;
};

export type LoanState = 'open' | 'overdue' | 'returned';
/** GET /api/v1/loans (the Lending screen; global with a location filter, screens §1). */
export type LoansParams = {
  direction?: LoanDirection;
  state?: LoanState;
  locationId?: string;
  personId?: string;
  q?: string;
  cursor?: string;
};
export type LoansPage = Page<LoanRow> & { counts: { out: number; in: number; overdue: number } };
/** GET /api/v1/things/:id/loans: the thing's loan history. */
export type ThingLoansResponse = { items: Loan[] };
/** GET /api/v1/people/:id/loans: the person page (D57). */
export type PersonLoans = {
  /** Open, out, to them. */
  has: LoanRow[];
  /** Open, in, from them. */
  lentUs: LoanRow[];
  history: LoanRow[];
  next_cursor: string | null;
};

/** POST /api/v1/loans/:id/attachments: condition photos only. */
export type CreateLoanAttachmentBody = {
  fileId: string;
  role: 'condition_out' | 'condition_in';
};

// ----- schedules and service records (T11) -----------------------------------------------------

export type ScheduleBasis = 'months' | 'units' | 'both' | 'once';
export type { ScheduleState };

export type Schedule = {
  id: string;
  locationId: string;
  subject: SubjectRef;
  name: string;
  everyMonths: number | null;
  /** A decimal string on the meter's unit. */
  everyUnits: string | null;
  meter: { id: string; label: string; unit: string } | null;
  /** A one-off date. */
  dueOn: string | null;
  leadDays: number;
  leadUnits: string | null;
  anchorOn: string;
  anchorValue: string | null;
  /** Read from the agenda, never recomputed in the client (T11). */
  next: {
    dueOn: string | null;
    dueValue: string | null;
    state: ScheduleState;
    basis: ScheduleBasis;
  };
  snoozedUntil: string | null;
  snoozedUntilValue: string | null;
  skipNext: boolean;
  active: boolean;
  lastService: { id: string; servicedOn: string } | null;
  rowVersion: number;
};

/** GET /api/v1/schedules (the Schedules screen; global, module `schedules` per row's location). */
export type SchedulesParams = {
  locationId?: string;
  state?: ScheduleState;
  subjectType?: 'thing' | 'place';
  q?: string;
  cursor?: string;
};
export type SchedulesPage = Page<Schedule> & { counts: { due: number; overdue: number } };
/** GET /api/v1/things/:id/schedules · /places/:id/schedules. */
export type SubjectSchedulesResponse = { items: Schedule[] };

/** POST /api/v1/schedules. None of the three intervals → 400 `schedule_interval_required`. */
export type CreateScheduleBody = {
  id?: string;
  subject: { thingId: string } | { placeId: string };
  name: string;
  everyMonths?: number;
  everyUnits?: string;
  meterId?: string;
  dueOn?: string;
  leadDays?: number;
  leadUnits?: string;
  anchorOn?: string;
  anchorValue?: string;
};
/** PATCH /api/v1/schedules/:id (proposed: the create's fields bar the subject, nullable to clear). */
export type UpdateScheduleBody = {
  name?: string;
  everyMonths?: number | null;
  everyUnits?: string | null;
  meterId?: string | null;
  dueOn?: string | null;
  leadDays?: number;
  leadUnits?: string | null;
  anchorOn?: string;
  anchorValue?: string | null;
  active?: boolean;
};

/** POST /api/v1/schedules/:id/complete: a service record that completes it (D29). */
export type CompleteScheduleBody = {
  servicedOn?: string;
  reading?: { value: string; takenAt?: string };
  vendor?: ByIdOrName;
  total?: string;
  currency?: string;
  notes?: string;
};
export type CompleteScheduleResult = { serviceRecord: ServiceRecord; schedule: Schedule };
/** POST /api/v1/schedules/:id/snooze: to a date or a meter value (+10% of the interval). */
export type SnoozeBody = { untilDate: string } | { untilValue: string };

export type ServiceRecord = {
  id: string;
  subject: SubjectRef;
  servicedOn: string;
  reading: { id: string; value: string; unit: string } | null;
  vendor: { id: string; name: string } | null;
  total: GatedMoney | null;
  lines: Array<{
    id: string;
    kind: ServiceLineKind;
    description: string;
    quantity: string | null;
    unitCost: GatedMoney | null;
  }>;
  completes: Array<{ scheduleId: string; name: string }>;
  notes: string | null;
  invoices: AttachmentRef[];
  loggedBy: ActorRef;
  rowVersion: number;
};
/** GET /api/v1/things/:id/service-records · /places/:id/service-records. */
export type ServiceRecordsPage = Page<ServiceRecord>;

export type ServiceLineInput = {
  kind: ServiceLineKind;
  description: string;
  quantity?: string;
  unitCost?: string;
};
/** POST /api/v1/service-records ("Log a service"). Core; `completes` needs Schedules on. */
export type CreateServiceRecordBody = {
  id?: string;
  subject: { thingId: string } | { placeId: string };
  servicedOn: string;
  reading?: { meterId: string; value: string; proofFileId?: string };
  vendor?: ByIdOrName;
  total?: string;
  currency?: string;
  /** At most 50. */
  lines?: ServiceLineInput[];
  completes?: string[];
  notes?: string;
};
/** PATCH /api/v1/service-records/:id (proposed: the create's fields bar the subject). */
export type UpdateServiceRecordBody = Partial<Omit<CreateServiceRecordBody, 'id' | 'subject'>>;

// ----- the paperwork library and expiring documents (T12) --------------------------------------

export type DocumentState = 'ok' | 'expiring' | 'expired';

export type ExpiringDocument = {
  id: string;
  locationId: string;
  subject: SubjectRef;
  kind: DocumentKind;
  /** Required for `other` (Q31). */
  title: string | null;
  expiresOn: string;
  leadDays: number;
  state: DocumentState;
  supersededById: string | null;
  /** Earlier terms, newest first: renewing keeps the old one (D172). */
  history: Array<{ id: string; expiresOn: string }>;
  documents: AttachmentRef[];
  rowVersion: number;
};

/** One row of the paperwork library (D39, D155). */
export type PaperworkRow = {
  attachment: AttachmentRef;
  subject: SubjectRef;
  expiring?: { id: string; kind: DocumentKind; expiresOn: string; state: DocumentState };
  /** A matching line of the file's text; a receipt's needs the money gate (step-3 Q19). */
  snippet?: string;
};
export type PaperworkParams = {
  q?: string;
  locationId?: string;
  role?: string;
  subjectType?: 'thing' | 'place' | 'location';
  expiry?: 'any' | 'expiring' | 'expired';
  cursor?: string;
};

/** GET /api/v1/documents (one: GET /api/v1/documents/:id → ExpiringDocument). */
export type DocumentsParams = {
  locationId?: string;
  kind?: DocumentKind;
  subjectType?: 'thing' | 'place' | 'location';
  /** One subject's documents: a thing's or place's id, or a location's (its own, D155). */
  subjectId?: string;
  state?: DocumentState;
  includeSuperseded?: boolean;
  cursor?: string;
};
/** POST /api/v1/documents. Module `paperwork`, `things.edit`. */
export type CreateDocumentBody = {
  id?: string;
  subject: SubjectInput;
  kind: DocumentKind;
  title?: string;
  expiresOn: string;
  leadDays?: number;
};
/** PATCH /api/v1/documents/:id (proposed). */
export type UpdateDocumentBody = {
  kind?: DocumentKind;
  title?: string | null;
  expiresOn?: string;
  leadDays?: number;
};
/** POST /api/v1/documents/:id/renew: a new row; the old one superseded (D172). */
export type RenewDocumentBody = { id?: string; expiresOn: string; leadDays?: number };
export type RenewDocumentResult = { renewed: ExpiringDocument; previous: ExpiringDocument };

// ----- the agenda (T13) -------------------------------------------------------------------------

export type AgendaAction = 'complete' | 'snooze' | 'mark_returned' | 'renew' | 'open';

export type AgendaItem = {
  /** `${sourceType}:${sourceId}:${kind}:${duePeriod}`, stable. */
  key: string;
  sourceType: ActiveSourceType;
  sourceId: string;
  kind: OccurrenceKind;
  state: AgendaState;
  locationId: string;
  subject: SubjectRef;
  /** The schedule's name, the warranty's provider or kind, the document's title or kind. */
  title: string;
  dueOn: string | null;
  dueValue: string | null;
  unit: string | null;
  /** By source and role. */
  actions: AgendaAction[];
};
/** GET /api/v1/agenda. The Expiring screen reads `sourceType=warranty,document,thing_expiry`. */
export type AgendaParams = {
  state?: 'due' | 'overdue' | 'expiring' | 'upcoming';
  sourceType?: ActiveSourceType | ActiveSourceType[];
  locationId?: string;
  from?: string;
  to?: string;
  cursor?: string;
};
export type AgendaPage = Page<AgendaItem> & {
  counts: { overdue: number; due: number; expiring: number };
};

// ----- channels and preferences (T15) ----------------------------------------------------------

export type Channel = {
  id: string;
  kind: 'email' | 'webpush' | 'webhook';
  label: string | null;
  /** A webhook's host only: its URL is never returned after it's made. */
  displayHost: string | null;
  verifiedAt: string | null;
  failingSince: string | null;
  /** The devices of a webpush channel. */
  subscriptions?: Array<{
    id: string;
    label: string | null;
    createdAt: string;
    lastSuccessAt: string | null;
  }>;
};

/** One kind in one location: per channel, and whether that's the default (Q8, Q10). */
export type KindPreference = {
  inapp: boolean;
  email: boolean;
  webpush: boolean;
  webhook: boolean;
  isDefault: boolean;
};

/** GET /api/v1/me/notification-settings. Viewers' locations list only `membership` (Q8). */
export type NotificationSettings = {
  timezone: string;
  /** HH:MM in `timezone` (default 08:00, Q9). */
  digestTime: string;
  quietFrom: string | null;
  quietTo: string | null;
  smtpConfigured: boolean;
  push: { available: boolean; publicKey: string | null; reason?: 'no_https' | 'no_subject' };
  channels: Channel[];
  locations: Array<{
    locationId: string;
    name: string;
    role: Role;
    kinds: Partial<Record<NotifyKind, KindPreference>>;
  }>;
  account: { aiSummary: { email: boolean } };
};
/** PUT /api/v1/me/notification-settings: both quiet ends or neither. */
export type PutNotificationSettingsBody = {
  digestTime?: string;
  quietFrom?: string | null;
  quietTo?: string | null;
};
/** PUT /api/v1/me/notification-preferences. A value equal to the default deletes the row. */
export type PutPreferencesBody = {
  /** At most 200. `locationId` null only for account-level kinds (`ai_summary`, Q35). */
  items: Array<{
    locationId: string | null;
    kind: NotifyKind;
    channel: PreferenceChannel;
    enabled: boolean;
  }>;
};
/** POST /api/v1/me/channels. At most 5. */
export type CreateChannelBody = { kind: 'webhook'; url: string; label?: string };
/** 201: the signing secret, shown **once**. */
export type CreatedChannel = { channel: Channel; secret: string };
/** POST /api/v1/me/channels/:id/test (5 an hour) · /me/push-subscriptions/:id/test. */
export type ChannelTestResult = { ok: boolean; status?: number; error?: string };
/** POST /api/v1/me/push-subscriptions: the same endpoint again updates it. */
export type CreatePushSubscriptionBody = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  label?: string;
};

// ----- the notification centre (T16) -----------------------------------------------------------

export type Notification = {
  id: string;
  kind: NotificationKind;
  createdAt: string;
  readAt: string | null;
  locationId: string | null;
  reminder?: {
    occurrenceId: string;
    sourceType: ActiveSourceType;
    sourceId: string;
    kind: OccurrenceKind;
    dueOn: string | null;
    dueValue: string | null;
    state: OccurrenceState;
    subject: SubjectRef;
    title: string;
    actions: AgendaAction[];
  };
  membership?: { userName: string; role: Role; locationName: string };
  aiCap?: { scope: AiScope; level: 80 | 100; month: string };
  exportReady?: {
    runId: string;
    /** A claim pack or insurance report (step 4), or a Kept export: a location's, or `me`. */
    kind: 'claim_pack' | 'insurance_report' | 'location' | 'me';
  };
};
/** GET /api/v1/notifications. */
export type NotificationsParams = {
  unread?: boolean;
  kind?: NotificationKind;
  locationId?: string;
  cursor?: string;
};
export type NotificationsPage = Page<Notification> & { unread: number };
/** GET /api/v1/notifications/count: the bell. */
export type NotificationCount = { unread: number };
/** POST /api/v1/notifications/read: some (at most 200), or all. */
export type ReadNotificationsBody = { ids: string[] } | { all: true };

// ----- the calendar feed (T17) -----------------------------------------------------------------

export type CalendarFeed = {
  id: string;
  createdAt: string;
  lastFetchedAt: string | null;
  fetches: number;
  revokedAt: string | null;
};
/** GET /api/v1/me/calendar-feeds. */
export type CalendarFeedsResponse = { items: CalendarFeed[] };
/** POST /api/v1/me/calendar-feeds → 201: the URL, shown **once**. At most 3 live. */
export type CreatedCalendarFeed = { id: string; url: string };

// ----- incidents, the insurance report and claim packs (T18) -----------------------------------

export type IncidentLifecycle = 'stolen' | 'destroyed' | 'lost';

/** GET /api/v1/incidents (proposed). */
export type IncidentRow = {
  id: string;
  locationId: string;
  kind: IncidentKind;
  occurredOn: string;
  policeReference: string | null;
  insurerReference: string | null;
  thingCount: number;
  claimCount: number;
  rowVersion: number;
};
/** GET /api/v1/incidents/:id (proposed): the row, its things, claims, documents and notes. */
export type Incident = IncidentRow & {
  notes: string | null;
  things: ThingRow[];
  claims: Array<{ id: string; thingId: string; status: ClaimStatus; reference: string | null }>;
  documents: AttachmentRef[];
  createdBy: ActorRef;
};
export type IncidentsParams = { locationId?: string; kind?: IncidentKind; cursor?: string };
/** POST /api/v1/locations/:id/incidents. `incidents.manage` (owner, admin). */
export type CreateIncidentBody = {
  id?: string;
  kind: IncidentKind;
  occurredOn: string;
  policeReference?: string;
  insurerReference?: string;
  notes?: string;
  /** At most 200. */
  thingIds?: string[];
  lifecycle?: IncidentLifecycle;
};
/** PATCH /api/v1/incidents/:id (proposed). */
export type UpdateIncidentBody = {
  kind?: IncidentKind;
  occurredOn?: string;
  policeReference?: string | null;
  insurerReference?: string | null;
  notes?: string | null;
};
/** POST /api/v1/incidents/:id/things. */
export type IncidentThingsBody = {
  add?: string[];
  remove?: string[];
  lifecycle?: IncidentLifecycle;
};

/** POST /api/v1/reports/insurance → 202 (as the inventory report, 5 an hour). */
export type InsuranceReportBody = {
  scope: { locationId: string } | { incidentId: string };
  /** YYYY-MM-DD; default today (Q20). */
  asOf?: string;
  /** Needs a rate for every pair, else 409 `rate_missing` with `missing` (Q21). */
  reportCurrency?: string;
  include?: { photos?: boolean };
  locale?: 'en' | 'ar' | 'fr' | 'de' | 'it';
  digits?: 'western' | 'eastern';
};
export type InsuranceReportCreated = ReportCreated;
/** The 409 `rate_missing` body's extra field. */
export type RateMissing = { missing: Array<{ from: string; to: string }> };
/** GET /api/v1/reports/insurance.csv (a link, not a fetch). */
export type InsuranceCsvParams = ({ locationId: string } | { incidentId: string }) & {
  asOf?: string;
};

/** POST /api/v1/claim-packs. Without `acknowledged` → 400 (D158). */
export type CreateClaimPackBody = {
  scope: { incidentId: string } | { locationId: string; thingIds: string[] };
  locale?: 'en' | 'ar' | 'fr' | 'de' | 'it';
  digits?: 'western' | 'eastern';
  acknowledged: true;
};
export type ClaimPackCreated = { id: string; status: ExportRunStatus };
/** GET /api/v1/claim-packs/:id (the creator only). */
export type ClaimPack = {
  id: string;
  status: ExportRunStatus;
  progress: { done: number; total: number };
  bytes?: number;
  error?: string;
  link: { expiresAt: string; downloads: number; lastDownloadedAt: string | null } | null;
  expiresAt: string;
};
/** POST /api/v1/claim-packs/:id/link: a new token, the previous one revoked; shown **once**. */
export type ClaimPackLinkBody = { days?: number };
export type ClaimPackLink = { url: string; expiresAt: string };
