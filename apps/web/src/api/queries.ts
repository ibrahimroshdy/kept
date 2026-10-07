/**
 * TanStack Query keys and hooks. Screens read through these; mutations invalidate by key prefix.
 * A 401 or 403 mfa_required is never retried: the session gate turns it into a redirect.
 */
import { QueryClient, useQuery } from '@tanstack/react-query';
import { getMe, getSetupStatus, getVersion, listMySessions } from './account';
import {
  getAdminSettings,
  getAdminStatus,
  listAdminUsers,
  listAlerts,
  listFailedJobs,
} from './admin';
import { captureKeys } from './capture/queries';
import { isApiError } from './client';
import { householdKeys } from './household/queries';
import { inventoryKeys } from './inventory/queries';
import {
  getInvite,
  getLocation,
  getMembers,
  listDeletedLocations,
  listLocations,
} from './locations';

export const keys = {
  version: ['version'] as const,
  setup: ['setup'] as const,
  me: ['me'] as const,
  sessions: ['me', 'sessions'] as const,
  locations: ['locations'] as const,
  /** Under `locations`, so invalidating the list refreshes it too. */
  deletedLocations: ['locations', 'deleted'] as const,
  location: (id: string) => ['locations', id] as const,
  members: (id: string) => ['locations', id, 'members'] as const,
  invite: (token: string) => ['invite', token] as const,
  admin: {
    all: ['admin'] as const,
    users: ['admin', 'users'] as const,
    settings: ['admin', 'settings'] as const,
    jobs: ['admin', 'jobs'] as const,
    alerts: ['admin', 'alerts'] as const,
    status: ['admin', 'status'] as const,
  },
  // Step 2: keys.places.*, keys.things.*, keys.search(params), … (api/inventory/queries.ts).
  ...inventoryKeys,
  // Step 3: keys.inbox.*, keys.ai.*, keys.labels.*, … (api/capture/queries.ts).
  ...captureKeys,
  // Step 4: keys.loans.*, keys.schedules.*, keys.notifications.*, … (api/household/queries.ts).
  ...householdKeys,
};

/** Retry transient failures twice; never retry what a retry can't fix. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (isApiError(error) && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

export function createQueryClient(): QueryClient {
  // One definition, so tests and main.tsx agree.
  return new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetry, staleTime: 30_000, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

export const useVersion = () =>
  useQuery({ queryKey: keys.version, queryFn: getVersion, staleTime: Number.POSITIVE_INFINITY });
export const useSetupStatus = () => useQuery({ queryKey: keys.setup, queryFn: getSetupStatus });
export const useMe = () => useQuery({ queryKey: keys.me, queryFn: getMe });
export const useMySessions = () => useQuery({ queryKey: keys.sessions, queryFn: listMySessions });
export const useLocations = () => useQuery({ queryKey: keys.locations, queryFn: listLocations });
/** The caller's own deleted locations still in their grace period (D149). */
export const useDeletedLocations = () =>
  useQuery({ queryKey: keys.deletedLocations, queryFn: listDeletedLocations });
/** One location; waits while `id` is still unknown (a page that reads it from its thing or place). */
export const useLocation = (id: string) =>
  useQuery({ queryKey: keys.location(id), queryFn: () => getLocation(id), enabled: !!id });
export const useMembers = (id: string) =>
  useQuery({ queryKey: keys.members(id), queryFn: () => getMembers(id) });
export const useInvitePreview = (token: string | null) =>
  useQuery({
    queryKey: keys.invite(token ?? ''),
    queryFn: () => getInvite(token ?? ''),
    enabled: !!token,
  });
export const useAdminUsers = () =>
  useQuery({ queryKey: keys.admin.users, queryFn: () => listAdminUsers() });
export const useAdminSettings = () =>
  useQuery({ queryKey: keys.admin.settings, queryFn: getAdminSettings });
export const useFailedJobs = () => useQuery({ queryKey: keys.admin.jobs, queryFn: listFailedJobs });
export const useAlerts = () => useQuery({ queryKey: keys.admin.alerts, queryFn: listAlerts });
export const useAdminStatus = () =>
  useQuery({ queryKey: keys.admin.status, queryFn: getAdminStatus });
