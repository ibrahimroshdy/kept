/**
 * The thing screen's own fetchers and hooks (task 26): everything the detail, create and edit
 * screens call that ./queries.ts doesn't already have. Kept in its own module so the parallel web
 * tasks never edit the same file; the paths still come from ./paths.ts only.
 */
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { api, ifMatch, written } from '../client';
import { inventoryPaths as p, qs } from './paths';
import { inventoryKeys as keys, nextCursor } from './queries';
import type {
  AttachmentView,
  ConvertToPlaceBody,
  ConvertToPlaceResult,
  CreateLinkBody,
  CreateThingBody,
  DuplicateBody,
  FileClass,
  FileView,
  MoveBody,
  MovePreview,
  MovePreviewBody,
  MoveResult,
  Page,
  Reading,
  RetypeBody,
  RevealResult,
  ThingLink,
  ThingView,
  TrashBody,
  TypeDetail,
  UpdateReadingBody,
} from './types';

export const thingApi = {
  create: (body: CreateThingBody) => api.post<ThingView>(p.things, body),
  /** Undoable (D150): `thing.retype`'s event id, for the Undo toast. */
  retype: (id: string, body: RetypeBody, rowVersion: number) =>
    written.post<ThingView>(p.thingRetype(id), body, ifMatch(rowVersion)),
  duplicate: (id: string, body: DuplicateBody = {}) =>
    api.post<ThingView>(p.thingDuplicate(id), body),
  addLink: (id: string, body: CreateLinkBody) => api.post<ThingLink>(p.thingLinks(id), body),
  removeLink: (linkId: string) => api.del(p.thingLink(linkId)),
  /** Owners and admins, If-Match; a 409 `reason: 'discards'` lists what it would lose. */
  convertToPlace: (id: string, rowVersion: number, body: ConvertToPlaceBody = {}) =>
    api.post<ConvertToPlaceResult>(p.thingConvertToPlace(id), body, ifMatch(rowVersion)),
  /** Undoable (D150): `thing.trash`'s event id; its undo also puts moved contents back. */
  trash: (id: string, body: TrashBody = {}) =>
    written.post<{ trashed: string[]; moved: string[]; trashBatchId: string }>(
      p.thingTrash(id),
      body,
    ),
  restore: (id: string) => api.post<{ restored: string[] }>(p.thingRestore(id)),
  movePreview: (body: MovePreviewBody) => api.post<MovePreview>(p.movePreview, body),
  /**
   * A single thing's move may carry its version (If-Match); a bulk move never does. Undoable
   * (D150): the answer carries one audit event id per moved thing.
   */
  move: (body: MoveBody, rowVersion?: number) =>
    written.post<MoveResult>(
      p.move,
      body,
      body.thingIds.length === 1 ? ifMatch(rowVersion) : undefined,
    ),

  // secrets (task 19)
  setSecret: (id: string, fieldKey: string, value: string) =>
    api.put<void>(p.thingSecret(id, fieldKey), { value }),
  reveal: (id: string, fieldKey: string) =>
    api.post<RevealResult>(p.thingSecretReveal(id, fieldKey)),
  copied: (id: string, fieldKey: string) => api.post<void>(p.thingSecretCopied(id, fieldKey)),

  // readings (task 16)
  acceptReading: (id: string) => api.post<Reading>(p.readingAccept(id)),
  updateReading: (id: string, body: UpdateReadingBody, rowVersion?: number) =>
    api.patch<Reading>(p.reading(id), body, ifMatch(rowVersion)),
  deleteReading: (id: string) => api.del(p.reading(id)),

  // attachments (task 17)
  attachments: (id: string, params: { role?: string; cursor?: string } = {}) =>
    api.get<Page<AttachmentView>>(p.thingAttachments(id) + qs(params)),
  deleteAttachment: (id: string) => api.del(p.attachment(id)),
};

/** The upload URL: `PUT /files/:id?locationId=&class=` (task 17). */
export const fileUploadPath = (fileId: string, locationId: string, cls: FileClass) =>
  p.file(fileId) + qs({ locationId, class: cls });

export type UploadedFile = FileView;

// ----- hooks -----------------------------------------------------------------------------------

/** A thing's attachments, one role at a time or all (Paperwork, list standard). */
export const useThingAttachments = (id: string, role?: string) =>
  useInfiniteQuery({
    queryKey: [...keys.things.attachments(id), { role: role ?? null }],
    queryFn: ({ pageParam }) =>
      thingApi.attachments(id, {
        ...(role ? { role } : {}),
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });

export const useReadings = (meterId: string) =>
  useInfiniteQuery({
    queryKey: keys.meters.readings(meterId),
    queryFn: ({ pageParam }) =>
      api.get<Page<Reading>>(p.meterReadings(meterId) + qs({ cursor: pageParam })),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });

/** The detail of one type (its resolved fields), for re-type previews and the create sheet. */
export const useTypeDetail = (id: string | null) =>
  useQuery({
    queryKey: keys.types.detail(id ?? ''),
    queryFn: () => api.get<TypeDetail>(p.type(id ?? '')),
    enabled: !!id,
  });

/** Invalidate everything a thing write can change: the thing, the lists, search and history. */
export function useInvalidateThing() {
  const qc = useQueryClient();
  return useCallback(
    async (id?: string) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: keys.things.all }),
        qc.invalidateQueries({ queryKey: keys.places.all }),
        qc.invalidateQueries({ queryKey: ['search'] }),
        qc.invalidateQueries({ queryKey: keys.home }),
        qc.invalidateQueries({ queryKey: ['meters'] }),
        qc.invalidateQueries({ queryKey: ['activity'] }),
        ...(id ? [qc.invalidateQueries({ queryKey: keys.things.history(id) })] : []),
      ]);
    },
    [qc],
  );
}
