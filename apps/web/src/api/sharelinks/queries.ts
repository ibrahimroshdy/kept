/**
 * Share links' fetchers, keys and hooks (1.5, D233) over ./types.ts and ./paths.ts.
 */
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from '../client';
import { sharelinkPaths as p } from './paths';
import type {
  CreatedShareLink,
  CreateShareLinkBody,
  SharedPage,
  ShareLinksResponse,
} from './types';

export const sharelinkKeys = {
  links: (locationId: string) => ['sharelinks', 'links', locationId] as const,
  preview: (id: string) => ['sharelinks', 'preview', id] as const,
  shared: (token: string) => ['sharelinks', 'shared', token] as const,
};

const withPage = (path: string, page: number) => (page ? `${path}?page=${page}` : path);

export const sharelinkApi = {
  links: (locationId: string) => api.get<ShareLinksResponse>(p.links(locationId)),
  create: (locationId: string, body: CreateShareLinkBody) =>
    api.post<CreatedShareLink>(p.links(locationId), body),
  revoke: (id: string) => api.del(p.link(id)),
  preview: (id: string, page = 0) => api.get<SharedPage>(withPage(p.preview(id), page)),
  shared: (token: string, page = 0) => api.get<SharedPage>(withPage(p.shared(token), page)),
};

export function useShareLinks(locationId: string) {
  return useQuery({
    queryKey: sharelinkKeys.links(locationId),
    queryFn: () => sharelinkApi.links(locationId),
  });
}

/** A shared page, a page at a time: the public page's (`token`) or an admin's preview (`id`). */
export function useSharedPage(source: { token: string } | { id: string }) {
  const key =
    'token' in source ? sharelinkKeys.shared(source.token) : sharelinkKeys.preview(source.id);
  return useInfiniteQuery({
    queryKey: key,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      'token' in source
        ? sharelinkApi.shared(source.token, pageParam)
        : sharelinkApi.preview(source.id, pageParam),
    getNextPageParam: (last) => last.nextPage ?? undefined,
    retry: false,
  });
}
