/**
 * The response and request shapes the web app uses, checked against the server's route schemas
 * (apps/server/src: accounts/me.ts, auth/me.ts, locations/views.ts, invites/routes.ts,
 * managed/routes.ts, admin/routes.ts). Where the two differ, the server is right and this file
 * changes. Dates are ISO 8601 strings; ids are UUIDv7 strings; field names are camelCase.
 */
import type { EmbeddingsSource, ModuleId, Preset, Role } from '@kept/shared';
import type { AiPauseReason } from './capture/types';

export type { EmbeddingsSource, ModuleId, Preset, Role };

export type LocationKind =
  | 'personal'
  | 'home'
  | 'apartment'
  | 'garage'
  | 'storage_unit'
  | 'office'
  | 'vacation_home'
  | 'custom';

// ----- meta ----------------------------------------------------------------------------------

/** GET /version (D147). */
export type VersionInfo = {
  version: string;
  revision: string | null;
  source: string | null;
  /** The image's third-party notices (D151), `/notices.txt`; null or absent without them (a
   * development server, an older one). */
  notices?: string | null;
};

// ----- setup (task 22) -----------------------------------------------------------------------

/**
 * GET /api/v1/setup (public). `oidc` (step 6 T16, D127): the generic OIDC provider's name for "Sign
 * in with <name>", when `KEPT_OIDC_ISSUER` is set and its discovery succeeded at boot; null or
 * absent otherwise (and on servers before step 6).
 */
export type SetupStatus = { needed: boolean; oidc?: { name: string } | null };
export type SetupBody = { code: string; email: string; password: string; displayName: string };
export type SetupResult = { userId: string };

/** POST /api/v1/auth/sign-up: always 202 `{next: 'sign-in'}`, taken address or not. */
export type SignUpBody = {
  email: string;
  password: string;
  displayName: string;
  inviteToken?: string;
};

// ----- auth (Better Auth) --------------------------------------------------------------------

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  username?: string | null;
  twoFactorEnabled?: boolean | null;
};

/** Sign-in answers either with the user, or with "now prove the second factor". */
export type SignInResult =
  | { twoFactorRedirect: true; twoFactorMethods?: string[] }
  | { twoFactorRedirect?: undefined; user: AuthUser; token?: string; redirect?: boolean };

export type TwoFactorEnableResult = { totpURI: string; backupCodes: string[] };

// ----- me (task 17, 18) ----------------------------------------------------------------------

/** GET /api/v1/me: the signed-in person and what the shell needs about them. */
export type Me = {
  user: {
    id: string;
    displayName: string;
    email: string | null;
    username: string | null;
    twoFactorEnabled: boolean;
    /** D47: created by an admin, signs in with a username. */
    managed: boolean;
    /** D164: `instance_admins` membership. */
    instanceAdmin: boolean;
  };
  /** Proven in this session (TOTP, backup code, or a passkey with UV). */
  mfa: boolean;
  /** Null only while it's hidden from this session (require_2fa without a second factor). */
  personalLocationId: string | null;
  /** Display preferences (§7.9). `locale` is `en` or `ar`. */
  profile: {
    timezone: string;
    locale: string;
    units: 'metric' | 'imperial';
    theme: 'system' | 'light' | 'dark';
    digits: 'western' | 'eastern';
    /** "Suggest where I am" (D153): the person's choice, on every device (T19). */
    suggestLocation?: boolean;
  };
  /** The locations this session can see, with the user's role and end date in each. */
  memberships: {
    locationId: string;
    name: string;
    kind: LocationKind;
    role: Role;
    expiresAt: string | null;
  }[];
  instance: {
    /** Instance admins only (false until the kit is acknowledged, D193); null for others. */
    recoveryKitAcknowledged: boolean | null;
  };
};

/** GET /api/v1/me/sessions (task 17: user agent, created, last active). */
export type DeviceSession = {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  lastActiveAt: string;
  current: boolean;
  /** A second factor was proven in this session (TOTP, backup code, passkey with UV). */
  secondFactor: boolean;
};

// ----- locations (task 19) -------------------------------------------------------------------

/** One entry of GET /api/v1/locations. */
export type LocationSummary = {
  id: string;
  name: string;
  kind: LocationKind;
  /** The account that owns the location (T25 decision 1): which registries apply here. */
  ownerAccountId: string;
  /** The caller's role here. */
  role: Role;
  /** The caller's own end date here (D46), or null. */
  membershipExpiresAt: string | null;
  preset: Preset;
  timezone: string;
  currency: string;
  memberCount: number;
  thingCount: number;
  /** Counted only for owners and admins; 0 otherwise. */
  pendingInviteCount: number;
  require2fa: boolean;
};

/**
 * GET /api/v1/locations/:id, and every entry of GET /api/v1/locations: the server answers the
 * same Location everywhere (locations/views.ts `LocationView`), POST included.
 *
 * The server always sends every field. The ones marked optional here are optional only because
 * step 2's mock fixtures (api/inventory/mock) predate them; read them with a fallback.
 */
export type LocationDetail = LocationSummary & {
  /** Modules switched on here (location_modules), before dependencies and provider gating. */
  modules: ModuleId[];
  /** An AI provider resolves for this location (D113, D191). */
  providerResolved: boolean;
  /** The switched-on modules after dependencies and provider gating. */
  effectiveModules?: ModuleId[];
  /** For PATCH's If-Match (§7.7). */
  rowVersion?: number;
  languages?: string[];
  moneyVisibleToViewers?: boolean;
  longUnseenMonths?: number;
  /** The owner's nominated successor (D165); shown to the owner only. */
  successorUserId?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

/** DELETE /api/v1/locations/:id: gone from every list, restorable until `purgeAfter`. */
export type DeletedLocationResult = { id: string; purgeAfter: string };

export type CreateLocationBody = {
  name: string;
  kind: Exclude<LocationKind, 'personal'>;
  rooms: string[];
  preset: Preset;
  timezone: string;
  currency: string;
};

/** PATCH /api/v1/locations/:id (locations/routes.ts `PatchBody`): only the fields that change. */
export type UpdateLocationBody = {
  /** 1–100 characters, trimmed. An owner or admin renames a location (location.settings). */
  name?: string;
  /** BCP 47 tags, at most 10 (D41): the languages AI writes search aliases in. */
  languages?: string[];
  /** IANA zone, canonicalised by the server: dates here read in it. */
  timezone?: string;
  /** Enabled currency code, uppercased by the server: new amounts default to it. */
  currency?: string;
};

/**
 * POST /api/v1/locations/:id/modules. PROPOSED body: the whole desired state in one call, so
 * "Save" on What to track is one audited, atomic change rather than a toggle per module.
 */
export type SetModulesBody = { preset: Preset; modules: ModuleId[] };

// ----- members and invites (tasks 19–21) -----------------------------------------------------

export type Member = {
  membershipId: string;
  userId: string;
  displayName: string;
  email: string | null;
  username: string | null;
  role: Role;
  expiresAt: string | null;
  managed: boolean;
  /** For managed accounts: who created it (D47). */
  managedByName: string | null;
  lastActiveAt: string | null;
  twoFactorEnabled: boolean;
  isYou: boolean;
  /** For PATCH's If-Match (§7.7): the server answers 428 without it. */
  rowVersion: number;
};

export type PendingInvite = {
  id: string;
  role: Role;
  /** When the link stops working (7 days, D33). */
  expiresAt: string;
  /** The membership's end date the invite grants, or null. */
  membershipExpiresAt: string | null;
  email: string | null;
  createdByName: string | null;
  createdAt: string;
};

/** GET /api/v1/locations/:id/members, every page joined. Invites are included for owners and
 * admins only. */
export type MembersResponse = { members: Member[]; invites: PendingInvite[] };

/** One page of GET /api/v1/locations/:id/members (§7.7: `limit`, `cursor`). Pending invites (at
 * most 50) come whole with every page. */
export type MembersPage = MembersResponse & { nextCursor?: string | null };

/** One page of GET /api/v1/locations (§7.7: `limit`, `cursor`). */
export type LocationsPage = { locations: LocationDetail[]; nextCursor?: string | null };

/** GET /api/v1/locations/deleted: the owner's deleted locations still in their grace period. */
export type DeletedLocation = {
  id: string;
  name: string;
  kind: LocationKind;
  deletedAt: string;
  purgeAfter: string;
};
export type DeletedLocationsPage = { locations: DeletedLocation[]; nextCursor?: string | null };

export type UpdateMemberBody = { role?: Role; expiresAt?: string | null };

export type CreateInviteBody = {
  role: Role;
  membershipExpiresAt?: string | null;
  email?: string;
};

/**
 * POST /api/v1/locations/:id/invites (task 20). The URL (`/invite#<token>`) carries the token in
 * its #fragment. `url` and `qrSvg` are null for an email invite (the link went only to the
 * mailbox) and on an idempotent replay (the token is never stored).
 */
export type CreateInviteResult = {
  id: string;
  role: Exclude<Role, 'owner'>;
  url: string | null;
  qrSvg: string | null;
  expiresAt: string;
  membershipExpiresAt: string | null;
  email: string | null;
  emailed: boolean;
};

/** GET /api/v1/invites/:token: the public preview (task 20). */
export type InvitePreview = {
  location: { name: string; kind: LocationKind };
  inviterName: string;
  role: Role;
  membershipExpiresAt: string | null;
  expiresAt: string;
  require2fa: boolean;
  /** The invite is for one email address; joining needs that address. */
  emailBound: boolean;
  /** Set when the caller is signed in and already belongs to the location. */
  alreadyMemberLocationId: string | null;
};

/**
 * POST /api/v1/invites/:token/accept. Signed in: no body. Not signed in: `newAccount`, which
 * creates the account and holds the invite for that address for ten minutes (the only way in
 * while sign-up is closed, D33, D127); the person then signs in and accepts again, which joins.
 * No session cookie is set.
 */
export type AcceptInviteBody = {
  newAccount?: { displayName: string; email: string; password: string };
};
/**
 * Signed in: 200 with the location. With `newAccount`: 202 `{next: 'sign-in'}` whether or not
 * the address already had an account (no enumeration); the person then signs in.
 */
export type AcceptInviteResult =
  | { locationId: string; alreadyMember: boolean }
  | { next: 'sign-in' };

export type CreateManagedBody = {
  displayName: string;
  username: string;
  role: Role;
  expiresAt?: string | null;
};
/** The one-time code the person signs in with before setting their own password (S3, D164). */
export type CreateManagedResult = {
  userId: string;
  username: string;
  /** Null on an idempotent replay (the code is never stored): issue a new one with reset-code. */
  code: string | null;
  codeExpiresAt: string;
  displayName: string;
  membershipId: string;
  role: Role;
  expiresAt: string | null;
};
/** POST /api/v1/managed-accounts/:userId/reset-code: a new one-time code (D164, D197). */
export type ManagedResetCode = { code: string; expiresAt: string };

// ----- instance admin (tasks 23–25) ----------------------------------------------------------

export type AdminUser = {
  id: string;
  displayName: string;
  email: string | null;
  username: string | null;
  managed: boolean;
  instanceAdmin: boolean;
  disabled: boolean;
  twoFactorEnabled: boolean;
  createdAt: string;
  /** Live memberships by role, across every location. */
  roles: Record<Role, number>;
};

/** An instance setting; `locked` when the environment sets it (the environment wins). */
export type AdminSetting<T> = { value: T; locked: boolean };

/**
 * GET /api/v1/admin/settings (apps/server/src/admin/routes.ts). A value the server environment
 * sets comes back `locked`, and a PUT of it is 409 `conflict` (§7.11): KEPT_SIGNUP_OPEN,
 * KEPT_BARCODE_LOOKUP (D126, off by default) and KEPT_BARCODE_CONTACT (the contact the Open*Facts
 * lookups name in their User-Agent). `formerHostnames` (T16; D120, Q32): old host names of this
 * instance, which redirect to the public URL, at most MAX_FORMER_HOSTNAMES, never the public
 * URL's own host (400). `ssrfAllowPrivate` (Q9, D83): whether a typed AI base URL may reach a
 * private address (off by default, for a self-hosted server); no environment variable sets it.
 */
export type AdminSettings = {
  signupOpen: AdminSetting<boolean>;
  barcodeLookup: AdminSetting<boolean>;
  barcodeContact: AdminSetting<string | null>;
  formerHostnames: string[];
  ssrfAllowPrivate: boolean;
  /** Step 8 (T11, D65): "Check for new versions", off by default; KEPT_UPDATE_CHECK locks it.
   * Absent from servers before step 8. */
  updateCheck?: AdminSetting<boolean>;
};
/** PUT /api/v1/admin/settings: any of them (a strict body); answers the settings. */
export type AdminSettingsBody = {
  signupOpen?: boolean;
  barcodeLookup?: boolean;
  /** An email address (at most 254 characters), or null to clear it. */
  barcodeContact?: string | null;
  formerHostnames?: string[];
  ssrfAllowPrivate?: boolean;
  updateCheck?: boolean;
};
/** The server's MAX_FORMER_HOSTNAMES (labels/former-hosts.ts). */
export const MAX_FORMER_HOSTNAMES = 10;
/**
 * A DNS host name as the server's `Hostname` accepts it once trimmed and lower-cased (RFC 1123
 * labels; no port, no scheme, no IP brackets).
 */
export const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * GET /api/v1/admin/jobs/failed. A job's data is never shown to an instance admin (D164), so
 * there is no location or other tenant detail here.
 */
export type FailedJob = {
  id: string;
  name: string;
  createdAt: string;
  failedAt: string;
  attempts: number;
  /** The last attempt's message (at most 500 characters), or null when it left none. */
  error: string | null;
};

/** Kinds so far; later steps add more (D166), so a screen must show an unknown one plainly. */
export type AdminAlertKind =
  | 'failed_jobs_rising'
  | 'audit_default_partition'
  | 'llm_default_partition'
  | 'backup_failed'
  | 'reminders_not_scanned'
  // Step 6 (T15) and step 8 (T5, T10, D66, D144, D166).
  | 'webhook_failing'
  | 'backup_stale'
  | 'disk_space_low'
  | 'bucket_versioning_off'
  | 'restore_drill_due'
  | 'backup_suspicious_size'
  | (string & {});

/** GET /api/v1/admin/accounts?q&limit: an account, its owner's name and how many locations it
 * owns; nothing about what is in them (D33; T19). */
export type AdminAccount = { id: string; ownerName: string; locations: number };

export type AdminAlert = {
  id: string;
  kind: AdminAlertKind;
  firstAt: string;
  lastAt: string;
  count: number;
  resolvedAt: string | null;
  /**
   * The latest figures, never tenant content: `failed_jobs_rising` → `{failedLastHour,
   * byQueue}`, `audit_default_partition` and `llm_default_partition` → `{rows, oldest, newest}`,
   * `backup_failed` → `{error, lastOk}` (lastOk: when the last good backup finished, or null),
   * `reminders_not_scanned` (D66, D166, step 4) → `{lastOkAt, lastRunAt}`: when the last
   * reminder scan finished and started, each null when none ever did (alerts.ts);
   * `backup_stale` → `{lastOkAt, hours}`, `disk_space_low` → `{volume: 'data' | 'backup',
   * usedRatio, freeBytes}`, `restore_drill_due` → `{lastDrillAt}` (backup/watch.ts).
   */
  payload: Record<string, unknown>;
};

/** GET /api/v1/admin/status (task 25). `alerts` is the number of open alerts. */
export type AdminStatus = {
  version: string;
  dbOk: boolean;
  alerts: number;
  recoveryKitAcknowledged: boolean;
  /** `configured: false`: KEPT_SMTP_URL is unset, so no link, invite or alert mail goes out. */
  mail: { configured: boolean };
  /**
   * The nightly backup (T31c, D207): `configured: false` while no KEPT_BACKUP_DIR or
   * KEPT_BACKUP_S3_BUCKET is set; the last run and the last good one. Absent from servers before
   * step 3 (and the demo), where the page shows no backup line.
   */
  backup?: {
    configured: boolean;
    last: AdminBackupRun | null;
    lastOk: AdminBackupRun | null;
  };
  /**
   * The reminder scan's last pass (step 4, T14; D166): when it last started and last finished, the
   * new occurrences that pass wrote and how long it took. Null before the first pass; absent from
   * servers before step 4.
   */
  reminders?: {
    lastRunAt: string | null;
    lastOkAt: string | null;
    occurrences: number;
    durationMs: number;
  } | null;
  /**
   * Generic OIDC sign-in (step 6 T16, D127, spike S6.7): whether it's configured, the button's
   * name, the issuer, the callback URL to register at the IdP, and why boot-time discovery failed
   * (OIDC is then off until a restart). Absent from servers before step 6.
   */
  oidc?: {
    configured: boolean;
    name: string | null;
    issuer: string | null;
    callbackUrl: string | null;
    /** `private_address`, `issuer_mismatch`, `insecure_endpoint`, `http_status`, or another code. */
    error: string | null;
  };
  /**
   * The MCP endpoint and OAuth connectors (step 6 T11, T12; D63, D125): connectors need an https
   * public URL, so without one they're `needs_https` and only personal tokens work.
   */
  connectors?: { mcpUrl: string; oauth: 'available' | 'needs_https' };
  /** Semantic search's index (step 6 T14, D200, D207). Absent from servers before step 6. */
  embeddings?: EmbeddingsStatus;
};

/**
 * Admin → Status → Embeddings (step 6 T14, D207): where vectors come from, how much is indexed,
 * a cap pause, and whether the local model can be offered. `PUT /api/v1/admin/embeddings
 * {source}` switches the source (audited) and answers this shape.
 */
export type EmbeddingsStatus = {
  source: EmbeddingsSource;
  /** Things with an embedding for their location's current model, and all live things. */
  indexed: number;
  total: number;
  /** A cap or day budget paused the indexing (D206); search stays on keywords meanwhile. */
  paused: { until: string; reason: AiPauseReason } | null;
  /**
   * The local model (D207): offered only when the server has its package. `downloadBytes` is its
   * size; `downloadedBytes` counts up while the first download runs, null when there is none.
   */
  local: { available: boolean; downloadBytes: number | null; downloadedBytes: number | null };
};
export type PutEmbeddingsBody = { source: EmbeddingsSource };

/** One recorded backup run (GET /api/v1/admin/status). */
export type AdminBackupRun = {
  id: string;
  status: 'ok' | 'failed';
  startedAt: string;
  finishedAt: string;
  /** `directory /backups` or `s3://bucket/prefix/`; never a credential. */
  target: string;
  bytes: number;
  files: number;
  /** Files the database lists that the file store no longer had. */
  missing: number;
  /** A directory target on the same disk as the data (D66's warning). */
  sameVolume: boolean;
  error: string | null;
};

/** POST /api/v1/me/email-change: 202, then the link to the old address (or 403 reauth_required). */
export type EmailChangeBody = { newEmail: string; password?: string };
export type EmailChangeStage = { stage: 'confirm_old' | 'verify_new' | 'done' };
