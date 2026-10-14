/**
 * Condition reports' fetchers, keys and hooks (1.x, D235) over ./types.ts and ./paths.ts. Lists
 * follow the list standard: `useInfiniteQuery` over `next_cursor`.
 */
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, ifMatch, requestWritten } from '../client';
import { qs } from '../inventory/paths';
import { nextCursor } from '../inventory/queries';
import type { Page, ReportCreated } from '../inventory/types';
import { conditionPaths as p } from './paths';
import type {
  ConditionPdfBody,
  ConditionReport,
  ConditionReportRow,
  ConditionReportsParams,
  ConditionRoom,
  CreateConditionReportBody,
  CreateConditionRoomBody,
  UpdateConditionReportBody,
  UpdateConditionRoomBody,
} from './types';

export const conditionKeys = {
  all: ['condition-reports'] as const,
  list: (params: ConditionReportsParams = {}) => ['condition-reports', 'list', params] as const,
  one: (id: string) => ['condition-reports', 'one', id] as const,
};

const del = (path: string, rowVersion: number) =>
  requestWritten<void>(path, { method: 'DELETE', headers: ifMatch(rowVersion) ?? {} });

export const conditionApi = {
  list: (params: ConditionReportsParams = {}) =>
    api.get<Page<ConditionReportRow>>(p.reports + qs(params)),
  report: (id: string) => api.get<ConditionReport>(p.report(id)),
  start: (locationId: string, body: CreateConditionReportBody) =>
    api.post<ConditionReport>(p.locationReports(locationId), body),
  update: (id: string, body: UpdateConditionReportBody, rowVersion: number) =>
    api.patch<ConditionReport>(p.report(id), body, ifMatch(rowVersion)),
  finish: (id: string, rowVersion: number) =>
    api.post<ConditionReport>(p.finish(id), {}, ifMatch(rowVersion)),
  remove: (id: string, rowVersion: number) => del(p.report(id), rowVersion),
  addRoom: (reportId: string, body: CreateConditionRoomBody) =>
    api.post<ConditionRoom>(p.rooms(reportId), body),
  updateRoom: (id: string, body: UpdateConditionRoomBody, rowVersion: number) =>
    api.patch<ConditionRoom>(p.room(id), body, ifMatch(rowVersion)),
  removeRoom: (id: string, rowVersion: number) => del(p.room(id), rowVersion),
  pdf: (body: ConditionPdfBody) => api.post<ReportCreated>(p.pdf, body),
};

export const useConditionReports = (params: ConditionReportsParams = {}) =>
  useInfiniteQuery({
    queryKey: conditionKeys.list(params),
    queryFn: ({ pageParam }) =>
      conditionApi.list({ ...params, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });

export const useConditionReport = (id: string | null | undefined) =>
  useQuery({
    queryKey: conditionKeys.one(id ?? ''),
    queryFn: () => conditionApi.report(id ?? ''),
    enabled: !!id,
  });
