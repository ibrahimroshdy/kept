/** Locations, memberships, modules, invites and managed accounts (tasks 19–21). */
import { allPages, api, ifMatch } from './client';
import { paths } from './paths';
import type {
  AcceptInviteBody,
  AcceptInviteResult,
  CreateInviteBody,
  CreateInviteResult,
  CreateLocationBody,
  CreateManagedBody,
  CreateManagedResult,
  DeletedLocation,
  DeletedLocationResult,
  DeletedLocationsPage,
  InvitePreview,
  LocationDetail,
  LocationsPage,
  ManagedResetCode,
  MembersPage,
  MembersResponse,
  SetModulesBody,
  UpdateLocationBody,
  UpdateMemberBody,
} from './types';

export const listLocations = async (): Promise<LocationDetail[]> => {
  const all: LocationDetail[] = [];
  await allPages<LocationsPage>(paths.locations, (p) => all.push(...p.locations));
  return all;
};
/** The owner's deleted locations in their grace period, newest first. */
export const listDeletedLocations = async (): Promise<DeletedLocation[]> => {
  const all: DeletedLocation[] = [];
  await allPages<DeletedLocationsPage>(paths.locationsDeleted, (p) => all.push(...p.locations));
  return all;
};
export const getLocation = (id: string) => api.get<LocationDetail>(paths.location(id));
/** 201 with the whole new location. */
export const createLocation = (body: CreateLocationBody) =>
  api.post<LocationDetail>(paths.locations, body);
/** Owner only; Personal answers 409. Restorable until `purgeAfter`. */
export const deleteLocation = (id: string) => api.del<DeletedLocationResult>(paths.location(id));
export const restoreLocation = (id: string) => api.post<LocationDetail>(paths.locationRestore(id));

export const getMembers = async (id: string): Promise<MembersResponse> => {
  const all: MembersResponse = { members: [], invites: [] };
  await allPages<MembersPage>(paths.locationMembers(id), (p) => {
    all.members.push(...p.members);
    all.invites = p.invites;
  });
  return all;
};
/** `rowVersion` is the member's, for If-Match: the server refuses a PATCH without it (428). */
export const updateMember = (
  id: string,
  membershipId: string,
  body: UpdateMemberBody,
  rowVersion?: number,
) =>
  api.patch<unknown>(
    paths.locationMember(id, membershipId),
    body,
    rowVersion === undefined ? undefined : { 'if-match': String(rowVersion) },
  );
/** Removes someone, or, with your own membership id, leaves the location (D180). */
export const removeMember = (id: string, membershipId: string) =>
  api.del(paths.locationMember(id, membershipId));

/** PATCH a location's settings (§7.7): the server answers 428 without its `rowVersion`. */
export const updateLocation = (id: string, body: UpdateLocationBody, rowVersion?: number) =>
  api.patch<LocationDetail>(paths.location(id), body, ifMatch(rowVersion));

export const setModules = (id: string, body: SetModulesBody) =>
  api.post<LocationDetail>(paths.locationModules(id), body);

export const createInvite = (id: string, body: CreateInviteBody) =>
  api.post<CreateInviteResult>(paths.locationInvites(id), body);
export const revokeInvite = (id: string, inviteId: string) =>
  api.del(paths.locationInvite(id, inviteId));

export const getInvite = (token: string) => api.get<InvitePreview>(paths.invite(token));
export const acceptInvite = (token: string, body: AcceptInviteBody = {}) =>
  api.post<AcceptInviteResult>(paths.inviteAccept(token), body);

export const createManagedAccount = (id: string, body: CreateManagedBody) =>
  api.post<CreateManagedResult>(paths.locationManagedAccounts(id), body);
/** A new one-time code for a managed account; the account is signed out (D164, D197). */
export const newManagedResetCode = (userId: string) =>
  api.post<ManagedResetCode>(paths.managedResetCode(userId));
