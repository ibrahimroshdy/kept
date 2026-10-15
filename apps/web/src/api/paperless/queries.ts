/**
 * Paperless-ngx's fetchers, keys and hooks (1.x, D248) over ./types.ts and ./paths.ts.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../client';
import { paperlessPaths as p } from './paths';
import type {
  PaperlessCheck,
  PaperlessConnection,
  PaperlessConnectionBody,
  PaperlessConnectionResponse,
  PaperlessLink,
  PaperlessLinkBody,
  PaperlessLinks,
  PaperlessSearch,
  PaperlessStatus,
  PaperlessSubject,
} from './types';

const subjectQuery = (s: PaperlessSubject) =>
  'thingId' in s
    ? `thingId=${encodeURIComponent(s.thingId)}`
    : `placeId=${encodeURIComponent(s.placeId)}`;
const subjectKey = (s: PaperlessSubject) => ('thingId' in s ? s.thingId : s.placeId);

export const paperlessKeys = {
  all: ['paperless'] as const,
  connection: (locationId: string) => ['paperless', 'connection', locationId] as const,
  status: (locationId: string) => ['paperless', 'status', locationId] as const,
  links: (s: PaperlessSubject) => ['paperless', 'links', subjectKey(s)] as const,
  search: (locationId: string, q: string, page: number, s: PaperlessSubject) =>
    ['paperless', 'search', locationId, q, page, subjectKey(s)] as const,
};

export const paperlessApi = {
  connection: (locationId: string) =>
    api.get<PaperlessConnectionResponse>(p.connection(locationId)),
  save: (locationId: string, body: PaperlessConnectionBody) =>
    api.put<PaperlessConnection>(p.connection(locationId), body),
  check: (locationId: string) => api.post<PaperlessCheck>(p.check(locationId)),
  disconnect: (locationId: string) => api.del(p.connection(locationId)),
  status: (locationId: string) => api.get<PaperlessStatus>(p.status(locationId)),
  search: (locationId: string, q: string, page: number, s: PaperlessSubject) =>
    api.get<PaperlessSearch>(
      `${p.documents(locationId)}?${[
        q ? `q=${encodeURIComponent(q)}` : '',
        `page=${page}`,
        subjectQuery(s),
      ]
        .filter(Boolean)
        .join('&')}`,
    ),
  links: (s: PaperlessSubject) => api.get<PaperlessLinks>(`${p.links()}?${subjectQuery(s)}`),
  link: (body: PaperlessLinkBody) => api.post<{ items: PaperlessLink[] }>(p.links(), body),
  unlink: (id: string) => api.del(p.link(id)),
  copy: (id: string) => api.post<{ link: PaperlessLink; attachmentId: string }>(p.linkCopy(id)),
};

export function usePaperlessConnection(locationId: string) {
  return useQuery({
    queryKey: paperlessKeys.connection(locationId),
    queryFn: () => paperlessApi.connection(locationId),
  });
}

/** Whether Paperless answers, asked only where the location is connected. */
export function usePaperlessStatus(locationId: string, enabled: boolean) {
  return useQuery({
    queryKey: paperlessKeys.status(locationId),
    queryFn: () => paperlessApi.status(locationId),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

export function usePaperlessLinks(s: PaperlessSubject, enabled = true) {
  return useQuery({
    queryKey: paperlessKeys.links(s),
    queryFn: () => paperlessApi.links(s),
    enabled,
  });
}

export function usePaperlessSearch(
  locationId: string,
  q: string,
  page: number,
  s: PaperlessSubject,
  enabled: boolean,
) {
  return useQuery({
    queryKey: paperlessKeys.search(locationId, q, page, s),
    queryFn: () => paperlessApi.search(locationId, q, page, s),
    enabled,
    placeholderData: keepPreviousData,
    retry: false,
  });
}
