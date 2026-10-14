import { SHARE_LINK_SCOPES } from '@kept/shared';
import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { id, textEnum, tstz } from './common.js';
import { places } from './places.js';
import { locations } from './tenancy.js';
import { things } from './things.js';

// Read-only share links (1.5, D39 item 7, D72, D116, D180, D233; engineering spec §1
// `share_links`, §3.2, §3.3): a box (a thing), a place or a filtered list of a location, as an
// expiring link that opens with no account. Only the token's SHA-256 is stored, and kept_app
// can't read even that back. The public page reads through kept.share_link_open() (kept_system,
// by the token's hash), which returns the D116 whitelist and nothing else; the creator must still
// administer the location on every view (D180). Row-level security, the cap and the doors are in
// the custom migration that follows; see src/sharelinks/sharelinks.test.ts.

const scope = textEnum('scope_type', SHARE_LINK_SCOPES);

export const shareLinks = pgTable(
  'share_links',
  {
    id: id(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    scopeType: scope.col().notNull(),
    /** A box (any thing): it and what's inside it, however deep. Gone with the thing. */
    thingId: uuid('thing_id').references(() => things.id, { onDelete: 'cascade' }),
    /** A place: what's in it and in the places and boxes inside it. Gone with the place. */
    placeId: uuid('place_id').references(() => places.id, { onDelete: 'cascade' }),
    /** A filtered list (@kept/shared ShareView, plus `tsq`, the words as the search matches
     * them): evaluated when the page opens, in the link's location only. */
    filter: jsonb('filter'),
    /** The list's name on its page; a box or place shows its own name. */
    title: text('title'),
    tokenHash: text('token_hash').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    revokedAt: tstz('revoked_at'),
    createdBy: uuid('created_by').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
    views: integer('views').notNull().default(0),
    lastViewedAt: tstz('last_viewed_at'),
  },
  (t) => [
    scope.check('share_links'),
    unique('share_links_token_hash_uq').on(t.tokenHash),
    check('share_links_token_hash_chk', sql`token_hash ~ '^[0-9a-f]{64}$'`),
    check(
      'share_links_subject_chk',
      sql`CASE scope_type
            WHEN 'thing' THEN thing_id IS NOT NULL AND place_id IS NULL AND filter IS NULL
            WHEN 'place' THEN place_id IS NOT NULL AND thing_id IS NULL AND filter IS NULL
            ELSE filter IS NOT NULL AND thing_id IS NULL AND place_id IS NULL
                 AND title IS NOT NULL END`,
    ),
    check('share_links_filter_chk', sql`filter IS NULL OR jsonb_typeof(filter) = 'object'`),
    check('share_links_title_chk', sql`title IS NULL OR char_length(title) BETWEEN 1 AND 120`),
    check(
      'share_links_expiry_chk',
      sql`expires_at > created_at AND expires_at <= created_at + interval '1 year'`,
    ),
    check('share_links_views_chk', sql`views >= 0`),
    index('share_links_location_idx').on(t.locationId, t.createdAt),
    index('share_links_thing_idx').on(t.thingId),
    index('share_links_place_idx').on(t.placeId),
  ],
);
