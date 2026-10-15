/**
 * Paperless-ngx's types (1.x, D248), as `apps/server/src/paperless/routes.ts` answers them. The
 * API token is write-only: sent in a PUT, never answered.
 */

/** Why a call to Paperless failed (`paperlessError` on a 400 or 502, `error` on a check). */
export type PaperlessError =
  | 'private_address'
  | 'http_public'
  | 'unreachable'
  | 'timeout'
  | 'redirect'
  | 'auth_failed'
  | 'not_paperless'
  | 'too_old'
  | 'not_found'
  | 'too_large'
  | 'failed';

/** What a document is, in Kept's paperwork roles: Paperless's document type or tags say so. */
export type PaperlessKind = 'receipt' | 'invoice' | 'manual' | 'warranty_doc' | 'document';

export type PaperlessConnection = {
  id: string;
  url: string;
  /** Paperless's version when the connection was last saved. */
  version: string | null;
  createdBy: { id: string; displayName: string };
  updatedAt: string;
  /** Links to its documents across the location's things and places. */
  links: number;
};

export type PaperlessConnectionResponse = { connection: PaperlessConnection | null };

export type PaperlessConnectionBody = {
  url: string;
  /** Required the first time; left out, the saved one is kept. */
  token?: string;
};

export type PaperlessCheck = { ok: boolean; version: string | null; error: PaperlessError | null };

export type PaperlessStatus = {
  connected: boolean;
  /** null when not connected. */
  reachable: boolean | null;
  version: string | null;
  error: PaperlessError | null;
  url: string | null;
};

export type PaperlessHit = {
  documentId: number;
  title: string;
  kind: PaperlessKind;
  typeName: string | null;
  correspondent: string | null;
  createdOn: string | null;
  tags: string[];
  /** Already linked to the thing or place the picker is for. */
  linked: boolean;
  openUrl: string;
};

export type PaperlessSearch = {
  count: number;
  page: number;
  pageSize: number;
  items: PaperlessHit[];
};

export type PaperlessSubject = { thingId: string } | { placeId: string };

export type PaperlessLink = {
  id: string;
  documentId: number;
  subject: PaperlessSubject;
  title: string;
  kind: PaperlessKind;
  typeName: string | null;
  correspondent: string | null;
  createdOn: string | null;
  /** The attachment "Copy into Kept" made. */
  copiedAttachmentId: string | null;
  openUrl: string;
  createdBy: { id: string; displayName: string };
  createdAt: string;
};

export type PaperlessLinks = { connected: boolean; url: string | null; items: PaperlessLink[] };

export type PaperlessLinkBody = PaperlessSubject & { documentIds: number[] };
