/**
 * Step-5 fetchers, query keys and hooks, over the contract in ./types.ts and the paths in
 * ./paths.ts (new routes) and step 2's and step 4's paths (routes that gain fields). Keys sit under
 * `householdKeys.thing(id)` where the record shows on the thing page, so one invalidation refreshes
 * a vehicle's tabs; the vehicles list has its own prefix. Lists follow the list standard (L88):
 * `useInfiniteQuery` over `next_cursor`.
 *
 * Writes are fetchers on `vehiclesApi` for the screens to wrap in `useMutation`. An undoable write
 * (a reading, a fill, starter schedules) goes through `written`, so its result carries
 * `auditEvents` for the Undo toast as well as the body's `undo`. Money needs a connection: none of
 * this is queued offline, except a reading, which goes through the step-3 queue (`log_reading`,
 * T19), not through here.
 */
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, ifMatch, requestWritten, written } from '../client';
import { householdPaths } from '../household/paths';
import { householdKeys } from '../household/queries';
import { inventoryPaths, qs } from '../inventory/paths';
import { inventoryKeys, nextCursor } from '../inventory/queries';
import { vehiclePaths as p } from './paths';
import type {
  ConfirmServiceBody,
  CostReport,
  CostsParams,
  CreateDocumentBodyV5,
  CreateFuelBody,
  CreateFuelResult,
  CreateReadingBodyV5,
  CreateReadingResultV5,
  CreateServiceDraftBody,
  CreateServiceDraftResult,
  DeleteFuelResult,
  DocumentsParamsV5,
  ExpiringDocumentV5,
  FuelPage,
  FuelParams,
  FuelRow,
  FuelSummary,
  FuelSummaryParams,
  HomeResponseV5,
  MeterSeries,
  Page,
  ProofsPage,
  ReadingRow,
  ReadingsParams,
  RenewDocumentBodyV5,
  SeriesParams,
  ServiceRecordsPageV5,
  ServiceRecordsParams,
  ServiceRecordV5,
  StarterSchedulesBody,
  StarterSchedulesResult,
  UpdateDocumentBodyV5,
  UpdateFuelBody,
  UpdateMeterBodyV5,
  VehicleHistoryReportBody,
  VehicleHistoryReportCreated,
  VehiclesPage,
  VehiclesParams,
} from './types';

export const vehicleKeys = {
  /** Every vehicles-list query (invalidate after anything that changes a row). */
  all: ['vehicles'] as const,
  list: (params: VehiclesParams = {}) => ['vehicles', 'list', params] as const,
  costs: (thingId: string, params: CostsParams = {}) =>
    [...householdKeys.thing(thingId), 'costs', params] as const,
  fuel: (thingId: string, params: FuelParams = {}) =>
    [...householdKeys.thing(thingId), 'fuel', params] as const,
  fuelSummary: (thingId: string, params: FuelSummaryParams = {}) =>
    [...householdKeys.thing(thingId), 'fuel-summary', params] as const,
  serviceRecords: (thingId: string, params: ServiceRecordsParams = {}) =>
    [...householdKeys.serviceRecords.thing(thingId), params] as const,
  serviceRecord: (id: string) => ['service-records', 'one', id] as const,
  documents: (thingId: string) => [...householdKeys.thing(thingId), 'documents'] as const,
  readings: (meterId: string, params: ReadingsParams = {}) =>
    [...inventoryKeys.meters.readings(meterId), params] as const,
  proofs: (meterId: string) => ['meters', meterId, 'proofs'] as const,
  series: (meterId: string, params: SeriesParams = {}) =>
    ['meters', meterId, 'series', params] as const,
};
const k = vehicleKeys;

/** A DELETE that sends If-Match and keeps the undoable audit events it recorded. */
const delWritten = <T>(path: string, rowVersion: number) =>
  requestWritten<T>(path, { method: 'DELETE', headers: ifMatch(rowVersion) ?? {} });

// ----- fetchers --------------------------------------------------------------------------------

export const vehiclesApi = {
  // the vehicles list, costs, series and starter schedules (T13)
  vehicles: (params: VehiclesParams = {}) => api.get<VehiclesPage>(p.vehicles + qs(params)),
  costs: (thingId: string, params: CostsParams = {}) =>
    api.get<CostReport>(p.thingCosts(thingId) + qs(params)),
  series: (meterId: string, params: SeriesParams = {}) =>
    api.get<MeterSeries>(p.meterSeries(meterId) + qs(params)),
  /** Undoable: the schedules it made go. */
  starterSchedules: (thingId: string, body: StarterSchedulesBody = {}) =>
    written.post<StarterSchedulesResult>(p.thingStarterSchedules(thingId), body),
  home: () => api.get<HomeResponseV5>(inventoryPaths.home),

  // meters and readings (T8)
  updateMeter: (meterId: string, body: UpdateMeterBodyV5, rowVersion: number) =>
    written.patch<unknown>(inventoryPaths.meter(meterId), body, ifMatch(rowVersion)),
  readings: (meterId: string, params: ReadingsParams = {}) =>
    api.get<Page<ReadingRow>>(inventoryPaths.meterReadings(meterId) + qs(params)),
  /** Undoable (D150). A backwards value is 409 `conflict`; an implausible jump is `needs_review`
   * unless `confirmJump` ("It's right", Q9). */
  createReading: (meterId: string, body: CreateReadingBodyV5) =>
    written.post<CreateReadingResultV5>(inventoryPaths.meterReadings(meterId), body),
  proofs: (meterId: string, cursor?: string) =>
    api.get<ProofsPage>(p.meterProofs(meterId) + qs({ cursor })),

  // service drafts (T9)
  createServiceDraft: (body: CreateServiceDraftBody, idempotencyKey: string) =>
    api.post<CreateServiceDraftResult>(p.serviceDrafts, body, {
      'idempotency-key': idempotencyKey,
    }),
  confirmService: (id: string, body: ConfirmServiceBody, rowVersion: number) =>
    written.post<ServiceRecordV5>(p.serviceRecordConfirm(id), body, ifMatch(rowVersion)),
  serviceRecord: (id: string) => api.get<ServiceRecordV5>(p.serviceRecord(id)),
  serviceRecords: (thingId: string, params: ServiceRecordsParams = {}) =>
    api.get<ServiceRecordsPageV5>(householdPaths.thingServiceRecords(thingId) + qs(params)),

  // fuel and charging (T11)
  fuel: (thingId: string, params: FuelParams = {}) =>
    api.get<FuelPage>(p.thingFuel(thingId) + qs(params)),
  createFuel: (thingId: string, body: CreateFuelBody, idempotencyKey: string) =>
    written.post<CreateFuelResult>(p.thingFuel(thingId), body, {
      'idempotency-key': idempotencyKey,
    }),
  updateFuel: (id: string, body: UpdateFuelBody, rowVersion: number) =>
    written.patch<FuelRow>(p.fuelEntry(id), body, ifMatch(rowVersion)),
  deleteFuel: (id: string, rowVersion: number) =>
    delWritten<DeleteFuelResult>(p.fuelEntry(id), rowVersion),
  fuelSummary: (thingId: string, params: FuelSummaryParams = {}) =>
    api.get<FuelSummary>(p.thingFuelSummary(thingId) + qs(params)),

  // vehicle documents (T12): step 4's routes with issue dates and costs
  documents: (params: DocumentsParamsV5) =>
    api.get<Page<ExpiringDocumentV5>>(householdPaths.documents + qs(params)),
  createDocument: (body: CreateDocumentBodyV5) =>
    api.post<ExpiringDocumentV5>(householdPaths.documents, body),
  updateDocument: (id: string, body: UpdateDocumentBodyV5, rowVersion: number) =>
    written.patch<ExpiringDocumentV5>(householdPaths.document(id), body, ifMatch(rowVersion)),
  renewDocument: (id: string, body: RenewDocumentBodyV5, rowVersion: number) =>
    written.post<{ renewed: ExpiringDocumentV5; previous: ExpiringDocumentV5 }>(
      householdPaths.documentRenew(id),
      body,
      ifMatch(rowVersion),
    ),

  // the history report (T15): read back through step 2's `reportsApi.run(id)` (../inventory/reports)
  vehicleHistoryReport: (body: VehicleHistoryReportBody) =>
    api.post<VehicleHistoryReportCreated>(p.reportsVehicleHistory, body),
};

// ----- hooks -----------------------------------------------------------------------------------

/** The Vehicles list (`/vehicles`, the `vehicles` surface). */
export const useVehicles = (params: VehiclesParams = {}) =>
  useInfiniteQuery({
    queryKey: k.list(params),
    queryFn: ({ pageParam }) =>
      vehiclesApi.vehicles({ ...params, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });

/** A vehicle's running costs (the Costs tab). */
export const useCosts = (thingId: string, params: CostsParams = {}) =>
  useQuery({
    queryKey: k.costs(thingId, params),
    queryFn: () => vehiclesApi.costs(thingId, params),
  });

/** A meter's series (the Readings tab's chart). */
export const useMeterSeries = (meterId: string, params: SeriesParams = {}) =>
  useQuery({
    queryKey: k.series(meterId, params),
    queryFn: () => vehiclesApi.series(meterId, params),
    enabled: !!meterId,
  });

/** A meter's readings, filtered (the `readings` surface). */
export const useReadings = (meterId: string, params: ReadingsParams = {}) =>
  useInfiniteQuery({
    queryKey: k.readings(meterId, params),
    queryFn: ({ pageParam }) =>
      vehiclesApi.readings(meterId, { ...params, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
    enabled: !!meterId,
  });

/** The odometer proof strip (D195), newest first. */
export const useProofs = (meterId: string) =>
  useInfiniteQuery({
    queryKey: k.proofs(meterId),
    queryFn: ({ pageParam }) => vehiclesApi.proofs(meterId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
    enabled: !!meterId,
  });

/** A vehicle's service records, drafts first (the Services tab, the `services` surface). */
export const useVehicleServiceRecords = (thingId: string, params: ServiceRecordsParams = {}) =>
  useInfiniteQuery({
    queryKey: k.serviceRecords(thingId, params),
    queryFn: ({ pageParam }) =>
      vehiclesApi.serviceRecords(thingId, {
        ...params,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });

/** One service record, a draft's suggestions and extraction included. */
export const useServiceRecord = (id: string) =>
  useQuery({
    queryKey: k.serviceRecord(id),
    queryFn: () => vehiclesApi.serviceRecord(id),
    enabled: !!id,
  });

/** A vehicle's fills and charges (the Fuel tab, the `fuel` surface). */
export const useFuel = (thingId: string, params: FuelParams = {}) =>
  useInfiniteQuery({
    queryKey: k.fuel(thingId, params),
    queryFn: ({ pageParam }) =>
      vehiclesApi.fuel(thingId, { ...params, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });

/** The Fuel tab's summary card and trends. */
export const useFuelSummary = (thingId: string, params: FuelSummaryParams = {}) =>
  useQuery({
    queryKey: k.fuelSummary(thingId, params),
    queryFn: () => vehiclesApi.fuelSummary(thingId, params),
  });

/** A vehicle's documents (the Documents tab). */
export const useVehicleDocuments = (
  thingId: string,
  params: Omit<DocumentsParamsV5, 'thingId'> = {},
) =>
  useInfiniteQuery({
    queryKey: [...k.documents(thingId), params] as const,
    queryFn: ({ pageParam }) =>
      vehiclesApi.documents({ ...params, thingId, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });
