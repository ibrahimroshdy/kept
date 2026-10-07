/**
 * Step-4 fetchers, query keys and hooks, over the contract in ./types.ts and the paths in
 * ./paths.ts. Keys are factories under one prefix per area (`householdKeys.loans.*`,
 * `householdKeys.schedules.*`, …) so a mutation invalidates by prefix; every record that shows on
 * the thing page also sits under `householdKeys.thing(id)`, so one invalidation refreshes the
 * page's sections. Lists follow the list standard (L88): `useInfiniteQuery` over `next_cursor`.
 *
 * Writes are fetchers on `householdApi` for the screens to wrap in `useMutation`. An undoable
 * write (plan Phase B's "undoable" rows, D150) goes through `written`/`requestWritten`, so its
 * result carries `auditEvents` for the Undo toast; creates are not undoable (§7.7). The undo
 * route itself is step 2's (`inventoryApi.undo`).
 */
import { isErrorCode } from '@kept/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ApiError, api, ifMatch, requestWritten, type Written, written } from '../client';
import { qs } from '../inventory/paths';
import { nextCursor } from '../inventory/queries';
import { householdPaths as p } from './paths';
import type {
  AgendaPage,
  AgendaParams,
  BorrowBody,
  BorrowResult,
  BrandLogo,
  CalendarFeedsResponse,
  ChannelTestResult,
  Claim,
  ClaimPack,
  ClaimPackCreated,
  ClaimPackLink,
  ClaimPackLinkBody,
  ClaimPrefill,
  ClaimsResponse,
  CompleteScheduleBody,
  CompleteScheduleResult,
  CreateChannelBody,
  CreateClaimBody,
  CreateClaimPackBody,
  CreateDocumentBody,
  CreatedCalendarFeed,
  CreatedChannel,
  CreateIncidentBody,
  CreateLoanAttachmentBody,
  CreatePushSubscriptionBody,
  CreateScheduleBody,
  CreateServiceRecordBody,
  CreateValuationBody,
  CreateWarrantyBody,
  DocumentsParams,
  ExpiringDocument,
  FxRate,
  FxRatesParams,
  FxRatesResponse,
  Incident,
  IncidentRow,
  IncidentsParams,
  IncidentThingsBody,
  InsuranceCsvParams,
  InsuranceReportBody,
  InsuranceReportCreated,
  LendBody,
  LendResult,
  Loan,
  LoansPage,
  LoansParams,
  NotificationCount,
  NotificationSettings,
  NotificationsPage,
  NotificationsParams,
  Page,
  PaperworkParams,
  PaperworkRow,
  PersonLoans,
  PutFxRateBody,
  PutNotificationSettingsBody,
  PutPreferencesBody,
  ReadNotificationsBody,
  RenewDocumentBody,
  RenewDocumentResult,
  ReturnBody,
  ReturnResult,
  Schedule,
  SchedulesPage,
  SchedulesParams,
  ServiceRecord,
  ServiceRecordsPage,
  SnoozeBody,
  SubjectSchedulesResponse,
  ThingLoansResponse,
  UpdateClaimBody,
  UpdateDocumentBody,
  UpdateIncidentBody,
  UpdateLoanBody,
  UpdateScheduleBody,
  UpdateServiceRecordBody,
  UpdateValuationBody,
  UpdateWarrantyBody,
  Valuation,
  ValuationsResponse,
  WarrantiesResponse,
  Warranty,
  WarrantyDefaults,
} from './types';

export const householdKeys = {
  /** Every step-4 record on one thing (valuations, warranties, claims, loans, schedules, …). */
  thing: (thingId: string) => ['household', 'thing', thingId] as const,
  place: (placeId: string) => ['household', 'place', placeId] as const,
  fx: {
    all: ['fx-rates'] as const,
    list: (accountId: string, params: FxRatesParams = {}) =>
      ['fx-rates', accountId, params] as const,
  },
  valuations: (thingId: string) => ['household', 'thing', thingId, 'valuations'] as const,
  warranties: (thingId: string) => ['household', 'thing', thingId, 'warranties'] as const,
  warrantyDefaults: (thingId: string) =>
    ['household', 'thing', thingId, 'warranty-defaults'] as const,
  claims: (thingId: string) => ['household', 'thing', thingId, 'claims'] as const,
  claimPrefill: (thingId: string) => ['household', 'thing', thingId, 'claim-prefill'] as const,
  loans: {
    all: ['loans'] as const,
    list: (params: LoansParams = {}) => ['loans', 'list', params] as const,
    thing: (thingId: string) => ['household', 'thing', thingId, 'loans'] as const,
    person: (personId: string) => ['loans', 'person', personId] as const,
  },
  schedules: {
    all: ['schedules'] as const,
    list: (params: SchedulesParams = {}) => ['schedules', 'list', params] as const,
    thing: (thingId: string) => ['household', 'thing', thingId, 'schedules'] as const,
    place: (placeId: string) => ['household', 'place', placeId, 'schedules'] as const,
  },
  serviceRecords: {
    thing: (thingId: string) => ['household', 'thing', thingId, 'service-records'] as const,
    place: (placeId: string) => ['household', 'place', placeId, 'service-records'] as const,
  },
  paperwork: {
    all: ['paperwork'] as const,
    list: (params: PaperworkParams = {}) => ['paperwork', 'list', params] as const,
  },
  documents: {
    all: ['documents'] as const,
    list: (params: DocumentsParams = {}) => ['documents', 'list', params] as const,
    one: (id: string) => ['documents', 'one', id] as const,
  },
  agenda: {
    all: ['agenda'] as const,
    list: (params: AgendaParams = {}) => ['agenda', 'list', params] as const,
  },
  notifications: {
    all: ['notifications'] as const,
    list: (params: NotificationsParams = {}) => ['notifications', 'list', params] as const,
    count: ['notifications', 'count'] as const,
  },
  notificationSettings: ['notification-settings'] as const,
  calendarFeeds: ['calendar-feeds'] as const,
  incidents: {
    all: ['incidents'] as const,
    list: (params: IncidentsParams = {}) => ['incidents', 'list', params] as const,
    one: (id: string) => ['incidents', 'one', id] as const,
  },
  claimPack: (id: string) => ['claim-pack', id] as const,
};
const k = householdKeys;

/** The error a multipart upload answers with (the client's own shape; as capture's putDisplay). */
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

/** A DELETE that sends If-Match and keeps the undoable audit events it recorded. */
const delWritten = (path: string, rowVersion?: number) =>
  requestWritten<void>(path, { method: 'DELETE', headers: ifMatch(rowVersion) ?? {} });

// ----- fetchers --------------------------------------------------------------------------------

export const householdApi = {
  // money (T8)
  fxRates: (accountId: string, params: FxRatesParams = {}) =>
    api.get<FxRatesResponse>(p.fxRates(accountId) + qs(params)),
  /** Undoable (the previous rate back, or deleted). Replacing an existing rate needs If-Match. */
  putFxRate: (accountId: string, body: PutFxRateBody, rowVersion?: number) =>
    requestWritten<FxRate>(p.fxRates(accountId), {
      method: 'PUT',
      body,
      headers: ifMatch(rowVersion) ?? {},
    }),
  deleteFxRate: (accountId: string, rate: FxRate) =>
    delWritten(p.fxRate(accountId, rate.fromCcy, rate.toCcy, rate.validFrom), rate.rowVersion),
  valuations: (thingId: string) => api.get<ValuationsResponse>(p.thingValuations(thingId)),
  createValuation: (thingId: string, body: CreateValuationBody) =>
    api.post<Valuation>(p.thingValuations(thingId), body),
  updateValuation: (id: string, body: UpdateValuationBody, rowVersion: number) =>
    written.patch<Valuation>(p.valuation(id), body, ifMatch(rowVersion)),
  deleteValuation: (id: string, rowVersion: number) => delWritten(p.valuation(id), rowVersion),

  // warranties, claims and brand logos (T9)
  warranties: (thingId: string) => api.get<WarrantiesResponse>(p.thingWarranties(thingId)),
  warrantyDefaults: (thingId: string) =>
    api.get<WarrantyDefaults>(p.thingWarrantyDefaults(thingId)),
  createWarranty: (thingId: string, body: CreateWarrantyBody) =>
    api.post<Warranty>(p.thingWarranties(thingId), body),
  updateWarranty: (id: string, body: UpdateWarrantyBody, rowVersion: number) =>
    written.patch<Warranty>(p.warranty(id), body, ifMatch(rowVersion)),
  deleteWarranty: (id: string, rowVersion: number) => delWritten(p.warranty(id), rowVersion),
  claims: (thingId: string) => api.get<ClaimsResponse>(p.thingClaims(thingId)),
  claimPrefill: (thingId: string) => api.get<ClaimPrefill>(p.thingClaimPrefill(thingId)),
  createClaim: (thingId: string, body: CreateClaimBody) =>
    api.post<Claim>(p.thingClaims(thingId), body),
  updateClaim: (id: string, body: UpdateClaimBody, rowVersion: number) =>
    written.patch<Claim>(p.claim(id), body, ifMatch(rowVersion)),
  deleteClaim: (id: string, rowVersion: number) => delWritten(p.claim(id), rowVersion),
  /** The image itself as the body, ≤ 2 MB: PNG, JPEG, WebP or SVG (told by its bytes); 415
   * otherwise. The server keeps a PNG of at most 256 px a side. */
  putBrandLogo: async (brandId: string, file: Blob): Promise<BrandLogo> => {
    let res: Response;
    try {
      res = await fetch(p.brandLogo(brandId), {
        method: 'PUT',
        credentials: 'include',
        headers: {
          accept: 'application/json',
          'content-type': file.type || 'application/octet-stream',
        },
        body: file,
      });
    } catch {
      throw new ApiError(0, 'offline', 'Needs a connection');
    }
    if (!res.ok) throw await uploadError(res);
    return (await res.json()) as BrandLogo;
  },
  deleteBrandLogo: (brandId: string) => api.del(p.brandLogo(brandId)),

  // lending and borrowing (T10)
  lend: (thingId: string, body: LendBody) => api.post<LendResult>(p.thingLend(thingId), body),
  borrow: (locationId: string, body: BorrowBody) =>
    api.post<BorrowResult>(p.locationBorrow(locationId), body),
  /** Undoable: reopens the loan and moves the thing back (un-merging it when it merged). */
  returnLoan: (id: string, body: ReturnBody, rowVersion: number) =>
    written.post<ReturnResult>(p.loanReturn(id), body, ifMatch(rowVersion)),
  updateLoan: (id: string, body: UpdateLoanBody, rowVersion: number) =>
    written.patch<Loan>(p.loan(id), body, ifMatch(rowVersion)),
  deleteLoan: (id: string, rowVersion: number) => delWritten(p.loan(id), rowVersion),
  loans: (params: LoansParams = {}) => api.get<LoansPage>(p.loans + qs(params)),
  thingLoans: (thingId: string) => api.get<ThingLoansResponse>(p.thingLoans(thingId)),
  personLoans: (personId: string, cursor?: string) =>
    api.get<PersonLoans>(p.personLoans(personId) + qs({ cursor })),
  addLoanAttachment: (loanId: string, body: CreateLoanAttachmentBody) =>
    api.post<unknown>(p.loanAttachments(loanId), body),

  // schedules and service records (T11)
  schedules: (params: SchedulesParams = {}) => api.get<SchedulesPage>(p.schedules + qs(params)),
  thingSchedules: (thingId: string) => api.get<SubjectSchedulesResponse>(p.thingSchedules(thingId)),
  placeSchedules: (placeId: string) => api.get<SubjectSchedulesResponse>(p.placeSchedules(placeId)),
  createSchedule: (body: CreateScheduleBody) => api.post<Schedule>(p.schedules, body),
  updateSchedule: (id: string, body: UpdateScheduleBody, rowVersion: number) =>
    written.patch<Schedule>(p.schedule(id), body, ifMatch(rowVersion)),
  deleteSchedule: (id: string, rowVersion: number) => delWritten(p.schedule(id), rowVersion),
  /** Undoable: deletes the service record (and its reading); the anchor falls back. */
  completeSchedule: (id: string, body: CompleteScheduleBody, rowVersion: number) =>
    written.post<CompleteScheduleResult>(p.scheduleComplete(id), body, ifMatch(rowVersion)),
  snoozeSchedule: (id: string, body: SnoozeBody, rowVersion: number) =>
    written.post<Schedule>(p.scheduleSnooze(id), body, ifMatch(rowVersion)),
  skipSchedule: (id: string, rowVersion: number) =>
    written.post<Schedule>(p.scheduleSkip(id), {}, ifMatch(rowVersion)),
  unsnoozeSchedule: (id: string, rowVersion: number) =>
    written.post<Schedule>(p.scheduleUnsnooze(id), {}, ifMatch(rowVersion)),
  thingServiceRecords: (thingId: string, cursor?: string) =>
    api.get<ServiceRecordsPage>(p.thingServiceRecords(thingId) + qs({ cursor })),
  placeServiceRecords: (placeId: string, cursor?: string) =>
    api.get<ServiceRecordsPage>(p.placeServiceRecords(placeId) + qs({ cursor })),
  createServiceRecord: (body: CreateServiceRecordBody) =>
    written.post<ServiceRecord>(p.serviceRecords, body),
  updateServiceRecord: (id: string, body: UpdateServiceRecordBody, rowVersion: number) =>
    written.patch<ServiceRecord>(p.serviceRecord(id), body, ifMatch(rowVersion)),
  deleteServiceRecord: (id: string, rowVersion: number) =>
    delWritten(p.serviceRecord(id), rowVersion),

  // the paperwork library and expiring documents (T12)
  paperwork: (params: PaperworkParams = {}) =>
    api.get<Page<PaperworkRow>>(p.paperwork + qs(params)),
  documents: (params: DocumentsParams = {}) =>
    api.get<Page<ExpiringDocument>>(
      p.documents +
        qs({
          ...params,
          includeSuperseded:
            params.includeSuperseded === undefined ? undefined : params.includeSuperseded ? 1 : 0,
        }),
    ),
  document: (id: string) => api.get<ExpiringDocument>(p.document(id)),
  createDocument: (body: CreateDocumentBody) => api.post<ExpiringDocument>(p.documents, body),
  updateDocument: (id: string, body: UpdateDocumentBody, rowVersion: number) =>
    written.patch<ExpiringDocument>(p.document(id), body, ifMatch(rowVersion)),
  deleteDocument: (id: string, rowVersion: number) => delWritten(p.document(id), rowVersion),
  /** Undoable: removes the new row and un-supersedes the old one. */
  renewDocument: (id: string, body: RenewDocumentBody, rowVersion: number) =>
    written.post<RenewDocumentResult>(p.documentRenew(id), body, ifMatch(rowVersion)),

  // the agenda (T13)
  agenda: (params: AgendaParams = {}) => {
    const { sourceType, ...rest } = params;
    const types = sourceType === undefined ? undefined : [sourceType].flat().join(',');
    return api.get<AgendaPage>(p.agenda + qs({ ...rest, sourceType: types }));
  },

  // channels and preferences (T15)
  notificationSettings: () => api.get<NotificationSettings>(p.notificationSettings),
  putNotificationSettings: (body: PutNotificationSettingsBody) =>
    api.put<NotificationSettings>(p.notificationSettings, body),
  putPreferences: (body: PutPreferencesBody) =>
    api.put<NotificationSettings>(p.notificationPreferences, body),
  createChannel: (body: CreateChannelBody) => api.post<CreatedChannel>(p.channels, body),
  deleteChannel: (id: string) => api.del(p.channel(id)),
  testChannel: (id: string) => api.post<ChannelTestResult>(p.channelTest(id)),
  createPushSubscription: (body: CreatePushSubscriptionBody) =>
    api.post<{ id: string }>(p.pushSubscriptions, body),
  deletePushSubscription: (id: string) => api.del(p.pushSubscription(id)),
  testPushSubscription: (id: string) => api.post<ChannelTestResult>(p.pushSubscriptionTest(id)),

  // the notification centre (T16)
  notifications: (params: NotificationsParams = {}) =>
    api.get<NotificationsPage>(
      p.notifications +
        qs({ ...params, unread: params.unread === undefined ? undefined : params.unread ? 1 : 0 }),
    ),
  notificationCount: () => api.get<NotificationCount>(p.notificationsCount),
  readNotifications: (body: ReadNotificationsBody) =>
    api.post<NotificationCount>(p.notificationsRead, body),

  // the calendar feed (T17)
  calendarFeeds: () => api.get<CalendarFeedsResponse>(p.calendarFeeds),
  createCalendarFeed: () => api.post<CreatedCalendarFeed>(p.calendarFeeds),
  revokeCalendarFeed: (id: string) => api.del(p.calendarFeed(id)),

  // incidents, the insurance report and claim packs (T18)
  incidents: (params: IncidentsParams = {}) => api.get<Page<IncidentRow>>(p.incidents + qs(params)),
  incident: (id: string) => api.get<Incident>(p.incident(id)),
  createIncident: (locationId: string, body: CreateIncidentBody) =>
    api.post<Incident>(p.locationIncidents(locationId), body),
  updateIncident: (id: string, body: UpdateIncidentBody, rowVersion: number) =>
    written.patch<Incident>(p.incident(id), body, ifMatch(rowVersion)),
  deleteIncident: (id: string, rowVersion: number) => delWritten(p.incident(id), rowVersion),
  incidentThings: (id: string, body: IncidentThingsBody, rowVersion: number) =>
    written.post<Incident>(p.incidentThings(id), body, ifMatch(rowVersion)),
  /** Poll with inventoryApi.report(id): the step-2 route, now for either kind. */
  insuranceReport: (body: InsuranceReportBody) =>
    api.post<InsuranceReportCreated>(p.reportsInsurance, body),
  /** The CSV download's URL (a link, not a fetch). */
  insuranceCsvUrl: (params: InsuranceCsvParams) => p.reportsInsuranceCsv + qs(params),
  createClaimPack: (body: CreateClaimPackBody) => api.post<ClaimPackCreated>(p.claimPacks, body),
  claimPack: (id: string) => api.get<ClaimPack>(p.claimPack(id)),
  createClaimPackLink: (id: string, body: ClaimPackLinkBody = {}) =>
    api.post<ClaimPackLink>(p.claimPackLink(id), body),
  revokeClaimPackLink: (id: string) => api.del(p.claimPackLink(id)),
};

/** What an undoable write answers: its body, and the audit events the Undo toast undoes. */
export type HouseholdWritten<T> = Written<T>;

// ----- hooks -----------------------------------------------------------------------------------

export const useFxRates = (accountId: string, params: FxRatesParams = {}) =>
  useQuery({
    queryKey: k.fx.list(accountId, params),
    queryFn: () => householdApi.fxRates(accountId, params),
    enabled: !!accountId,
  });

export const useValuations = (thingId: string) =>
  useQuery({
    queryKey: k.valuations(thingId),
    queryFn: () => householdApi.valuations(thingId),
    enabled: !!thingId,
  });

export const useWarranties = (thingId: string) =>
  useQuery({
    queryKey: k.warranties(thingId),
    queryFn: () => householdApi.warranties(thingId),
    enabled: !!thingId,
  });
export const useWarrantyDefaults = (thingId: string, enabled = true) =>
  useQuery({
    queryKey: k.warrantyDefaults(thingId),
    queryFn: () => householdApi.warrantyDefaults(thingId),
    enabled: enabled && !!thingId,
  });
export const useClaims = (thingId: string) =>
  useQuery({
    queryKey: k.claims(thingId),
    queryFn: () => householdApi.claims(thingId),
    enabled: !!thingId,
  });
export const useClaimPrefill = (thingId: string, enabled = true) =>
  useQuery({
    queryKey: k.claimPrefill(thingId),
    queryFn: () => householdApi.claimPrefill(thingId),
    enabled: enabled && !!thingId,
  });

/** The Lending screen: `counts` ride on every page (take them from the first). */
export const useLoans = (params: LoansParams = {}, enabled = true) =>
  useInfiniteQuery({
    queryKey: k.loans.list(params),
    queryFn: ({ pageParam }) =>
      householdApi.loans({ ...params, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
    enabled,
  });
export const useThingLoans = (thingId: string) =>
  useQuery({
    queryKey: k.loans.thing(thingId),
    queryFn: () => householdApi.thingLoans(thingId),
    enabled: !!thingId,
  });
export const usePersonLoans = (personId: string) =>
  useInfiniteQuery({
    queryKey: k.loans.person(personId),
    queryFn: ({ pageParam }) => householdApi.personLoans(personId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: PersonLoans) => last.next_cursor ?? undefined,
    enabled: !!personId,
  });

export const useSchedules = (params: SchedulesParams = {}) =>
  useInfiniteQuery({
    queryKey: k.schedules.list(params),
    queryFn: ({ pageParam }) =>
      householdApi.schedules({ ...params, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });
/** A thing's or a place's schedules (the thing page's section, the place page's). */
export const useSubjectSchedules = (subject: { thingId: string } | { placeId: string }) =>
  useQuery({
    queryKey:
      'thingId' in subject
        ? k.schedules.thing(subject.thingId)
        : k.schedules.place(subject.placeId),
    queryFn: () =>
      'thingId' in subject
        ? householdApi.thingSchedules(subject.thingId)
        : householdApi.placeSchedules(subject.placeId),
  });
export const useServiceRecords = (subject: { thingId: string } | { placeId: string }) =>
  useInfiniteQuery({
    queryKey:
      'thingId' in subject
        ? k.serviceRecords.thing(subject.thingId)
        : k.serviceRecords.place(subject.placeId),
    queryFn: ({ pageParam }) =>
      'thingId' in subject
        ? householdApi.thingServiceRecords(subject.thingId, pageParam)
        : householdApi.placeServiceRecords(subject.placeId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });

export const usePaperwork = (params: PaperworkParams = {}) =>
  useInfiniteQuery({
    queryKey: k.paperwork.list(params),
    queryFn: ({ pageParam }) =>
      householdApi.paperwork({ ...params, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });
export const useDocuments = (params: DocumentsParams = {}) =>
  useInfiniteQuery({
    queryKey: k.documents.list(params),
    queryFn: ({ pageParam }) =>
      householdApi.documents({ ...params, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });

/** One expiring document (Renew from a link, D172). */
export const useDocument = (id: string) =>
  useQuery({
    queryKey: k.documents.one(id),
    queryFn: () => householdApi.document(id),
    enabled: !!id,
  });

/** The agenda (Expiring, Home's rows' lists): `counts` ride on every page. */
export const useAgenda = (params: AgendaParams = {}, enabled = true) =>
  useInfiniteQuery({
    queryKey: k.agenda.list(params),
    queryFn: ({ pageParam }) =>
      householdApi.agenda({ ...params, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
    enabled,
  });

export const useNotificationSettings = () =>
  useQuery({ queryKey: k.notificationSettings, queryFn: householdApi.notificationSettings });

export const useNotifications = (params: NotificationsParams = {}) =>
  useInfiniteQuery({
    queryKey: k.notifications.list(params),
    queryFn: ({ pageParam }) =>
      householdApi.notifications({ ...params, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });
/** How often the shell's counts are read again while the app is open and visible (T24). */
export const COUNTS_POLL_MS = 60_000;

/**
 * The bell's unread count, and the rail's badge (D198): a cheap index scan on the server. Read
 * again every minute while the page is visible (never in the background) and whenever the window
 * regains focus, so a reminder the scan just made shows without a reload.
 */
export const useNotificationCount = (enabled = true) =>
  useQuery({
    queryKey: k.notifications.count,
    queryFn: householdApi.notificationCount,
    enabled,
    refetchOnWindowFocus: true,
    refetchInterval: COUNTS_POLL_MS,
    refetchIntervalInBackground: false,
  });

export const useCalendarFeeds = () =>
  useQuery({ queryKey: k.calendarFeeds, queryFn: householdApi.calendarFeeds });

export const useIncidents = (params: IncidentsParams = {}) =>
  useInfiniteQuery({
    queryKey: k.incidents.list(params),
    queryFn: ({ pageParam }) =>
      householdApi.incidents({ ...params, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });
export const useIncident = (id: string) =>
  useQuery({
    queryKey: k.incidents.one(id),
    queryFn: () => householdApi.incident(id),
    enabled: !!id,
  });

/** A claim pack's run, polled while it builds (`refetchInterval` from the caller). */
export const useClaimPack = (id: string, refetchInterval: number | false = false) =>
  useQuery({
    queryKey: k.claimPack(id),
    queryFn: () => householdApi.claimPack(id),
    enabled: !!id,
    refetchInterval,
  });
