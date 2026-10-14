/**
 * Share links' types (1.5, D233), as `apps/server/src/sharelinks/routes.ts` answers them. A link's
 * token is shown once, in the create answer's `url`, and never again.
 */
import type { Condition, ShareLinkScope, ShareLinkState, ShareView } from '@kept/shared';

export type ShareLinkRow = {
  id: string;
  locationId: string;
  scope: ShareLinkScope;
  /** The box or place shared; null for a list, and when it is gone. */
  subject: { id: string; name: string | null; isUnplaced: boolean } | null;
  /** A list's name. */
  title: string | null;
  view: ShareView | null;
  state: ShareLinkState;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  createdBy: { id: string; displayName: string };
  views: number;
  lastViewedAt: string | null;
};

export type ShareLinksResponse = { items: ShareLinkRow[] };

export type CreateShareLinkBody = (
  | { thingId: string }
  | { placeId: string }
  | { view: ShareView; title: string }
) & { expiresInDays: number };

export type CreatedShareLink = { link: ShareLinkRow; url: string };

export type SharedStep = { name: string | null; kind: 'place' | 'container'; isUnplaced: boolean };

/** One thing on a shared page: D116's whitelist, and nothing else. */
export type SharedThing = {
  name: string | null;
  type: { icon: string | null; name: string | null; builtinKey: string | null } | null;
  path: SharedStep[];
  quantity: number;
  condition: Condition | null;
  description: string | null;
  photo: { thumbUrl: string | null; url: string } | null;
};

export type SharedPage = {
  scope: ShareLinkScope;
  title: string | null;
  thing: SharedThing | null;
  place: { name: string; isUnplaced: boolean; path: SharedStep[] } | null;
  total: number;
  cap: number;
  page: number;
  nextPage: number | null;
  items: SharedThing[];
  expiresAt: string;
};
