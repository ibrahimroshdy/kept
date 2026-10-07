/**
 * Connections fetchers, query keys and hooks over ./types.ts and ./paths.ts: tokens and
 * connected apps, recent changes by connections, the OAuth consent step and location webhooks.
 * Lists follow the list standard (L88). A secret comes back from create and rotate only; the
 * screens (T21–T23) keep it in component state and drop it on close, never in the query cache.
 */
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, ifMatch } from '../client';
import { qs } from '../inventory/paths';
import { nextCursor } from '../inventory/queries';
import { connectionsPaths as p } from './paths';
import type {
  ConnectionChangesPage,
  ConnectionChangesParams,
  CreatedWebhook,
  CreateTokenBody,
  CreateTokenResult,
  CreateWebhookBody,
  OAuthConsent,
  OAuthConsentBody,
  OAuthConsentResult,
  RotatedSecret,
  TokenRow,
  TokensPage,
  UpdateTokenBody,
  UpdateWebhookBody,
  WebhookDeliveriesPage,
  WebhookRow,
  WebhooksResponse,
  WebhookTestResult,
} from './types';

export const connectionsKeys = {
  all: ['connections'] as const,
  tokens: ['connections', 'tokens'] as const,
  changes: (tokenId?: string) => ['connections', 'changes', tokenId ?? ''] as const,
  consent: (query: string) => ['connections', 'consent', query] as const,
  webhooks: (locationId: string) => ['connections', 'webhooks', locationId] as const,
  deliveries: (webhookId: string) => ['connections', 'deliveries', webhookId] as const,
};

/** The OAuth plugin's query string, passed through as is (`?` included, or empty). */
const withQuery = (path: string, query: string) =>
  query ? `${path}${query.startsWith('?') ? query : `?${query}`}` : path;

export const connectionsApi = {
  tokens: (cursor?: string) => api.get<TokensPage>(p.tokens + qs({ cursor })),
  createToken: (body: CreateTokenBody) => api.post<CreateTokenResult>(p.tokens, body),
  renameToken: (id: string, body: UpdateTokenBody, rowVersion: number) =>
    api.patch<TokenRow>(p.token(id), body, ifMatch(rowVersion)),
  revokeToken: (id: string) => api.del(p.token(id)),
  changes: (params: ConnectionChangesParams = {}) =>
    api.get<ConnectionChangesPage>(p.changes + qs(params)),

  consent: (query: string) => api.get<OAuthConsent>(withQuery(p.oauthConsent, query)),
  answerConsent: (query: string, body: OAuthConsentBody) =>
    api.post<OAuthConsentResult>(withQuery(p.oauthConsent, query), body),

  webhooks: (locationId: string) => api.get<WebhooksResponse>(p.locationWebhooks(locationId)),
  createWebhook: (locationId: string, body: CreateWebhookBody) =>
    api.post<CreatedWebhook>(p.locationWebhooks(locationId), body),
  updateWebhook: (id: string, body: UpdateWebhookBody, rowVersion: number) =>
    api.patch<WebhookRow>(p.webhook(id), body, ifMatch(rowVersion)),
  rotateWebhookSecret: (id: string) => api.post<RotatedSecret>(p.webhookRotateSecret(id)),
  testWebhook: (id: string) => api.post<WebhookTestResult>(p.webhookTest(id)),
  deleteWebhook: (id: string) => api.del(p.webhook(id)),
  deliveries: (id: string, cursor?: string) =>
    api.get<WebhookDeliveriesPage>(p.webhookDeliveries(id) + qs({ cursor })),
};

export function useTokens() {
  return useInfiniteQuery({
    queryKey: connectionsKeys.tokens,
    queryFn: ({ pageParam }) => connectionsApi.tokens(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });
}

export function useConnectionChanges(tokenId?: string) {
  return useInfiniteQuery({
    queryKey: connectionsKeys.changes(tokenId),
    queryFn: ({ pageParam }) =>
      connectionsApi.changes({
        ...(tokenId ? { tokenId } : {}),
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });
}

export function useOAuthConsent(query: string) {
  return useQuery({
    queryKey: connectionsKeys.consent(query),
    queryFn: () => connectionsApi.consent(query),
  });
}

export function useWebhooks(locationId: string) {
  return useQuery({
    queryKey: connectionsKeys.webhooks(locationId),
    queryFn: () => connectionsApi.webhooks(locationId),
  });
}

export function useWebhookDeliveries(webhookId: string) {
  return useInfiniteQuery({
    queryKey: connectionsKeys.deliveries(webhookId),
    queryFn: ({ pageParam }) => connectionsApi.deliveries(webhookId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });
}
