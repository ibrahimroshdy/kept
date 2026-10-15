/**
 * Moving mode's fetchers, keys and hooks (1.x, D251) over ./types.ts and ./paths.ts. The list
 * follows the list standard: `useInfiniteQuery` over `next_cursor`. Box writes keep the undoable
 * audit events they recorded (`requestWritten`) for the Undo toast.
 */
import { useInfiniteQuery } from '@tanstack/react-query';
import { api, ifMatch, requestWritten } from '../client';
import { qs } from '../inventory/paths';
import { nextCursor } from '../inventory/queries';
import type { Page, ReportCreated } from '../inventory/types';
import { movingPaths as p } from './paths';
import type {
  AddBoxBody,
  BoxOfContainer,
  ContentsSheetsBody,
  CreateMoveBody,
  Move,
  MoveBox,
  MoveRow,
  MovesParams,
  UnpackBody,
  UpdateBoxBody,
  UpdateMoveBody,
} from './types';

export const movingKeys = {
  all: ['moves'] as const,
  list: (params: MovesParams = {}) => ['moves', 'list', params] as const,
  one: (id: string) => ['moves', 'one', id] as const,
};

export const movingApi = {
  list: (params: MovesParams = {}) => api.get<Page<MoveRow>>(p.moves + qs(params)),
  move: (id: string) => api.get<Move>(p.move(id)),
  start: (locationId: string, body: CreateMoveBody) =>
    api.post<Move>(p.locationMoves(locationId), body),
  update: (id: string, body: UpdateMoveBody, rowVersion: number) =>
    api.patch<Move>(p.move(id), body, ifMatch(rowVersion)),
  remove: (id: string, rowVersion: number) =>
    requestWritten<void>(p.move(id), { method: 'DELETE', headers: ifMatch(rowVersion) ?? {} }),
  addBox: (id: string, body: AddBoxBody) => api.post<MoveBox>(p.boxes(id), body),
  updateBox: (id: string, containerId: string, body: UpdateBoxBody) =>
    requestWritten<MoveBox>(p.box(id, containerId), { method: 'PATCH', body }),
  unpack: (id: string, containerId: string, body: UnpackBody = {}) =>
    requestWritten<MoveBox>(p.unpack(id, containerId), { method: 'POST', body }),
  removeBox: (id: string, containerId: string) =>
    requestWritten<void>(p.box(id, containerId), { method: 'DELETE' }),
  boxOf: (containerId: string) => api.get<BoxOfContainer>(p.boxOf(containerId)),
  sheets: (body: ContentsSheetsBody) => api.post<ReportCreated>(p.sheets, body),
};

export const useMoves = (params: MovesParams = {}) =>
  useInfiniteQuery({
    queryKey: movingKeys.list(params),
    queryFn: ({ pageParam }) =>
      movingApi.list({ ...params, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });
