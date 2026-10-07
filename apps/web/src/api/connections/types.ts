/**
 * Settings → Connections' API contract (step-6 plan T10, T12, T15; D58, D63, D124, D179, D180):
 * personal tokens and connected apps (OAuth grants are tokens of kind `oauth`), recent changes by
 * connections with undo, the OAuth consent step, and location webhooks. A token's or a webhook's
 * secret is in its create (or rotate) answer only, never in a list.
 *
 * Two fields are this contract's, not the route tables': `rowVersion` on a token and a webhook
 * row (their PATCH takes If-Match, §7.7), and `confirmCrossLocation` on a token create (the
 * "asks again" of D179's warning; T10 names the field).
 */
import type {
  TokenKind,
  TokenRevokedReason,
  TokenScope,
  WebhookDeliveryStatus,
  WebhookDisabledReason,
  WebhookEvent,
} from '@kept/shared';
import type { HistoryEvent, Page } from '../inventory/types';
import type { LocationKind, Role } from '../types';

export type {
  TokenKind,
  TokenRevokedReason,
  TokenScope,
  WebhookDeliveryStatus,
  WebhookEvent,
} from '@kept/shared';

// ----- tokens and connected apps (T10) -----------------------------------------------------------

/** `GET /tokens`: the caller's own, personal and OAuth. Never a hash or a secret. */
export type TokenRow = {
  id: string;
  kind: TokenKind;
  name: string;
  scope: TokenScope;
  /** `kind` names the Personal location in the reader's language (UI review steps 6–8, M9). */
  locations: { id: string; name: string; kind?: LocationKind }[];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedReason: TokenRevokedReason | null;
  /** An OAuth app's name as it calls itself: untrusted text (D179). */
  clientName?: string;
  rowVersion: number;
};
export type TokensPage = Page<TokenRow>;

/** A ready-made MCP client configuration: `<public URL>/mcp` with the bearer header (T10). */
export type ClientConfig = {
  url: string;
  headers: Record<string, string>;
  /** The client's own config file, when its documentation gives the shape. */
  file?: { name: string; contents: string };
};

/** `POST /tokens`: one location at least (D179), an optional expiry. */
export type CreateTokenBody = {
  name: string;
  scope: TokenScope;
  locationIds: string[];
  expiresAt?: string;
  /** Sent again after D179's warning, to create a write token across differing member lists. */
  confirmCrossLocation?: boolean;
};

/** 201: the token row, its secret (this answer only) and the client configs. */
export type CreatedToken = {
  token: TokenRow;
  secret: string;
  clientConfigs: { claudeDesktop: ClientConfig; generic: ClientConfig };
};
/** 200: a write token over locations whose member lists differ (D179); nothing is made yet. */
export type CrossLocationWarning = { warning: 'cross_location_write' };
export type CreateTokenResult = CreatedToken | CrossLocationWarning;

export function isCrossLocationWarning(r: CreateTokenResult): r is CrossLocationWarning {
  return 'warning' in r;
}

/** `PATCH /tokens/:id` (If-Match). */
export type UpdateTokenBody = { name: string };

/** `GET /connections/changes?cursor&tokenId`: audit events made by the caller's tokens (D58). */
export type ConnectionChange = HistoryEvent & {
  token: { id: string; name: string; kind: TokenKind };
  /** While the event can be undone (7 days, D124). */
  undo: { eventId: string; until: string } | null;
};
export type ConnectionChangesPage = Page<ConnectionChange>;
export type ConnectionChangesParams = { cursor?: string; tokenId?: string };

// ----- OAuth consent (T12) -----------------------------------------------------------------------

/**
 * `GET /oauth/consent?<the plugin's query>`. The client's name and URI are as it calls itself
 * (untrusted, D179); its logo is never fetched or shown.
 */
export type OAuthConsent = {
  client: { name: string; uri: string | null; logoHost?: string };
  requestedScopes: string[];
  locations: { id: string; name: string; kind?: LocationKind; role: Role; canWrite: boolean }[];
};

/** `POST /oauth/consent?<the plugin's query>`. */
export type OAuthConsentBody = { accept: boolean; scope: TokenScope; locationIds: string[] };
export type OAuthConsentResult = { redirectTo: string };

// ----- location webhooks (T15) -------------------------------------------------------------------

export type WebhookRow = {
  id: string;
  url: string;
  events: WebhookEvent[];
  active: boolean;
  failingSince: string | null;
  disabledReason: WebhookDisabledReason | null;
  createdBy: { id: string; displayName: string };
  lastDelivery?: { status: WebhookDeliveryStatus; at: string; httpStatus: number | null };
  rowVersion: number;
};
export type WebhooksResponse = { items: WebhookRow[] };

export type CreateWebhookBody = { url: string; events: WebhookEvent[] };
/** 201: the secret is shown once. */
export type CreatedWebhook = { webhook: WebhookRow; secret: string };
/** `PATCH /webhooks/:id` (If-Match). */
export type UpdateWebhookBody = { url?: string; events?: WebhookEvent[]; active?: boolean };
export type RotatedSecret = { secret: string };
/** `POST /webhooks/:id/test`: a `ping` sent now; the receiver's HTTP status, null if none. */
export type WebhookTestResult = { httpStatus: number | null };

export type WebhookDelivery = {
  id: string;
  event: WebhookEvent | 'ping';
  status: WebhookDeliveryStatus;
  attempts: number;
  httpStatus: number | null;
  createdAt: string;
  nextAttemptAt: string | null;
};
export type WebhookDeliveriesPage = Page<WebhookDelivery>;
