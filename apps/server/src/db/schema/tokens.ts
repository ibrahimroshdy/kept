import { TOKEN_KINDS, TOKEN_REVOKED_REASONS, TOKEN_SCOPES } from '@kept/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { id, mutable, textEnum, tstz } from './common.js';
import { locations } from './tenancy.js';

// Personal tokens and OAuth grants as principals (step-6 plan T4; engineering spec §1.10, §3.2,
// §7.3, §7.13; D15, D60, D63, D179, D180, D190; plan Q6, Q7, Q19). A token acts as its creator,
// limited to its locations and scope: withScope sets `app.token_id` beside `app.user_id`, and
// kept.visible_location_ids()/writable_location_ids()/admin_location_ids() intersect the creator's
// memberships with token_locations on every call. Row-level security, the location guard, the
// doors (verify, OAuth grant, rate hit, revoke) and the membership trigger are in the custom
// migration that follows (0070); see src/db/tokens.test.ts.

const kind = textEnum('kind', TOKEN_KINDS);
const scope = textEnum('scope', TOKEN_SCOPES);
const revokedReason = textEnum('revoked_reason', TOKEN_REVOKED_REASONS);
const rateKind = textEnum('kind', TOKEN_SCOPES);

/**
 * A personal token (`kpt_<lookup>_<secret>`, shown once) or an OAuth grant (one per user and
 * client while live, Q7). Only the secret's HMAC is stored; kept_app can't SELECT `hash`, and
 * verification goes through kept.token_verify().
 */
export const apiTokens = pgTable(
  'api_tokens',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    kind: kind.col().notNull(),
    name: text('name').notNull(),
    lookup: text('lookup'),
    hash: text('hash'),
    oauthClientId: text('oauth_client_id'),
    scope: scope.col().notNull(),
    createdWithMfa: boolean('created_with_mfa').notNull().default(false),
    expiresAt: tstz('expires_at'),
    lastUsedAt: tstz('last_used_at'),
    revokedAt: tstz('revoked_at'),
    revokedReason: revokedReason.col(),
    ...mutable(),
  },
  (t) => [
    kind.check('api_tokens'),
    scope.check('api_tokens'),
    revokedReason.check('api_tokens'),
    check('api_tokens_name_chk', sql`char_length(name) BETWEEN 1 AND 80`),
    check('api_tokens_lookup_chk', sql`lookup ~ '^[A-Za-z0-9]{8}$'`),
    check('api_tokens_hash_chk', sql`hash ~ '^[0-9a-f]{64}$'`),
    check('api_tokens_oauth_client_chk', sql`char_length(oauth_client_id) <= 400`),
    check(
      'api_tokens_kind_fields_chk',
      sql`CASE kind WHEN 'personal'
            THEN lookup IS NOT NULL AND hash IS NOT NULL AND oauth_client_id IS NULL
            ELSE lookup IS NULL AND hash IS NULL AND oauth_client_id IS NOT NULL END`,
    ),
    check('api_tokens_revoked_chk', sql`(revoked_at IS NULL) = (revoked_reason IS NULL)`),
    uniqueIndex('api_tokens_lookup_uq').on(t.lookup),
    uniqueIndex('api_tokens_oauth_uq')
      .on(t.userId, t.oauthClientId)
      .where(sql`kind = 'oauth' AND revoked_at IS NULL`),
    index('api_tokens_user_idx').on(t.userId),
  ],
);

/** The locations a token may reach (§7.13): a token whose last row goes is revoked (0070). */
export const tokenLocations = pgTable(
  'token_locations',
  {
    tokenId: uuid('token_id')
      .notNull()
      .references(() => apiTokens.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ name: 'token_locations_pk', columns: [t.tokenId, t.locationId] }),
    index('token_locations_location_idx').on(t.locationId),
  ],
);

/**
 * Per-token, per-minute request counters (§3.2, Q19), shared across replicas. Definer-only: only
 * kept.token_rate_hit() touches them, and kept.prune_stale_rows() drops those past 2 hours.
 */
export const tokenRateWindows = pgTable(
  'token_rate_windows',
  {
    tokenId: uuid('token_id')
      .notNull()
      .references(() => apiTokens.id, { onDelete: 'cascade' }),
    minute: tstz('minute').notNull(),
    kind: rateKind.col().notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [
    primaryKey({ name: 'token_rate_windows_pk', columns: [t.tokenId, t.minute, t.kind] }),
    rateKind.check('token_rate_windows'),
    check('token_rate_windows_count_chk', sql`count >= 0`),
  ],
);
